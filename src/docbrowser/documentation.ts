import markdownit from 'markdown-it'
import * as path from 'path'
import * as vscode from 'vscode'
import { constructCommandString, getVersionedParamsAtPosition, onEvent, registerCommand } from '../utils'
import { LanguageClientFeature } from '../languageClient'

const liveDocumentationDebounceMs = 250
const liveDocumentationSetting = 'liveDocumentation'

function openArgs(href: string) {
    const matches = href.match(/^((\w+:\/\/)?.+?)(?:[:#](\d+))?$/)
    let uri
    let line
    if (matches[1] && matches[3] && matches[2] === undefined) {
        uri = matches[1]
        line = parseInt(matches[3])
    } else {
        uri = vscode.Uri.parse(matches[1])
    }
    return { uri, line }
}

const md = new markdownit()
    .use(
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('@traptitech/markdown-it-katex'),
        {
            output: 'html',
        }
    )
    .use(
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        require('markdown-it-footnote')
    )

// add custom validator to allow for file:// links
const BAD_PROTO_RE = /^(vbscript|javascript|data):/
const GOOD_DATA_RE = /^data:image\/(gif|png|jpeg|webp);/
md.validateLink = (url) => {
    // url should be normalized at this point, and existing entities are decoded
    const str = url.trim().toLowerCase()

    return BAD_PROTO_RE.test(str) ? (GOOD_DATA_RE.test(str) ? true : false) : true
}

md.renderer.rules.link_open = (tokens, idx, options, _env, self) => {
    const aIndex = tokens[idx].attrIndex('href')

    if (aIndex >= 0 && tokens[idx].attrs[aIndex][1] === '@ref' && tokens.length > idx + 1) {
        const commandUri = constructCommandString('language-julia.search-word', { searchTerm: tokens[idx + 1].content })
        tokens[idx].attrs[aIndex][1] = vscode.Uri.parse(commandUri).toString()
    } else if (aIndex >= 0 && tokens.length > idx + 1) {
        const href = tokens[idx + 1].content
        const { uri, line } = openArgs(href)
        let commandUri
        if (line === undefined) {
            commandUri = constructCommandString('vscode.open', uri)
        } else {
            commandUri = constructCommandString('language-julia.openFile', { path: uri, line })
        }
        tokens[idx].attrs[aIndex][1] = commandUri
    }

    return self.renderToken(tokens, idx, options)
}

export function activate(context: vscode.ExtensionContext, languageClientFeature) {
    const provider = new DocumentationViewProvider(context, languageClientFeature)

    context.subscriptions.push(
        registerCommand('language-julia.show-documentation-pane', async () => await provider.showDocumentationPane()),
        registerCommand('language-julia.show-documentation', async () => await provider.showDocumentation()),
        registerCommand('language-julia.browse-back-documentation', async () => provider.browseBack()),
        registerCommand('language-julia.browse-forward-documentation', async () => provider.browseForward()),
        registerCommand('language-julia.search-word', async (params: { searchTerm: string }) =>
            provider.findHelp(params)
        ),
        vscode.window.registerWebviewViewProvider('julia-documentation', provider)
    )
}

class DocumentationViewProvider implements vscode.WebviewViewProvider {
    private view?: vscode.WebviewView

    private backStack = Array<string>() // also keep current page
    private forwardStack = Array<string>()
    private liveDocumentationTimer: ReturnType<typeof setTimeout> | undefined = undefined
    private liveDocumentationRequestId = 0
    private lastCursorKey: string | undefined = undefined

    constructor(
        private context: vscode.ExtensionContext,
        private languageClientFeature: LanguageClientFeature
    ) {
        this.context.subscriptions.push(
            vscode.window.onDidChangeTextEditorSelection((e) => this.scheduleLiveDocumentationUpdate(e.textEditor)),
            vscode.window.onDidChangeActiveTextEditor((editor) => this.scheduleLiveDocumentationUpdate(editor)),
            vscode.workspace.onDidChangeConfiguration((e) => {
                if (e.affectsConfiguration(`julia.${liveDocumentationSetting}`)) {
                    if (this.liveDocumentationTimer) {
                        clearTimeout(this.liveDocumentationTimer)
                    }

                    if (this.isLiveDocumentationEnabled()) {
                        this.scheduleLiveDocumentationUpdate(vscode.window.activeTextEditor)
                    }
                }
            })
        )
    }

    private isLiveDocumentationEnabled() {
        return vscode.workspace.getConfiguration('julia').get<boolean>(liveDocumentationSetting, true)
    }

    resolveWebviewView(view: vscode.WebviewView) {
        this.view = view

        view.webview.options = {
            enableScripts: true,
            enableCommandUris: true,
        }
        view.webview.html = this.createWebviewHTML(
            'Use the `language-julia.show-documentation` command in an editor or search for documentation above.'
        )

        onEvent(view.webview.onDidReceiveMessage, (msg) => {
            if (msg.type === 'search') {
                this.showDocumentationFromWord(msg.query)
            } else {
                console.error('unknown message received')
            }
        })

        this.scheduleLiveDocumentationUpdate(vscode.window.activeTextEditor)
    }

    private scheduleLiveDocumentationUpdate(editor: vscode.TextEditor | undefined) {
        if (!this.view) {
            return
        }

        if (!this.isLiveDocumentationEnabled()) {
            return
        }

        if (this.liveDocumentationTimer) {
            clearTimeout(this.liveDocumentationTimer)
        }

        this.liveDocumentationTimer = setTimeout(() => {
            this.updateDocumentationFromCursor(editor)
        }, liveDocumentationDebounceMs)
    }

    private async updateDocumentationFromCursor(editor: vscode.TextEditor | undefined) {
        if (!this.view || !editor) {
            return
        }

        if (!this.isLiveDocumentationEnabled()) {
            return
        }

        const position = editor.selection.active
        const cursorKey = `${editor.document.uri.toString()}:${position.line}:${position.character}`
        if (cursorKey === this.lastCursorKey) {
            return
        }

        this.lastCursorKey = cursorKey

        const requestId = ++this.liveDocumentationRequestId
        const docAsMD = await this.getDocumentationFromHover(editor.document, position)

        if (!this.view || requestId !== this.liveDocumentationRequestId) {
            return
        }

        const docAsHTML = md.render(docAsMD || 'No documentation found for the symbol under cursor.')
        this.view.webview.postMessage({
            type: 'update-documentation',
            html: docAsHTML,
        })
    }

    private async getDocumentationFromHover(document: vscode.TextDocument, position: vscode.Position): Promise<string> {
        const hovers = await vscode.commands.executeCommand<vscode.Hover[]>(
            'vscode.executeHoverProvider',
            document.uri,
            position
        )

        if (!hovers || hovers.length === 0) {
            return ''
        }

        const pieces = hovers
            .flatMap((hover) => this.hoverContentsToMarkdown(hover.contents))
            .map((value) => value.trim())
            .filter((value) => value.length > 0)

        return pieces.join('\n\n')
    }

    private hoverContentsToMarkdown(
        contents: vscode.MarkdownString | vscode.MarkedString | Array<vscode.MarkdownString | vscode.MarkedString>
    ): string[] {
        const values = Array.isArray(contents) ? contents : [contents]

        return values.map((value) => {
            if (value instanceof vscode.MarkdownString) {
                return value.value
            }

            if (typeof value === 'string') {
                return value
            }

            return `\`\`\`${value.language}\n${value.value}\n\`\`\``
        })
    }

    findHelp(params: { searchTerm: string }) {
        this.showDocumentationFromWord(params.searchTerm)
    }

    async showDocumentationPane() {
        if (this.view?.show === undefined) {
            // this forces the webview to be resolved, but changes focus:
            await vscode.commands.executeCommand('julia-documentation.focus')
        }
        this.view?.show(true)
    }

    async showDocumentationFromWord(word: string) {
        const docAsMD = await this.getDocumentationFromWord(word)
        if (!docAsMD) {
            return
        }

        await this.showDocumentationPane()
        const html = this.createWebviewHTML(docAsMD)
        this.setHTML(html)
    }

    async getDocumentationFromWord(word: string): Promise<string> {
        return await this.languageClientFeature.withLanguageClient(
            async (languageClient) => {
                return await languageClient.sendRequest('julia/getDocFromWord', { word: word })
            },
            async (err) => {
                console.error('LC request failed with ', err)
                return ''
            }
        )
    }

    async showDocumentation() {
        // telemetry.traceEvent('command-showdocumentation')
        const editor = vscode.window.activeTextEditor
        if (!editor) {
            return
        }

        const docAsMD = await this.getDocumentation(editor)
        if (!docAsMD) {
            return
        }

        this.forwardStack = [] // initialize forward page stack for manual search
        await this.showDocumentationPane()
        const html = this.createWebviewHTML(docAsMD)
        this.setHTML(html)
    }

    async getDocumentation(editor: vscode.TextEditor): Promise<string> {
        return await this.languageClientFeature.withLanguageClient(
            async (languageClient) => {
                return await languageClient.sendRequest<string>(
                    'julia/getDocAt',
                    getVersionedParamsAtPosition(editor.document, editor.selection.start)
                )
            },
            (err) => {
                console.error('LC request failed with ', err)
                return ''
            }
        )
    }

    createWebviewHTML(docAsMD: string) {
        const docAsHTML = md.render(docAsMD)

        const extensionPath = this.context.extensionPath

        const googleFontscss = this.view.webview.asWebviewUri(
            vscode.Uri.file(path.join(extensionPath, 'libs', 'google_fonts', 'css'))
        )
        const fontawesomecss = this.view.webview.asWebviewUri(
            vscode.Uri.file(path.join(extensionPath, 'libs', 'fontawesome', 'fontawesome.min.css'))
        )
        const solidcss = this.view.webview.asWebviewUri(
            vscode.Uri.file(path.join(extensionPath, 'libs', 'fontawesome', 'solid.min.css'))
        )
        const brandscss = this.view.webview.asWebviewUri(
            vscode.Uri.file(path.join(extensionPath, 'libs', 'fontawesome', 'brands.min.css'))
        )
        const documenterStylesheetcss = this.view.webview.asWebviewUri(
            vscode.Uri.file(path.join(extensionPath, 'libs', 'documenter', 'documenter-vscode.css'))
        )
        const katexcss = this.view.webview.asWebviewUri(
            vscode.Uri.file(path.join(extensionPath, 'libs', 'katex', 'katex.min.css'))
        )

        const webfontjs = this.view.webview.asWebviewUri(
            vscode.Uri.file(path.join(extensionPath, 'libs', 'webfont', 'webfont.js'))
        )

        return `
    <html lang="en" class='theme--documenter-vscode'>

    <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0" />
        <title>Julia Documentation Pane</title>
        <link href=${googleFontscss} rel="stylesheet" type="text/css" />
        <link href=${fontawesomecss} rel="stylesheet" type="text/css" />
        <link href=${solidcss} rel="stylesheet" type="text/css" />
        <link href=${brandscss} rel="stylesheet" type="text/css" />
        <link href=${katexcss} rel="stylesheet" type="text/css" />
        <link href=${documenterStylesheetcss} rel="stylesheet" type="text/css">

        <script type="text/javascript">
            WebFontConfig = {
                custom: {
                    families: ['KaTeX_AMS', 'KaTeX_Caligraphic:n4,n7', 'KaTeX_Fraktur:n4,n7','KaTeX_Main:n4,n7,i4,i7', 'KaTeX_Math:i4,i7', 'KaTeX_Script','KaTeX_SansSerif:n4,n7,i4', 'KaTeX_Size1', 'KaTeX_Size2', 'KaTeX_Size3', 'KaTeX_Size4', 'KaTeX_Typewriter'],
                    urls: ['${katexcss}']
                },
            }
        </script>

        <style>
        body {
            word-break: normal;
            overflow-wrap: break-word;
        }
        body:active {
            outline: 1px solid var(--vscode-focusBorder);
        }
        .search {
            position: fixed;
            background-color: var(--vscode-sideBar-background);
            width: 100%;
            padding: 5px;
            display: flex;
            z-index: 2;
        }
        .search input[type="text"] {
            width: 100%;
            background-color: var(--vscode-input-background);
            border: none;
            outline: none;
            color: var(--vscode-input-foreground);
            padding: 4px;
        }
        .search input[type="text"]:focus {
            outline: 1px solid var(--vscode-editorWidget-border);
        }
        button {
            width: 30px;
            margin: 0 5px 0 0;
            display: inline;
            border: none;
            box-sizing: border-box;
            padding: 5px 7px;
            text-align: center;
            cursor: pointer;
            justify-content: center;
            align-items: center;
            background-color: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            font-family: var(--vscode-font-family);
        }
        button:hover {
            background-color: var(--vscode-button-hoverBackground);
        }

        button:focus {
            outline: 1px solid var(--vscode-focusBorder);
            outline-offset: 0px;
        }
        </style>

        <script src=${webfontjs}></script>
    </head>

    <body>
        <div class="search">
            <input id="search-input" type="text" placeholder="Search"></input>
        </div>
        <div class="docs-main" style="padding: 50px 1em 1em 1em">
            <article id="docs-content" class="content">
                ${docAsHTML}
            </article>
        </div>
        <script>
            const vscode = acquireVsCodeApi()

            function search(val) {
                if (val) {
                    vscode.postMessage({
                        type: 'search',
                        query: val
                    })
                }
            }
            function onKeyDown(ev) {
                if (ev && ev.keyCode === 13) {
                    const val = document.getElementById('search-input').value
                    search(val)
                }
            }

            window.addEventListener('message', (event) => {
                const message = event.data
                if (!message || message.type !== 'update-documentation') {
                    return
                }

                const docsContent = document.getElementById('docs-content')
                if (docsContent) {
                    docsContent.innerHTML = message.html || ''
                }
            })

            document.getElementById('search-input').addEventListener('keydown', onKeyDown)
        </script>
    </body>

    </html>
    `
    }

    setHTML(html: string) {
        // set current stack
        this.backStack.push(html)

        if (this.view) {
            this.view.webview.html = html
        }
    }

    isBrowseBackAvailable() {
        return this.backStack.length > 1
    }

    isBrowseForwardAvailable() {
        return this.forwardStack.length > 0
    }

    browseBack() {
        if (!this.isBrowseBackAvailable()) {
            return
        }

        const current = this.backStack.pop()
        this.forwardStack.push(current)

        this.setHTML(this.backStack.pop())
    }

    browseForward() {
        if (!this.isBrowseForwardAvailable()) {
            return
        }

        this.setHTML(this.forwardStack.pop())
    }
}
