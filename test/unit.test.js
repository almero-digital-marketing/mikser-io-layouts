import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { format } from 'node:util'
import { mkdtemp, rm, access, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { layouts } from '../index.js'
import { frontMatter } from 'mikser-io'
import { createHarness } from './_harness.js'

async function withTempWorking(fn) {
    const dir = await mkdtemp(path.join(tmpdir(), 'mikser-layouts-'))
    try { return await fn(dir) }
    finally { await rm(dir, { recursive: true, force: true }) }
}

describe('layouts plugin', () => {
    it('registers all the expected hooks', () => {
        const h = createHarness()
        layouts()(h.core)
        // Two onLoaded handlers — state init + MCP tool registration.
        // MCP registration is a no-op when runtime.options.mcp isn't
        // present (vector / schemas / preview use the same gating
        // pattern). Before tools-with-domain moved, the registration
        // lived in mikser-io-mcp.
        assert.equal(h.hooks.loaded.length, 2)
        assert.equal(h.hooks.import.length, 1)
        assert.equal(h.hooks.processed.length, 1)
        assert.equal(h.hooks.beforeRender.length, 1)
        assert.equal(h.hooks.complete.length, 1)
        assert.ok(h.sync.has('layouts'))
        // The inspect primitive is exposed at factory-eval — before any
        // onLoaded fires — so plugins listed after layouts in the
        // plugins array can see it during their own onLoaded.
        assert.equal(typeof h.runtime.options.layouts?.inspect, 'function')
    })

    it('initializes runtime.state.layouts on onLoaded with empty maps', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({ options: { workingFolder, outputFolder: path.join(workingFolder, 'out') } })
            layouts()(h.core)
            await h.runHook('loaded')
            // sitemap + uriIndex retired — sitemap is now backed by
            // the catalog's indexed meta_href column, queried via the
            // worker-side read-only sqlite handle in src/render.js.
            assert.deepEqual(h.runtime.state.layouts, { layouts: {} })
            assert.equal(h.runtime.options.layoutsFolder, path.join(workingFolder, 'layouts'))
        })
    })

    it('onSync CREATE registers a layout in state.layouts and writes a journal entry', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({ options: { workingFolder, outputFolder: path.join(workingFolder, 'out') } })
            layouts()(h.core)
            await h.runHook('loaded')
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post.hbs' } })

            const entry = h.journal.find(e => e.operation === 'create')
            assert.ok(entry)
            assert.equal(entry.entity.id, '/layouts/post.hbs')
            assert.equal(entry.entity.template, 'hbs')
            assert.equal(entry.entity.format, 'html')
            assert.equal(entry.entity.name, 'post')
            assert.ok(h.runtime.state.layouts.layouts['post'])
        })
    })

    it('onSync CREATE for a sidecar .js layout drops .js from id', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({ options: { workingFolder, outputFolder: path.join(workingFolder, 'out') } })
            layouts()(h.core)
            await h.runHook('loaded')
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post.hbs.js' } })
            const entry = h.journal.find(e => e.operation === 'create')
            assert.equal(entry.entity.id, '/layouts/post.hbs')
        })
    })

    it('onSync DELETE removes the layout from state.layouts and writes a delete entry', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({ options: { workingFolder, outputFolder: path.join(workingFolder, 'out') } })
            layouts()(h.core)
            await h.runHook('loaded')
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post.hbs' } })
            assert.ok(h.runtime.state.layouts.layouts['post'])

            await h.runSync('layouts', { action: 'delete', context: { relativePath: 'post.hbs' } })

            assert.equal(h.runtime.state.layouts.layouts['post'], undefined)
            assert.equal(h.journal.filter(e => e.operation === 'delete').length, 1)
        })
    })

    it('onProcessed assigns a matched layout to the entity', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({
                options: { workingFolder, outputFolder: path.join(workingFolder, 'out') },
            })
            layouts({ autoLayouts: true })(h.core)
            await h.runHook('loaded')
            // Seed a layout
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post.hbs' } })

            // Seed a document journal entry whose name matches 'post'
            const doc = {
                id: '/documents/post.md',
                collection: 'documents',
                name: 'post',
                format: 'md',
                meta: { lang: 'en' },
            }
            h.journal.push({ id: 99, entity: doc, operation: 'create', context: {}, options: {}, output: null })

            await h.runHook('processed', { aborted: false })

            assert.ok(doc.layout, 'entity should have been assigned a layout')
            assert.equal(doc.layout.name, 'post')
            // Sitemap presence is now equivalent to "the catalog has
            // this entity with meta.href set" — verified end-to-end by
            // the scenario tests against a real subprocess + sqlite.
            // Unit-level we just check the entity got its layout.
        })
    })

    it('warns once about a match pattern that selected nothing', async () => {
        // A pattern selecting zero entities is otherwise completely silent —
        // no warn, no debug — so a typo'd or missing language segment loses a
        // whole section while the build goes green.
        //
        // `force` makes this a full cycle. The warning is gated on that,
        // because on an incremental run the evaluated set is whatever changed
        // and a healthy pattern legitimately matches none of it.
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({
                options: { workingFolder, outputFolder: path.join(workingFolder, 'out'), force: true },
            })
            layouts({
                autoLayouts: false,
                match: {
                    // matchEntity globs entity.name only for '@/' patterns;
                    // everything else globs entity.id. Both forms here, so
                    // the test pins the real rule rather than the loose
                    // "patterns match name" summary.
                    '@/post':            'post',      // matches name
                    '/documents/post.md': 'post',      // matches id
                    'nonesuch/*':        'section',   // matches neither
                },
            })(h.core)
            await h.runHook('loaded')
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post.hbs' } })
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'section.hbs' } })

            const doc = { id: '/documents/post.md', collection: 'documents', name: 'post', format: 'md', meta: {} }
            h.journal.push({ id: 1, entity: doc, operation: 'create', context: {}, options: {}, output: null })
            await h.runHook('processed', { aborted: false })

            const warnings = h.logs.filter(l =>
                l.level === 'warn' && l.args.join(' ').includes('Layout pattern'))
            assert.equal(warnings.length, 1, `expected one warning, got ${warnings.length}`)
            // Structured first, sentence second — the call is
            // logger.warn({ code, ... }, msg, ...values), and the fields are
            // what the build report keys on. The harness records the args
            // unformatted, so render the message the way the logger would.
            const [fields, ...message] = warnings[0].args
            assert.equal(fields.code, 'layout-pattern-no-match', 'carries the code the report is asserted on')
            assert.equal(fields.pattern, 'nonesuch/*')
            assert.equal(fields.matchedAgainst, 'id')
            const text = format(...message)
            assert.match(text, /nonesuch/, 'names the pattern that matched nothing')
            assert.ok(!text.includes("'post'"), 'must not name the pattern that DID match')
            assert.match(text, /matched against entity\.id/, 'names the field this pattern is matched against')
            assert.match(text, /'@\/'/, "points at the '@/' prefix for name matching")
            // No longer advises --force: the warning only fires on a full
            // cycle now, so the advice would be telling the reader to do what
            // they have already done.
            assert.ok(!text.includes('--force'), 'does not advise what the reader just did')
        })
    })

    it('stays silent about an unmatched pattern on an incremental cycle', async () => {
        // The inverse of the test above, and the reason the gate exists. An
        // incremental run re-evaluates only what changed, so a pattern that
        // matches plenty of documents matches none of the two entities in a
        // settled build. Warning there fires on every healthy build, and a
        // warning that always fires is one the reader filters out — taking
        // the real instance with it.
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({
                // No `force`, no `firstRun`, no cache invalidation.
                options: { workingFolder, outputFolder: path.join(workingFolder, 'out') },
            })
            layouts({ autoLayouts: false, match: { 'nonesuch/*': 'section' } })(h.core)
            await h.runHook('loaded')
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'section.hbs' } })

            const doc = {
                id: '/documents/post.md', name: 'post', collection: 'documents',
                type: 'document', format: 'md', meta: {},
            }
            h.journal.push({ id: 1, entity: doc, operation: 'create', context: {}, options: {}, output: null })
            await h.runHook('processed', { aborted: false })

            const warnings = h.logs.filter(l =>
                l.level === 'warn' && l.args.join(' ').includes('Layout pattern'))
            assert.deepEqual(
                warnings, [],
                'an incremental cycle cannot support the conclusion, so it must not draw it',
            )
        })
    })

    it('does not repeat the pattern warning on a second cycle', async () => {
        // Watch mode runs onProcessed per cycle; a warning per cycle would be
        // noise, so it is reported once per process.
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({
                options: { workingFolder, outputFolder: path.join(workingFolder, 'out'), force: true },
            })
            layouts({ autoLayouts: false, match: { 'nonesuch/*': 'section' } })(h.core)
            await h.runHook('loaded')
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'section.hbs' } })

            for (const id of [1, 2]) {
                h.journal.push({
                    id,
                    entity: { id: `/documents/p${id}.md`, collection: 'documents', name: `p${id}`, format: 'md', meta: {} },
                    operation: 'create', context: {}, options: {}, output: null,
                })
                await h.runHook('processed', { aborted: false })
            }

            const warnings = h.logs.filter(l =>
                l.level === 'warn' && l.args.join(' ').includes('Layout pattern'))
            assert.equal(warnings.length, 1, 'warned once, not once per cycle')
        })
    })

    it('warns when a render-requested entity (carries correlationId) matches no layout', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({
                options: { workingFolder, outputFolder: path.join(workingFolder, 'out') },
            })
            layouts({ autoLayouts: true })(h.core)
            await h.runHook('loaded')

            // A render-submitted entity: no meta.layout, name won't
            // auto-match any layout, and it carries useRenderer's
            // correlationId under entity.options.
            const rendered = {
                id: '/archive/franchises/38f8.json',
                collection: 'archive',
                name: 'franchises/38f8',
                format: 'json',
                meta: { company: 'Acme' },
                options: { correlationId: 'abc-123' },
            }
            h.journal.push({ id: 99, entity: rendered, operation: 'create', context: {}, options: {}, output: null })

            await h.runHook('processed', { aborted: false })

            assert.equal(rendered.layout, undefined, 'no layout should have matched')
            const warned = h.logs.some(l =>
                l.level === 'warn' && l.args.join(' ').includes('Render requested') && l.args.join(' ').includes('no layout matched'))
            assert.ok(warned, 'should warn that the render-requested entity matched no layout')
        })
    })

    it('stays silent for a normal layout-less entity (no correlationId)', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({
                options: { workingFolder, outputFolder: path.join(workingFolder, 'out') },
            })
            layouts({ autoLayouts: true })(h.core)
            await h.runHook('loaded')

            // Same shape, but NOT a render request — no correlationId.
            const plain = {
                id: '/files/data/blob.json',
                collection: 'files',
                name: 'data/blob',
                format: 'json',
                meta: {},
            }
            h.journal.push({ id: 99, entity: plain, operation: 'create', context: {}, options: {}, output: null })

            await h.runHook('processed', { aborted: false })

            const warned = h.logs.some(l => l.level === 'warn' && l.args.join(' ').includes('Render requested'))
            assert.equal(warned, false, 'normal layout-less files must not trigger the render warning')
        })
    })

    // Layouts go through the frontmatter pipeline like documents do.
    // The layouts plugin reads the file at sync time and populates
    // entity.content; the frontmatter plugin then walks the journal at
    // onProcess and lifts YAML into entity.meta. The two plugins
    // compose via the journal contract alone — no cross-imports.
    it('onImport reads layout content from disk so frontmatter can populate entity.meta', async () => {
        await withTempWorking(async (workingFolder) => {
            const layoutsFolder = path.join(workingFolder, 'layouts')
            await mkdir(layoutsFolder, { recursive: true })
            await writeFile(path.join(layoutsFolder, 'article.hbs'),
                '---\nmatch: "@/articles/*"\nmcpUi:\n  mode: preview\n  description: "Article preview"\n  actions: ["approve","reject"]\n---\n<article>{{title}}</article>\n')

            const h = createHarness({ options: { workingFolder, outputFolder: path.join(workingFolder, 'out') } })
            layouts()(h.core)
            frontMatter()(h.core)
            await h.runHook('loaded')
            await h.runHook('import')

            const created = h.journal.find(e => e.operation === 'create' && e.entity?.id === '/layouts/article.hbs')
            assert.ok(created, 'expected a journal CREATE for the layout')
            assert.ok(created.entity.content?.includes('match: "@/articles/*"'),
                'layout entity.content should carry the raw file bytes before frontmatter runs')

            // Frontmatter plugin runs onProcess against the same journal,
            // strips the YAML, and lifts the metadata into entity.meta.
            await h.runHook('process')

            assert.equal(created.entity.meta?.match, '@/articles/*')
            assert.equal(created.entity.meta?.mcpUi?.mode, 'preview')
            assert.equal(created.entity.meta?.mcpUi?.description, 'Article preview')
            assert.deepEqual(created.entity.meta?.mcpUi?.actions, ['approve', 'reject'])
            // entity.content is now the stripped body — no YAML, no leading ---.
            assert.equal(created.entity.content.trim(), '<article>{{title}}</article>')
        })
    })

    it('onProcessed attaches entity.layout from the catalog (post-frontmatter strip), not the raw state map', async () => {
        // The layouts plugin's in-memory state map (runtime.state.layouts.layouts)
        // is populated at sync time with the RAW file body — YAML and all.
        // The front-matter plugin's onProcess pass updates the CATALOG
        // entity's content (via updateEntry), not the state map. If
        // onProcessed naively attached entity.layout = layouts[name],
        // the renderer would receive the raw file via entity.layout.content
        // and emit YAML verbatim. The fix: resolve the layout from the
        // catalog by id, falling back to the state map only when the
        // catalog hasn't caught up. This test pins that contract.
        await withTempWorking(async (workingFolder) => {
            const layoutsFolder = path.join(workingFolder, 'layouts')
            await mkdir(layoutsFolder, { recursive: true })
            await writeFile(path.join(layoutsFolder, 'article.hbs'),
                '---\nmatch: "@/articles/*"\nmcpUi:\n  mode: preview\n---\n<article>{{title}}</article>\n')

            const h = createHarness({ options: { workingFolder, outputFolder: path.join(workingFolder, 'out') } })
            layouts()(h.core)
            frontMatter()(h.core)
            await h.runHook('loaded')
            await h.runHook('import')

            // Add a document that explicitly names the layout — exercises
            // the `entity.meta.layout = '...'` branch in onProcessed.
            const doc = {
                id: '/documents/article.md',
                collection: 'documents',
                type: 'document',
                name: 'article',
                meta: { layout: 'article' },
                content: 'body',
            }
            h.journal.push({ id: 99, entity: doc, operation: 'create', context: {}, options: {}, output: null })

            // process strips frontmatter on the catalog layout entity.
            await h.runHook('process')
            // processed walks the document journal and attaches the layout.
            await h.runHook('processed')

            // entity.layout MUST come from the catalog (clean) — not from
            // the raw state map. If the raw state map leaked in, content
            // would still start with `---\nmatch:...`.
            assert.ok(doc.layout, 'expected onProcessed to attach a layout to the document')
            assert.ok(!doc.layout.content?.includes('match: "@/articles/*"'),
                'attached layout content must be post-frontmatter-strip (catalog), not the raw state-map entry')
            assert.equal(doc.layout.content.trim(), '<article>{{title}}</article>')
        })
    })

    it('onSync CREATE reads layout content from disk so frontmatter can run on updates', async () => {
        await withTempWorking(async (workingFolder) => {
            const layoutsFolder = path.join(workingFolder, 'layouts')
            await mkdir(layoutsFolder, { recursive: true })
            await writeFile(path.join(layoutsFolder, 'card.hbs'),
                '---\nmode: edit\n---\n<form>{{title}}</form>\n')

            const h = createHarness({ options: { workingFolder, outputFolder: path.join(workingFolder, 'out') } })
            layouts()(h.core)
            frontMatter()(h.core)
            await h.runHook('loaded')
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'card.hbs' } })
            await h.runHook('process')

            const created = h.journal.find(e => e.operation === 'create' && e.entity?.id === '/layouts/card.hbs')
            assert.ok(created)
            assert.equal(created.entity.meta?.mode, 'edit')
            assert.equal(created.entity.content.trim(), '<form>{{title}}</form>')
        })
    })

    it('onSync CREATE returns empty content (and stays silent at debug) when the file is missing', async () => {
        // Sync events can synthetically arrive without a corresponding
        // file (test harness usage; rare race in production). The plugin
        // logs at debug and proceeds with empty content rather than
        // throwing — downstream renderers surface the real issue.
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({ options: { workingFolder, outputFolder: path.join(workingFolder, 'out') } })
            layouts()(h.core)
            await h.runHook('loaded')
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'ghost.hbs' } })

            const created = h.journal.find(e => e.operation === 'create')
            assert.ok(created)
            assert.equal(created.entity.content, '')
            assert.ok(h.logs.some(l => l.level === 'debug' && l.args.join(' ').includes('unreadable')),
                'expected a debug log noting the missing layout file')
        })
    })

    it('onSync returns false when relativePath is missing', async () => {
        const h = createHarness()
        layouts()(h.core)
        assert.equal(await h.runSync('layouts', { action: 'create', context: {} }), false)
    })

    it('onComplete writes the rendered output to disk by default', async () => {
        await withTempWorking(async (workingFolder) => {
            const outputFolder = path.join(workingFolder, 'out')
            const h = createHarness({ options: { workingFolder, outputFolder } })
            layouts()(h.core)
            await h.runHook('loaded')

            const entity = {
                id: '/documents/page.md',
                collection: 'documents',
                name: 'page',
                destination: '/page.html',
                layout: { name: 'page', format: 'html' },
            }
            await h.runHook('complete', { entity, options: {}, output: { result: '<h1>Hi</h1>' } })

            const written = path.join(outputFolder, 'page.html')
            await assert.doesNotReject(() => access(written), 'expected the file to be written')
        })
    })

    it('onComplete with entity.options.save === false skips the disk write (bytes-only mode)', async () => {
        await withTempWorking(async (workingFolder) => {
            const outputFolder = path.join(workingFolder, 'out')
            const h = createHarness({ options: { workingFolder, outputFolder } })
            layouts()(h.core)
            await h.runHook('loaded')

            const entity = {
                id: '/documents/page.md',
                collection: 'documents',
                name: 'page',
                destination: '/page.html',
                layout: { name: 'page', format: 'html' },
                options: { save: false },
            }
            await h.runHook('complete', { entity, options: {}, output: { result: '<h1>Hi</h1>' } })

            const written = path.join(outputFolder, 'page.html')
            await assert.rejects(() => access(written), 'expected NO file to be written')
        })
    })

    // The cleanUrls × postprocess interaction lives in onBeforeRender's
    // destination-assignment block. The engine's postprocess queue is
    // now a plain changeExtension swap (no peek at runtime.config.layouts);
    // the layouts plugin compensates by leaving destination flat
    // (`/foo.html`) when the layout declares a postprocessor, so the
    // engine's swap naturally produces `/foo.pdf`. If layouts ever goes
    // back to writing `/foo/index.html` for a postprocessor-bearing
    // layout, the engine emits `/foo/index.pdf` and the served-URL
    // contract breaks. This test pins the decoupling.
    describe('cleanUrls × postprocess destination assignment', () => {
        // Harness for driving onBeforeRender against a single seeded
        // entity. Stubs the refs surface so the incremental dispatch
        // path picks the entity up via inverseClosureOf instead of the
        // SQL --force path (which would need useDatabase).
        async function runBeforeRender({ cleanUrls, postprocessor }) {
            return withTempWorking(async (workingFolder) => {
                const entity = {
                    id: '/documents/foo.md',
                    collection: 'documents',
                    type: 'document',
                    name: 'foo',
                    format: 'md',
                    time: 1,
                    meta: {},
                    layout: {
                        name: 'page',
                        template: 'hbs',
                        format: 'html',
                        ...(postprocessor ? { postprocessor } : {}),
                    },
                }
                const h = createHarness({
                    options: {
                        workingFolder,
                        outputFolder: path.join(workingFolder, 'out'),
                        force: false,
                    },
                    entities: [entity],
                })
                // Incremental-dispatch path: refs.inverseClosureOf returns
                // the seed set; manifest is left undefined (the ?. chains
                // tolerate it).
                h.runtime.refs = {
                    inverseClosureOf: () => new Set([entity.id]),
                }
                layouts({ cleanUrls })(h.core)
                await h.runHook('loaded')
                // Seed a journal mutation so the incremental dispatch's
                // useJournal walk finds it.
                h.journal.push({
                    id: 99,
                    entity,
                    operation: 'create',
                    context: {},
                    options: {},
                    output: null,
                })
                await h.runHook('beforeRender', { aborted: false })
                assert.equal(h.renderTasks.length, 1, 'expected one render task to be queued')
                return h.renderTasks[0].entity.destination
            })
        }

        it('cleanUrls on, no postprocessor → /foo/index.html (folder transform applied)', async () => {
            const dest = await runBeforeRender({ cleanUrls: true, postprocessor: null })
            assert.equal(dest, path.join('/foo', 'index.html'))
        })

        it('cleanUrls on, layout has postprocessor → /foo.html (folder transform skipped so engine swap yields /foo.<ext>)', async () => {
            const dest = await runBeforeRender({ cleanUrls: true, postprocessor: 'pdf' })
            assert.equal(dest, '/foo.html')
        })

        it('cleanUrls off, layout has postprocessor → /foo.html (basic shape, cleanUrls irrelevant)', async () => {
            const dest = await runBeforeRender({ cleanUrls: false, postprocessor: 'pdf' })
            assert.equal(dest, '/foo.html')
        })
    })

    it('onComplete writes the intermediate to previewFolder (not outputFolder) when options.save:false and a postprocessor is configured', async () => {
        await withTempWorking(async (workingFolder) => {
            const outputFolder = path.join(workingFolder, 'out')
            const previewFolder = path.join(workingFolder, 'runtime', 'preview')
            const h = createHarness({ options: { workingFolder, outputFolder, previewFolder } })
            layouts()(h.core)
            await h.runHook('loaded')

            // Intermediate: postprocessor is configured, no origin yet
            // (we haven't entered the postprocess phase).
            // options.save:false means the FINAL output is skipped, but
            // the intermediate still needs to land somewhere so the
            // postprocessor can read it — that "somewhere" is
            // previewFolder, not outputFolder. Keeps outputFolder
            // clean for previews.
            const intermediate = {
                id: '/documents/r.md',
                collection: 'documents',
                name: 'r',
                destination: '/r.html',
                layout: { name: 'r', format: 'html', postprocessor: 'pdf' },
                options: { save: false },
            }
            await h.runHook('complete', { entity: intermediate, options: {}, output: { result: '<h1>R</h1>' } })

            // Lands in previewFolder, not outputFolder.
            await assert.doesNotReject(
                () => access(path.join(previewFolder, 'r.html')),
                'intermediate must be written to previewFolder for postprocess to consume',
            )
            await assert.rejects(
                () => access(path.join(outputFolder, 'r.html')),
                'intermediate must NOT appear in outputFolder during preview flow',
            )
        })
    })
})

