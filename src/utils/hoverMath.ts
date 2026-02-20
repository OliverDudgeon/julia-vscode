import * as vscode from 'vscode'

type MathRenderer = {
    tex2svgPromise(latex: string, options: { display: boolean }): Promise<unknown>
    startup: {
        adaptor: {
            outerHTML(node: unknown): string
        }
    }
}

let g_mathRenderer: Promise<MathRenderer> | null = null

async function getMathRenderer(): Promise<MathRenderer> {
    if (g_mathRenderer) {
        return g_mathRenderer
    }

    g_mathRenderer = (async () => {
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const MathJax = require('mathjax') as {
            init(config: unknown): Promise<void>
            tex2svgPromise(latex: string, options: { display: boolean }): Promise<unknown>
            startup: {
                adaptor: {
                    outerHTML(node: unknown): string
                }
            }
        }

        await MathJax.init({
            loader: {
                load: ['input/tex', 'output/svg'],
            },
            tex: {
                packages: {
                    '[+]': ['ams', 'newcommand', 'require', 'color', 'noerrors', 'noundefined'],
                },
            },
            svg: {
                fontCache: 'local',
            },
        })

        return MathJax
    })().catch((error) => {
        g_mathRenderer = null
        throw error
    })

    return g_mathRenderer
}

const blockMathRegex = /```math\s*\r?\n([\s\S]*?)\r?\n```/g
const fencedCodeRegex = /```[\s\S]*?```/g
const inlineMathRegex = /``([^`\r\n]+?)``/g

function isDarkTheme(kind: vscode.ColorThemeKind): boolean {
    return kind === vscode.ColorThemeKind.Dark || kind === vscode.ColorThemeKind.HighContrast
}

function escapeHtmlAttribute(value: string): string {
    return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function applySvgThemeColor(svgMarkup: string, themeKind: vscode.ColorThemeKind): string {
    const color = isDarkTheme(themeKind) ? '#FFFFFF' : '#000000'
    const styleDeclaration = `color:${color};`

    if (/^<svg[^>]*style="/i.test(svgMarkup)) {
        return svgMarkup.replace(/<svg([^>]*?)style="([^"]*)"([^>]*)>/i, (_match, before, style, after) => {
            return `<svg${before}style="${styleDeclaration}${style}"${after}>`
        })
    }

    return svgMarkup.replace(/<svg/i, `<svg style="${styleDeclaration}"`)
}

function normalizeJuliaEscapedLatex(latex: string): string {
    const normalized = latex.replace(/\\+([a-zA-Z]+)/g, '\\$1')

    return normalized
}

function sanitizeMatrixLatex(latex: string): string {
    const sanitized = latex.replace(
        /(?:\\\\\s*)+\\end\{(matrix|bmatrix|pmatrix|Bmatrix|vmatrix|Vmatrix)\}/g,
        '\\end{$1}'
    )

    return sanitized
}

async function latexToSvgDataUri(latex: string, displayMode: boolean, themeKind: vscode.ColorThemeKind): Promise<string> {
    const renderer = await getMathRenderer()
    const canonicalLatex = sanitizeMatrixLatex(normalizeJuliaEscapedLatex(latex))

    const mathNode = await renderer.tex2svgPromise(canonicalLatex, {
        display: displayMode,
    })
    const outer = renderer.startup.adaptor.outerHTML(mathNode)
    const svgMatch = outer.match(/<svg[\s\S]*<\/svg>/)

    if (svgMatch) {
        const themedSvgMarkup = applySvgThemeColor(svgMatch[0], themeKind)
        const base64 = Buffer.from(themedSvgMarkup, 'utf8').toString('base64')
        return `data:image/svg+xml;base64,${base64}`
    }

    throw new Error('Failed to render LaTeX equation to SVG.')
}

async function renderMathImageTag(latex: string, displayMode: boolean, themeKind: vscode.ColorThemeKind): Promise<string> {
    const uri = await latexToSvgDataUri(latex, displayMode, themeKind)
    const blockStyle = displayMode ? 'display:block;margin:0.5em 0;' : 'display:inline;vertical-align:middle;'
    const alt = escapeHtmlAttribute(latex)
    return `<img src="${uri}" alt="${alt}" style="${blockStyle}" />`
}

async function replaceMatches(
    markdown: string,
    regex: RegExp,
    replacer: (...matches: string[]) => Promise<string>
): Promise<string> {
    let result = ''
    let lastIndex = 0

    regex.lastIndex = 0

    for (const match of markdown.matchAll(regex)) {
        const startIndex = match.index ?? 0
        result += markdown.slice(lastIndex, startIndex)
        result += await replacer(...match)
        lastIndex = startIndex + match[0].length
    }

    result += markdown.slice(lastIndex)

    return result
}

async function replaceInlineMath(markdown: string, themeKind: vscode.ColorThemeKind): Promise<string> {
    return replaceMatches(markdown, inlineMathRegex, async (_match: string, equation: string) => {
        const latex = equation.trim()
        if (!latex) {
            return _match
        }

        try {
            return await renderMathImageTag(latex, false, themeKind)
        } catch {
            return _match
        }
    })
}

export async function renderDocumenterMathInMarkdown(markdown: string, themeKind: vscode.ColorThemeKind): Promise<string> {
    if (!markdown.includes('```math') && !markdown.includes('``')) {
        return markdown
    }

    const withBlockMath = await replaceMatches(markdown, blockMathRegex, async (_match: string, equation: string) => {
        const latex = equation.trim()
        if (!latex) {
            return _match
        }

        try {
            return `\n\n${await renderMathImageTag(latex, true, themeKind)}\n\n`
        } catch {
            return _match
        }
    })

    const fencedBlocks = withBlockMath.match(fencedCodeRegex) ?? []
    const textSegments = withBlockMath.split(fencedCodeRegex)

    const transformedSegments = await Promise.all(textSegments.map(async (segment) => replaceInlineMath(segment, themeKind)))

    return transformedSegments
        .map((segment, index) => {
            if (index < fencedBlocks.length) {
                return `${segment}${fencedBlocks[index]}`
            }
            return segment
        })
        .join('')
}

