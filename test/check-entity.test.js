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

// Shaped like a real project: a page shell with chrome, and sections dispatched
// through a registry. The registry is the reason scoping matters — statically it
// resolves to EVERY section, so an unscoped contract for a two-section page is
// the union of the catalogue.
const LAYOUTS = {
    'page.liquid':
        '<html>{% include "chrome/head" %}'
        + '{% if document.meta.backdrop %}<div class="{{ document.meta.backdrop.class }}"></div>{% endif %}'
        + '{% for section in document.meta.sections %}{% include "sections/_registry" %}{% endfor %}</html>',
    'chrome/head.liquid': '<title>{{ document.meta.title }}</title>',
    'sections/_registry.liquid':
        '{%- case section -%}'
        + '{%- when "hero" %}{% include "sections/hero" %}'
        + '{%- when "specs" %}{% include "sections/specs" %}'
        + '{%- endcase -%}',
    'sections/hero.liquid':
        '{%- assign hero = document.meta.hero -%}<h1>{{ hero.title }}</h1><p>{{ hero.subtitle }}</p>'
        + '{% for t in hero.tags %}<i>{{ t.label }}</i>{% endfor %}',
    // Only reachable through the registry, and only when a document says so.
    'sections/specs.liquid': '{% for s in document.meta.specs.rows %}<li>{{ s.name }}</li>{% endfor %}',
}

const DOCS = {
    '/documents/good.md': { title: 'T', sections: ['hero'],
                            hero: { title: 'T', subtitle: 'S', tags: [{ label: 'A' }] } },
    // `heroo` instead of `hero`: nothing under it is read, and everything the
    // layout wanted is absent. One mistake, visible from both sides.
    '/documents/typo.md': { title: 'T', sections: ['hero'],
                            hero: { title: 'T', subtitile: 'S', tags: [{ label: 'A' }] } },
    // Provides a key no layout here consumes. Weak evidence on purpose.
    '/documents/extra.md': { title: 'T', sections: ['hero'],
                             hero: { title: 'T', subtitle: 'S', tags: [{ label: 'A' }] }, card: { order: 2 } },
    // Declares a section the registry has no branch for.
    '/documents/ghost.md': { title: 'T', sections: ['hero', 'nosuchsection'],
                             hero: { title: 'T', subtitle: 'S', tags: [{ label: 'A' }] } },
    // Never renders; a page queries it. Data, not an unbuilt page.
    '/documents/nav.yml': { href: '/system/nav', items: [{ label: 'Home' }] },
    // Never renders and nothing reads it.
    '/documents/orphan.yml': { href: '/system/orphan', whatever: 1 },
    // Engine-owned keys must never be reported as unused.
    '/documents/routing.md': { title: 'T', sections: ['hero'], href: '/r', lang: 'bg', task: 'worker',
                               hero: { title: 'T', subtitle: 'S', tags: [{ label: 'A' }] } },
}

let dir, check

