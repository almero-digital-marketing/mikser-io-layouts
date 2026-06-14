// `inspect()` domain primitive — exposed at `runtime.options.layouts.inspect`
// and wrapped by `mikser-io-mcp`'s `mikser_layouts_inspect` tool.
//
// Given a layout id, returns the layout meta, template source bytes, a
// regex-derived view of variables/includes/iterations referenced by the
// template, and up to N sample entities that explicitly target this
// layout.
//
// Lives here, not in mikser-io-mcp, because "what does it mean to
// inspect a layout" is template-engine knowledge — naive Liquid /
// Handlebars / Eta regex parsing. The MCP plugin should not know
// those engines exist; it just wraps this in a tool.

import { readFile } from 'node:fs/promises'

// Liquid / Handlebars / Eta keywords we don't want surfaced as
// "variables this layout references." Anything that looks like a path
// (`document.meta.X`) survives; bare keywords filter out.
const TEMPLATE_KEYWORDS = new Set([
    'if', 'else', 'elsif', 'endif', 'unless', 'endunless',
    'for', 'endfor', 'each', 'break', 'continue', 'in', 'of',
    'case', 'when', 'endcase', 'switch',
    'capture', 'endcapture', 'assign', 'include', 'layout', 'block',
    'endblock', 'comment', 'endcomment', 'raw', 'endraw',
    'true', 'false', 'nil', 'null', 'and', 'or', 'not', 'with',
])

// Naive multi-engine template scan. Hits liquid (`{{ X }}`, `{% ... %}`),
// handlebars (`{{ X }}`, `{{#each X}}`), and eta (`<%= X %>`,
// `<% for X of Y %>`). Returns up to three buckets:
//   variables  — bare identifier paths used in output position
//   includes   — referenced sub-templates (liquid `include` / `layout`)
//   iterations — `for X in Y` / `each X` shapes so the caller knows
//                where array fields are expected
//
// "Naive" is the right word: regex pass, not an AST walk. False positives
// possible; per-engine plugins can register smarter parsers later.
export function parseTemplateReferences(source) {
    const empty = { variables: [], includes: [], iterations: [] }
    if (typeof source !== 'string' || !source) return empty

    const variables = new Set()
    const includes = new Set()
    const iterations = []

    // {{ X.Y.Z }} and <%= X.Y.Z %> — output expressions. Capture leading
    // identifier path; ignore filters (`| upcase`), pipes, and anything
    // after a space.
    const outputExpr = /(?:\{\{=?|<%=)\s*([^}%|]+?)(?:\s*\||\s*\}\}|\s*-?%>)/g
    for (const m of source.matchAll(outputExpr)) {
        const expr = m[1].trim()
        const ident = expr.match(/^[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*/)
        if (ident && !TEMPLATE_KEYWORDS.has(ident[0])) {
            variables.add(ident[0])
        }
    }

    // Liquid include / layout — sub-template references.
    for (const m of source.matchAll(/\{%\s*include\s+['"]([^'"]+)['"]/g)) {
        includes.add(m[1])
    }
    for (const m of source.matchAll(/\{%\s*layout\s+['"]([^'"]+)['"]/g)) {
        includes.add(m[1])
    }

    // Liquid `{% for X in Y %}` and `{% for X in Y.Z %}`.
    for (const m of source.matchAll(/\{%\s*for\s+(\w+)\s+in\s+([\w.]+)/g)) {
        iterations.push({ item: m[1], collection: m[2] })
        variables.add(m[2])
    }
    // Handlebars `{{#each X.Y}}`.
    for (const m of source.matchAll(/\{\{#each\s+([\w.]+)/g)) {
        iterations.push({ item: '(each)', collection: m[1] })
        variables.add(m[1])
    }
    // Eta `<% for (const X of Y) { %>` / `<% for X of Y %>`.
    for (const m of source.matchAll(/<%\s*for\s*\(?\s*(?:const|let|var)?\s*(\w+)\s+of\s+([\w.]+)/g)) {
        iterations.push({ item: m[1], collection: m[2] })
        variables.add(m[2])
    }

    return {
        variables: Array.from(variables).sort(),
        includes: Array.from(includes).sort(),
        iterations,
    }
}

// Build the inspect() function. Closes over the catalog access primitives
// (findEntity / findEntities) and the collection name; returned closure
// gets attached to `runtime.options.layouts.inspect`.
export function createInspect({ findEntity, findEntities, collection }) {
    return async function inspect(id, { samples = 3 } = {}) {
        const layout = await findEntity({ id })
        if (!layout || layout.collection !== collection) {
            const err = new Error(`Layout not found: ${id}`)
            err.code = 'LAYOUT_NOT_FOUND'
            throw err
        }

        let templateSource = ''
        try {
            templateSource = await readFile(layout.uri, 'utf8')
        } catch (err) {
            const wrapped = new Error(`Layout entity exists but template file unreadable (${layout.uri}): ${err.message}`)
            wrapped.code = 'LAYOUT_TEMPLATE_UNREADABLE'
            throw wrapped
        }

        const references = parseTemplateReferences(templateSource)

        let sampleEntities = []
        if (samples > 0) {
            // Indexed query on `meta_layout` — returns only the
            // entities that name this layout, not the whole catalog.
            const matching = await findEntities({ 'meta.layout': layout.name })
            sampleEntities = matching
                .slice(0, samples)
                .map(e => ({ id: e.id, name: e.name, meta: e.meta }))
        }

        return {
            layout: {
                id:            layout.id,
                name:          layout.name,
                uri:           layout.uri,
                format:        layout.format,
                template:      layout.template,
                postprocessor: layout.postprocessor ?? null,
            },
            templateSource,
            references,
            samples: sampleEntities,
        }
    }
}