async function transformMarkdownString(
    markdown: vscode.MarkdownString,
    themeKind: vscode.ColorThemeKind
): Promise<vscode.MarkdownString> {
    const transformedValue = await renderDocumenterMathInMarkdown(markdown.value, themeKind)
    if (transformedValue === markdown.value) {
        if (markdown.supportHtml !== true) {
            markdown.supportHtml = true
        }
        return markdown
    }

    const transformed = new vscode.MarkdownString(transformedValue, markdown.supportThemeIcons)
    transformed.isTrusted = markdown.isTrusted
    transformed.baseUri = markdown.baseUri
    transformed.supportThemeIcons = markdown.supportThemeIcons
    transformed.supportHtml = true

    return transformed
}

async function transformHoverContent(
    content: vscode.MarkdownString | vscode.MarkedString,
    themeKind: vscode.ColorThemeKind
): Promise<vscode.MarkdownString | vscode.MarkedString> {
    if (content instanceof vscode.MarkdownString) {
        return transformMarkdownString(content, themeKind)
    }

    if (typeof content === 'string') {
        const transformedValue = await renderDocumenterMathInMarkdown(content, themeKind)
        const transformed = new vscode.MarkdownString(transformedValue)
        transformed.supportHtml = true
        return transformed
    }

    return content
}

export async function transformHoverMath(hover: vscode.Hover): Promise<vscode.Hover> {
    const mathRenderingEnabled = vscode.workspace.getConfiguration('julia').get<boolean>('hover.mathRendering', true)
    if (!mathRenderingEnabled) {
        return hover
    }

    const themeKind = vscode.window.activeColorTheme.kind

    if (Array.isArray(hover.contents)) {
        const transformedContents = await Promise.all(hover.contents.map((content) => transformHoverContent(content, themeKind)))
        return new vscode.Hover(
            transformedContents,
            hover.range
        )
    }

    return new vscode.Hover(await transformHoverContent(hover.contents, themeKind), hover.range)
}
