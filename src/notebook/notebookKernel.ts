import { exists } from 'async-file'
import { Subject } from 'await-notify'
import { ChildProcess, spawn } from 'child_process'
import * as net from 'net'
import * as path from 'path'
import { v4 as uuidv4 } from 'uuid'
import * as vscode from 'vscode'
import {
    CancellationToken,
    createMessageConnection,
    MessageConnection,
    NotificationType,
    RequestType,
    StreamMessageReader,
    StreamMessageWriter,
} from 'vscode-jsonrpc/node'
import { getAbsEnvPath } from '../jlpkgenv'
import { JuliaExecutable } from '../executables'
import { getCrashReportingPipename, handleNewCrashReportFromException } from '../telemetry'
import { generatePipeName, getCustomEnvironmentVariables, inferJuliaNumThreads } from '../utils'
import { JuliaNotebookFeature } from './notebookFeature'
import { DebugConfigTreeProvider } from '../debugger/debugConfig'

const notifyTypeDisplay = new NotificationType<{
    items: { mimetype: string; data: string }[]
}>('notebook/display')
const notifyTypeStreamoutput = new NotificationType<{
    name: string
    data: string
}>('streamoutput')
type ProgressUpdate = {
    id: string
    parentid: string
    name: string
    fraction: number | null
    done: boolean
}
const notifyTypeProgress = new NotificationType<ProgressUpdate>('notebook/updateProgress')
const requestTypeRunCell = new RequestType<
    { filename: string; line: number; column: number; code: string },
    { success: boolean; error: { message: string; name: string; stack: string } },
    void
>('notebook/runcell')

// function getDisplayPathName(pathValue: string): string {
//     return pathValue.startsWith(homedir()) ? `~${path.relative(homedir(), pathValue)}` : pathValue
// }

export class JuliaKernel {
    private _localDisposables: vscode.Disposable[] = []

    private _scheduledExecutionRequests: vscode.NotebookCellExecution[] = []
    private _currentExecutionRequest: vscode.NotebookCellExecution = null
    private _processExecutionRequests = new Subject()

    private _kernelProcess: ChildProcess
    public _msgConnection: MessageConnection
    private _current_request_id: number = 0

    private _onCellRunFinished = new vscode.EventEmitter<void>()
    public onCellRunFinished = this._onCellRunFinished.event

    private _onConnected = new vscode.EventEmitter<void>()
    public onConnected = this._onConnected.event

    private _onStopped = new vscode.EventEmitter<void>()
    public onStopped = this._onStopped.event

    private _tokenSource = new vscode.CancellationTokenSource()

    private debuggerPipename: string | null
    public activeDebugSession: vscode.DebugSession | null
    public stopDebugSessionAfterExecution: boolean

    constructor(
        private extensionPath: string,
        public controller: vscode.NotebookController,
        public notebook: vscode.NotebookDocument,
        public juliaExecutable: JuliaExecutable,
        private outputChannel: vscode.OutputChannel,
        private notebookFeature: JuliaNotebookFeature,
        private compiledProvider: DebugConfigTreeProvider
    ) {
        this.run(this._tokenSource.token)
    }

    public dispose() {
        this.stop()
        this._localDisposables.forEach((d) => d.dispose())
    }

    public mapCellToPath(uri: string) {
        const cellUri = vscode.Uri.parse(uri, true)

        // find cell in document by matching its URI
        const cell = this.notebook.getCells().find((c) => c.document.uri.toString() === uri)

        const cellPath = path.join(
            path.dirname(cellUri.fsPath),
            `jl_notebook_cell_df34fa98e69747e1a8f8a730347b8e2f_${cellUri.fragment}.jl`
        )

        this.notebookFeature.pathToCell.set(cellPath, cell)

        return cellPath
    }

    public async queueCell(cell: vscode.NotebookCell): Promise<void> {
        // Clear prior outputs so each run shows fresh output
        const clearOutputExecution = this.controller.createNotebookCellExecution(cell)
        clearOutputExecution.start()
        await clearOutputExecution.clearOutput()
        clearOutputExecution.end(undefined)

        // Create execution object that will run the code
        const execution = this.controller.createNotebookCellExecution(cell)
        execution.token.onCancellationRequested(() => {
            execution.end(undefined)
        })
        this._scheduledExecutionRequests.push(execution)

        this._processExecutionRequests.notify()
    }