describe('layouts plugin: multi-layouts (matching)', () => {
    it('meta.layouts array assigns multiple layouts to one entity', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({
                options: { workingFolder, outputFolder: path.join(workingFolder, 'out') },
            })
            layouts()(h.core)
            await h.runHook('loaded')
            // Layout names are derived from the filename minus its
            // template AND format extensions (see getFormatInfo). So
            // `post.html.hbs` has name 'post'; `post-email.eml.hbs` has
            // name 'post-email'. Distinct names → both land in the state
            // map.
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post.html.hbs' } })
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post-email.eml.hbs' } })

            const doc = {
                id: '/documents/blog/welcome.md',
                collection: 'documents',
                name: 'blog/welcome',
                format: 'md',
                meta: { layouts: ['post', 'post-email'] },
            }
            h.journal.push({ id: 1, entity: doc, operation: 'create', context: {}, options: {}, output: null })
            await h.runHook('processed', { aborted: false })

            assert.equal(doc.layouts.length, 2)
            assert.deepEqual(doc.layouts.map(l => l.name).sort(), ['post', 'post-email'])
            assert.equal(doc.layout.name, 'post', 'entity.layout back-compat = first layout')
        })
    })

    it('errors when both meta.layout and meta.layouts are set', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({
                options: { workingFolder, outputFolder: path.join(workingFolder, 'out') },
            })
            layouts()(h.core)
            await h.runHook('loaded')
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post.hbs' } })

            const doc = {
                id: '/documents/blog/welcome.md',
                collection: 'documents',
                name: 'blog/welcome',
                format: 'md',
                meta: { layout: 'post', layouts: ['post'] },
            }
            h.journal.push({ id: 1, entity: doc, operation: 'create', context: {}, options: {}, output: null })
            await h.runHook('processed', { aborted: false })

            assert.deepEqual(doc.layouts, [], 'resolution failed → no layouts')
            const erred = h.logs.some(l =>
                l.level === 'error' && l.args.join(' ').includes('both \'meta.layout\' and \'meta.layouts\''))
            assert.ok(erred, 'should log a clear error about the dual-key collision')
        })
    })

    it('options.match patterns multi-match — every matching pattern contributes', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({
                options: { workingFolder, outputFolder: path.join(workingFolder, 'out') },
            })
            layouts({ match: { '@/blog/*': 'post', '@/**': 'fallback' } })(h.core)
            await h.runHook('loaded')
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post.hbs' } })
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'fallback.hbs' } })

            const doc = {
                id: '/documents/blog/welcome.md',
                collection: 'documents',
                name: 'blog/welcome',
                format: 'md',
                meta: {},
            }
            h.journal.push({ id: 1, entity: doc, operation: 'create', context: {}, options: {}, output: null })
            await h.runHook('processed', { aborted: false })

            // Both patterns match `/documents/blog/welcome.md` — get both layouts.
            assert.equal(doc.layouts.length, 2)
            const names = doc.layouts.map(l => l.name).sort()
            assert.deepEqual(names, ['fallback', 'post'])
        })
    })

    it('autoLayouts stays single-match (no multi-match fanout)', async () => {
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({
                options: { workingFolder, outputFolder: path.join(workingFolder, 'out') },
            })
            layouts({ autoLayouts: true })(h.core)
            await h.runHook('loaded')
            // Single auto-layout candidate matches the entity name.
            // The peel ladder is intentionally first-wins; the test
            // verifies multi-match doesn't apply here (entity gets one
            // layout, not many).
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post.hbs' } })

            const doc = {
                id: '/documents/post.md',
                collection: 'documents',
                name: 'post',
                format: 'md',
                meta: {},
            }
            h.journal.push({ id: 1, entity: doc, operation: 'create', context: {}, options: {}, output: null })
            await h.runHook('processed', { aborted: false })

            assert.equal(doc.layouts.length, 1, 'autoLayouts is fallback-first-wins, not multi-match')
            assert.equal(doc.layouts[0].name, 'post')
        })
    })
})

