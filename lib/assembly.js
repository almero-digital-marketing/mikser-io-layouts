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
    recordReads,
    observeConsumed,
    queryContext,
    useDatabase,
    reportError,
} from 'mikser-io'
import { compileDestinationTemplate, sanitizeDestination, primaryDestination } from './destination.js'
import { setSidecarStamp, sidecarHookInstalled } from './sidecar-modules.js'

// What the sidecar actually returned, for a message a reader can act on.
// `[object Object]` and `` are the two least useful things to print here.
function describePages(value) {
    if (Array.isArray(value)) return `an array of ${value.length}`
    if (value === null) return 'null'
    if (typeof value === 'object') return `an object with keys ${Object.keys(value).join(', ') || '(none)'}`
    if (typeof value === 'number') return `the number ${value}`
    return `a ${typeof value} (${JSON.stringify(value)})`
}

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

            // Entities whose last render attempt threw. Nothing else will
            // schedule them: their own source has not changed, so they are
            // gated at import, and the manifest still holds the snapshot from
            // the last GOOD render — every hash agrees and the page stays
            // broken. Same hook as the opt-outs above, for the same reason:
            // a dispatch set the ref walk cannot reach.
            const failedIds = runtime.manifest?.failedIds?.() ?? []

            if (seeds.length === 0 && optOutEntities.length === 0
                && queryAffected.size === 0 && failedIds.length === 0) return

            const closure = seeds.length ? runtime.refs.inverseClosureOf(seeds) : new Set()
            // Combine closure ids + opt-out ids + query-affected ids
            // into one dispatch set.
            const dispatchIds = new Set(closure)
            for (const e of optOutEntities) dispatchIds.add(e.id)
            for (const id of queryAffected) dispatchIds.add(id)
            for (const id of failedIds) dispatchIds.add(id)

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
                // `meta: true` records which of the entity's own meta keys
                // the sidecar reads. This is the half of a layout's contract
                // that static parsing structurally cannot reach: a sidecar is
                // plain JavaScript, so `row.meta?.hero?.tags` has no syntax
                // for any template parser to find. Observing the read is the
                // only way to know the key is required.
                const sidecarTrack = createTrack({ partial: false, meta: true, consumed: true })
                if (existsSync(sidecarPath)) {
                    try {
                        // Stamp = the shared sidecar digest, so the URL
                        // changes exactly when some .js under layoutsFolder
                        // does. With the resolve hook installed that stamp
                        // also reaches the sidecar's own imports; without it
                        // only the entry reloads, so fall back to a
                        // per-render stamp to keep at least that much.
                        const stamp = entity.layout.inputs?.shared || ''
                        setSidecarStamp(stamp)
                        const entryStamp = sidecarHookInstalled() ? stamp : Date.now();
                        // Semicolon above is load-bearing: without it the
                        // parenthesised destructuring assignment below reads
                        // as a CALL of the preceding expression.
                        ({ load, plugins = [] } = await import(`${sidecarPath}?stamp=${entryStamp}`))
                    } catch (err) {
                        logger.error('Layout sidecar %s failed to load: %s', sidecarPath.replace(runtime.options.workingFolder + '/', ''), err.message)
                        throw err
                    }
                    if (load) {
                        try {
                            // The sidecar sees a read-recording view of the
                            // entity. Only `meta` is wrapped — id, name and uri
                            // are plumbing, and recording them as content keys
                            // would bury the ones that matter.
                            //
                            // Prefixed `meta.` rather than `data.meta.`: these
                            // are the DOCUMENT's own keys, read before any
                            // transform the sidecar applies, while the template
                            // reads whatever the sidecar hands back.
                            const observed = entity?.meta
                                ? { ...entity, meta: recordReads(entity.meta, 'meta', sidecarTrack.metaRead) }
                                : entity
                            // Entities the sidecar PULLS IN are observed too,
                            // each against its own id. A page reads
                            // `items[].label` off a navigation document it
                            // queried, and without this nothing records which
                            // of that document's keys anyone actually needs —
                            // so a document that never renders has no derivable
                            // contract at all.
                            const seenEntity = async (...args) =>
                                observeConsumed(await findEntity(...args), sidecarTrack)
                            const seenEntities = async (...args) => {
                                const rows = await findEntities(...args)
                                return Array.isArray(rows)
                                    ? rows.map(row => observeConsumed(row, sidecarTrack))
                                    : rows
                            }
                            data = await queryContext.run(
                                { entityId: entity.id, track: sidecarTrack },
                                () => load({ entity: observed, findEntity: seenEntity,
                                             findEntities: seenEntities, runtime, signal }),
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
                    // `pages` is the pagination COUNT, and only a count.
                    //
                    // The guard above is truthiness and the loop below is
                    // `page < data.pages`, so a sidecar returning anything
                    // truthy that is not a positive number passed the first
                    // and ran zero times in the second. `{ pages: [] }`
                    // coerces to 0; `{ pages: [{…}] }` coerces to NaN. Both
                    // produced NO page: no file, no error, no warning, not
                    // counted in `Rendered:`, no manifest snapshot — a green
                    // build with the page simply absent, and --audit-output
                    // cannot see it either because an entity that never
                    // rendered has no snapshot to be missing.
                    //
                    // `pages` is also the obvious name for the list in a
                    // sitemap, which is exactly where it lands.
                    //
                    // Thrown rather than reinterpreted. The key has one
                    // meaning; guessing a second from the value's type is how
                    // a name comes to mean two things depending on what you
                    // put in it. This fails the render for this entity, which
                    // is counted, recorded and named.
                    if (!Number.isInteger(data.pages) || data.pages < 1) {
                        // Reported, not thrown. This runs in onBeforeRender,
                        // a lifecycle hook rather than a render, so an
                        // exception here tears the whole build down with a
                        // stack trace — one mistyped sidecar stopping every
                        // other page, which trades a silent failure for a
                        // total one.
                        //
                        // reportError, not logger.error. This entity could
                        // not be turned into output, which is what a render
                        // error IS — so it is counted in `errors`, recorded in
                        // mikser_failures, and makes a one-shot build exit 1.
                        // A coded logger.error would register as a fault, and
                        // a fault leaves the build green: "🟢 Mikser completed"
                        // beside a red line and exit 0 is the same green build
                        // the report was about.
                        const message =
                            `sidecar returned \`pages\` as ${describePages(data.pages)}. `
                            + '`pages` is the pagination COUNT — a positive integer — and is reserved '
                            + 'in the data a layout receives, so a list cannot be passed under it. '
                            + 'Rename it (`items`, `entries`, `urls`) and the layout renders once '
                            + 'with that list available.'
                        reportError(entity, new Error(message), { layout: entity.layout?.name ?? null })
                        logger.error({ code: 'layout-pages-not-a-count', id: entity.id,
                            layout: entity.layout?.name ?? null },
                            'Layout %s: %s — %s produced no output.',
                            entity.layout?.name ?? '?', message, entity.id)
                        continue
                    }
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
                            }, { data, plugins, sidecarQueries: sidecarTrack.queries,
                                 // Plain arrays, because this context is journaled as JSON
                                 // before the render runs — a Set arrives as {}.
                                 //
                                 // That same round-trip is why these are what the
                                 // SIDECAR read and nothing more: the recording
                                 // views inside `data` do not survive it, so a key
                                 // only the template touches is never recorded
                                 // here. See check_entity's untraceable handling.
                                 sidecarMetaReads: [...(sidecarTrack.metaReads ?? [])],
                                 sidecarConsumedReads: [...(sidecarTrack.consumedReads ?? [])].map(([k, v]) => [k, [...v]]) })
                        }
                    } else {
                        // Pagination was asked for, and nothing was queued.
                        //
                        // The guard exists so an entity whose name already
                        // carries its format is not expanded twice, but it
                        // shares the shape that made the type confusion above
                        // so expensive: no task, no message, output absent on
                        // a green build. Whatever the right handling is, it is
                        // not silence.
                        logger.warn({ code: 'layout-pagination-skipped', id: entity.id },
                            'Pagination was requested for %s (pages: %d) but its name already ends '
                            + 'with its format (%s), so no page was produced.',
                            entity.id, data.pages, entity.format)
                    }
                } else {
                    // Same derivation onProcessed persists onto the catalog
                    // entity — one function, so a stored destination and the
                    // file actually written cannot disagree. Drift here would
                    // produce links pointing at files that are not there.
                    entity.destination = primaryDestination({
                        entity, layout: entity.layout, options, endsWith: _.endsWith,
                    })
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
                        { data, plugins, sidecarQueries: sidecarTrack.queries,
                          // Plain arrays, because this context is journaled as JSON
                                 // before the render runs — a Set arrives as {}.
                                 //
                                 // That same round-trip is why these are what the
                                 // SIDECAR read and nothing more: the recording
                                 // views inside `data` do not survive it, so a key
                                 // only the template touches is never recorded
                                 // here. See check_entity's untraceable handling.
                                 sidecarMetaReads: [...(sidecarTrack.metaReads ?? [])],
                                 sidecarConsumedReads: [...(sidecarTrack.consumedReads ?? [])].map(([k, v]) => [k, [...v]]) })
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
