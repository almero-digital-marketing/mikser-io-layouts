// `inspect()` domain primitive — exposed at `runtime.options.layouts.inspect`
// and wrapped by `mikser-io-mcp`'s `mikser_layouts_inspect` tool.
//
// Returns a layout's metadata + template source + references it depends
// on + sample entities that target it. References come from two sources:
//
//   - `runtime`: the manifest's recorded refClosure from recent renders
//     of sample entities. PRECISE — captures what the renderer actually
//     touched, including findEntities/queryEntities query edges. Null
//     when the layout has never rendered.
//
//   - `static`: dispatched to the renderer plugin via its optional
//     `parseReferences(source)` method. Used for "what could this template
//     reference" — covers conditional branches not exercised by past
//     renders, and brand-new layouts that have no runtime data yet.
//     `{ available: false, reason }` when the renderer doesn't expose
//     a parser (markdown / metatext / custom renderers).
//
// Layouts is engine-agnostic — it dispatches by `entity.template` exactly
// like the render workers do. Template-syntax knowledge stays in the
// renderer plugin where it belongs.

import { readFile } from 'node:fs/promises'

export function createInspect({ runtime, findEntity, findEntities, useDatabase, collection }) {
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

        // Static refs: dispatch to the renderer's own parser. The
        // renderer is registered under `runtime.renderers` keyed by the
        // template name (the same dispatch path render.js uses).
        const renderer = runtime.renderers?.get(layout.template)
        const staticRefs = typeof renderer?.parseReferences === 'function'
            ? safeParseReferences(renderer, templateSource, layout.template)
            : { available: false, reason: renderer
                ? `Renderer "${layout.template}" does not expose parseReferences()`
                : `No renderer registered for template "${layout.template}"`
            }

        // Sample entities + their recent manifest snapshots. The
        // refClosure on each snapshot is the *runtime* answer to
        // "what does rendering this layout actually depend on."
        const matching = samples > 0
            ? await findEntities({ 'meta.layout': layout.name })
            : []
        const sampleEntities = matching
            .slice(0, samples)
            .map(e => ({ id: e.id, name: e.name, meta: e.meta }))

        const runtimeRefs = await collectRuntimeRefs({
            sampleEntities, useDatabase, layoutName: layout.name,
        })

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
            references: {
                runtime: runtimeRefs,
                static:  staticRefs,
            },
            samples: sampleEntities,
        }
    }
}

// Each sample → most-recent mikser_snapshots row by renderedAt. Returns
// `null` when no sample has ever rendered (layout exists but isn't used).
// The refClosure column is JSON; parse it once per row so the caller sees
// a structured array.
async function collectRuntimeRefs({ sampleEntities, useDatabase, layoutName }) {
    if (!sampleEntities.length) {
        return { available: false, reason: 'No sample entities target this layout' }
    }
    const db = useDatabase?.()
    if (!db?.handle) {
        return { available: false, reason: 'Database handle unavailable' }
    }

    const stmt = db.handle.prepare(`
        SELECT destination, refClosure, renderedAt, inputHash, outputHash
        FROM mikser_snapshots
        WHERE id = ?
        ORDER BY renderedAt DESC
        LIMIT 1
    `)

    const perSample = []
    for (const sample of sampleEntities) {
        const row = stmt.get(sample.id)
        if (!row) {
            perSample.push({ entityId: sample.id, rendered: false })
            continue
        }
        let refClosure = []
        try {
            refClosure = row.refClosure ? JSON.parse(row.refClosure) : []
        } catch { /* malformed JSON: surface empty rather than throw */ }
        perSample.push({
            entityId:   sample.id,
            destination: row.destination,
            renderedAt: row.renderedAt,
            inputHash:  row.inputHash,
            outputHash: row.outputHash,
            refClosure,
        })
    }

    const everRendered = perSample.some(s => s.rendered !== false && s.refClosure)
    if (!everRendered) {
        return { available: false, reason: `No sample entity using "${layoutName}" has rendered yet` }
    }
    return { available: true, samples: perSample }
}

// Wrap the renderer's parser so a thrown error in one engine doesn't
// blow up inspect() for everyone. Errors surface in the returned shape
// instead. Defensive — renderer authors may write naive parsers that
// throw on malformed source.
function safeParseReferences(renderer, source, templateName) {
    try {
        const out = renderer.parseReferences(source)
        if (out == null || typeof out !== 'object') {
            return { available: false, reason: `Renderer "${templateName}" parseReferences() returned non-object` }
        }
        return { available: true, ...out }
    } catch (err) {
        return { available: false, reason: `Renderer "${templateName}" parseReferences() threw: ${err.message}` }
    }
}