describe('layouts plugin: multi-layouts (collision)', () => {
    it('drops both render tasks when two layouts produce the same destination', async () => {
        await withTempWorking(async (workingFolder) => {
            const outputFolder = path.join(workingFolder, 'out')
            const doc = {
                id: '/documents/blog/welcome.md',
                collection: 'documents',
                name: 'blog/welcome',
                format: 'md',
                meta: { layouts: ['post', 'post-card'] },
            }
            const h = createHarness({
                options: { workingFolder, outputFolder },
                entities: [doc],
            })
            // Incremental-dispatch path: refs.inverseClosureOf returns
            // the seed; the dispatcher hydrates the entity by id.
            h.runtime.refs = { inverseClosureOf: () => new Set([doc.id]) }
            layouts()(h.core)
            await h.runHook('loaded')
            // Both layouts produce `.html` for the same entity name
            // (post → /welcome.html and post-card → /welcome.html).
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post.html.hbs' } })
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post-card.html.hbs' } })

            h.journal.push({ id: 1, entity: doc, operation: 'create', context: {}, options: {}, output: null })
            await h.runHook('processed', { aborted: false })
            await h.runHook('beforeRender', { aborted: false })

            assert.equal(h.renderTasks.length, 0, 'collision must skip every task for the entity')
            const erred = h.logs.some(l =>
                l.level === 'error' && l.args.join(' ').includes('Layout collision'))
            assert.ok(erred, 'should log the collision with both layout names')
        })
    })

    it('no collision when two layouts produce different formats', async () => {
        await withTempWorking(async (workingFolder) => {
            const outputFolder = path.join(workingFolder, 'out')
            const doc = {
                id: '/documents/blog/welcome.md',
                collection: 'documents',
                name: 'blog/welcome',
                format: 'md',
                meta: { layouts: ['post', 'post-email'] },
            }
            const h = createHarness({
                options: { workingFolder, outputFolder },
                entities: [doc],
            })
            h.runtime.refs = { inverseClosureOf: () => new Set([doc.id]) }
            layouts()(h.core)
            await h.runHook('loaded')
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post.html.hbs' } })
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post-email.eml.hbs' } })

            h.journal.push({ id: 1, entity: doc, operation: 'create', context: {}, options: {}, output: null })
            await h.runHook('processed', { aborted: false })
            await h.runHook('beforeRender', { aborted: false })

            assert.equal(h.renderTasks.length, 2, 'one task per layout, different extensions')
            const destinations = h.renderTasks.map(t => t.entity.destination).sort()
            // cleanUrls defaults to true and applies to `html` ONLY, so the
            // page folds into a folder while the email keeps its flat name.
            assert.deepEqual(destinations, ['/blog/welcome.eml', '/blog/welcome/index.html'])
        })
    })
})