    private async messageLoop(token: CancellationToken) {
        const finalizeIfCancelled = () => {
            if (this._currentExecutionRequest && token.isCancellationRequested) {
                this.finalizeActiveExecution('Kernel stopped')
            }
        }

        while (true) {
            if (token.isCancellationRequested) {
                finalizeIfCancelled()
                return
            }

            while (this._scheduledExecutionRequests.length > 0) {
                this._currentExecutionRequest = this._scheduledExecutionRequests.shift()

                if (this._currentExecutionRequest.token.isCancellationRequested) {
                    console.log('this is cancelled')
                } else {
                    const executionOrder = ++this._current_request_id
                    this._currentExecutionRequest.executionOrder = executionOrder

                    const cellPath = this.mapCellToPath(this._currentExecutionRequest.cell.document.uri.toString())

                    const runStartTime = Date.now()
                    this._currentExecutionRequest.start(runStartTime)

                    let result: { success: boolean; error: { message: string; name: string; stack: string } }
                    if (this._currentExecutionRequest.token.isCancellationRequested) {
                        const message = 'Execution cancelled'
                        this._currentExecutionRequest.appendOutput(
                            new vscode.NotebookCellOutput([
                                vscode.NotebookCellOutputItem.error({ name: 'Error', message, stack: '' }),
                            ])
                        )
                        const runEndTime = Date.now()
                        this._currentExecutionRequest.end(false, runEndTime)
                        this._currentExecutionRequest = null
                        this._onCellRunFinished.fire()
                        continue
                    }
                    const cancelPromise = new Promise<never>((_, reject) => {
                        const disp = this._currentExecutionRequest.token.onCancellationRequested(() => {
                            disp.dispose()
                            reject(new Error('Execution cancelled'))
                        })
                    })

                    try {
                        result = await Promise.race([
                            this._msgConnection.sendRequest(
                                requestTypeRunCell,
                                {
                                    filename: cellPath,
                                    line: 0,
                                    column: 0,
                                    code: this._currentExecutionRequest.cell.document.getText(),
                                },
                                this._currentExecutionRequest.token
                            ),
                            cancelPromise,
                        ])
                    } catch (err) {
                        const execution = this._currentExecutionRequest
                        if (!execution) {
                            continue
                        }
                        const message = err instanceof Error ? err.message : 'Execution interrupted'
                        const stack = err instanceof Error && typeof err.stack === 'string' ? err.stack : ''
                        execution.appendOutput(
                            new vscode.NotebookCellOutput([
                                vscode.NotebookCellOutputItem.error({
                                    name: 'Error',
                                    message,
                                    stack,
                                }),
                            ])
                        )
                        const runEndTime = Date.now()
                        execution.end(false, runEndTime)
                        this._currentExecutionRequest = null
                        this._onCellRunFinished.fire()
                        continue
                    }

                    if (!this._currentExecutionRequest) {
                        continue
                    }

                    if (this.stopDebugSessionAfterExecution && this.activeDebugSession) {
                        vscode.debug.stopDebugging(this.activeDebugSession)
                    }

                    if (!result.success) {
                        this._currentExecutionRequest.appendOutput(
                            new vscode.NotebookCellOutput([vscode.NotebookCellOutputItem.error(result.error)])
                        )
                    }

                    const runEndTime = Date.now()
                    this._currentExecutionRequest.end(result.success, runEndTime)
                }
                this._currentExecutionRequest = null

                this._onCellRunFinished.fire()

                if (token.isCancellationRequested) {
                    finalizeIfCancelled()
                    return
                }
            }

            await this._processExecutionRequests.wait()
        }
    }

    public async toggleDebugging() {
        if (this.activeDebugSession) {
            vscode.debug.stopDebugging(this.activeDebugSession)
        } else {
            this.stopDebugSessionAfterExecution = false
            await vscode.debug.startDebugging(undefined, {
                type: 'julia',
                request: 'attach',
                name: 'Julia Notebook',
                pipename: this.debuggerPipename,
                stopOnEntry: false,
                compiledModulesOrFunctions: this.compiledProvider.getCompiledItems(),
                compiledMode: this.compiledProvider.compiledMode,
            })
        }
    }

