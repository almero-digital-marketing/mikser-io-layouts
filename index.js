// mikser-io-layouts — SSG-flavor task-production policy for mikser-io.
//
// Five concerns, three split into lib/ for navigation:
//   - bootstrap + sync + output (this file: onSync / onLoaded / onImport /
//     onComplete bodies, plus the factory + hook wiring)
//   - destination resolution helpers (lib/destination.js)
//   - inspect() primitive  (lib/inspect.js)
//   - layout matching      (lib/matching.js — onProcessed body)
//   - render-task assembly (lib/assembly.js — onBeforeRender body)
//
// The split is for cognitive load, not for plugin boundaries — the
// pieces still close over the same factory-destructured core API and
// always ship together.

import path from 'node:path'
import { mkdir, writeFile, unlink, rmdir, readFile } from 'node:fs/promises'
import { globby } from 'globby'
import _ from 'lodash'
import {
    gateChecksum, sweepDeleted, scanSummary,
    checksumsByCollection,
    checksum as fileChecksum, checksumOf,
    useDatabase,
    writeOutput, reportUnchanged,
} from 'mikser-io'

import { createInspect } from './lib/inspect.js'
import { createOnProcessed } from './lib/matching.js'
import { createOnBeforeRender } from './lib/assembly.js'
import { registerMcpTools } from './lib/mcp.js'

