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

export function createOnProcessed({
    runtime, useLogger, useJournal,
    findEntity, matchEntity, collection,
    OPERATION,
    options,
}) {
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
                        if (!resolved.find(l => l.name === layout.name)) resolved.push(layout)
                    } else {
                        logger.warn('Layout not found for %s: %s', entity.collection, entity.id, name)
                    }
                }
                return resolved
            }

            // Multi-match over config patterns.
            const matched = []
            for (const pattern in options.match || []) {
                if (matchEntity(entity, pattern)) {
                    const name = options.match[pattern]
                    const layout = await resolveLayout(name)
                    if (layout && !matched.find(l => l.name === layout.name)) {
                        matched.push(layout)
                    }
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
                    if (layout) matched.push(layout)
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
                    try {
                        entity.layouts = await resolveLayoutsForEntity(entity)
                    } catch (err) {
                        logger.error('Layout resolution for %s: %s', entity.id, err.message)
                        entity.layouts = []
                    }
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
    }
}