describe('layouts plugin: multi-layouts (destination template)', () => {
    it('frontmatter destination template overrides the default derivation', async () => {
        await withTempWorking(async (workingFolder) => {
            const outputFolder = path.join(workingFolder, 'out')
            const doc = {
                id: '/documents/blog/welcome.md',
                collection: 'documents',
                name: 'blog/welcome',
                format: 'md',
                meta: { layouts: ['post-card'] },
            }
            const h = createHarness({
                options: { workingFolder, outputFolder },
                entities: [doc],
            })
            h.runtime.refs = { inverseClosureOf: () => new Set([doc.id]) }
            layouts()(h.core)
            await h.runHook('loaded')
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post-card.html.hbs' } })
            // Inject meta.destination on the layout state entry (would
            // normally come from the front-matter plugin processing the
            // layout). resolveLayout falls back to stateEntry when the
            // catalog mock doesn't have the layout row.
            const cardLayout = h.runtime.state.layouts.layouts['post-card']
            cardLayout.meta = { destination: '/cards/{{entity.name}}.html' }

            h.journal.push({ id: 1, entity: doc, operation: 'create', context: {}, options: {}, output: null })
            await h.runHook('processed', { aborted: false })
            await h.runHook('beforeRender', { aborted: false })

            assert.equal(h.renderTasks.length, 1)
            assert.equal(h.renderTasks[0].entity.destination, '/cards/blog/welcome.html')
        })
    })

    it('destination template that resolves to a path-traversal is rejected', async () => {
        await withTempWorking(async (workingFolder) => {
            const outputFolder = path.join(workingFolder, 'out')
            const doc = {
                id: '/documents/blog/x.md',
                collection: 'documents',
                name: 'blog/x',
                format: 'md',
                meta: { layouts: ['evil'] },
            }
            const h = createHarness({
                options: { workingFolder, outputFolder },
                entities: [doc],
            })
            h.runtime.refs = { inverseClosureOf: () => new Set([doc.id]) }
            layouts()(h.core)
            await h.runHook('loaded')
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'evil.html.hbs' } })
            const evilLayout = h.runtime.state.layouts.layouts['evil']
            evilLayout.meta = { destination: '../../../etc/passwd' }

            h.journal.push({ id: 1, entity: doc, operation: 'create', context: {}, options: {}, output: null })
            await h.runHook('processed', { aborted: false })
            await assert.rejects(
                () => h.runHook('beforeRender', { aborted: false }),
                /path-traversal/,
            )
        })
    })
})