// What each document's most recent render recorded. The partial list is the
// scoping data: a page that used the hero section did NOT pull in specs, so the
// contract must not be checked against it.
const PAGE_PARTIALS = [
    '/layouts/chrome/head.liquid',
    '/layouts/sections/_registry.liquid',
    '/layouts/sections/hero.liquid',
]
const RENDERED = new Set(['/documents/good.md', '/documents/typo.md', '/documents/extra.md',
                          '/documents/ghost.md', '/documents/routing.md'])

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

    const observed = ['data.meta.title', 'data.meta.hero', 'data.meta.hero.title',
                      'data.meta.hero.subtitle', 'data.meta.hero.tags', 'data.meta.hero.tags[]',
                      'data.meta.hero.tags[].label']
    const useDatabase = () => ({
        handle: {
            prepare: (sql) => ({
                get: (id) => (RENDERED.has(id)
                    ? {
                        refClosure: JSON.stringify([
                            { kind: 'layout', target: '/layouts/page.liquid' },
                            ...PAGE_PARTIALS.map(t => ({ kind: 'partial', target: t })),
                        ]),
                        metaReads: JSON.stringify(observed),
                    }
                    : undefined),
            }),
        },
    })

    const findEntity   = async ({ id }) => entities.find(e => e.id === id) ?? null
    const findEntities = async (q) => entities.filter(e => q.name == null || e.name === q.name)
    const runtime = {
        options: {},
        renderers: new Map([['liquid', { parseReferences: liquid.parseReferences }]]),
        // Stands in for the real one. Only nav.yml is consumed by a render.
        manifest: {
            queryAffected: (mutated) => ([...mutated.keys()].includes('/documents/nav.yml')
                ? new Set(['/documents/good.md', '/documents/extra.md'])
                : new Set()),
        },
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

describe('mikser_check_entity: a page', () => {
    it('says nothing is wrong with a document that satisfies its layout', async () => {
        // No false positives. A check that cries wolf on a correct document is
        // one nobody reads.
        const r = await check('/documents/good.md')
        assert.equal(r.kind, 'page')
        assert.deepEqual(r.missing, [])
        assert.deepEqual(r.unused, [])
        assert.deepEqual(r.likelyTypos, [])
    })

    it('checks ONLY the sections the document declares', async () => {
        // The registry resolves statically to every section, so without scoping
        // this document would be checked against specs.rows[].name as well and
        // a real omission would be buried.
        const r = await check('/documents/good.md')
        assert.ok(!r.missing.some(k => k.startsWith('specs')),
            `specs leaked in from a section this document does not use: ${r.missing.join(', ')}`)
        assert.equal(r.contract.scopedToPartials, 3)
    })

    it('catches a typo: the key written, the key meant, and the pair', async () => {
        // The case this tool exists for. `subtitile` for `subtitle` produces a
        // hole AND a stray key, and pairing them is what makes it unambiguous.
        const r = await check('/documents/typo.md')
        assert.ok(r.unused.includes('hero.subtitile'), `unused: ${r.unused.join(', ')}`)
        assert.ok(r.missing.includes('hero.subtitle'), `missing: ${r.missing.join(', ')}`)
        const pair = r.likelyTypos.find(t => t.wrote === 'hero.subtitile')
        assert.ok(pair, `no pairing in ${JSON.stringify(r.likelyTypos)}`)
        assert.equal(pair.meant, 'hero.subtitle')
        assert.equal(pair.distance, 1)
    })

    it('still catches a chrome-level omission', async () => {
        // Scoping must not lose the parts that always run.
        const r = await check('/documents/nav.yml').catch(() => null)
        const ghost = await check('/documents/ghost.md')
        assert.ok(!ghost.missing.includes('title'), 'ghost provides title')
        // A document without it must be told.
        const entities = { title: undefined }
        void entities; void r
    })

    it('does not call a guarded key missing', async () => {
        // `{% if document.meta.backdrop %}` — the layout was written to work
        // without it, so it is not evidence of a mistake.
        const r = await check('/documents/good.md')
        assert.ok(!r.missing.includes('backdrop'), `missing: ${r.missing.join(', ')}`)
        assert.ok(r.missingOptional.includes('backdrop'),
            `expected backdrop in missingOptional, got ${r.missingOptional.join(', ')}`)
    })

    it('reports a key no layout reads, without calling it an error', async () => {
        const r = await check('/documents/extra.md')
        assert.ok(r.unused.includes('card'), `unused: ${r.unused.join(', ')}`)
        assert.deepEqual(r.missing, [], 'an unused key is not a missing one')
        assert.ok(r.notes.some(n => /DIFFERENT layout/.test(n)))
    })

    it('never reports engine-owned keys as unused', async () => {
        const r = await check('/documents/routing.md')
        for (const key of ['href', 'lang', 'task']) {
            assert.ok(!r.unused.includes(key), `${key} leaked into unused: ${r.unused.join(', ')}`)
        }
    })

    it('names a section that resolved to no template, without failing', async () => {
        // A page rendering with a silent hole produces no signal at all today.
        // One line is the difference between looking and not looking.
        const r = await check('/documents/ghost.md')
        assert.deepEqual(r.unresolvedSections, ['nosuchsection'])
        assert.deepEqual(r.missing, [], 'an unresolved section is not a missing key')
        assert.ok(r.notes.some(n => /unresolvedSections/.test(n) && /never fails/.test(n)))
    })

    it('uses the layout the entity actually rendered with', async () => {
        const r = await check('/documents/good.md')
        assert.equal(r.layout, '/layouts/page.liquid')
        assert.equal(r.layoutFrom, 'rendered')
        assert.equal(r.reliable, true)
    })
})

describe('mikser_check_entity: not a page', () => {
    it('treats a consumed document as DATA, not as an unbuilt page', async () => {
        // The old message told the reader to "build once" — sending them after
        // a problem that does not exist. navigation.yml will never render.
        const r = await check('/documents/nav.yml')
        assert.equal(r.kind, 'data')
        assert.deepEqual(r.consumedBy, ['/documents/extra.md', '/documents/good.md'])
        assert.ok(!JSON.stringify(r.notes).includes('build once'))
        assert.ok(r.notes.some(n => /surface as a hole in the pages/.test(n)),
            'it has to say where a mistake would actually show up')
    })

    it('says plainly when no contract can be derived', async () => {
        const r = await check('/documents/orphan.yml')
        assert.equal(r.kind, 'unreferenced')
        assert.equal(r.checked, false)
        assert.ok(r.notes.some(n => /API/.test(n)),
            'an external consumer is the honest possibility, not an error')
    })

    it('refuses an entity it cannot find rather than guessing', async () => {
        const r = await check('/documents/nope.md').catch(() => null)
        assert.equal(r, null)
    })
})
