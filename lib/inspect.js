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
    return async function inspect(id, { samples = 3, partials = null } = {}) {
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

        const contract = await buildContract({
            layout, templateSource, runtime, findEntities, collection,
            only: partials ? new Set(partials) : null,
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
                contract,
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
        SELECT destination, refClosure, metaReads, renderedAt, inputHash, outputHash
        FROM mikser_snapshots
        WHERE id = ?
        ORDER BY renderedAt DESC
        LIMIT 1
    `)

    const perSample = []
    // Union across samples. One document exercises one set of branches, so the
    // keys a layout needs are only visible across several of them — which is
    // also why this can never be a complete answer on its own, and why the
    // static closure sits beside it.
    const observed = new Set()
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
        let metaReads = []
        try {
            metaReads = row.metaReads ? JSON.parse(row.metaReads) : []
        } catch { /* same: an unreadable column is not worth throwing over */ }
        for (const path of metaReads) observed.add(path)
        perSample.push({
            entityId:   sample.id,
            destination: row.destination,
            renderedAt: row.renderedAt,
            inputHash:  row.inputHash,
            outputHash: row.outputHash,
            refClosure,
            metaReads,
        })
    }

    const everRendered = perSample.some(s => s.rendered !== false && s.refClosure)
    if (!everRendered) {
        return { available: false, reason: `No sample entity using "${layoutName}" has rendered yet` }
    }
    return {
        available: true,
        samples: perSample,
        // Meta keys these renders ACTUALLY read, union of the samples.
        //
        // The counterpart to references.contract, and deliberately not merged
        // with it: the contract says what the templates COULD read, this says
        // what was read. Only this one sees a sidecar, because a sidecar is
        // plain JavaScript; only the contract sees a branch no sample took.
        // Reported apart so a caller can tell which of the two it is trusting.
        metaReads: [...observed].sort(),
    }
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

// The contract of a layout AND everything it pulls in.
//
// `references.static` answers "what does this FILE mention", which is one file
// deep and in that file's own vocabulary. Neither is what an author needs. A
// page layout is mostly `{% include %}`, so its own file mentions almost
// nothing; and a section that opens `{% assign hero = data.meta.hero %}` then
// talks about `hero.tags`, which names nothing the author can write.
//
// So this walks the whole tree and rewrites every path back into the caller's
// terms. `hero.tags` inside sections/hero.liquid, reached through
// `{% render 'ui/tags', tags: hero.tags %}`, comes back out as
// `data.meta.hero.tags` — which IS the key in the document's front matter.
//
// Engine-agnostic by construction: it never looks at template syntax, only at
// what each renderer's own parseReferences() reports. An engine that exposes no
// parser contributes nothing and SAYS SO, in `incomplete`. A partial-looking
// contract reported as complete would be worse than no contract at all, which
// is the whole reason the caps below are reported rather than silently applied.
const MAX_DEPTH = 12
const MAX_TEMPLATES = 200

async function buildContract({ layout, templateSource, runtime, findEntities, collection, only }) {
    const consumes  = new Set()
    // Read only behind a guard, anywhere in the tree. Kept apart from
    // `consumes` so a caller can tell "the layout needs this" from "the layout
    // uses this if it is there" — the difference between a document being wrong
    // and a document being smaller.
    const optional  = new Set()
    const templates = []
    const incomplete = []
    const visited   = new Set()

    // A path rewritten through the substitutions in scope. Only the FIRST
    // segment can be an alias — `hero.tags` where `hero` is bound to
    // `data.meta.hero` is `data.meta.hero.tags`; the tail is property access on
    // whatever that resolved to and never needs rewriting.
    const resolve = (path, subs) => {
        if (!path) return path
        const [head, ...rest] = String(path).split('.')
        // The head may carry the element marker a parser adds for a loop
        // variable: `{% for t in tags %}{{ t.label }}` reports `tags[].label`.
        // The binding is keyed by the plain name, so the marker comes off for
        // the lookup and goes back on after it — otherwise every key read off
        // a loop item stops dead at the partial boundary, which is precisely
        // the hop this exists to cross.
        const isElement = head.endsWith('[]')
        const base = subs[isElement ? head.slice(0, -2) : head]
        if (!base) return path
        return [isElement ? `${base}[]` : base, ...rest].join('.')
    }

    const layoutNamed = async (name) => {
        const rows = (await findEntities({ name })) ?? []
        return rows.find(e => e.collection === collection) ?? null
    }

    async function walk(name, template, source, bindings, depth) {
        // Keyed by name AND bindings: one partial rendered with two different
        // arguments has two different contracts, and collapsing them would
        // lose one. Cyclic includes and runaway fan-out are bounded instead.
        const key = `${name}|${JSON.stringify(bindings)}`
        if (visited.has(key)) return
        if (depth > MAX_DEPTH) {
            incomplete.push({ template: name, reason: `include depth exceeded ${MAX_DEPTH}` })
            return
        }
        if (visited.size >= MAX_TEMPLATES) {
            incomplete.push({ template: name, reason: `stopped after ${MAX_TEMPLATES} templates` })
            return
        }
        visited.add(key)

        const renderer = runtime.renderers?.get(template)
        if (typeof renderer?.parseReferences !== 'function') {
            incomplete.push({
                template: name,
                reason: renderer
                    ? `renderer "${template}" exposes no parseReferences(), so nothing under it was read`
                    : `no renderer registered for template "${template}"`,
            })
            return
        }
        const parsed = safeParseReferences(renderer, source, template)
        if (!parsed.available || parsed.parseError) {
            incomplete.push({ template: name, reason: parsed.reason ?? `parse error: ${parsed.parseError}` })
            return
        }

        // Substitutions in scope: what this template was called with, then its
        // own assigns layered on top — an assign can refer to an argument, so
        // it is resolved against what is known so far.
        const subs = { ...bindings }
        for (const a of parsed.assigns ?? []) {
            if (a?.key && a.from) subs[a.key] = resolve(a.from, subs)
        }

        const resolved = []
        for (const v of parsed.variables ?? []) {
            const r = resolve(v, subs)
            consumes.add(r)
            resolved.push(r)
        }
        for (const v of parsed.optional ?? []) optional.add(resolve(v, subs))
        templates.push({ template: name, bindings, consumes: resolved.sort() })

        for (const p of parsed.partials ?? []) {
            // Engines that have not been taught to report arguments still
            // report NAMES, so the tree is still walked — just without the
            // bindings that make aliases resolvable.
            const isRich = p && typeof p === 'object'
            const partialName = isRich ? p.name : p
            if (!partialName) continue

            // A partial that shares the caller's scope starts from it. In
            // liquid that is `include` (as against `render`), and in handlebars
            // every partial — the registry pattern depends on it, since the
            // section name it dispatches on lives in the caller's loop.
            // Inherited partials start from the scope they were included in,
            // resolved through this template's own substitutions first.
            const childBindings = {}
            if (isRich && p.inherits) {
                for (const [name, path] of Object.entries(p.scope ?? {})) {
                    childBindings[name] = resolve(path, subs)
                }
            }
            if (isRich) {
                for (const [arg, path] of Object.entries(p.args ?? {})) {
                    childBindings[arg] = resolve(path, subs)
                }
                for (const alias of p.aliases ?? []) {
                    if (alias?.to && alias.from) childBindings[alias.to] = resolve(alias.from, subs)
                }
            } else {
                incomplete.push({
                    template: partialName,
                    reason: `renderer "${template}" reports partial names but not their arguments, `
                        + 'so anything reached through an argument is unresolved',
                })
            }

            const entity = await layoutNamed(partialName)
            if (!entity) {
                incomplete.push({ template: partialName, reason: 'no layout entity has this name' })
                continue
            }
            // Scoped to what a particular render actually pulled in.
            //
            // A page layout that dispatches sections through a registry
            // resolves STATICALLY to every section template in the project,
            // because the `case` has a branch for each. Unscoped, the contract
            // for a two-section page is the union of the whole catalogue and a
            // real omission is one line in three hundred.
            //
            // The manifest already recorded which partials each render used, so
            // the scope is observed rather than guessed. Skipping is silent by
            // design: a branch this render did not take is not a gap in the
            // contract, it is a part of the layout that does not apply.
            if (only && !only.has(entity.id)) continue
            let childSource
            try {
                childSource = await readFile(entity.uri, 'utf8')
            } catch (err) {
                incomplete.push({ template: partialName, reason: `unreadable (${entity.uri}): ${err.message}` })
                continue
            }
            await walk(partialName, entity.template, childSource, childBindings, depth + 1)
        }
    }

    await walk(layout.name, layout.template, templateSource, {}, 0)

    // The subset an author actually writes. Everything else in `consumes` is
    // render-time furniture — helpers, loop variables, plugin surfaces — and
    // is kept, but it is not what a document's front matter is checked against.
    // Entity meta, whichever root binding reached it.
    //
    // A template can arrive at the same keys by more than one name: `data` is
    // whatever a layout sidecar returned, and the entity is ALSO bound under
    // its own type, so `document.meta.title` and `data.meta.title` are the same
    // document key. Matching only `data.` was lmed-shaped — a project with no
    // sidecar writes `document.meta.` and would have got an empty contract,
    // which reads exactly like a layout that needs nothing.
    const META_ROOT = /^[A-Za-z_$][\w$]*\.meta\./
    const strip = (p) => (META_ROOT.test(p) ? p.replace(META_ROOT, '') : (p.startsWith('meta.') ? p.slice(5) : null))
    const meta = [...consumes]
        .map(p => (META_ROOT.test(p) ? p.replace(META_ROOT, '') : (p.startsWith('meta.') ? p.slice(5) : null)))
        .filter(Boolean)

    return {
        available: true,
        // What the walk was allowed to reach. Null means the whole layout tree
        // — every branch of every dispatch — which answers "what COULD this
        // layout read" rather than "what does this page read".
        scopedTo: only ? [...only].sort() : null,
        // False whenever ANY branch could not be read. A contract that looks
        // complete but silently omits a partial is the failure this exists to
        // prevent, so the flag leads and the reasons are named.
        complete: incomplete.length === 0,
        meta: [...new Set(meta)].sort(),
        // The subset of `meta` a layout guards. A document missing one of these
        // is not wrong — the template was written to work without it.
        optionalMeta: [...new Set([...optional].map(strip).filter(Boolean))].sort(),
        consumes: [...consumes].sort(),
        templates,
        incomplete,
    }
}