export function layouts(userOptions = {}) {
    // cleanUrls DEFAULTS TO TRUE. It previously had no default, so unset it
    // was falsy and pages landed at `hera.html` instead of `hera/index.html`
    // — while the README's options block presented `cleanUrls: true` in a way
    // that reads as a defaults table. There was no warning, the site worked,
    // and the wrong URL shape was everywhere: the kind of thing discovered
    // after canonical tags and hreflang are wired against the shape you
    // assumed. Defaulting it matches both the README and what almost every
    // site wants; pass `cleanUrls: false` for flat output.
    const options = { cleanUrls: true, ...userOptions }
    return ({
        runtime,
        onLoaded,
        useLogger,
        onImport,
        createEntity,
        updateEntity,
        deleteEntity,
        watch,
        onProcessed,
        onBeforeRender,
        useJournal,
        renderEntities,
        onComplete,
        onSync,
        matchEntity,
        changeExtension,
        getFormatInfo,
        findById,
        findEntity,
        findEntities,
        constants: { ACTION, OPERATION, TASKS },
    }) => {
        const collection = 'layouts'
        const type = 'layout'

        // Read a layout file's bytes into entity.content so the frontmatter
        // plugin can extract YAML metadata at onProcess. Defensive — sync
        // events can arrive ahead of file state in edge cases (rename races,
        // synthetic test sync calls). A missing file logs at debug and the
        // entity goes in with empty content; downstream renderers will
        // surface the real failure mode with a clearer error.
        async function readLayoutContent(uri) {
            try {
                return await readFile(uri, 'utf8')
            } catch (err) {
                useLogger().debug('Layout content unreadable at %s: %s', uri, err.message)
                return ''
            }
        }

        // Sitemap lookups live in the catalog — `meta_href` is indexed,
        // so any "find entity by href" query goes through findEntity or
        // (in workers) the read-only sqlite handle they open at first task.
        // The old `runtime.state.layouts.sitemap` in-memory map + `uriIndex`
        // are gone: every entity's "sitemap presence" IS its catalog row.

        // Expose the layouts inspection surface for other plugins (the
        // mikser-io-mcp plugin wraps inspect() as the mikser_layouts_inspect
        // tool). Done at factory-eval time — before any onLoaded fires — so
        // a later plugin's onLoaded can see it. Matches the preview plugin
        // pattern (`runtime.options.preview = { store, get, stats, config }`).
        runtime.options.layouts = {
            inspect: createInspect({ runtime, findEntity, findEntities, useDatabase, collection }),
        }

        // MCP tool registration. Gated on runtime.options.mcp — when the
        // mcp plugin isn't loaded, this is a no-op (vector / schemas /
        // preview use the same pattern). The mcp plugin must be FIRST
        // in the plugins array for this to fire; that constraint is
        // documented in mikser-io's CLAUDE.md.
        onLoaded(async () => {
            registerMcpTools({ runtime, useLogger })
        })

        onSync(collection, async ({ action, context }) => {
            if (!context.relativePath) return false
            const logger = useLogger()
            const { relativePath } = context

            // A .js file under the layouts folder is a SIDECAR (or something
            // a sidecar imports), never a layout. It used to have its `.js`
            // stripped and be created as an entity, which produced a phantom
            // `/layouts/page` — holding JS source as its content — beside the
            // real `/layouts/page.liquid`.
            //
            // Sidecars are inputs to a layout's checksum instead (see
            // sidecarInputs above), so the right response to one changing is
            // to re-run the layouts scan: it recomputes every composite and
            // emits an UPDATE for whichever layouts actually moved, which is
            // what makes their dependents re-render.
            if (_.endsWith(relativePath, '.js') && isSidecarScript(relativePath)) {
                logger.debug('Layouts sidecar changed (%s) — rescanning layouts', relativePath)
                await rescanLayouts()
                return
            }

            // A JS-authored layout (post.hbs.js) keeps its historical
            // behaviour: the trailing .js is dropped so the id is
            // /layouts/post.hbs.
            let id = path.join(`/${collection}`, relativePath)
            if (_.endsWith(id, '.js')) id = id.replace(new RegExp('.js$'), '')

            const uri = path.join(runtime.options.layoutsFolder, relativePath)
            const { layouts } = runtime.state.layouts
            switch (action) {
                case ACTION.CREATE:
                    var layout = {
                        id,
                        uri,
                        collection,
                        type,
                        name: relativePath.replace(path.extname(relativePath), ''),
                        content: await readLayoutContent(uri),
                        ...getFormatInfo(relativePath)
                    }
                    layouts[layout.name] = layout
                    await createEntity(layout)
                    break
                case ACTION.UPDATE:
                    var layout = {
                        id,
                        uri,
                        collection,
                        type,
                        name: relativePath.replace(path.extname(relativePath), ''),
                        content: await readLayoutContent(uri),
                        ...getFormatInfo(relativePath)
                    }
                    layouts[layout.name] = layout
                    await updateEntity(layout)
                    break
                case ACTION.DELETE:
                    var layout = {
                        id,
                        collection,
                        type,
                        format: path.extname(relativePath).substring(1).toLowerCase(),
                    }
                    for (let name in layouts) {
                        if (layouts[name].id == layout.id) {
                            delete layouts[name]
                        }
                    }
                    await deleteEntity(layout)
                    break
            }
        })

        onLoaded(async () => {
            const logger = useLogger()

            // Only the layouts collection map lives in memory now. The
            // sitemap was 14k+ entries at scale and got serialized to every
            // worker via Piscina; it now lives in the catalog and workers
            // query it directly through their read-only sqlite handle (see
            // src/render.js's ensureWorkerDb / lookupHrefViaDb).
            //
            // `layouts.layouts` (name → layout entity) stays because it's
            // small (typically 5-20 entries), referenced by template-engine
            // partial registration at render-plugin load time, and cheap to
            // both serialize and rebuild.
            runtime.state.layouts = {
                layouts: {},
            }

            // Folder name resolved here (config override or default to the
            // collection name) and used immediately to build the absolute
            // path. No need to keep the bare folder-name string on
            // runtime.options — runtime.options.layoutsFolder is the only
            // useful form downstream.
            const layoutsFolderName = options.layoutsFolder || collection
            runtime.options.layoutsFolder = path.join(runtime.options.workingFolder, layoutsFolderName)
            runtime.options.layoutsStateFolder = path.join(runtime.options.outputFolder, 'state')

            logger.debug('Layouts folder: %s', runtime.options.layoutsFolder)
            await mkdir(runtime.options.layoutsFolder, { recursive: true })

            watch(collection, runtime.options.layoutsFolder)

            // Rebuild the in-memory layouts map from the catalog. Indexed
            // on `collection`, returns the small layouts set — typically a
            // few entries, not the full corpus. Subsequent in-cycle
            // mutations to layouts flow through createEntity in onProcess
            // below.
            const { layouts } = runtime.state.layouts
            for (const e of await findEntities({ collection })) {
                layouts[e.name] = e
            }
        })

        // A layout's `.js` sidecar is where a mikser site's data layer lives,
        // and it was the one file in the project that could be edited without
        // effect: `.js` is excluded from the scan below, so the sidecar was
        // not an entity, not watched as an input, and not part of any hash.
        // Nothing depended on it, so nothing re-rendered — silently, and
        // looking exactly like a bug in your own code.
        //
        // Fixed by folding sidecars into the LAYOUT's checksum rather than
        // making them entities. A sidecar is an input to a layout, not a
        // thing a site has; giving it an entity would put JS source in the
        // catalog and (via the id-stripping in onSync) a phantom
        // `/layouts/page` alongside the real `/layouts/page.liquid`.
        //
        // Two components:
        //   own     — the layout's own sidecar, `<name>.js`
        //   shared  — every OTHER .js under the folder, as one digest
        //
        // `shared` is coarse on purpose: a sidecar's own imports
        // (layouts/lib/context.js and friends) would otherwise need a module
        // graph walk. Treating any shared .js change as invalidating every
        // layout is what the folder can afford — tens of files, not
        // thousands — and it is predictable, which a partial graph walk
        // would not be.
        // NOT every .js under the folder is a sidecar. `post.hbs.js` is a
        // LAYOUT — a template written as JS, whose id drops the trailing .js
        // to become /layouts/post.hbs. `post.js` is the sidecar for layout
        // `post`. The discriminator is whether stripping `.js` leaves a
        // further extension:
        //
        //   post.js        → post        no extension  → sidecar
        //   lib/context.js → lib/context no extension  → sidecar-adjacent
        //   post.hbs.js    → post.hbs    .hbs          → layout, leave alone
        //
        // Getting this wrong turns every JS-authored layout into a
        // non-entity, which is why it is a rule and not a guess.
        const isSidecarScript = (rel) => path.extname(rel.replace(/\.js$/, '')) === ''

        async function sidecarInputs() {
            const scriptPaths = (await globby('**/*.js', { cwd: runtime.options.layoutsFolder }))
                .filter(isSidecarScript)
            const own = new Map()
            const shared = []
            for (const rel of scriptPaths.sort()) {
                const sum = await fileChecksum(path.join(runtime.options.layoutsFolder, rel))
                own.set(rel.replace(/\.js$/, ''), sum)
                shared.push(`${rel}:${sum}`)
            }
            return { own, sharedDigest: shared.length ? checksumOf(shared.join('\n')) : '' }
        }

        // The value the checksum gate compares. Passed as `bytes` so the gate
        // keeps owning the --force / cache-invalidated / prior-checksum
        // logic instead of this plugin reimplementing it.
        async function layoutInputBytes(uri, name, inputs) {
            const template = await fileChecksum(uri)
            const sidecar = inputs.own.get(name) ?? ''
            return Buffer.from(`${template}:${sidecar}:${inputs.sharedDigest}`, 'utf8')
        }

        // Named so onSync can re-run it when a sidecar changes. A function
        // declaration, so it is hoisted above the onSync registration above.
        async function rescanLayouts() {
            const { layouts } = runtime.state.layouts
            const logger = useLogger()
            const paths = await globby('**/*', { cwd: runtime.options.layoutsFolder, ignore: ['**/*.js'] })
            const inputs = await sidecarInputs()
            const scanned = new Set()
            const stats = { emitted: 0, skipped: 0, deleted: 0 }

            // Same checksum gate + delete sweep mechanics as useSource
            // (source.js) — extracted into shared helpers so adding a
            // future scanning plugin doesn't repeat them again. Layouts
            // can't simply USE useSource because it owns the in-memory
            // `runtime.state.layouts.layouts` map (consumed by hbs's
            // partial registration, by resolveLayout below, and by
            // layouts.inspect), and the load step layers in
            // getFormatInfo. The gate + sweep + summary line shape are
            // shared regardless.
            // Bulk-prefetch this collection's (id → checksum) map once
            // before the loop; the gate hits a Map.get instead of a per-
            // file SQL lookup.
            const priorChecksums = checksumsByCollection(collection)
            for (let relativePath of paths) {
                const uri = path.join(runtime.options.layoutsFolder, relativePath)
                const id = path.join('/layouts', relativePath)
                scanned.add(id)

                const name = relativePath.replace(path.extname(relativePath), '')
                const chksum = await gateChecksum(uri, id, {
                    priorChecksums,
                    bytes: await layoutInputBytes(uri, name, inputs),
                })
                if (chksum === null) {
                    stats.skipped++
                    continue
                }

                const layout = {
                    id, uri,
                    name: relativePath.replace(path.extname(relativePath), ''),
                    collection,
                    type,
                    content: await readLayoutContent(uri),
                    checksum: chksum,
                    // Declared so inputHashOf folds the sidecars into this
                    // layout's input hash. Without it the gate checksum
                    // moves but the hash does not — an entity that has
                    // content is hashed on {meta, content} — so consumers
                    // still skip and the sidecar edit reaches nothing.
                    inputs: {
                        sidecar: inputs.own.get(name) ?? null,
                        shared: inputs.sharedDigest || null,
                    },
                }
                Object.assign(layout, await getFormatInfo(relativePath))
                layouts[layout.name] = layout
                await createEntity(layout)
                stats.emitted++
            }

            stats.deleted = await sweepDeleted(collection, scanned, async (e) => {
                // Drop the layout from the in-memory map alongside the
                // journal DELETE so partial-resolution and consumer
                // renders this cycle don't reach for a layout whose file
                // is gone.
                for (let name in layouts) {
                    if (layouts[name].id === e.id) delete layouts[name]
                }
                await deleteEntity({ id: e.id, type, collection })
                logger.debug('Layouts removed (file gone): %s', e.name)
            }, runtime.options.layoutsFolder)
            // ownerPrefix: the layouts folder. Sweep stays scoped to
            // entities whose uri is rooted there; foreign entries in
            // the `layouts` collection (none in practice today, but
            // future MCP-served / API-injected layouts get the same
            // protection as CSV-emitted documents).

            logger.info(scanSummary({ cap: 'Layouts', loaded: paths.length, ...stats }))
        }

        onImport(rescanLayouts)

        // Matching + assembly are extracted to lib/ for cognitive load
        // (~185 + ~360 lines respectively). They still close over the
        // same factory-destructured core API — the createX(ctx) pattern
        // just threads the destructured args explicitly across module
        // boundaries.
        onProcessed(createOnProcessed({
            runtime, useLogger, useJournal,
            findEntity, matchEntity, collection,
            OPERATION,
            options,
        }))

        onBeforeRender(createOnBeforeRender({
            runtime, useLogger, useJournal,
            findById, findEntity, findEntities,
            renderEntities,
            changeExtension,
            OPERATION, TASKS,
            options,
        }))

        onComplete(async ({ entity, options, output }) => {
            const logger = useLogger()
            if (entity.layout && !options?.ignore && output.result != null) {
                // `entity.options.save === false` (set by useRenderer when
                // called with { save: false }) opts out of writing the
                // FINAL output to disk. The bytes still come back to the
                // caller via output.result. Strict equality — only the
                // literal `false` opts out, matching the catalog-flag pattern.
                //
                // The intermediate file (when a postprocessor will run next)
                // must still exist somewhere on disk so the postprocessor
                // can consume it. For save:true, that's outputFolder; for
                // save:false, that's runtime.options.previewFolder — an
                // engine-owned scratch path under runtimeFolder, never
                // exposed in user-visible outputFolder. The postprocess
                // task's outputFolder is rewritten in engine.js so post
                // plugins resolve `entity.origin` against the same base.
                const isFinal = !entity.layout.postprocessor || entity.origin != null
                const previewMode = entity.options?.save === false
                const skipWrite = previewMode && isFinal
                const writeBase = (previewMode && !isFinal)
                    ? runtime.options.previewFolder
                    : runtime.options.outputFolder

                if (!skipWrite) {
                    const destinationFile = path.join(writeBase, entity.destination)
                    // writeOutput skips the write when the bytes already on
                    // disk are identical. Invalidation is deliberately
                    // conservative — an entity that merely READ another
                    // re-renders, because the engine cannot know which field
                    // was read — so byte-identical output is routine, and
                    // rewriting it moved mtime for live-reload, rsync and
                    // `find -newer` alike. mkdir/unlink moved inside it.
                    const wrote = await writeOutput(destinationFile, output.result)
                    if (wrote) {
                        logger.debug('Layout render finished: %s', entity.destination.replace(runtime.options.workingFolder, ''))
                    } else {
                        reportUnchanged(entity)
                        logger.debug('Layout render finished, output unchanged: %s', entity.destination.replace(runtime.options.workingFolder, ''))
                    }
                } else {
                    logger.debug('Layout render finished (save:false, bytes only): %s', entity.id)
                }

                if (entity.origin && entity.origin !== entity.destination) {
                    // Don't unlink the origin if it was the same path we just
                    // wrote to (post plugins that produce the same extension as
                    // the renderer's output — e.g. MJML→HTML on `*.html-mjml.*`
                    // layouts). Otherwise we'd delete our own final file.
                    //
                    // For preview flow (entity.options.save === false) the
                    // intermediate lived in previewFolder; for normal flow
                    // it lived in outputFolder. Pick the right base.
                    const originBase = previewMode
                        ? runtime.options.previewFolder
                        : runtime.options.outputFolder
                    const originFile = path.join(originBase, entity.origin)
                    try {
                        await unlink(originFile)
                    } catch { }
                    // With cleanUrls the origin was `<name>/index.html`; once
                    // the postprocessor wrote `<name>.<ext>` elsewhere, that
                    // folder is left empty. Remove it if so. rmdir only
                    // succeeds on an empty directory, so this is a no-op when
                    // the folder still holds other outputs (e.g. paginated
                    // pages).
                    try {
                        await rmdir(path.dirname(originFile))
                    } catch { }
                }
            }
        })

        return {
            collection,
            type,
        }
    }
}