describe('layouts plugin: destination is persisted (mikser-io#1)', () => {
    // entity.destination used to exist only as a per-render-task field and
    // was never written back, so the catalog had none — and runtime.href(),
    // which needs the TARGET's destination to build a relative URL, fell
    // through and returned the whole entity instead of { url }.
    async function processOne({ layoutFile, entity, options }) {
        return withTempWorking(async (workingFolder) => {
            const h = createHarness({
                options: { workingFolder, outputFolder: path.join(workingFolder, 'out') },
            })
            layouts(options)(h.core)
            await h.runHook('loaded')
            await h.runSync('layouts', { action: 'create', context: { relativePath: layoutFile } })
            h.journal.push({ id: 1, entity, operation: 'create', context: {}, options: {}, output: null })
            await h.runHook('processed', { aborted: false })
            return entity
        })
    }

    const doc = (name) => ({
        id: `/documents/${name}.md`, collection: 'documents', name, format: 'md', meta: {},
    })

    it('stamps a cleanUrls destination onto the entity', async () => {
        const out = await processOne({
            layoutFile: 'page.hbs',
            entity: { ...doc('contacts'), meta: { layout: 'page' } },
            options: { cleanUrls: true },
        })
        assert.equal(out.destination, '/contacts/index.html')
    })

    it('stamps a flat destination when cleanUrls is off', async () => {
        const out = await processOne({
            layoutFile: 'page.hbs',
            entity: { ...doc('contacts'), meta: { layout: 'page' } },
            options: { cleanUrls: false },
        })
        assert.equal(out.destination, '/contacts.html')
    })

    it('leaves an index page flat — cleanUrls already special-cases it', async () => {
        const out = await processOne({
            layoutFile: 'page.hbs',
            entity: { ...doc('index'), meta: { layout: 'page' } },
            options: { cleanUrls: true },
        })
        assert.equal(out.destination, '/index.html')
    })

    it('is absent when no layout matched, rather than a bogus path', async () => {
        const out = await processOne({
            layoutFile: 'page.hbs',
            entity: doc('orphan'),
            options: { autoLayouts: false, match: {} },
        })
        assert.equal(out.destination, undefined)
    })
})