    private async containsJuliaEnv(folder: string) {
        return (
            ((await exists(path.join(folder, 'Project.toml'))) && (await exists(path.join(folder, 'Manifest.toml')))) ||
            ((await exists(path.join(folder, 'JuliaProject.toml'))) &&
                (await exists(path.join(folder, 'JuliaManifest.toml'))))
        )
    }

    private async getAbsEnvPathForNotebook() {
        if (this.notebook.isUntitled) {
            // We don't know the location of the notebook, so just use the default env
            return await getAbsEnvPath()
        } else {
            // First, figure out whether the notebook is in the workspace
            if (
                this.notebook.uri.scheme === 'file' &&
                vscode.workspace.getWorkspaceFolder(this.notebook.uri) !== undefined
            ) {
                let currentFolder = path.dirname(vscode.Uri.parse(this.notebook.uri.toString()).fsPath)

                // We run this loop until we are looking at a folder that is no longer part of the workspace
                while (vscode.workspace.getWorkspaceFolder(vscode.Uri.file(currentFolder)) !== undefined) {
                    if (await this.containsJuliaEnv(currentFolder)) {
                        return currentFolder
                    }

                    currentFolder = path.normalize(path.join(currentFolder, '..'))
                }

                // We did not find anything in the workspace, so return default
                return await getAbsEnvPath()
            } else {
                // Notebook is not inside the workspace, so just use the default env
                return await getAbsEnvPath()
            }
        }
    }

    private async getCwdPathForNotebook() {
        if (this.notebook.isUntitled) {
            if (vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0) {
                return vscode.workspace.workspaceFolders[0].uri.fsPath
            } else {
                return await this.getAbsEnvPathForNotebook()
            }
        }

        if (this.notebook.uri.scheme === 'file') {
            return path.dirname(this.notebook.uri.fsPath)
        } else {
            return await getAbsEnvPath()
        }
    }

