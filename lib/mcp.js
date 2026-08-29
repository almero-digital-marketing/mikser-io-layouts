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

    const ok = (data) => ({ content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] })

    // One read of the entity's most recent snapshot. Everything this tool knows
    // about what actually happened comes from here.
    const snapshotOf = (id) => {
        const db = useDatabase?.()
        if (!db?.handle) return null
        try {
            return db.handle.prepare(
                'SELECT refClosure, metaReads FROM mikser_snapshots WHERE id = ? ORDER BY renderedAt DESC LIMIT 1',
            ).get(id) ?? null
        } catch {
            // A catalog written before metaReads existed. The static half of
            // the contract still works; only the observed half is absent, which
            // `reliable` already accounts for.
            return db.handle.prepare(
                'SELECT refClosure FROM mikser_snapshots WHERE id = ? ORDER BY renderedAt DESC LIMIT 1',
            ).get(id) ?? null
        }
    }
    const parse = (json, fallback) => { try { return json ? JSON.parse(json) : fallback } catch { return fallback } }
    const edgesOf = (snap) => parse(snap?.refClosure, [])
    const readsOf = (snap) => parse(snap?.metaReads, [])

    // What every render read OFF this entity, and who read it.
    //
    // The contract for a document that never renders. `metaReads` answers "what
    // did rendering THIS entity read"; this answers it from the other side —
    // what does anything need FROM it — which is the only sense in which a data
    // document has a contract at all.
    const consumedContractOf = (id) => {
        const db = useDatabase?.()
        if (!db?.handle) return { keys: [], by: [] }
        let rows = []
        try {
            rows = db.handle.prepare(
                'SELECT id, consumedReads FROM mikser_snapshots WHERE consumedReads IS NOT NULL',
            ).all()
        } catch { return { keys: [], by: [] } }   // catalog predates the column
        const keys = new Set(); const by = new Set()
        for (const row of rows) {
            for (const [cid, paths] of parse(row.consumedReads, [])) {
                if (cid !== id) continue
                by.add(row.id)
                for (const path of paths) keys.add(path)
            }
        }
        return { keys: [...keys].sort(), by: [...by].sort() }
    }

    // Compare what is consumed against what a document provides. Shared, so a
    // data document is held to the same standard as a page — the only
    // difference is where its contract came from.
    const compare = (entity, consumedSet, optionalSet) => {
        const provided = flattenMeta(entity.meta ?? {}, '', new Set())
        const isUsed = (k) => consumedSet.has(k)
            || [...consumedSet].some(c => c.startsWith(`${k}.`) || c.startsWith(`${k}[`))
        const isProvided = (k) => provided.has(k)
            || [...provided].some(x => x.startsWith(`${k}.`) || x.startsWith(`${k}[`))
        const isOptional = (k) => optionalSet.has(k)
            || [...optionalSet].some(o => k.startsWith(`${o}.`) || k.startsWith(`${o}[`))
        const absent = [...consumedSet].filter(k => k && !isProvided(k))
        const missing = absent.filter(k => !isOptional(k)).sort()
        const missingOptional = absent.filter(isOptional).sort()
        const candidates = [...provided]
            .filter(k => !isUsed(k))
            .filter(k => !ENGINE_KEYS.has(k.split('.')[0].replace(/\[\]$/, '')))
            .sort()

        // "The parent was read, and every child looks unused" is the signature
        // of a read this engine cannot follow, not of dead data.
        //
        // Provenance is recorded where a value is READ off an entity. When that
        // value is then handed on — a sidecar returning it to a template — the
        // context carrying it is journaled as JSON in between, so the recording
        // view does not survive and only the top-level access was ever seen. A
        // form built from `enquiry.fields` shows `enquiry` consumed and every
        // field beneath it apparently unused, on pages that visibly render it.
        //
        // Reporting those as unused is worse than saying nothing: someone
        // acting on the list deletes a working form. They are collapsed under
        // the ancestor that WAS read, and named for what they are — untraceable.
        // Only when the ancestor was read and NOTHING under it was — "parent
        // consumed, every child unused" is the signature.
        //
        // If any sibling IS consumed, the engine can evidently see inside that
        // structure, so a key nobody read is real evidence and must stay in
        // `unused`. Without this the safeguard would swallow the strongest
        // signal the tool has: a typo like `hero.subtitile` sits under `hero`,
        // which is certainly consumed.
        const blind = (ancestor) => ![...consumedSet].some(c =>
            c.startsWith(`${ancestor}.`) || c.startsWith(`${ancestor}[`))
        const ancestorRead = (key) => {
            let p = key
            while (true) {
                if (p.endsWith('[]')) p = p.slice(0, -2)
                else if (p.includes('.')) p = p.replace(/\.[^.]+$/, '')
                else return null
                if (!p) return null
                if (consumedSet.has(p)) return blind(p) ? p : null
            }
        }
        const unused = []
        const byAncestor = new Map()
        for (const key of candidates) {
            const under = ancestorRead(key)
            if (!under) { unused.push(key); continue }
            if (!byAncestor.has(under)) byAncestor.set(under, [])
            byAncestor.get(under).push(key)
        }
        const untraceable = [...byAncestor]
            .map(([under, keys]) => ({ under, keys: keys.sort() }))
            .sort((a, b) => a.under.localeCompare(b.under))
        const likelyTypos = []
        for (const wrote of unused) {
            let best = null
            for (const wanted of [...missing, ...missingOptional]) {
                const d = distance(wrote, wanted)
                if (d > 0 && d <= 2 && (!best || d < best.distance)) best = { meant: wanted, distance: d }
            }
            if (best) likelyTypos.push({ wrote, ...best })
        }
        return { provided, missing, missingOptional, unused, untraceable, likelyTypos }
    }


    // Which renders pulled this entity in through a catalog query.
    //
    // The manifest recorded the FILTER each render ran, and matching an entity
    // against those filters is exactly what invalidation already does — so this
    // reuses queryAffected rather than inventing a second matcher that would
    // drift from it. Observed, not guessed.
    const consumersOf = (entity) => {
        try {
            const affected = runtime.manifest?.queryAffected?.(new Map([[entity.id, entity]]))
            return [...(affected ?? [])].filter(cid => cid !== entity.id).sort()
        } catch { return [] }
    }

    mcp.simpleTool(
        'mikser_check_entity',
        'Check a document against the contract of the layout that renders it, BEFORE the mistake ships.\n\n'
        + 'A mistyped key does not fail a build. The section it named simply does not render, the page goes out '
        + 'with a hole in it, and every signal reads clean. This is the check that catches it.\n\n'
        + 'It classifies the entity first, because not every document is a page. `kind` is one of:\n'
        + '  page   — renders through a layout; checked against that layout\'s contract.\n'
        + '  data   — never renders, but other entities pull it in through a query. Reports who consumes it. '
        + 'A missing key here surfaces as a hole in THOSE pages, not in this file, and no amount of building '
        + 'will make it render.\n'
        + '  unreferenced — never renders and nothing in the catalog reads it. Not an error: the catalog is '
        + 'readable over the API, so an external consumer may depend on it.\n\n'
        + 'For a page, read `missing` first — keys the layout consumes UNCONDITIONALLY that this document has '
        + 'no value for. That is the only list meaning "this is probably wrong". Then `likelyTypos`, which '
        + 'pairs a key you wrote against a key the layout wanted within two edits; a typo produces both at '
        + 'once, which is far stronger than either alone.\n\n'
        + 'Everything else means "you may want to look", never "this is broken": `missingOptional` is guarded '
        + 'by the layout and safe to omit, `unused` may be consumed by a different layout, and '
        + '`unresolvedSections` names a section that matched no template under this layout.\n\n'
        + 'The contract is scoped to the partials this entity ACTUALLY rendered with. Unscoped, a page using '
        + 'two of twenty sections would be checked against all twenty and a real omission would be one line in '
        + 'three hundred.\n\n'
        + 'Check `reliable` before trusting an absence.',
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

            const snap = snapshotOf(id)
            const renderedLayout = snap ? edgesOf(snap).find(e => e.kind === 'layout')?.target ?? null : null
            const usedPartials = snap ? edgesOf(snap).filter(e => e.kind === 'partial').map(e => e.target) : null
            const observed = readsOf(snap).map(bareKey)

            // WHAT KIND OF ENTITY IS THIS. Four answers, and they are not the
            // same question with different confidence — they are different
            // questions. Conflating them is how a data document that will never
            // render gets told to "build once".
            let layoutId = layout ?? renderedLayout
            let mode = layout ? 'given' : (renderedLayout ? 'rendered' : null)
            if (!layoutId && entity.meta?.layout) {
                const named = (await findEntities({ name: entity.meta.layout })) ?? []
                layoutId = named.find(e => e.collection === collection)?.id ?? null
                mode = layoutId ? 'declared' : null
            }

            if (!layoutId) {
                // Not a page. Before saying anything, find out whether anything
                // in the catalog pulls it in — the manifest recorded the query
                // filters every render ran, so this is observed, not guessed.
                const read = consumedContractOf(id)
                const consumers = read.by.length ? read.by : consumersOf(entity)
                if (consumers.length) {
                    // A real contract, from the other side: the keys renders
                    // actually took off this entity, held to the same standard
                    // as a page — same comparison, same lists.
                    const cmp = compare(entity, new Set(read.keys), new Set())
                    return ok({
                        entity: id, kind: 'data',
                        verdict: 'not a page — other entities consume it',
                        consumedBy: consumers,
                        checked: read.keys.length > 0,
                        reliable: read.keys.length > 0,
                        missing: cmp.missing,
                        likelyTypos: cmp.likelyTypos,
                        unused: cmp.unused,
                        untraceable: cmp.untraceable,
                        consumedKeys: read.keys,
                        counts: { consumedKeys: read.keys.length, provided: cmp.provided.size,
                                  missing: cmp.missing.length, unused: cmp.unused.length },
                        notes: [
                            `This entity never renders. ${consumers.length} render(s) pulled it in through a catalog query, so it is data, not a page — building will not make it appear.`,
                            read.keys.length
                                ? 'consumedKeys is what those renders actually READ off this entity. That is its contract: a key here with no value is a hole in the pages listed above, not in this file.'
                                : 'No key-level reads are recorded yet, so only the consumer list is known. Build once with a current mikser and the fields each render takes off this entity get recorded.',
                            'untraceable means an ancestor WAS read but the members could not be followed: the value was handed to a template and provenance does not survive that hop. Treat them as consumed.',
                            'unused here means no render took the key. It may still be served to an API client or another process, which this tool cannot see — mikser is not always a static site generator.',
                        ],
                    })
                }
                return ok({
                    entity: id, kind: 'unreferenced',
                    verdict: 'no contract could be derived',
                    checked: false,
                    notes: [
                        'This entity has never rendered, declares no meta.layout, and no render in the manifest queried it. Nothing in this project reads it.',
                        'That is not an error. The catalog is readable over the API, so another process or an external consumer may depend on it, and this tool cannot see them.',
                        'If it was MEANT to be a page, it matched no layout — check the layouts match patterns or set meta.layout.',
                    ],
                })
            }

            // Scoped to the partials this entity actually rendered with. A page
            // layout that dispatches sections through a registry resolves
            // statically to every section in the project, so an unscoped
            // contract for a two-section page is the union of the catalogue and
            // a real omission is one line in three hundred.
            const inspected = await runtime.options.layouts.inspect(layoutId, {
                samples: 0,
                partials: usedPartials && usedPartials.length ? usedPartials : null,
            })
            const contract = inspected.references?.contract ?? { meta: [], complete: false, incomplete: [] }
            const optional = new Set(contract.optionalMeta ?? [])

            const consumed = new Set([...(contract.meta ?? []), ...observed])
            // `missing` is the ONLY list that should read as "this is probably
            // wrong". A key the layout guards with `{% if %}` is one the layout
            // was written to work without, so it belongs in the softer list.
            const { provided, missing, missingOptional, unused, untraceable, likelyTypos } =
                compare(entity, consumed, optional)

            // A declared section that resolved to no template under this
            // layout. Weak evidence, reported apart from `missing` and never a
            // failure — but a page rendering with a silent hole produces no
            // signal at all today, and one line is the difference between
            // looking and not looking.
            const declared = Array.isArray(entity.meta?.sections) ? entity.meta.sections : []
            const rendered = new Set((usedPartials ?? []).map(p => p.split('/').pop().replace(/\.\w+$/, '')))
            const unresolvedSections = declared.filter(s => typeof s === 'string' && !rendered.has(s))

            const reliable = contract.complete === true && mode === 'rendered'
            return ok({
                entity: id,
                kind: 'page',
                layout: layoutId,
                layoutFrom: mode,
                reliable,
                missing,
                likelyTypos,
                missingOptional,
                unused,
                untraceable,
                unresolvedSections,
                counts: { consumed: consumed.size, provided: provided.size, missing: missing.length,
                          missingOptional: missingOptional.length, unused: unused.length },
                contract: { complete: contract.complete, incomplete: contract.incomplete ?? [],
                            scopedToPartials: usedPartials?.length ?? null },
                observedReads: observed.length,
                notes: [
                    'missing is the strong signal: the layout consumes the key unconditionally and this document has no value for it.',
                    'likelyTypos pairs an unused key against a wanted one within two edits. A real typo produces both, which is why the pair is worth more than either list.',
                    'missingOptional is NOT a defect. The layout guards these behind a condition, so it was written to work without them — they are listed only so a deliberate omission can be told from a forgotten one.',
                    'unresolvedSections named a section that resolved to no template under THIS layout. Weak evidence: the section may render under a different layout, its template may not be written yet, or the data may be consumed outside the SSG entirely — the catalog is readable over the API. It never fails a check.',
                    'untraceable is NOT a list of problems. An ancestor of each key WAS read, but the value was handed on — a sidecar returning it to a template — and provenance does not survive that hop, so the members could not be followed. Treat them as consumed unless you have another reason to doubt it.',
                    'unused is weak evidence too, and weakest of all where mikser is not a static site generator. A key may be consumed by a DIFFERENT layout, or by an API client reading the catalog over HTTP, or by another process entirely — none of which this tool can see. Engine-owned keys (href, lang, layout, task, ...) are excluded outright.',
                    'The contract is scoped to the partials this entity ACTUALLY rendered with, not to every branch the layout could take. Unscoped, a page that uses two of twenty sections is checked against all twenty.',
                    'reliable is false unless the contract was fully read AND this entity has rendered. An absence is only evidence when it is true.',
                ],
            })
        },
    )

    logger.debug('MCP tool registered: mikser_check_entity (layouts plugin)')
}
