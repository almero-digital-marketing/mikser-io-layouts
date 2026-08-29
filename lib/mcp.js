// MCP tool surface for layouts. Registered against the mcp substrate
// at `runtime.options.mcp` when present — same gating pattern other
// siblings use (vector, schemas, preview). When mcp isn't loaded, the
// registration is a no-op.
//
// One tool: `mikser_layouts_inspect`. Surfaces the inspect() primitive
// already exposed at `runtime.options.layouts.inspect`. The schema and
// author-facing description live here because they're MCP-flavor; the
// underlying data shape is owned by lib/inspect.js.

import { z } from 'zod'

export function registerMcpTools({ runtime, useLogger, findEntity, findEntities, useDatabase, collection }) {
    const mcp = runtime.options.mcp
    if (!mcp) return   // mcp plugin not loaded — nothing to register
    if (!runtime.options.layouts?.inspect) return   // shouldn't happen if we run after our own inspect setup, but defensive

    const logger = useLogger()

    mcp.simpleTool(
        'mikser_layouts_inspect',
        'Inspect a layout and everything it pulls in. Answers "what does this layout need from a document" '
        + 'before you write one — which saves a guess-and-render-empty cycle, and is the only way to catch a '
        + 'mistyped key before it ships a page with a section silently missing.\n\n'
        + 'START WITH references.contract.meta. It is the list of document meta keys the WHOLE layout tree '
        + 'consumes, resolved through includes and renamings into the vocabulary a document actually writes — '
        + 'so `data.meta.hero.tags` in a partial three files down comes back as `hero.tags`. Compare it against '
        + 'the meta you are about to write: a key in the contract with no value is a gap, and a key you wrote '
        + 'that appears nowhere in it is usually a typo.\n\n'
        + 'Check references.contract.complete before trusting a comparison. When false, some branch could not be '
        + 'read and references.contract.incomplete names each one with a reason.\n\n'
        + 'Also returns the template source, sample entities targeting the layout, and both reference views: '
        + 'runtime (what recent renders actually touched) and static (what the source mentions, including '
        + 'branches no render has taken).',
        {
            id: z.string().describe('Layout id, e.g. "/layouts/reports/royalty.html-pdf.liquid". Use mikser_query_entities with { collection: "layouts" } to discover ids.'),
            samples: z.number().int().min(0).max(10).optional().describe('How many existing entities currently using this layout to include as data-shape examples. Default 3. Only entities with explicit meta.layout match; auto-matched layouts are not surfaced.'),
        },
        async ({ id, samples = 3 }) => {
            try {
                const result = await runtime.options.layouts.inspect(id, { samples })
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            ...result,
                            notes: [
                                'references.contract is the one to read first: the whole layout tree walked, with partial arguments and renamings resolved, so `meta` lists document keys in the form a document writes them. `[]` marks an element — `hero.tags[].label` means each tag has a label, not that the list does.',
                                'references.contract.complete is false when any branch could not be read, and `incomplete` names each with a reason. An incomplete contract is still useful, but a key missing from it may only be missing because that branch was unreadable — do not treat absence as proof.',
                                'references.contract covers TEMPLATES. A layout sidecar is plain JavaScript and cannot be parsed, so a key only it reads will not appear there — look in references.runtime.metaReads instead.',
                                'references.runtime.metaReads is what renders actually READ, sidecars included, unioned across the samples. It sees a sidecar the contract cannot; it does not see a branch no sample took. The two are complements, not alternatives.',
                                'references.runtime is the precise answer from manifest snapshots — what the renderer actually touched in recent renders. Empty if the layout has never rendered.',
                                'references.static is the renderer-plugin walk of THIS FILE only, in this file\'s own vocabulary. references.contract is the same walk followed across every partial and resolved into the author\'s. Prefer the contract.',
                                'samples only includes entities with explicit meta.layout. Auto-matched layouts are not listed; use mikser_query_entities with a filename-pattern filter for those.',
                            ],
                        }, null, 2),
                    }],
                }
            } catch (err) {
                logger.error('MCP mikser_layouts_inspect error: %s', err.message)
                return {
                    isError: true,
                    content: [{ type: 'text', text: err.message }],
                }
            }
        },
    )

    registerCheckTool({ runtime, findEntity, findEntities, useDatabase, collection, logger })

    logger.debug('MCP tool registered: mikser_layouts_inspect (layouts plugin)')
}