    private async run(token: CancellationToken) {
        try {
            const connectedPromise = new Subject()
            const serverListeningPromise = new Subject()

            const pn = generatePipeName(uuidv4(), 'vscjl-nbk')

            const server = net.createServer((socket) => {
                this._msgConnection = createMessageConnection(
                    new StreamMessageReader(socket),
                    new StreamMessageWriter(socket)
                )

                this._msgConnection.onNotification(notifyTypeDisplay, ({ items }) => {
                    const execution = this._currentExecutionRequest
                    if (execution) {
                        execution.appendOutput(
                            new vscode.NotebookCellOutput(
                                items.map((item) => {
                                    if (item.mimetype === 'image/png' || item.mimetype === 'image/jpeg') {
                                        return new vscode.NotebookCellOutputItem(
                                            Buffer.from(item.data, 'base64'),
                                            item.mimetype
                                        )
                                    } else if (item.mimetype.endsWith('+json')) {
                                        return vscode.NotebookCellOutputItem.json(item.data, item.mimetype)
                                    } else {
                                        return vscode.NotebookCellOutputItem.text(item.data, item.mimetype)
                                    }
                                })
                            )
                        )
                    }
                })

                const outputsPerExecution = new WeakMap<
                    vscode.NotebookCellExecution,
                    { output: vscode.NotebookCellOutput | undefined; name: 'stdout' | 'stderr' }
                >()
                type ProgressTiming = { start: number; last: number }
                type ProgressState = {
                    nodes: Map<string, ProgressUpdate>
                    order: string[]
                    timings: Map<string, ProgressTiming>
                    output?: vscode.NotebookCellOutput
                }
                const progressPerExecution = new WeakMap<vscode.NotebookCellExecution, ProgressState>()
                this._msgConnection.onNotification(notifyTypeStreamoutput, ({ name, data }) => {
                    const execution = this._currentExecutionRequest
                    if (!execution) {
                        return
                    }
                    if (name === 'stdout' || name === 'stderr') {
                        // Ensure \r is in a seprate line.
                        data.split(/(\r)/).forEach((line) => {
                            const previousOutput = outputsPerExecution.get(this._currentExecutionRequest)
                            if (previousOutput?.name === name) {
                                execution.appendOutputItems(
                                    [vscode.NotebookCellOutputItem[name](line)],
                                    previousOutput.output
                                )
                            } else {
                                const output = new vscode.NotebookCellOutput([
                                    vscode.NotebookCellOutputItem[name](line),
                                ])
                                execution.appendOutput([output])
                                outputsPerExecution.set(this._currentExecutionRequest, { output, name })
                            }
                        })
                    } else {
                        throw new Error('Unknown stream type.')
                    }
                })

                this._msgConnection.onNotification(notifyTypeProgress, (progress) => {
                    const execution = this._currentExecutionRequest
                    if (!execution) {
                        return
                    }

                    const state = progressPerExecution.get(execution) ?? {
                        nodes: new Map<string, ProgressUpdate>(),
                        order: [],
                        timings: new Map<string, ProgressTiming>(),
                    }

                    const updated = progress.done
                        ? {
                              ...progress,
                              fraction: progress.fraction === null ? 1 : progress.fraction,
                              done: true,
                          }
                        : progress

                    if (!state.order.includes(progress.id)) {
                        state.order.push(progress.id)
                    }
                    state.nodes.set(progress.id, updated)

                    const now = Date.now()
                    const timing = state.timings.get(progress.id) ?? { start: now, last: now }
                    timing.last = now
                    state.timings.set(progress.id, timing)

                    const html = renderProgressHtml(state)

                    const currentOutputs = execution.cell.outputs
                    const existingIndex = currentOutputs.findIndex((o) => o.metadata?.jlvscodeProgress === true)
                    const existing = existingIndex === -1 ? undefined : currentOutputs[existingIndex]

                    if (html === null) {
                        if (existing) {
                            execution.replaceOutput(
                                currentOutputs.filter((_, idx) => idx !== existingIndex)
                            )
                        }
                        progressPerExecution.set(execution, { ...state, output: undefined })
                        return
                    }

                    if (existing) {
                        execution.replaceOutputItems(
                            [vscode.NotebookCellOutputItem.text(html, 'text/html')],
                            existing
                        )
                        progressPerExecution.set(execution, { ...state, output: existing })
                    } else {
                        const progressOutput = new vscode.NotebookCellOutput(
                            [vscode.NotebookCellOutputItem.text(html, 'text/html')],
                            { jlvscodeProgress: true }
                        )
                        execution.appendOutput(progressOutput)
                        progressPerExecution.set(execution, { ...state, output: progressOutput })
                    }
                })

                this._msgConnection.listen()

                this._msgConnection.onClose(() => {
                    this.finalizeActiveExecution('Kernel disconnected')
                })

                this._onConnected.fire(null)

                connectedPromise.notify()
            })

            server.listen(pn, () => {
                serverListeningPromise.notify()
            })

            this.outputChannel.appendLine(`Pre 'await serverListeningPromise.wait()'`)
            await serverListeningPromise.wait()
            this.outputChannel.appendLine(`Post 'await serverListeningPromise.wait()'`)

            const pkgenvpath = await this.getAbsEnvPathForNotebook()
            this.outputChannel.appendLine(`Post 'const pkgenvpath = await this.getAbsEnvPathForNotebook()'`)
            const cwdPath = await this.getCwdPathForNotebook()
            this.outputChannel.appendLine(`Post 'const cwdPath = await this.getCwdPathForNotebook()'`)

            const nthreads = inferJuliaNumThreads()

            const args = ['--color=yes', `--project=${pkgenvpath}`, '--history-file=no']

            const env = {
                ...process.env,
                ...getCustomEnvironmentVariables(),
            }

            if (nthreads === 'auto') {
                args.push('--threads=auto')
            } else if (nthreads !== undefined) {
                env['JULIA_NUM_THREADS'] = nthreads
            }

            this.outputChannel.appendLine(
                `Now starting the kernel process from the extension with '${this.juliaExecutable.command}', '${args}'.`
            )

            this.debuggerPipename = generatePipeName(uuidv4(), 'vsc-jl-repldbg')

            this.notebookFeature.debugPipenameToKernel.set(this.debuggerPipename, this)

            this._kernelProcess = spawn(
                this.juliaExecutable.command,
                [
                    ...this.juliaExecutable.args,
                    ...args,
                    path.join(this.extensionPath, 'scripts', 'notebook', 'notebook.jl'),
                    pn,
                    this.debuggerPipename,
                    getCrashReportingPipename(),
                ],
                {
                    env,
                    cwd: cwdPath,
                }
            )

            this.outputChannel.appendLine('Successfully started the kernel process from the extension.')

            const outputChannel = this.outputChannel

            this._kernelProcess.stdout.on('data', function (data) {
                outputChannel.append(String(data))
            })
            this._kernelProcess.stderr.on('data', function (data) {
                outputChannel.append(String(data))
            })
            const tokenSource = this._tokenSource
            const processExecutionRequests = this._processExecutionRequests

            this._kernelProcess.on('close', async (code) => {
                this.finalizeActiveExecution('Kernel stopped')
                tokenSource.cancel()
                processExecutionRequests.notify()

                this._onStopped.fire(undefined)
                outputChannel.appendLine(`Kernel closed with ${code}.`)
                this._kernelProcess = undefined

                this.dispose()
            })

            this.outputChannel.appendLine(`Pre 'await connectedPromise.wait()'`)
            await connectedPromise.wait()
            this.outputChannel.appendLine(`Post 'await connectedPromise.wait()'`)

            await this.messageLoop(token)

            this._onStopped.fire(undefined)

            this.dispose()
        } catch (err) {
            handleNewCrashReportFromException(err, 'Extension')
            throw err
        }
    }

