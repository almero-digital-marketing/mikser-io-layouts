// Layout assignment (the matching half of the plugin).
//
// onProcessed fires once per cycle. For every CREATE/UPDATE entity in
// the journal that's NOT a layout itself, we figure out which layouts
// should render it and stash the result in `entity.layouts` (canonical
// multi-match) + `entity.layout` (back-compat alias).
//
// Three resolution paths, in priority:
//   1. Author declared (`meta.layout` string OR `meta.layouts` array
//      — dual key, mutually exclusive).
//   2. options.match pattern hits → multi-match, every matching
//      pattern contributes a layout.
//   3. options.autoLayouts → the peel-ladder fallback (first-wins,
//      single match by design).
//
// onProcessed runs BEFORE onBeforeRender; the layout snapshot stored
// on entity.layouts here may go stale by render time (frontmatter
// mutations during onPersist or sidecar load). The assembly phase
// (lib/assembly.js) re-fetches each layout via findEntity to recover.

import path from 'node:path'

import _ from 'lodash'
import { primaryDestination } from './destination.js'
import { isFullCycle } from 'mikser-io'

export function createOnProcessed({
    runtime, useLogger, useJournal,
    findEntity, matchEntity, collection,
    OPERATION,
    options,
}) {
    // A `match` pattern that selects nothing is silent — no warn, no debug —
    // and the build goes green with those pages simply absent. The patterns
    // run against entity.name, so on a localized site they carry real content
    // ('@/*/{aparati,devices}/index'); adding a language means adding its
    // segment, and missing one loses a whole section while the other
    // languages still look right.
    //
    // Tallied across the process, reported once. Same reasoning as the
    // assets-preset case in core: a deliberate declaration that selected
    // nothing is essentially always a mistake, and it is exactly what the
    // author cannot see.
    const matchTally = { evaluated: 0, hit: new Set(), reported: false }

    // Patterns a LAYOUT declared for itself in its own front-matter, seen
    // during the run. Recorded here rather than derived at report time
    // because by then the cycle's resolved-layout reads are gone, and a
    // layout deleted mid-run should not be reported as a dud pattern.
    const declaredSeen = new Map()

    // A pattern's identity for the tally. The same glob can legitimately
    // appear in config and in a layout's front-matter; they are different
    // rules and either can be the dead one.
    const tallyKey = (pattern, layoutName) =>
        layoutName ? `layout:${layoutName}:${pattern}` : `config:${pattern}`

    function reportUnmatchedPatterns(logger) {
        if (matchTally.reported) return
        const patterns = [
            ...Object.keys(options.match || {}).map(pattern =>
                ({ pattern, layout: options.match[pattern], source: null })),
            ...Array.from(declaredSeen.values()),
        ]
        if (!patterns.length || !matchTally.evaluated) return
        // Only when the cycle evaluated everything. An incremental run
        // re-evaluates whatever changed, so a healthy pattern matches none of
        // the two entities in a settled build — and a warning that fires on
        // every build is one the reader filters, which takes the real
        // instance with it. The message already pointed at --force to check
        // the whole catalog; that is the condition, not a footnote.
        if (!isFullCycle(runtime)) return
        matchTally.reported = true

        for (const { pattern, layout: layoutName, source } of patterns) {
            if (matchTally.hit.has(tallyKey(pattern, source))) continue
            // Phrased as what was observed: an incremental cycle only
            // re-evaluates changed entities, so a pattern can legitimately
            // match nothing in a run of three. The count lets the reader
            // tell that apart from a typo.
            // The name/id rule is the thing people get wrong, and it is not
            // what it looks like: matchEntity() globs entity.name ONLY for a
            // pattern beginning '@/' — every other pattern globs entity.id,
            // which carries the '/<collection>/' prefix and the extension.
            // So 'post' does NOT match a document named 'post'; '@/post' and
            // '/documents/post.md' both do.
            const onName = pattern.startsWith('@/')
            // Where the pattern is written decides where the fix goes, and
            // the two places look nothing alike. Without this the reader of
            // a front-matter typo goes hunting through the config.
            const declaredIn = source ? ` declared in layouts/${source}` : ''
            logger.warn(
                { code: 'layout-pattern-no-match', pattern, layout: layoutName,
                  declaredIn: source || 'layouts.match',
                  evaluated: matchTally.evaluated, matchedAgainst: onName ? 'name' : 'id' },
                'Layout pattern %j (→ %j)%s matched none of the %d entities evaluated. ' +
                'It is matched against entity.%s%s.',
                pattern, layoutName, declaredIn, matchTally.evaluated,
                onName ? 'name' : 'id',
                onName ? '' : " — prefix a pattern with '@/' to match entity.name instead, " +
                             'since an id looks like /<collection>/<name>.<ext>')
        }
    }

    return async function onProcessedHandler(signal) {
        const logger = useLogger()
        const { layouts } = runtime.state.layouts

        // Resolve a layout name to the catalog entity (post-front-matter
        // strip) rather than the state-map entry (raw file bytes). The
        // state map is just an index — it's populated at sync time with
        // whatever readLayoutContent returned, before front-matter has
        // had a chance to lift YAML attributes into meta and strip them
        // from content. Attaching the raw state-map entry as
        // entity.layout makes the renderer emit YAML verbatim into the
        // rendered output (visible bug surfaced via MCP-UI previews).
        //
        // Catalog is the single source of truth for content; state map
        // is just the name → id lookup. Falls back to the state entry
        // only when the catalog hasn't caught up (sync races, synthetic
        // test setups where front-matter hasn't been wired).
        async function resolveLayout(name) {
            const stateEntry = layouts[name]
            if (!stateEntry) return undefined
            return (await findEntity({ id: stateEntry.id })) || stateEntry
        }

        // `match:` in a layout's own front-matter — the colocated twin of a
        // `layouts({ match: … })` rule, and documented alongside
        // `destination:` since before either worked. `destination` was
        // implemented; this was not, and a layout carrying it matched
        // nothing, logged nothing, and looked configured. Reported after it
        // cost a consumer the longest detour of their session.
        //
        // Read through resolveLayout for the same reason destination is
        // (lib/assembly.js): the state map holds the file as synced, before
        // front-matter has been lifted into meta. The raw entry has no
        // `meta.match` to find.
        //
        // Built once per cycle rather than per entity: one findEntity per
        // layout over a 5-20 entry map is nothing, the same work repeated
        // for every document in the catalog is not.
        let declaredPatterns = null
        async function layoutDeclaredPatterns() {
            if (declaredPatterns) return declaredPatterns
            declaredPatterns = []
            for (const name of Object.keys(layouts)) {
                const declared = (await resolveLayout(name))?.meta?.match
                if (!declared) continue
                for (const pattern of Array.isArray(declared) ? declared : [declared]) {
                    if (typeof pattern !== 'string' || !pattern) {
                        logger.warn(
                            'Layout %j declares a non-string `match` (%j) — expected a glob, or an array of them.',
                            name, pattern)
                        continue
                    }
                    declaredPatterns.push({ pattern, layout: name, source: name })
                    declaredSeen.set(tallyKey(pattern, name), { pattern, layout: name, source: name })
                }
            }
            return declaredPatterns
        }

        // Resolve the set of layouts that should render `entity` this
        // cycle. Returns an array — empty if none matched. Rules:
        //   1. meta.layout (string) and meta.layouts (array) can't both
        //      be set; if both → throw, caught and logged below.
        //   2. Author-declared selection (meta.layout / meta.layouts)
        //      wins: every named layout is resolved; unknown names get
        //      a warning but don't break the rest.
        //   3. No author selection → multi-match across options.match
        //      patterns. Every matching pattern contributes a layout.
        //   4. No pattern matched AND options.autoLayouts → fall back
        //      to the existing peel ladder; first found wins (the
        //      ladder is a search-by-priority by design, not a list of
        //      independent matches).
        async function resolveLayoutsForEntity(entity) {
            if (entity.meta?.layout && entity.meta?.layouts) {
                throw new Error(
                    `Entity ${entity.id}: both 'meta.layout' and 'meta.layouts' are set — pick one.`
                )
            }
            const declared = Array.isArray(entity.meta?.layouts)
                ? entity.meta.layouts
                : entity.meta?.layout
                    ? [entity.meta.layout]
                    : null

            if (declared) {
                const resolved = []
                for (const name of declared) {
                    const layout = await resolveLayout(name)
                    if (layout) {
                        // meta.layout / meta.layouts in the document's own
                        // frontmatter. Labelled so --explain says the choice
                        // came from the content, not from config — which is
                        // where you would otherwise go looking.
                        if (!resolved.find(l => l.name === layout.name)) {
                            resolved.push({ ...layout, matchedBy: 'meta.layout' })
                        }
                    } else {
                        logger.warn('Layout not found for %s: %s', entity.collection, entity.id, name)
                    }
                }
                return resolved
            }

            // Multi-match over config patterns.
            const matched = []
            matchTally.evaluated++
            for (const pattern in options.match || []) {
                if (matchEntity(entity, pattern)) {
                    matchTally.hit.add(tallyKey(pattern, null))
                    const name = options.match[pattern]
                    const layout = await resolveLayout(name)
                    if (layout && !matched.find(l => l.name === layout.name)) {
                        // Record WHICH pattern claimed it. With several
                        // patterns able to match one entity, "why did this
                        // page get that layout" is otherwise only answerable
                        // by re-running the matcher by hand — and it is the
                        // question asked whenever the answer is surprising.
                        // Surfaced by `mikser --explain`.
                        matched.push({ ...layout, matchedBy: pattern })
                    }
                }
            }

            // Then the patterns each layout declared for itself. A peer of
            // the config rules, not a fallback: both are "a pattern claimed
            // this entity", and an entity legitimately matched by one of
            // each gets both layouts, exactly as two config patterns would.
            for (const { pattern, layout: name, source } of await layoutDeclaredPatterns()) {
                if (!matchEntity(entity, pattern)) continue
                matchTally.hit.add(tallyKey(pattern, source))
                const layout = await resolveLayout(name)
                if (layout && !matched.find(l => l.name === layout.name)) {
                    // Distinguishable from a config pattern in `--explain`:
                    // the same glob can be written in either place, and the
                    // fix goes to a different file depending on which.
                    matched.push({ ...layout, matchedBy: `${pattern} (layouts/${name})` })
                }
            }

            // Auto-layout: only as a fallback when no pattern matched.
            // The peel ladder is intentionally first-wins — it's a
            // most-specific-name search, not a multi-match.
            if (matched.length === 0 && options.autoLayouts && entity.id) {
                const lookupBase = entity.id.replace(`/${entity.collection}/`, '')
                const dir = path.dirname(lookupBase)
                const base = path.basename(lookupBase)
                const chunks = base.split('.')
                const candidates = []
                for (let i = chunks.length; i > 0; i--) {
                    const head = chunks.slice(0, i).join('.')
                    candidates.push(dir && dir !== '.' ? path.join(dir, head) : head)
                }
                const autoLayout = candidates.find(name => layouts[name])
                if (autoLayout) {
                    const layout = await resolveLayout(autoLayout)
                    // Labelled so `mikser --explain` can distinguish "a
                    // pattern you wrote chose this" from "the name happened
                    // to match a layout file" — a distinction that decides
                    // whether the fix is in the config or in a filename.
                    if (layout) matched.push({ ...layout, matchedBy: 'auto-layout' })
                    logger.debug('Auto layout matched %s -> %s for %s', entity.name, autoLayout, entity.id)
                } else {
                    logger.trace('Auto layout no match for %s tried: %s', entity.id, candidates.join(', '))
                }
            }

            return matched
        }

        for await (let { entity, operation } of useJournal('Layouts processing', [OPERATION.CREATE, OPERATION.UPDATE, OPERATION.DELETE], signal)) {
            if (entity.collection == collection) continue
            switch (operation) {
                case OPERATION.CREATE:
                case OPERATION.UPDATE:
                    let resolutionFailed = false
                    try {
                        entity.layouts = await resolveLayoutsForEntity(entity)
                    } catch (err) {
                        logger.error('Layout resolution for %s: %s', entity.id, err.message)
                        entity.layouts = []
                        resolutionFailed = true
                    }

                    // Whether the AUTHOR asked for a layout. Used further
                    // down to tell an abandoned page from a typo.
                    //
                    // Captured here, before the mirror below writes
                    // meta.layout for the pattern-matched and auto-layout
                    // paths, so the field still answers one question. Read
                    // after it, "the author named a layout" and "we recorded
                    // the one we chose" are the same value. That is a
                    // legibility choice, not a fix: the mirror only writes
                    // when a layout was found, so the `layouts.length === 0`
                    // term below already excludes every entity it touched.
                    const declaredALayout = Boolean(
                        entity.meta?.layout || entity.meta?.layouts?.length)
                    // Back-compat alias. Most existing downstream code
                    // reads `entity.layout`; keep it pointing at the
                    // first matched layout so it stays useful. The
                    // onBeforeRender task-build phase iterates
                    // entity.layouts and reassigns entity.layout per
                    // task to the layout being processed.
                    entity.layout = entity.layouts[0]

                    // Mirror the matched name(s) into meta so the
                    // catalog's `meta_layout` index can find this
                    // entity via "anything with a layout" queries.
                    // Author-declared cases already have meta.layout
                    // (or meta.layouts) set; this covers the
                    // pattern-match / auto-layout paths.
                    // Persist the primary destination.
                    //
                    // The primary destination has to be persisted, not just
                    // set per render task. runtime.href() needs the TARGET's
                    // destination to build a relative URL, and it reads the
                    // catalog: a destination that only ever exists on a
                    // task makes href() fall through and return the whole
                    // entity instead of { url }. The catalog is written only
                    // through the journal, and this hook is where that
                    // happens, so it is derived here.
                    //
                    // "Primary" means page 1 / the sole output of the FIRST
                    // matched layout — the same choice entity.layout already
                    // makes. Paginated pages 2..n keep their own per-task
                    // destinations; a single stored field cannot describe
                    // several outputs, and the one a link should point at is
                    // the first.
                    if (entity.layouts.length) {
                        try {
                            const destination = primaryDestination({
                                entity, layout: entity.layouts[0], options, endsWith: _.endsWith,
                            })
                            if (destination) entity.destination = destination
                        } catch (err) {
                            logger.warn('Destination for %s: %s', entity.id, err.message)
                        }
                    }

                    if (entity.layouts.length && !entity.meta?.layout && !entity.meta?.layouts) {
                        entity.meta = entity.meta || {}
                        if (entity.layouts.length === 1) {
                            entity.meta.layout = entity.layouts[0].name
                        } else {
                            entity.meta.layouts = entity.layouts.map(l => l.name)
                        }
                    }

                    // A render-requested entity (carries useRenderer's
                    // correlationId) that resolved to no layout will
                    // silently produce nothing — the caller just gets
                    // api.js's "did not complete". Surface the real
                    // reason here, where we authoritatively know no
                    // layout matched. Gated on correlationId so the
                    // thousands of normal layout-less content files
                    // stay quiet.
                    if (entity.layouts.length === 0 && entity.options?.correlationId) {
                        logger.warn(
                            'Render requested for %s but no layout matched — set meta.layout / meta.layouts, add a layouts.match rule, or name it to match a layout (auto-layout). Entities without a layout are not rendered.',
                            entity.id,
                        )
                    }

                    // Tell the manifest this entity produces nothing, so the
                    // snapshots it used to hold stop claiming files nobody
                    // writes any more.
                    //
                    // Take `layout:` out of a document's front matter and the
                    // page stayed on disk with a snapshot still vouching for
                    // it — and because the file still matched the hash its own
                    // render recorded, --audit-output read OK while the site
                    // served a page the source no longer asked for. The
                    // manifest cannot see this by itself: with no render task
                    // there is nothing to compare against, and an asset whose
                    // preset threw looks exactly the same from there. This
                    // hook is where it IS knowable, so this is where it is
                    // said.
                    //
                    // Only for an entity that declared nothing and matched
                    // nothing. The two excluded cases are both errors, and
                    // mikser keeps the last good output through an error
                    // rather than taking the page down:
                    //
                    //   declared but unresolvable — `layout: page` with no
                    //     `page` layout, already warned about by
                    //     resolveLayout. Renaming a layout file would
                    //     otherwise delete every page that names it, on the
                    //     strength of a typo.
                    //   resolution threw — meta.layout and meta.layouts both
                    //     set, say. Nothing was decided, so nothing follows.
                    //
                    // Optional-called: the peer floor is core ^11.1.0 and
                    // recordNoOutput is newer than that, so on an older
                    // engine this is simply the behaviour that came before.
                    if (entity.layouts.length === 0 && !declaredALayout && !resolutionFailed) {
                        runtime.manifest?.recordNoOutput?.(entity.id)
                    }

                    // meta.postprocessor (string) / meta.postprocessors
                    // (array) override is read at task-build time (in
                    // onBeforeRender) because the layout entity is
                    // re-fetched from the catalog there — any mutation
                    // we did to it here would be reverted by the
                    // refresh. We just sanity-check the dual key here
                    // so authors see the error early.
                    if (entity.meta?.postprocessor && entity.meta?.postprocessors) {
                        logger.error(
                            'Entity %s: both meta.postprocessor and meta.postprocessors set — pick one. The chain will fall back to the singular.',
                            entity.id,
                        )
                    }

                    if (entity.layouts.length) {
                        logger.debug('Layouts matched for %s (%d): %s',
                            entity.id, entity.layouts.length,
                            entity.layouts.map(l => l.name).join(', '))
                    } else if (entity.meta?.href) {
                        logger.trace('Layout missing for %s: %s', entity.collection, entity.id)
                    }
                    break
                case OPERATION.DELETE:
                    // Catalog DELETE is the sole source of truth for "this
                    // entity is no longer in the sitemap" — sitemap lives
                    // in the catalog (queried via meta_href), so the
                    // DELETE alone removes it.
                    break
            }
            // Any layout/meta mutation above is auto-persisted by the
            // useJournal generator when this for-body completes (the
            // generator JSON.stringifies the entity post-yield and
            // UPDATEs the row if it diverged from the original).
        }

        // After the journal is drained, so `evaluated` is the whole cycle.
        reportUnmatchedPatterns(logger)
    }
}