describe('layouts plugin: cleanUrls default (layouts#1)', () => {
    // It had no default, so unset it was falsy and pages landed at
    // `hera.html` — while the README's options block read as a defaults
    // table showing `cleanUrls: true`. No warning, site works, wrong URL
    // shape everywhere.
    async function destinationFor(options) {
        return withTempWorking(async (workingFolder) => {
            const h = createHarness({
                options: { workingFolder, outputFolder: path.join(workingFolder, 'out') },
            })
            layouts(options)(h.core)
            await h.runHook('loaded')
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'page.hbs' } })
            const entity = {
                id: '/documents/hera.md', collection: 'documents', name: 'hera',
                format: 'md', meta: { layout: 'page' },
            }
            h.journal.push({ id: 1, entity, operation: 'create', context: {}, options: {}, output: null })
            await h.runHook('processed', { aborted: false })
            return entity.destination
        })
    }

    it('defaults to on', async () => {
        assert.equal(await destinationFor({}), '/hera/index.html')
    })

    it('false still gives flat output', async () => {
        assert.equal(await destinationFor({ cleanUrls: false }), '/hera.html')
    })

    it('explicit true is the same as the default', async () => {
        assert.equal(await destinationFor({ cleanUrls: true }), '/hera/index.html')
    })
})

