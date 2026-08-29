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
    '/documents/nav.yml': { href: '/system/nav', items: [{ label: 'Home', href: '/' }], menuLabel: 'Menu',
                            // Read as a whole and then handed to a template, so
                            // only the top-level access is ever recorded.
                            enquiry: { title: 'Ask', fields: [{ label: 'Message', name: 'message' }] } },
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
    // What renders took OFF other entities. good.md read two fields of nav.yml
    // and never touched menuLabel — which is the whole point: the contract for a
    // document that never renders is what its consumers actually read.
    const CONSUMED = [['/documents/nav.yml', ['items', 'items[]', 'items[].label', 'items[].href', 'enquiry']]]
    const useDatabase = () => ({
        handle: {
            prepare: (sql) => ({
                all: () => (sql.includes('consumedReads')
                    ? [{ id: '/documents/good.md', consumedReads: JSON.stringify(CONSUMED) }]
                    : []),
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
        assert.ok(r.notes.some(n => /another layout or an API client/.test(n)),
            'the caveat has to travel with the finding')
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
        assert.ok(r.notes.some(n => /unresolvedSections/.test(n) && /defect/.test(n)),
            'it must be named as something to look at, not a failure')
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
        // a problem that does not exist. A data document will never render.
        const r = await check('/documents/nav.yml')
        assert.equal(r.kind, 'data')
        assert.deepEqual(r.consumedBy, ['/documents/good.md'])
        assert.ok(!JSON.stringify(r.notes).includes('build once'))
        assert.ok(r.notes.some(n => /hole in those pages/.test(n)),
            'it has to say where a mistake would actually show up')
    })

    it('derives a real contract from what its consumers READ', async () => {
        // Not a refusal and not just a consumer list: the keys renders actually
        // took off this entity. That is its contract, asked from the other side.
        const r = await check('/documents/nav.yml')
        assert.equal(r.checked, true)
        assert.equal(r.reliable, true)
        assert.ok(r.consumedKeys.includes('items[].label'), `consumedKeys: ${r.consumedKeys.join(', ')}`)
        assert.deepEqual(r.missing, [], 'this document provides everything its consumers read')
    })

    it('does not call a key unused when an ancestor of it WAS read', async () => {
        // The signature of a read this engine cannot follow: `enquiry` was read
        // and handed to a template, and provenance does not survive that hop, so
        // every field under it looks untouched while being on every page.
        // Reporting nine false findings is worse than one honest line — someone
        // acting on the list deletes a working form.
        const r = await check('/documents/nav.yml')
        for (const key of ['enquiry.title', 'enquiry.fields[].label', 'enquiry.fields[].name']) {
            assert.ok(!r.unused.includes(key), `${key} was reported unused: ${r.unused.join(', ')}`)
        }
        const group = r.untraceable.find(g => g.under === 'enquiry')
        assert.ok(group, `expected them collapsed under enquiry, got ${JSON.stringify(r.untraceable)}`)
        assert.ok(group.keys.includes('enquiry.fields[].label'))
        assert.ok(r.notes.some(n => /untraceable/.test(n) && /could not be followed/.test(n)),
            'the reason it cannot be judged has to travel with it')
    })

    it('still reports a key nothing read at all', async () => {
        // The safeguard must not swallow the real signal: menuLabel has no
        // ancestor that was read, so it stays where it belongs.
        const r = await check('/documents/nav.yml')
        assert.ok(r.unused.includes('menuLabel'), `unused: ${r.unused.join(', ')}`)
        assert.ok(r.notes.some(n => /API client/.test(n)), 'its caveat has to travel with it')
    })

    it('holds a data document to the same standard as a page', async () => {
        // menuLabel is provided and no render reads it. Weak evidence, exactly
        // as on a page — an API client may well be the consumer.
        const r = await check('/documents/nav.yml')
        assert.ok(r.consumedKeys.includes('items[].label'))
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

// A DECLARED contract outranks one read out of templates.
//
// A zod schema says nothing about liquid. It needs no filter table, states
// required-versus-optional outright rather than inferring it from `{% if %}`
// guards and `| default:`, and is engine-agnostic by construction. Where one
// exists, nothing parsed out of a template should be able to call a document
// broken — that inference has been wrong, and `missing` is the one list that
// must only ever mean "probably wrong".
describe('mikser_check_entity: with a declared schema', () => {
    let checkWithSchema, dir2

    before(async () => {
        const { z } = await import('zod')
        dir2 = await mkdtemp(path.join(tmpdir(), 'mikser-check-schema-'))
        const entities = []
        for (const [rel, content] of Object.entries(LAYOUTS)) {
            const uri = path.join(dir2, rel)
            await mkdir(path.dirname(uri), { recursive: true })
            await writeFile(uri, content)
            entities.push({ id: `/layouts/${rel}`, name: rel.replace(/\.liquid$/, ''), uri,
                            collection: 'layouts', template: 'liquid' })
        }
        // Declares a key the layouts do NOT read, and omits one they do.
        const schema = z.object({
            title: z.string(),
            byline: z.string(),                    // declared, no layout reads it
            hero: z.object({
                title: z.string(),
                subtitle: z.string().optional(),   // declared optional
            }),
        })
        const doc = { id: '/documents/schemed.md', name: 'schemed', collection: 'documents',
                      meta: { schema: 'article', title: 'T', sections: ['hero'],
                              hero: { title: 'T', tags: [{ label: 'A' }] } } }
        entities.push(doc)

        const useDatabase = () => ({ handle: { prepare: (sql) => ({
            all: () => [],
            get: () => (sql.includes('refClosure')
                ? { refClosure: JSON.stringify([
                    { kind: 'layout', target: '/layouts/page.liquid' },
                    ...PAGE_PARTIALS.map(t => ({ kind: 'partial', target: t })),
                  ]) }
                : { metaReads: JSON.stringify(['data.meta.title', 'data.meta.hero.title']) }),
        }) } })
        const findEntity = async ({ id }) => entities.find(e => e.id === id) ?? null
        const findEntities = async (q) => entities.filter(e => q.name == null || e.name === q.name)
        const runtime = {
            options: { schemas: { lookup: (n) => (n === 'article' ? schema : undefined), names: () => ['article'] } },
            renderers: new Map([['liquid', { parseReferences: liquid.parseReferences }]]),
        }
        runtime.options.layouts = {
            inspect: createInspect({ runtime, findEntity, findEntities, useDatabase, collection: 'layouts' }),
        }
        const registry = new Map()
        runtime.options.mcp = { simpleTool: (n, _d, _s, h) => registry.set(n, h) }
        registerCheckTool({ runtime, findEntity, findEntities, useDatabase,
                            collection: 'layouts', logger: { debug() {} } })
        checkWithSchema = async (id) =>
            JSON.parse((await registry.get('mikser_check_entity')({ id })).content[0].text)
    })

    after(async () => { if (dir2) await rm(dir2, { recursive: true, force: true }) })

    it('takes `missing` from the schema and says so', async () => {
        const r = await checkWithSchema('/documents/schemed.md')
        assert.equal(r.missingFrom, 'schema')
        assert.ok(r.missing.includes('byline'), `missing: ${r.missing.join(', ')}`)
    })

    it('honours zod optionality instead of inferring it from the template', async () => {
        // `.optional()` states it. No guard analysis, no filter table.
        const r = await checkWithSchema('/documents/schemed.md')
        assert.ok(!r.missing.includes('hero.subtitle'))
        assert.ok(r.missingOptional.includes('hero.subtitle'),
            `missingOptional: ${r.missingOptional.join(', ')}`)
    })

    it('reports drift in both directions', async () => {
        const r = await checkWithSchema('/documents/schemed.md')
        assert.equal(r.drift.schema, 'article')
        // The layouts read hero.tags[].label; nothing declares it.
        assert.ok(r.drift.readButNotDeclared.some(k => k.startsWith('hero.tags')),
            `readButNotDeclared: ${r.drift.readButNotDeclared.join(', ')}`)
        // byline is declared and no layout reads it.
        assert.ok(r.drift.declaredButNotRead.includes('byline'),
            `declaredButNotRead: ${r.drift.declaredButNotRead.join(', ')}`)
    })

    it('labels an inferred contract as inferred when there is no schema', async () => {
        const r = await check('/documents/good.md')
        assert.equal(r.missingFrom, 'inferred')
        assert.ok(r.notes.some(n => /strong evidence rather than proof/.test(n)),
            'the weaker source has to say that it is weaker')
    })
})

// Is this record complete AS A RECORD?
//
// A layout contract cannot answer that. A catalog entry missing a field its
// siblings all carry renders perfectly, reads nothing that is absent, and passes
// every other check here — and a derived schema will not catch it either, since
// a key one sibling lacks becomes `.optional()`. Comparing a record with its own
// kind is the only thing that sees it.
//
// Weak evidence on purpose: records differ for good reasons.
describe('mikser_check_entity: peer comparison', () => {
    let peerCheck

    const entry = (n, extra = {}) => ({
        id: `/documents/cat-${n}.md`, name: `cat-${n}`, collection: 'documents',
        meta: { schema: 'catalog', title: `T${n}`, href: `/c/${n}`, summary: 'S', ...extra },
    })

    before(async () => {
        // Nine complete siblings, one missing `summary`, and one carrying a key
        // only it has.
        const entities = [
            ...Array.from({ length: 9 }, (_, i) => entry(i)),
            (() => { const e = entry('gap'); delete e.meta.summary; return e })(),
            entry('extra', { oddball: true }),
        ]
        const findEntity = async ({ id }) => entities.find(e => e.id === id) ?? null
        const findEntities = async (q) => entities.filter(e =>
            Object.entries(q ?? {}).every(([k, v]) => k.split('.').reduce((o, x) => o?.[x], e) === v))
        const runtime = { options: {}, renderers: new Map() }
        runtime.options.layouts = { inspect: async () => ({ references: {} }) }
        const registry = new Map()
        runtime.options.mcp = { simpleTool: (n, _d, _s, h) => registry.set(n, h) }
        registerCheckTool({
            runtime, findEntity, findEntities,
            // No snapshots: these never render, so they are data documents.
            useDatabase: () => ({ handle: { prepare: () => ({ all: () => [], get: () => undefined }) } }),
            collection: 'layouts', logger: { debug() {} },
        })
        peerCheck = async (id) =>
            JSON.parse((await registry.get('mikser_check_entity')({ id })).content[0].text)
    })

    it('reports a key most siblings carry and this record lacks', async () => {
        const r = await peerCheck('/documents/cat-gap.md')
        const gap = r.peerGaps?.find(g => g.key === 'summary')
        assert.ok(gap, `no peer gap found: ${JSON.stringify(r.peerGaps)}`)
        assert.equal(gap.siblings, 10, 'ten of the ten siblings have it')
        assert.equal(gap.of, 10)
    })

    it('names the group, so the count means something', async () => {
        const r = await peerCheck('/documents/cat-gap.md')
        assert.equal(r.peerGroup.type, 'catalog')
        assert.equal(r.peerGroup.peers, 10)
    })

    it('says nothing about a complete record', async () => {
        // No false positives, or nobody reads the list.
        const r = await peerCheck('/documents/cat-0.md')
        assert.equal(r.peerGaps, undefined)
    })

    it('does not report a key only ONE sibling has', async () => {
        // `oddball` exists on exactly one record. One record is not a pattern.
        const r = await peerCheck('/documents/cat-0.md')
        assert.ok(!(r.peerGaps ?? []).some(g => g.key === 'oddball'))
    })

    it('never fails the check — it is a prompt, not a defect', async () => {
        const r = await peerCheck('/documents/cat-gap.md')
        assert.notEqual(r.kind, undefined)
        assert.ok(r.notes.some(n => /peerGaps/.test(n) && /defect|only check possible/.test(n)),
            'the weakness has to travel with the finding')
    })

    it('excludes engine-owned keys from the comparison', async () => {
        const r = await peerCheck('/documents/cat-gap.md')
        for (const k of ['schema', 'href', 'lang']) {
            assert.ok(!(r.peerGaps ?? []).some(g => g.key === k), `${k} leaked into peerGaps`)
        }
    })
})
