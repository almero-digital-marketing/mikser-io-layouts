// Render-task assembly (the harder half of the plugin).
//
// onBeforeRender fires once per cycle, AFTER matching has stamped
// `entity.layouts` on each entity. Here we iterate the dispatch set,
// re-fetch each layout from the catalog (front-matter mutations can
// land between onProcessed and now), build the task envelope, resolve
// per-task destinations (default derivation or per-layout `destination:`
// Handlebars template), detect collisions, expand pagination, attach
// the postprocess chain, and stream tasks into the journal via
// renderEntities() in batches.
//
// Two dispatch sources, picked based on whether we have a refs graph:
//   - --force / no refs: stream layout-bearing entities from SQL,
//     hydrating one at a time. No full-catalog allocation.
//   - incremental: build seed list from the journal, walk
//     inverseClosureOf(seeds), union with opt-outs (meta.cache: 0)
//     and query-affected snapshots. Bounded by closure size, not
//     by catalog size.

import path from 'node:path'
import { existsSync } from 'node:fs'
import _ from 'lodash'
import {
    inputHashOf,
    createTrack,
    queryContext,
    useDatabase,
} from 'mikser-io'
import { compileDestinationTemplate, sanitizeDestination } from './destination.js'

export function createOnBeforeRender({
    runtime, useLogger, useJournal,
    findById, findEntity, findEntities,
    renderEntities,
    changeExtension,
    OPERATION, TASKS,
    options,
}) {
    return async function onBeforeRenderHandler(signal) {
        const logger = useLogger()
        const tasks = []

        // Batched journal flush. tasks accumulate across many entities
        // (sidecar load, pagination expansion), so cap the in-memory
        // queue at FLUSH_BATCH and write to the journal in chunks. At
        // 1M --force the prior shape held the full tasks list in heap
        // (~10GB); chunked flushing keeps peak constant regardless of
        // corpus. Each renderEntities call is one journal transaction;
        // multiple calls land sequentially before onRender fires.
        const FLUSH_BATCH = 1000
        async function maybeFlush() {
            if (tasks.length >= FLUSH_BATCH) {
                await renderEntities(tasks)
                tasks.length = 0
            }
        }

        // Async generator over the entities-to-dispatch. Two shapes
        // depending on path:
        //   - --force / no refs: stream layout-bearing ids from SQL
        //     (ORDER BY time DESC; one-at-a-time findById hydration;
        //     no entity-array materialization regardless of corpus)
        //   - incremental: build seeds + closure + opt-outs in JS
        //     (bounded by graph reachability; typically tens to
        //     hundreds), sort the small set, yield in order.
        async function* dispatchSource() {
            if (runtime.options.force || !runtime.refs?.inverseClosureOf) {
                // --force path. Project ids only — ~50B vs ~7KB per
                // full entity body, ~140× smaller. SQL ORDER BY time
                // DESC handles the sort we'd otherwise do JS-side.
                // findById hydrates each in turn; entities without a
                // resolved .layout (meta.layout was set but no layout
                // file matched) drop here.
                const db = useDatabase()
                const ids = db.prepare(`
                    SELECT id FROM mikser_entities
                    WHERE meta_layout IS NOT NULL
                    ORDER BY time DESC
                `).all().map(r => r.id)
                if (runtime.options.force) {
                    logger.debug('Force rebuild — streaming %d candidate entities', ids.length)
                }
                for (const id of ids) {
                    if (signal.aborted) return
                    const entity = findById(id)
                    if (entity?.layout) yield entity
                }
                return
            }

            // Incremental path. Build seed list from journal mutations,
            // walk refs.inverseClosureOf to get the dispatch ids, then
            // findById each one. Crucially: we do NOT materialize the
            // full layout-bearing slice of the catalog into heap. At
            // 110k entities that allocation was 800MB; this path is
            // bounded by closure size (typically 10s-100s on warm).
            //
            // Hash-aware seeding: drop CREATE/UPDATE entries whose
            // post-processing inputHash matches the last manifest
            // snapshot. Cold-start file discovery emits CREATE for
            // every file even when content didn't change — without
            // this filter, every restart would seed every entity and
            // the closure walk would expand to the whole catalog.
            // DELETE seeds always count.
            const recordedHashes = runtime.manifest?.recordedHashes() ?? new Map()

            const seenSeeds = new Set()
            const seeds = []
            for await (let { entity, operation } of useJournal(
                'Layouts dispatch',
                [OPERATION.CREATE, OPERATION.UPDATE, OPERATION.DELETE],
                signal,
            )) {
                if (!entity?.id || seenSeeds.has(entity.id)) continue
                if (operation === OPERATION.DELETE) {
                    seenSeeds.add(entity.id)
                    seeds.push(entity)
                    continue
                }
                const current = await findEntity({ id: entity.id }) ?? entity
                const priorHash = recordedHashes.get(current.id)
                if (priorHash && inputHashOf(current) === priorHash) continue
                seenSeeds.add(current.id)
                seeds.push(current)
            }

            // Opt-outs: `meta.cache: false` entities render every
            // cycle regardless of refs (escape hatch for external-data
            // sidecars, ECT partials, anything mikser can't precisely
            // track). Indexed query on the `meta_cache` column —
            // typical site has 0-10 of these, no full scan.
            const optOutEntities = await findEntities({ 'meta.cache': 0 })

            // Query-dep affected snapshots: aggregate layouts that
            // depend on findEntities(...) instead of static $-refs need
            // a second-pass dispatch hint. manifest.queryAffected walks
            // every snapshot whose refClosure contains a `query` entry
            // and sift-matches the recorded filter against the cycle's
            // mutated entities. Bounded by snapshots-with-query (small
            // — index pages, sitemaps, RSS) × seeds.
            const mutatedEntities = new Map(seeds.map(s => [s.id, s]))
            const queryAffected = runtime.manifest?.queryAffected(mutatedEntities) ?? new Set()

            if (seeds.length === 0 && optOutEntities.length === 0 && queryAffected.size === 0) return

            const closure = seeds.length ? runtime.refs.inverseClosureOf(seeds) : new Set()
            // Combine closure ids + opt-out ids + query-affected ids
            // into one dispatch set.
            const dispatchIds = new Set(closure)
            for (const e of optOutEntities) dispatchIds.add(e.id)
            for (const id of queryAffected) dispatchIds.add(id)

            // Hydrate each id via findById. LRU cache absorbs
            // duplicates (refs BFS revisits, partial dispatches
            // hitting the same layout, etc.). Bounded by closure
            // size — not by catalog size. We do materialize this
            // small set because the sort is intrinsically order-
            // sensitive — closure walk doesn't preserve time order.
            const entities = []
            for (const id of dispatchIds) {
                const entity = findById(id)
                if (entity?.layout) entities.push(entity)
            }
            entities.sort((a, b) => b.time - a.time)
            logger.debug('Incremental dispatch: %d seeds + %d opt-outs → %d entities',
                seeds.length, optOutEntities.length, entities.length)
            for (const entity of entities) {
                if (signal.aborted) return
                yield entity
            }
        }

        for await (const original of dispatchSource()) {
            if (signal.aborted) return

            delete original.page
            delete original.pages
            delete original.destination

            // Multi-layouts: one render task per matched layout.
            // entity.layouts is set in onProcessed; back-compat
            // single-layout entities fall back to [entity.layout].
            const layoutsForEntity = original.layouts?.length
                ? original.layouts
                : (original.layout ? [original.layout] : [])

            // Per-entity destination set, to detect collisions across
            // the layouts that match this same entity. On collision,
            // log a named-names error and skip ALL tasks for this
            // entity (no winner — fail-fast surfaces the design
            // decision back to the author).
            const tasksForEntity = []
            const destinationsForEntity = new Map() // destination → layout.name
            let collisionFound = false

            for (const staleLayout of layoutsForEntity) {
                if (collisionFound) break
                if (signal.aborted) return

                // Re-fetch the layout from the catalog. Front-matter
                // mutations to layout entities (e.g. `meta.destination`)
                // landed during onProcess but the snapshot stored on
                // `entity.layouts` at onProcessed time can be stale; the
                // catalog has the latest by onBeforeRender.
                const refreshedLayout = (await findEntity({ id: staleLayout.id })) || staleLayout

                // Apply entity-level postprocessor override per layout.
                // meta.postprocessors (array) wins over meta.postprocessor
                // (string); fall back to whatever the layout filename
                // encoded.
                const chainOverride = Array.isArray(original.meta?.postprocessors)
                    ? original.meta.postprocessors
                    : original.meta?.postprocessor
                        ? [original.meta.postprocessor]
                        : null
                const layout = chainOverride
                    ? { ...refreshedLayout, postprocessors: chainOverride, postprocessor: chainOverride[0] }
                    : refreshedLayout

                const entity = _.cloneDeep(original)
                // Per-task: pin entity.layout to the layout being processed
                // so downstream code (pagination, sidecar lookup, renderer
                // dispatch) sees the single-layout shape it expects.
                entity.layout = layout
                entity.destination = '/' + entity.name
                let data
                let load
                let plugins = []
                const sidecarPath = `${path.join(runtime.options.layoutsFolder, entity.layout.name)}.js`
                // Existence-check first so a real ERR_MODULE_NOT_FOUND inside the
                // sidecar (e.g. it imports a missing package) doesn't get swallowed
                // as "sidecar doesn't exist".
                // Sidecar queries flow into the render's refClosure as
                // `kind: 'query'` edges via the same track shape the engine
                // uses. Without this, layouts whose sidecars build their
                // data with findEntities/queryEntities would silently miss
                // invalidations when a newly-added entity should make the
                // listing change. partial slot disabled — sidecars don't
                // load partials themselves.
                const sidecarTrack = createTrack({ partial: false })
                if (existsSync(sidecarPath)) {
                    try {
                        ({ load, plugins = [] } = await import(`${sidecarPath}?stamp=${Date.now()}`))
                    } catch (err) {
                        logger.error('Layout sidecar %s failed to load: %s', sidecarPath.replace(runtime.options.workingFolder + '/', ''), err.message)
                        throw err
                    }
                    if (load) {
                        try {
                            data = await queryContext.run(
                                { entityId: entity.id, track: sidecarTrack },
                                () => load({ entity, findEntity, findEntities, runtime, signal }),
                            )
                        } catch (err) {
                            logger.error('Layout sidecar %s load() threw: %s', sidecarPath.replace(runtime.options.workingFolder + '/', ''), err.message)
                            throw err
                        }
                    }
                }

                // Capture a candidate task without queueing yet. Collisions
                // (two layouts producing the same destination for the same
                // entity) are detected after all layouts have been processed,
                // and the whole entity's task set is dropped on the floor —
                // no winner. See the collision check after the per-layout
                // loop closes.
                const queueTask = (taskEntity, taskOptions, taskContext) => {
                    if (destinationsForEntity.has(taskEntity.destination)) {
                        const firstLayout = destinationsForEntity.get(taskEntity.destination)
                        logger.error(
                            'Layout collision for %s:\n  - %s → %s\n  - %s → %s\nSet a `destination:` override on one of them, or change one\'s format. Skipping this entity for the cycle.',
                            original.id,
                            firstLayout, taskEntity.destination,
                            layout.name, taskEntity.destination,
                        )
                        collisionFound = true
                        return
                    }
                    destinationsForEntity.set(taskEntity.destination, layout.name)
                    tasksForEntity.push({ entity: taskEntity, options: taskOptions, context: taskContext })
                }

                // Layout-owned destination template (frontmatter
                // `destination:` field). When set, it FULLY overrides the
                // default `entity.name + .format` (+ cleanUrls) derivation.
                // The template gets `{ entity }` as context — including
                // pagination fields (`entity.page`, `entity.pages`) when
                // populated below.
                const destinationTemplate = layout.meta?.destination
                    ? compileDestinationTemplate(layout.meta.destination)
                    : null

                if (data?.pages) {
                    if (!_.endsWith(entity.name, entity.format)) {
                        // Loop bound is `< data.pages` (not `data.pages - 1`).
                        // With 4 pages and the old bound, iteration only ran
                        // page=0,1,2 and the 4th page was silently dropped —
                        // the sitemap claimed "Page X of 4" but the destination
                        // for page 4 was never produced.
                        for (let page = 0; page < data.pages; page++) {
                            const pageEntity = _.cloneDeep(entity)
                            pageEntity.pages = data.pages
                            if (page) {
                                pageEntity.page = page + 1
                                pageEntity.id = changeExtension(entity.id, `${pageEntity.page}.${entity.layout.format}`)
                                // Remember the source entity id so the render manifest
                                // can reclaim paginated outputs when the parent is deleted.
                                pageEntity.parent = entity.id
                                if (entity.meta) {
                                    if (entity.meta.href) {
                                        pageEntity.meta.href = `${entity.meta.href}.${pageEntity.page}`
                                    } else {
                                        pageEntity.meta.href = `/${entity.name}.${pageEntity.page}`
                                    }
                                }
                            } else {
                                pageEntity.page = 1
                            }

                            if (destinationTemplate) {
                                pageEntity.destination = sanitizeDestination(destinationTemplate({ entity: pageEntity }))
                            } else if (page) {
                                if (options.cleanUrls && entity.layout.format == 'html') {
                                    pageEntity.destination = path.join(entity.destination.replace('index', ''), pageEntity.page.toString(), `index.${entity.layout.format}`)
                                } else {
                                    pageEntity.destination += `.${pageEntity.page}.${entity.layout.format}`
                                }
                            } else {
                                if (options.cleanUrls && !_.endsWith(entity.name, 'index') && entity.layout.format == 'html') {
                                    pageEntity.destination = path.join(entity.destination, `index.${entity.layout.format}`)
                                } else {
                                    pageEntity.destination += `.${entity.layout.format}`
                                }
                            }

                            queueTask(pageEntity, {
                                renderer: entity.layout.template,
                                postprocessor: entity.layout.postprocessor,
                                postprocessors: entity.layout.postprocessors ?? (entity.layout.postprocessor ? [entity.layout.postprocessor] : []),
                                tasks: entity.meta?.task || TASKS.INLINE,
                            }, { data, plugins, sidecarQueries: sidecarTrack.queries })
                        }
                    }
                } else {
                    if (destinationTemplate) {
                        entity.destination = sanitizeDestination(destinationTemplate({ entity }))
                    } else if (!_.endsWith(entity.name, entity.format)) {
                        // cleanUrls turns `foo` into `foo/index.html` so the
                        // served URL is `/foo/`. Skip the transform when the
                        // layout declares a postprocessor — the HTML render
                        // is a throwaway stepping stone (a PDF stepping
                        // stone has no served URL), and leaving it flat
                        // means engine.onPostprocess's plain extension swap
                        // produces `/foo.<ext>` naturally. Postprocess is
                        // decoupled from cleanUrls by where the decision
                        // gets made — not by the engine knowing about it.
                        if (options.cleanUrls
                            && !_.endsWith(entity.name, 'index')
                            && entity.layout.format == 'html'
                            && !entity.layout.postprocessor
                        ) {
                            entity.destination = path.join(entity.destination, `index.${entity.layout.format}`)
                        } else {
                            entity.destination += `.${entity.layout.format}`
                        }
                    }
                    if (entity.destination) {
                        queueTask(entity, {
                            renderer: entity.layout.template,
                            postprocessor: entity.layout.postprocessor,
                            postprocessors: entity.layout.postprocessors ?? (entity.layout.postprocessor ? [entity.layout.postprocessor] : []),
                            tasks: entity.meta?.task || TASKS.INLINE,
                        },
                        // sidecarQueries threads the sidecar load()'s
                        // findEntities calls into manifest.collectEdges
                        // as `{kind: 'query', filter}` refClosure entries.
                        // Without it, aggregate layouts that don't
                        // paginate (sitemap.xml, index pages, RSS feeds)
                        // lose query-dep tracking and never invalidate
                        // when matching entities are added/modified/
                        // deleted. The paginated branch above already
                        // does this.
                        { data, plugins, sidecarQueries: sidecarTrack.queries })
                    }
                }
            } // end per-layout for-loop

            // Commit this entity's tasks (only if no collision was
            // hit). A collision drops EVERYTHING for the entity — no
            // winner, no half-built output.
            if (!collisionFound) {
                tasks.push(...tasksForEntity)
            }
            await maybeFlush()
        }
        // Final flush — drain anything below the FLUSH_BATCH watermark.
        if (tasks.length) await renderEntities(tasks)
    }
}