// Meta keys the ENGINE owns. They appear on documents, are consumed by mikser
// itself rather than by any layout, and would otherwise be reported as unused on
// every entity — noise that teaches a reader to ignore the list.
const ENGINE_KEYS = new Set([
    'layout', 'layouts', 'task', 'destination', 'format', 'template', 'href',
    'lang', 'url', 'pages', 'parent', 'plugins', 'presets', 'refs', 'date',
    'draft', 'stamp', 'postprocessor',
])

// A document's meta in the same vocabulary a layout contract uses: dotted
// paths, with `[]` for "each element of" rather than an index. Both sides have
// to speak it or the comparison is meaningless.
function flattenMeta(value, prefix, out) {
    if (value === null || typeof value !== 'object') return out
    if (Array.isArray(value)) {
        // One `[]` for the whole array: the contract says "each tag has a
        // label", never "tag 7 has a label", so element shapes are merged.
        if (value.length) out.add(`${prefix}[]`)
        for (const item of value) flattenMeta(item, `${prefix}[]`, out)
        return out
    }
    for (const [k, v] of Object.entries(value)) {
        const path = prefix ? `${prefix}.${k}` : k
        out.add(path)
        flattenMeta(v, path, out)
    }
    return out
}

// Observed reads carry the prefix of where they were seen — `meta.` for the
// document's own keys as a sidecar read them, `data.meta.` for what a template
// read. Both describe the same document, so both reduce to the bare key.
const bareKey = (p) => p.replace(/^[A-Za-z_$][\w$]*\.meta\./, '').replace(/^meta\./, '')

// Edit distance, capped: only used to ask "did they mean this one", so anything
// past a couple of edits is not a typo and the answer stops mattering.
function distance(a, b) {
    if (Math.abs(a.length - b.length) > 3) return 99
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i)
    for (let i = 1; i <= a.length; i++) {
        let last = prev[0]
        prev[0] = i
        for (let j = 1; j <= b.length; j++) {
            const tmp = prev[j]
            prev[j] = Math.min(
                prev[j] + 1,
                prev[j - 1] + 1,
                last + (a[i - 1] === b[j - 1] ? 0 : 1),
            )
            last = tmp
        }
    }
    return prev[b.length]
}

