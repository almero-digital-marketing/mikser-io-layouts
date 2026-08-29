// Checking a document against the contract of the layout that renders it.
//
// A mistyped key does not fail a build. The section it named simply does not
// render, the page ships with a hole, and every signal reads clean. This is the
// check that catches it before it ships, and it exists because the two halves it
// needs — the layout contract and what renders actually read — are useless
// separately: the contract is blind to a sidecar, and observed reads are blind
// to a branch this document never took.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createInspect } from '../lib/inspect.js'
import { registerCheckTool } from '../lib/mcp.js'
import * as liquid from 'mikser-io-render-liquid'

const LAYOUTS = {
    'page.liquid': '<html>{% include "sections/hero" %}<p>{{ document.meta.summary }}</p></html>',
    'sections/hero.liquid':
        '{%- assign hero = document.meta.hero -%}<h1>{{ hero.title }}</h1>'
        + '{% for t in hero.tags %}<i>{{ t.label }}</i>{% endfor %}',
}

const DOCS = {
    '/documents/good.md': { summary: 'S', hero: { title: 'T', tags: [{ label: 'A' }] } },
    // `heroo` instead of `hero`: nothing under it is read, and everything the
    // layout wanted is absent. One mistake, visible from both sides.
    '/documents/typo.md': { summary: 'S', heroo: { title: 'T' } },
    // Provides a key no layout here consumes. Weak evidence on purpose.
    '/documents/extra.md': { summary: 'S', hero: { title: 'T', tags: [{ label: 'A' }] }, card: { order: 2 } },
    // Engine-owned keys must never be reported as unused.
    '/documents/routing.md': { summary: 'S', href: '/r', lang: 'bg', task: 'worker',
                               hero: { title: 'T', tags: [{ label: 'A' }] } },
}

let dir, check

before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mikser-check-'))
    const entities = []
    for (const [rel, content] of Object.entries(LAYOUTS)) {
        const uri = path.join(dir, rel)
        await mkdir(path.dirname(uri), { recursive: true })
        await writeFile(uri, content)
        entities.push({ id: `/layouts/${rel}`, name: rel.replace(/\.liquid$/, ''), uri,
                        collection: 'layouts', template: 'liquid' })
    }
    for (const [id, meta] of Object.entries(DOCS)) {
        entities.push({ id, name: id.slice(11), collection: 'documents', meta })
    }

    // A stand-in manifest. Every document rendered with page.liquid, and read
    // what a correct one would — so `unused` and `missing` are exercised
    // without needing a real build in a unit test.
    const observed = ['data.meta.summary', 'data.meta.hero', 'data.meta.hero.title',
                      'data.meta.hero.tags', 'data.meta.hero.tags[]', 'data.meta.hero.tags[].label']
    const useDatabase = () => ({
        handle: {
            prepare: (sql) => ({
                get: (id) => (DOCS[id]
                    ? (sql.includes('refClosure')
                        ? { refClosure: JSON.stringify([{ kind: 'layout', target: '/layouts/page.liquid' }]) }
                        : { metaReads: JSON.stringify(observed) })
                    : undefined),
            }),
        },
    })

    const findEntity   = async ({ id }) => entities.find(e => e.id === id) ?? null
    const findEntities = async (q) => entities.filter(e => q.name == null || e.name === q.name)
    const runtime = {
        options: {},
        renderers: new Map([['liquid', { parseReferences: liquid.parseReferences }]]),
    }
    runtime.options.layouts = {
        inspect: createInspect({ runtime, findEntity, findEntities, useDatabase, collection: 'layouts' }),
    }
    const registry = new Map()
    runtime.options.mcp = { simpleTool: (name, _d, _s, handler) => registry.set(name, handler) }
    registerCheckTool({ runtime, findEntity, findEntities, useDatabase,
                        collection: 'layouts', logger: { debug() {} } })

    check = async (id) => JSON.parse((await registry.get('mikser_check_entity')({ id })).content[0].text)
})

after(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

describe('mikser_check_entity', () => {
    it('says nothing is wrong with a document that satisfies the layout', async () => {
        // The assertion that matters most: no false positives. A check that
        // cries wolf on a correct document is one nobody reads.
        const r = await check('/documents/good.md')
        assert.deepEqual(r.missing, [])
        assert.deepEqual(r.unused, [])
        assert.deepEqual(r.likelyTypos, [])
    })

    it('names the keys the layout wants and the document lacks', async () => {
        const r = await check('/documents/typo.md')
        assert.ok(r.missing.includes('hero.title'), `missing: ${r.missing.join(', ')}`)
        assert.ok(r.missing.includes('hero.tags[].label'))
    })

    it('pairs the key written against the key meant', async () => {
        // The point of the tool. A typo shows up as a hole AND a stray key, and
        // matching one list against the other turns two weak signals into one
        // strong one.
        const r = await check('/documents/typo.md')
        const pair = r.likelyTypos.find(t => t.wrote === 'heroo')
        assert.ok(pair, `no pairing found in ${JSON.stringify(r.likelyTypos)}`)
        assert.equal(pair.meant, 'hero')
        assert.equal(pair.distance, 1)
    })

    it('reports a key no layout reads, without calling it an error', async () => {
        const r = await check('/documents/extra.md')
        assert.ok(r.unused.includes('card'), `unused: ${r.unused.join(', ')}`)
        assert.deepEqual(r.missing, [], 'an unused key is not a missing one')
        assert.ok(r.notes.some(n => /DIFFERENT layout/.test(n)),
            'the weakness of this signal has to travel with it')
    })

    it('never reports engine-owned keys as unused', async () => {
        // href, lang and task are consumed by mikser, not by any layout. Listing
        // them on every document would teach a reader to skip the list.
        const r = await check('/documents/routing.md')
        for (const key of ['href', 'lang', 'task']) {
            assert.ok(!r.unused.includes(key), `${key} leaked into unused: ${r.unused.join(', ')}`)
        }
    })

    it('counts a parent as provided when the layout reads through it', async () => {
        const r = await check('/documents/good.md')
        assert.ok(!r.missing.includes('hero'), 'hero is provided by providing its contents')
    })

    it('uses the layout the entity actually rendered with', async () => {
        const r = await check('/documents/good.md')
        assert.equal(r.layout, '/layouts/page.liquid')
        assert.equal(r.layoutFrom, 'last render')
    })

    it('refuses an entity it cannot find rather than guessing', async () => {
        const r = await check('/documents/nope.md').catch(() => null)
        assert.equal(r, null, 'a missing entity must not produce a report')
    })
})