    public async stop() {
        if (this._kernelProcess) {
            this._kernelProcess.kill()
            this._kernelProcess = undefined
        }
    }

    public async restart() {
        this.notebookFeature.restart(this)
    }

    public async interrupt() {
        this._kernelProcess?.kill('SIGINT')
    }

    private finalizeActiveExecution(reason: string) {
        const execution = this._currentExecutionRequest
        if (!execution) {
            return
        }

        execution.appendOutput(
            new vscode.NotebookCellOutput([
                vscode.NotebookCellOutputItem.error({ name: 'Error', message: reason, stack: '' }),
            ])
        )

        const endTime = Date.now()
        execution.end(false, endTime)
        this._currentExecutionRequest = null
        this._onCellRunFinished.fire()
    }
}

function renderProgressHtml(state: { nodes: Map<string, ProgressUpdate>; order: string[]; timings: Map<string, { start: number; last: number }> }): string | null {
    if (state.nodes.size === 0) {
        return null
    }

    const escapeHtml = (value: string) =>
        value
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;')

    const depthCache = new Map<string, number>()
    const depthOf = (id: string): number => {
        if (depthCache.has(id)) {
            return depthCache.get(id)!
        }
        let depth = 0
        let cursor = state.nodes.get(id)
        const seen = new Set<string>()
        while (cursor && cursor.parentid && !seen.has(cursor.parentid)) {
            seen.add(cursor.parentid)
            if (!state.nodes.has(cursor.parentid)) {
                break
            }
            depth += 1
            cursor = state.nodes.get(cursor.parentid)
        }
        depthCache.set(id, depth)
        return depth
    }

    const now = Date.now()

    const MAX_ROWS = 10
    const activeRows = state.order
        .map((id) => state.nodes.get(id))
        .filter((p): p is ProgressUpdate => !!p)
        .map((progress) => ({ progress, depth: depthOf(progress.id) }))

    let rowsForRender = activeRows
    let truncated = false
    if (activeRows.length > MAX_ROWS) {
        truncated = true
        rowsForRender = [...activeRows]
        while (rowsForRender.length > MAX_ROWS) {
            let removeIdx = 0
            let maxDepth = -1
            for (let i = 0; i < rowsForRender.length; i++) {
                if (rowsForRender[i].depth > maxDepth) {
                    maxDepth = rowsForRender[i].depth
                    removeIdx = i
                }
            }
            rowsForRender.splice(removeIdx, 1)
        }
    }

    const rows = rowsForRender
        .map(({ progress, depth }) => {
            const label = progress.name && progress.name.length > 0 ? progress.name : 'Progress'
            const fraction = progress.fraction
            const bounded = typeof fraction === 'number' ? Math.max(0, Math.min(1, fraction)) : null
            const pctText = bounded === null ? '—' : `${Math.floor(bounded * 100)}%`
            const width = bounded === null ? 100 : bounded * 100
            const doneClass = progress.done || (bounded !== null && bounded >= 1) ? 'done' : ''
            const indeterminate = bounded === null
            const timing = state.timings.get(progress.id)
            const elapsedMs = timing ? (progress.done ? timing.last - timing.start : now - timing.start) : 0
            const etaMs = !progress.done && bounded !== null && bounded > 0 && bounded < 1 ? elapsedMs * (1 / bounded - 1) : null
            const elapsedText = formatDuration(elapsedMs)
            const etaText = etaMs === null ? '' : `ETA ${formatDuration(etaMs)}`
            const timeText = progress.done ? `Elapsed ${elapsedText}` : etaText || `Elapsed ${elapsedText}`
            return {
                depth,
                label: escapeHtml(label),
                pctText,
                width,
                doneClass,
                indeterminate,
                id: progress.id,
                timeText,
            }
        })

    const barRows = rows
        .map((row) => {
            const indent = row.depth * 12
            const fillStyle = row.indeterminate ? 'width: 100%; opacity: 0.35;' : `width: ${row.width}%;`
            return `<div class="jl-nb-progress-row ${row.doneClass}" style="padding-left:${indent}px">
                <div class="jl-nb-progress-label">${row.label}</div>
                <div class="jl-nb-progress-bar"><div class="jl-nb-progress-fill" style="${fillStyle}"></div></div>
                <div class="jl-nb-progress-pct">${row.pctText}</div>
                <div class="jl-nb-progress-time">${row.timeText}</div>
            </div>`
        })
        .join('')

    const truncatedRow = truncated
        ? `<div class="jl-nb-progress-trunc">… ${activeRows.length - MAX_ROWS} more not shown</div>`
        : ''

    const styles = `
<style>
.jl-nb-progress-panel { font-family: var(--vscode-editor-font-family, monospace); font-size: 12px; margin-top: 6px; border: 1px solid var(--vscode-panel-border, #ccc); border-radius: 4px; padding: 6px; background: var(--vscode-editor-background, #fff); width: 100%; box-sizing: border-box; overflow: hidden; }
.jl-nb-progress-row { display: grid; grid-template-columns: auto 1fr auto auto; align-items: center; gap: 6px; margin-bottom: 4px; width: 100%; box-sizing: border-box; }
.jl-nb-progress-row:last-child { margin-bottom: 0; }
.jl-nb-progress-label { color: var(--vscode-editor-foreground, #222); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 100%; }
.jl-nb-progress-bar { position: relative; height: 8px; background: var(--vscode-editor-lineHighlightBackground, #e5e5e5); border-radius: 4px; overflow: hidden; width: 100%; box-sizing: border-box; }
.jl-nb-progress-fill { position: absolute; inset: 0; background: linear-gradient(90deg, var(--vscode-progressBar-background, #0b8aee), var(--vscode-progressBar-background, #0b8aee)); transition: width 120ms ease-out; }
.jl-nb-progress-row.done .jl-nb-progress-fill { background: var(--vscode-charts-green, #2e9d32); }
.jl-nb-progress-pct { color: var(--vscode-descriptionForeground, #666); font-variant-numeric: tabular-nums; white-space: nowrap; }
.jl-nb-progress-time { color: var(--vscode-descriptionForeground, #666); font-variant-numeric: tabular-nums; white-space: nowrap; }
.jl-nb-progress-trunc { color: var(--vscode-descriptionForeground, #666); font-style: italic; margin-top: 4px; }
</style>`

    return `${styles}<div class="jl-nb-progress-panel">${barRows}${truncatedRow}</div>`
}

function formatDuration(ms: number): string {
    if (!isFinite(ms) || ms < 0) {
        return '—'
    }
    const totalSeconds = Math.max(0, Math.round(ms / 1000))
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60
    const pad = (n: number) => (n < 10 ? `0${n}` : `${n}`)
    if (hours > 0) {
        return `${hours}:${pad(minutes)}:${pad(seconds)}`
    }
    return `${minutes}:${pad(seconds)}`
}
