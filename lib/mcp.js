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
    'draft', 'stamp', 'postprocessor', 'schema',
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

    // A DECLARED contract, walked out of a zod schema.
    //
    // This is the only source here that is engine-agnostic by construction. It
    // says nothing about liquid or handlebars, it needs no filter table, and it
    // states required-versus-optional outright instead of inferring it from
    // `{% if %}` guards and `| default:` filters — which is the same distinction
    // reconstructed by reading templates, and got wrong twice.
    //
    // Where a schema exists it therefore OUTRANKS anything read out of a
    // template, and the inferred contract is demoted to reporting drift.
    const zdef = (t) => t?._zod?.def ?? t?._def ?? {}
    function schemaKeys(type, prefix, required, optional, depth = 0) {
        const def = zdef(type)
        if (!def.type || depth > 12) return
        switch (def.type) {
            // A wrapper says the value beneath it may be absent; everything
            // under it inherits that, since a document omitting the parent
            // cannot be faulted for omitting its members.
            case 'optional':
            case 'nullable':
            case 'default':
                if (prefix) { required.delete(prefix); optional.add(prefix) }
                schemaKeys(def.innerType, prefix, required, new Set(), depth + 1)
                for (const k of collectAll(def.innerType, prefix, depth + 1)) optional.add(k)
                return
            case 'object':
                for (const [key, child] of Object.entries(def.shape ?? {})) {
                    const path = prefix ? `${prefix}.${key}` : key
                    const childDef = zdef(child)
                    const soft = ['optional', 'nullable', 'default'].includes(childDef.type)
                    ;(soft ? optional : required).add(path)
                    schemaKeys(child, path, required, optional, depth + 1)
                }
                return
            case 'array':
                // The element path is NOT added as a key of its own. Requiring
                // `tags[]` would claim the array must be non-empty, which no
                // schema said — an empty list is a valid `z.array()`.
                schemaKeys(def.element, `${prefix}[]`, required, optional, depth + 1)
                return
            default:
                return
        }
    }
    // Every path under a type, regardless of requiredness — used to mark a whole
    // optional subtree optional.
    function collectAll(type, prefix, depth = 0) {
        const req = new Set(); const opt = new Set()
        schemaKeys(type, prefix, req, opt, depth)
        return [...req, ...opt]
    }

    // How this record compares with its own kind.
    //
    // A layout contract answers "what does this template read". It cannot answer
    // "is this record complete AS A RECORD" — a catalog entry missing a field
    // its siblings all carry renders perfectly, reads nothing that is absent,
    // and passes every other check here. That is among the commonest content
    // defects and nothing else in this tool can see it.
    //
    // Deliberately weak evidence, and reported as such: records differ for good
    // reasons, and a document is not wrong for lacking what its neighbours have.
    // It is a prompt to look.
    //
    // Needs a real peer group. With one sibling "most of them" means nothing, so
    // below MIN_PEERS the comparison is not made rather than made badly.
    const MIN_PEERS = 3
    const PEER_SHARE = 0.7

    const declaredTypeOf = (entity) => {
        const key = runtime.options.schemasKey ?? runtime.options.schemaKey ?? 'meta.schema'
        return key.split('.').reduce((o, k) => o?.[k], entity) ?? entity?.meta?.schema ?? null
    }

    const peerGapsFor = async (entity) => {
        const type = declaredTypeOf(entity)
        if (!type) return null
        const key = runtime.options.schemasKey ?? runtime.options.schemaKey ?? 'meta.schema'
        const siblings = ((await findEntities({ [key]: type })) ?? [])
            .filter(e => e?.id && e.id !== entity.id && e.collection === entity.collection)
        if (siblings.length < MIN_PEERS) return null

        const counts = new Map()
        for (const peer of siblings) {
            for (const k of flattenMeta(peer.meta ?? {}, '', new Set())) {
                counts.set(k, (counts.get(k) ?? 0) + 1)
            }
        }
        const mine = flattenMeta(entity.meta ?? {}, '', new Set())
        const threshold = Math.ceil(siblings.length * PEER_SHARE)
        const gaps = [...counts]
            .filter(([k, c]) => c >= threshold && !mine.has(k))
            .filter(([k]) => !ENGINE_KEYS.has(k.split('.')[0].replace(/\[\]$/, '')))
            // A key whose PARENT this document also lacks is one finding, not
            // several: report `card`, not `card.order` and `card.wide` under it.
            .filter(([k]) => { const parent = k.replace(/\.[^.]+$|\[\]$/, ''); return parent === k || mine.has(parent) })
            .map(([key, count]) => ({ key, siblings: count, of: siblings.length }))
            .sort((a, b) => b.siblings - a.siblings || a.key.localeCompare(b.key))
        return { type, peers: siblings.length, gaps }
    }

    // The schema declared for this entity, if the schemas plugin is loaded and
    // the entity names one. `schemaKey` is the plugin's own config — commonly
    // `meta.layout`, so a layout and its schema share a name.
    const schemaFor = (entity) => {
        const api = runtime.options.schemas
        if (!api?.lookup) return null
        const key = runtime.options.schemasKey ?? runtime.options.schemaKey ?? 'meta.schema'
        const name = key.split('.').reduce((o, k) => o?.[k], entity)
            ?? entity?.meta?.schema ?? entity?.meta?.layout
        if (!name) return null
        const schema = api.lookup(name)
        return schema ? { name, schema } : null
    }

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
                    // A declared schema outranks consumer reads here for the
                    // same reason it does on a page: it says what the record
                    // must contain, where consumer reads only say what someone
                    // happened to look at. Without this a data document was the
                    // one kind that could not benefit from its own schema.
                    // Two questions, two comparisons — as on a page.
                    //
                    // `unused` and `untraceable` ask "does anything READ this",
                    // which only consumption answers. Running them against the
                    // schema instead reported keys as unread that the recorded
                    // reads plainly contain: a schema does not enumerate array
                    // elements, so every `x[]` in the document looked untouched.
                    const byReads = compare(entity, new Set(read.keys), new Set())
                    const declared = schemaFor(entity)
                    let cmp = byReads
                    if (declared) {
                        const req = new Set(); const opt = new Set()
                        schemaKeys(declared.schema, '', req, opt)
                        const bySchema = compare(entity, new Set([...req, ...opt]), opt)
                        // `missing` from the declaration, the rest from reality.
                        cmp = { ...byReads, missing: bySchema.missing,
                                missingOptional: bySchema.missingOptional }
                    }
                    // Matters most here: a data document is otherwise only
                    // checked against whatever its consumers happen to read, so
                    // a field every sibling carries and nobody reads yet is
                    // invisible.
                    const peers = await peerGapsFor(entity)
                    return ok({
                        entity: id, kind: 'data',
                        verdict: 'not a page — other entities consume it',
                        consumedBy: consumers,
                        checked: read.keys.length > 0,
                        reliable: read.keys.length > 0,
                        missingFrom: declared ? 'schema' : 'consumers',
                        missing: cmp.missing,
                        missingOptional: cmp.missingOptional,
                        likelyTypos: cmp.likelyTypos,
                        unused: cmp.unused,
                        untraceable: cmp.untraceable,
                        ...(peers?.gaps.length
                            ? { peerGaps: peers.gaps, peerGroup: { type: peers.type, peers: peers.peers } }
                            : {}),
                        consumedKeys: read.keys,
                        counts: { consumedKeys: read.keys.length, provided: cmp.provided.size,
                                  missing: cmp.missing.length, unused: cmp.unused.length },
                        notes: [
                            `Never renders — ${consumers.length} render(s) query it. Building will not make it appear, and a key it lacks shows up as a hole in those pages.`,
                            'missing: check missingFrom — "schema" is declared, "consumers" is only what someone happened to read off it.',
                            'Look, do not panic: consumedKeys (what renders actually took), peerGaps (most records of this type carry it), unused (may still be served to an API client), untraceable (an ancestor was read but its members could not be followed). None of these is a defect on its own.',
                        ],
                    })
                }
                // Nothing reads it, so nothing can say what it needs — except
                // its own kind. This is the one check available here, and the
                // only place in the tool where peer comparison is not merely
                // corroboration.
                const orphanPeers = await peerGapsFor(entity)
                return ok({
                    entity: id, kind: 'unreferenced',
                    verdict: 'no contract could be derived',
                    checked: false,
                    ...(orphanPeers?.gaps.length
                        ? { peerGaps: orphanPeers.gaps,
                            peerGroup: { type: orphanPeers.type, peers: orphanPeers.peers } }
                        : {}),
                    notes: [
                        'Never renders, declares no layout, and no render queried it. Not an error: the catalog is readable over the API, so a consumer outside this project may depend on it.',
                        ...(orphanPeers?.gaps.length
                            ? ['peerGaps is the only check possible here — nothing reads this entity, so only the other records of its type say anything about it.']
                            : []),
                        'If it was meant to be a page it matched no layout: check the layouts match patterns, or set meta.layout.',
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
            // `unused` always comes from what is CONSUMED — a key nothing reads
            // is the question there, and a schema does not answer it.
            const inferred = compare(entity, consumed, optional)
            const { provided, unused, untraceable, likelyTypos } = inferred

            // `missing` prefers the DECLARED contract. A schema states
            // required-versus-optional outright, needs no template parsing, and
            // is engine-agnostic by construction — where one exists, nothing
            // read out of a template should be able to call a document broken.
            const peerCheck = await peerGapsFor(entity)
            const declaredSchema = schemaFor(entity)
            let missing = inferred.missing
            let missingOptional = inferred.missingOptional
            let drift = null
            if (declaredSchema) {
                const req = new Set(); const opt = new Set()
                schemaKeys(declaredSchema.schema, '', req, opt)
                // Both sets are candidates: an absent OPTIONAL key still has
                // to be reported, in the softer list, or a schema's optionality
                // would silently drop it from the report altogether.
                const bySchema = compare(entity, new Set([...req, ...opt]), opt)
                missing = bySchema.missing
                missingOptional = bySchema.missingOptional
                // Where the two disagree, which is the drift the schemas plugin
                // exists to catch: a layout reading a key nobody declared, or a
                // declared key no layout reads.
                const knows = (k) => req.has(k) || opt.has(k)
                    || [...req, ...opt].some(d => d.startsWith(`${k}.`) || d.startsWith(`${k}[`))

                // `declaredButNotRead` asks whether a declared key is read by
                // ANY layout, so it is answered against the UNSCOPED contract —
                // the opposite of `missing`, which asks what THIS page needs.
                //
                // Scoped, a shorter edition of a page looked broken: every
                // section it does not use made the schema's keys for that
                // section look dead, and one such page reported 118 of them
                // while its longer sibling reported none. The document's only
                // difference was using fewer sections.
                const wide = await runtime.options.layouts.inspect(layoutId, { samples: 0 })
                const anyLayout = new Set([
                    ...(wide.references?.contract?.meta ?? []),
                    ...observed,
                ])
                const readAnywhere = (k) => anyLayout.has(k)
                    || [...anyLayout].some(c => c.startsWith(`${k}.`) || c.startsWith(`${k}[`))
                drift = {
                    schema: declaredSchema.name,
                    readButNotDeclared: [...consumed].filter(k => k && !knows(k)).sort(),
                    declaredButNotRead: [...req].filter(k => !readAnywhere(k)).sort(),
                }

                // And the same noise in the softer list: a key this page's
                // layout cannot reach is not an omission, it is not applicable.
                // Reporting 139 of them is the noise the scoping fix removed
                // from `missing`, arriving by another route.
                const reachable = (k) => consumed.has(k)
                    || [...consumed].some(c => c.startsWith(`${k}.`) || c.startsWith(`${k}[`))
                missingOptional = missingOptional.filter(reachable)
            }

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
                // Where `missing` came from, because the two are not equally
                // trustworthy and a caller acting on it deserves to know which
                // it has: 'schema' is declared, 'inferred' is read out of
                // templates and can be wrong.
                missingFrom: declaredSchema ? 'schema' : 'inferred',
                missing,
                likelyTypos,
                missingOptional,
                ...(drift ? { drift } : {}),
                unused,
                untraceable,
                ...(peerCheck?.gaps.length
                    ? { peerGaps: peerCheck.gaps, peerGroup: { type: peerCheck.type, peers: peerCheck.peers } }
                    : {}),
                unresolvedSections,
                counts: { consumed: consumed.size, provided: provided.size, missing: missing.length,
                          missingOptional: missingOptional.length, unused: unused.length },
                contract: { complete: contract.complete, incomplete: contract.incomplete ?? [],
                            scopedToPartials: usedPartials?.length ?? null },
                observedReads: observed.length,
                // One line per field, saying what to DO with it. These are
                // read on every call, so anything that is not actionable is
                // cost without value.
                notes: [
                    'missing: the layout needs it and this document has no value for it. Check missingFrom — "schema" is declared and authoritative, "inferred" is read from templates and is strong evidence rather than proof.',
                    'likelyTypos: a key you wrote paired with one the layout wanted, within two edits. A typo produces both, so the pair is worth more than either list.',
                    'Look, do not panic: missingOptional (guarded by the layout, safe to omit), unused (may be read by another layout or an API client), untraceable (an ancestor was read but its members could not be followed), unresolvedSections (matched no template here), peerGaps (most records of this type carry it). None of these is a defect on its own.',
                    'reliable: false means the contract had gaps or this entity has not rendered. An absence is only evidence when it is true.',
                ],
            })
        },
    )

    logger.debug('MCP tool registered: mikser_check_entity (layouts plugin)')
}