describe('layouts plugin: destination template helpers (layouts#3)', () => {
    // Without helpers a template can only interpolate whole values, so a
    // path cannot be derived from PART of entity.name — which blocks
    // per-language output roots on a catalog holding several languages.
    const render = async (tpl, entity) => {
        const { compileDestinationTemplate } = await import('../lib/destination.js')
        return compileDestinationTemplate(tpl)({ entity })
    }

    it('strips a leading language segment — the case that needed this', async () => {
        assert.equal(
            await render("/{{ after entity.name '/' }}/index.html", { name: 'bg/kontakti' }),
            '/kontakti/index.html')
    })

    it('keeps the rest of a nested path intact', async () => {
        assert.equal(
            await render("/{{ after entity.name '/' }}/index.html", { name: 'bg/web/booking' }),
            '/web/booking/index.html')
    })

    it('replace is literal, not a regex', async () => {
        // A destination is a path; a stray metacharacter must not silently
        // change what matches.
        assert.equal(await render("/{{ replace entity.name '.' '-' }}", { name: 'a.b.c' }), '/a-b-c')
        assert.equal(await render("/{{ replace entity.name 'a.c' 'X' }}", { name: 'abc' }), '/abc')
    })

    it('covers the path-shaping set', async () => {
        assert.equal(await render('/{{ before entity.name "/" }}', { name: 'bg/x' }), '/bg')
        assert.equal(await render('/{{ afterLast entity.name "/" }}', { name: 'a/b/c' }), '/c')
        assert.equal(await render('/{{ beforeLast entity.name "/" }}', { name: 'a/b/c' }), '/a/b')
        assert.equal(await render('/{{ dirname entity.name }}', { name: 'a/b/c' }), '/a/b')
        assert.equal(await render('/{{ basename entity.name }}', { name: 'a/b/c' }), '/c')
        assert.equal(await render('/{{ lower entity.name }}', { name: 'A/B' }), '/a/b')
        assert.equal(await render('/{{ upper entity.name }}', { name: 'a' }), '/A')
    })

    it('handles a missing value without emitting "undefined" into a path', async () => {
        assert.equal(await render("/{{ after entity.nope '/' }}x", { name: 'a' }), '/x')
    })

    it('does not register helpers on the shared handlebars instance', async () => {
        // Registering on the default export would leak `replace` into a
        // project's own renderHbs layouts, appearing from nowhere.
        const handlebars = (await import('handlebars')).default
        for (const name of ['after', 'before', 'replace', 'dirname', 'basename']) {
            assert.equal(handlebars.helpers[name], undefined, `${name} leaked globally`)
        }
    })

    it('still rejects path traversal after helpers run', async () => {
        const { compileDestinationTemplate, sanitizeDestination } = await import('../lib/destination.js')
        const out = compileDestinationTemplate("/{{ after entity.name '/' }}")({ entity: { name: 'x/../../etc/passwd' } })
        assert.throws(() => sanitizeDestination(out), /path-traversal/)
    })
})