export function registerCheckTool({ runtime, findEntity, findEntities, useDatabase, collection, logger }) {
    const mcp = runtime.options.mcp

    // Which layout this entity ACTUALLY rendered with, taken from its most
    // recent snapshot rather than predicted.
    //
    // Layout selection has three mechanisms — declared meta.layout, a match
    // pattern, and the auto-layout peel ladder — and re-deriving them here
    // would be a second implementation to keep in step with the first. The
    // manifest already recorded the answer.
    const layoutFromSnapshot = (id) => {
        const db = useDatabase?.()
        if (!db?.handle) return null
        const row = db.handle.prepare(
            'SELECT refClosure FROM mikser_snapshots WHERE id = ? ORDER BY renderedAt DESC LIMIT 1',
        ).get(id)
        if (!row?.refClosure) return null
        try {
            return JSON.parse(row.refClosure).find(e => e.kind === 'layout')?.target ?? null
        } catch { return null }
    }

    const readsFromSnapshot = (id) => {
        const db = useDatabase?.()
        if (!db?.handle) return []
        const row = db.handle.prepare(
            'SELECT metaReads FROM mikser_snapshots WHERE id = ? ORDER BY renderedAt DESC LIMIT 1',
        ).get(id)
        if (!row?.metaReads) return []
        try { return JSON.parse(row.metaReads) } catch { return [] }
    }

    mcp.simpleTool(
        'mikser_check_entity',
        'Check a document against the contract of the layout that renders it, BEFORE the mistake ships.\n\n'
        + 'A mistyped key does not fail a build. The section it named simply does not render, the page goes out '
        + 'with a hole in it, and every signal reads clean. This is the check that catches it: what the layout '
        + 'tree needs, against what the document actually provides.\n\n'
        + 'Read `missing` first — keys the layout consumes that this document has no value for. Then '
        + '`likelyTypos`, which pairs a key you wrote against a key the layout wanted that is one or two edits '
        + 'away; a typo usually shows up as both at once, which is a far stronger signal than either alone.\n\n'
        + '`unused` is weaker evidence and says so: another layout may consume the key, and keys the engine '
        + 'itself owns are excluded. Treat it as a prompt to look, not a defect.\n\n'
        + 'Check `reliable` before trusting an absence. When false, some branch of the layout could not be read '
        + 'or the document has never rendered, and a key may be missing from the analysis rather than from the '
        + 'document.',
        {
            id: z.string().describe('Entity id, e.g. "/documents/en/index.md".'),
            layout: z.string().optional()
                .describe('Layout id to check against. Omit to use the layout this entity last rendered with, '
                    + 'which is what the manifest recorded rather than a prediction.'),
        },
        async ({ id, layout }) => {
            const entity = await findEntity({ id })
            if (!entity) {
                return { isError: true, content: [{ type: 'text', text:
                    `No entity ${JSON.stringify(id)}. Use mikser_query_entities to find its id.` }] }
            }

            // Resolve the layout: explicit, then what it rendered with, then
            // what it asked for. Each fallback is weaker, and which one was
            // used is reported so the caller can judge.
            let layoutId = layout ?? layoutFromSnapshot(id)
            let source = layout ? 'given' : (layoutId ? 'last render' : null)
            if (!layoutId && entity.meta?.layout) {
                const named = (await findEntities({ name: entity.meta.layout })) ?? []
                layoutId = named.find(e => e.collection === collection)?.id ?? null
                source = layoutId ? 'meta.layout' : null
            }
            if (!layoutId) {
                return { isError: true, content: [{ type: 'text', text:
                    `Cannot tell which layout renders ${id}: it has never rendered and declares no meta.layout. `
                    + 'Pass `layout` explicitly, or build once so the manifest records it.' }] }
            }

            const inspected = await runtime.options.layouts.inspect(layoutId, { samples: 0 })
            const contract = inspected.references?.contract ?? { meta: [], complete: false, incomplete: [] }

            // Consumed is the UNION of both halves, and it has to be: the
            // contract is blind to a sidecar (plain JavaScript, nothing to
            // parse) and the observed reads are blind to a branch this document
            // never took. Using either alone reports keys as unused that are
            // demonstrably read.
            const observed = readsFromSnapshot(id).map(bareKey)
            const consumed = new Set([...(contract.meta ?? []), ...observed])
            const provided = flattenMeta(entity.meta ?? {}, '', new Set())

            const isUsed = (key) => consumed.has(key)
                // A parent is used when anything under it is: a document
                // providing `hero` for a layout that reads `hero.title` has not
                // provided a spare key.
                || [...consumed].some(c => c.startsWith(`${key}.`) || c.startsWith(`${key}[`))
            const isProvided = (key) => provided.has(key)
                // And the reverse: a layout reading `hero.tags[]` is satisfied
                // by a document that provided the array.
                || [...provided].some(p => p.startsWith(`${key}.`) || p.startsWith(`${key}[`))

            const missing = [...consumed].filter(k => k && !isProvided(k)).sort()
            const unused = [...provided]
                .filter(k => !isUsed(k))
                .filter(k => !ENGINE_KEYS.has(k.split('.')[0].replace(/\[\]$/, '')))
                .sort()

            // The pair. A mistyped key leaves a hole where the real key was
            // wanted AND a stray key nothing reads, so matching one list
            // against the other turns two weak signals into one strong one.
            const likelyTypos = []
            for (const wrote of unused) {
                let best = null
                for (const wanted of missing) {
                    const d = distance(wrote, wanted)
                    if (d > 0 && d <= 2 && (!best || d < best.distance)) best = { meant: wanted, distance: d }
                }
                if (best) likelyTypos.push({ wrote, ...best })
            }

            const reliable = contract.complete === true && observed.length > 0
            return {
                content: [{ type: 'text', text: JSON.stringify({
                    entity: id,
                    layout: layoutId,
                    layoutFrom: source,
                    reliable,
                    missing,
                    likelyTypos,
                    unused,
                    counts: { consumed: consumed.size, provided: provided.size,
                              missing: missing.length, unused: unused.length },
                    contract: { complete: contract.complete, incomplete: contract.incomplete ?? [] },
                    observedReads: observed.length,
                    notes: [
                        'missing is the strong signal: the layout consumes the key and this document has no value for it.',
                        'likelyTypos pairs an unused key against a missing one within two edits. A real typo usually produces both, which is why the pair is worth more than either list.',
                        'unused is weak evidence. A key may be consumed by a DIFFERENT layout — a card rendered on a listing page is the common case — and keys the engine owns (href, lang, layout, task, ...) are excluded outright.',
                        'reliable is false when the contract could not be fully read, or when this entity has never rendered so nothing was observed. An absence is only evidence when reliable is true.',
                        'Coverage is the union of what the layout templates read (the contract) and what renders actually read (observed, which includes sidecars). Neither sees everything alone.',
                    ],
                }, null, 2) }],
            }
        },
    )

    logger.debug('MCP tool registered: mikser_check_entity (layouts plugin)')
}