describe('layouts plugin: a sidecar is a tracked input (layouts#4)', () => {
    // The sidecar is where a mikser site's data layer lives, and it was the
    // one file that could be edited without effect: `.js` is excluded from
    // the scan, so it was not an entity, not watched as an input, and not
    // part of any hash. Nothing depended on it, so nothing re-rendered —
    // silently, looking exactly like a bug in your own code.
    async function scan(files, { existing = [] } = {}) {
        return withTempWorking(async (workingFolder) => {
            const layoutsFolder = path.join(workingFolder, 'layouts')
            await mkdir(path.join(layoutsFolder, 'lib'), { recursive: true })
            for (const [rel, body] of Object.entries(files)) {
                await writeFile(path.join(layoutsFolder, rel), body)
            }
            const h = createHarness({
                options: { workingFolder, outputFolder: path.join(workingFolder, 'out') },
                entities: existing,
            })
            layouts()(h.core)
            await h.runHook('loaded')
            await h.runHook('import')
            const created = h.journal.filter(e => ['create', 'update'].includes(e.operation))
            return { h, layoutsFolder, emitted: created.map(e => e.entity), checksums:
                Object.fromEntries(created.map(e => [e.entity.name, e.entity.checksum])) }
        })
    }

    it('folds the sidecar into the layout checksum, so editing it changes the hash', async () => {
        const before = await scan({ 'page.liquid': '<p>x</p>', 'page.js': 'export const load = () => ({ a: 1 })' })
        const after  = await scan({ 'page.liquid': '<p>x</p>', 'page.js': 'export const load = () => ({ a: 2 })' })
        assert.ok(before.checksums.page, 'the layout was emitted')
        assert.notEqual(before.checksums.page, after.checksums.page,
                        'a sidecar edit must change the layout checksum')
    })

    it('an unchanged sidecar leaves the checksum alone', async () => {
        const a = await scan({ 'page.liquid': '<p>x</p>', 'page.js': 'export const load = () => ({})' })
        const b = await scan({ 'page.liquid': '<p>x</p>', 'page.js': 'export const load = () => ({})' })
        assert.equal(a.checksums.page, b.checksums.page)
    })

    it('a SHARED script under the folder invalidates every layout', async () => {
        // A sidecar's own imports (layouts/lib/context.js and friends) would
        // otherwise need a module-graph walk. Treating any shared .js change
        // as invalidating every layout is what a layouts folder can afford,
        // and it is predictable — which a partial graph walk would not be.
        const before = await scan({
            'page.liquid': '<p>x</p>', 'post.liquid': '<p>y</p>',
            'lib/context.js': 'export const chrome = 1',
        })
        const after = await scan({
            'page.liquid': '<p>x</p>', 'post.liquid': '<p>y</p>',
            'lib/context.js': 'export const chrome = 2',
        })
        assert.notEqual(before.checksums.page, after.checksums.page)
        assert.notEqual(before.checksums.post, after.checksums.post)
    })

    it('catalogues a sidecar as an entity of its own', async () => {
        // A sidecar is where a site's data layer lives, and it used to be the
        // one source file no tool could read, search or resolve: an agent could
        // see what a template does but not what feeds it.
        const { emitted } = await scan({ 'page.liquid': '<p>x</p>', 'page.js': 'export const load = () => ({})' })
        assert.deepEqual(emitted.map(e => e.id).sort(), ['/layouts/page.js', '/layouts/page.liquid'])
    })

    it('keeps the .js, so a sidecar cannot be mistaken for its layout', async () => {
        // The original objection to cataloguing it: stripping the extension
        // produces a phantom /layouts/page beside the real
        // /layouts/page.liquid, and `page` is how layouts are resolved.
        const { emitted } = await scan({ 'page.liquid': '<p>x</p>', 'page.js': 'export const load = () => ({})' })
        const sidecar = emitted.find(e => e.id === '/layouts/page.js')
        assert.equal(sidecar.name, 'page.js', 'the name keeps its extension too')
        assert.equal(sidecar.type, 'sidecar')
        assert.ok(!emitted.some(e => e.id === '/layouts/page'), 'no phantom')
    })

    it('carries the source, so it can be read and searched', async () => {
        const source = 'export const load = () => ({ children: [] })'
        const { emitted } = await scan({ 'page.liquid': '<p>x</p>', 'page.js': source })
        assert.equal(emitted.find(e => e.id === '/layouts/page.js').content, source)
    })

    it('does not put a sidecar in the layouts name map', async () => {
        // That map answers "which template renders this". A sidecar renders
        // nothing, and an entry there would shadow a real layout called `page`.
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({ options: { workingFolder, outputFolder: path.join(workingFolder, 'out') } })
            await mkdir(path.join(workingFolder, 'layouts'), { recursive: true })
            await writeFile(path.join(workingFolder, 'layouts', 'page.liquid'), '<p>x</p>')
            await writeFile(path.join(workingFolder, 'layouts', 'page.js'), 'export const load = () => ({})')
            layouts()(h.core)
            await h.runHook('loaded')
            await h.runHook('import')
            const map = h.runtime.state.layouts.layouts
            assert.ok(map.page, 'the real layout is there')
            assert.equal(map.page.id, '/layouts/page.liquid')
            assert.equal(map['page.js'], undefined, 'the sidecar is not')
        })
    })

    it('still treats a JS-AUTHORED layout as a layout, not a sidecar', async () => {
        // post.hbs.js is a template written as JS; its id drops the trailing
        // .js. Only a .js whose remaining name has no extension is a sidecar.
        await withTempWorking(async (workingFolder) => {
            const h = createHarness({ options: { workingFolder, outputFolder: path.join(workingFolder, 'out') } })
            layouts()(h.core)
            await h.runHook('loaded')
            await h.runSync('layouts', { action: 'create', context: { relativePath: 'post.hbs.js' } })
            const entry = h.journal.find(e => e.operation === 'create')
            assert.equal(entry.entity.id, '/layouts/post.hbs')
        })
    })
})
