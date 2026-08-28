// The contract of a layout AND everything it pulls in.
//
// `references.static` reports what ONE FILE mentions, in that file's own
// vocabulary. For a real page layout that is close to useless: page.liquid is
// mostly `{% include %}` and mentions almost nothing itself, while the section
// that does the work opens `{% assign hero = data.meta.hero %}` and then talks
// about `hero.tags` — a name that appears in no document and that an author
// cannot write.
//
// So an agent checking a document against a layout had nothing to check
// against, which is how a typo'd key ships a page with a section missing.
//
// These pin the two hops that used to break the chain: a value passed AS AN
// ARGUMENT to a partial, and a value renamed by an alias. Both have to come
// back out in the author's terms — `data.meta.*` — or the contract cannot be
// diffed against a document's front matter.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createInspect } from '../lib/inspect.js'
import * as liquid from 'mikser-io-render-liquid'

// page → sections/hero → ui/tags. The key under test, `hero.tags`, is reached
// through an alias in the middle file and an argument into the last one, so
// nothing but a resolved closure can find it.
const FILES = {
    'page.liquid':
        '<html><body>{% include "chrome/nav" %}'
        + '{% for section in data.meta.sections %}{% include "sections/hero" %}{% endfor %}'
        + '</body></html>',
    'chrome/nav.liquid': '<nav>{{ data.meta.title }}</nav>',
    'sections/hero.liquid':
        '{%- assign hero = data.meta.hero -%}'
        + '<h1>{{ hero.title }}</h1>'
        + '{% if hero.background %}<img src="{{ hero.background }}">{% endif %}'
        + '{% render "ui/tags", tags: hero.tags, heading: hero.tagsTitle %}',
    'ui/tags.liquid':
        '<ul>{% for t in tags %}<li>{{ t.label }}<span>{{ t.icon }}</span></li>{% endfor %}</ul>',
}

let dir, inspect, contract

before(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'mikser-contract-'))
    const entities = []
    for (const [rel, content] of Object.entries(FILES)) {
        const uri = path.join(dir, rel)
        await mkdir(path.dirname(uri), { recursive: true })
        await writeFile(uri, content)
        const name = rel.replace(/\.liquid$/, '')
        entities.push({ id: `/layouts/${rel}`, name, uri, collection: 'layouts', template: 'liquid', format: 'html' })
    }

    // The real liquid parser, dispatched exactly the way render does it — by
    // `entity.template`. Nothing here knows what liquid syntax looks like.
    const runtime = { renderers: new Map([['liquid', { parseReferences: liquid.parseReferences }]]) }

    inspect = createInspect({
        runtime,
        findEntity:   async ({ id }) => entities.find(e => e.id === id) ?? null,
        findEntities: async (q) => entities.filter(e => q.name == null || e.name === q.name),
        useDatabase:  () => null,
        collection:   'layouts',
    })
    contract = (await inspect('/layouts/page.liquid', { samples: 0 })).references.contract
})

after(async () => { if (dir) await rm(dir, { recursive: true, force: true }) })

describe('the layout contract', () => {
    it('follows a key through an ARGUMENT into the partial that consumes it', () => {
        // `{% render "ui/tags", tags: hero.tags %}` — dropping the argument was
        // the hole: ui/tags talks about `tags`, and nothing tied that back to
        // the document key it was handed.
        assert.ok(contract.meta.includes('hero.tags'),
            `expected hero.tags in the contract, got: ${contract.meta.join(', ')}`)
    })

    it('resolves an alias back into the vocabulary the author writes', () => {
        // sections/hero says `hero.title`. No document has a `hero.title` at
        // the root — it is `data.meta.hero.title`, and only the assign says so.
        assert.ok(contract.meta.includes('hero.title'))
        assert.ok(contract.meta.includes('hero.background'))
        assert.ok(!contract.consumes.some(c => c === 'hero.title'),
            'the unresolved local name must not survive into the contract')
    })

    it('reaches keys two hops down, through an argument AND a loop', () => {
        // ui/tags iterates what it was handed and reads `.label` off each item.
        // Two rewrites away from the document: tags → hero.tags → an element.
        assert.ok(contract.meta.includes('hero.tags[].label'),
            `expected hero.tags[].label, got: ${contract.meta.join(', ')}`)
        assert.ok(contract.meta.includes('hero.tags[].icon'))
    })

    it('marks an element as an element, not as the collection', () => {
        // `hero.tags.label` would be a key that exists on no document — the
        // label is on each tag, not on the list.
        assert.ok(!contract.meta.includes('hero.tags.label'))
    })

    it('includes what the layout itself consumes, not only its partials', () => {
        assert.ok(contract.meta.includes('sections'))
        assert.ok(contract.meta.includes('title'), 'chrome/nav is walked too')
    })

    it('reports itself COMPLETE when every branch was read', () => {
        assert.equal(contract.complete, true,
            `unexpected gaps: ${JSON.stringify(contract.incomplete)}`)
        assert.deepEqual(contract.incomplete, [])
    })

    it('names every template it walked, so the closure is auditable', () => {
        const walked = contract.templates.map(t => t.template).sort()
        assert.deepEqual(walked, ['chrome/nav', 'page', 'sections/hero', 'ui/tags'])
    })
})

// A contract that LOOKS complete but silently skipped a branch is worse than
// no contract: it invites an agent to trust a set difference that is missing
// half its right-hand side. So every gap has to be named, and `complete` has
// to go false the moment one exists.
describe('the layout contract, where it cannot see', () => {
    const build = async (files, rendererFor) => {
        const dir = await mkdtemp(path.join(tmpdir(), 'mikser-contract-gap-'))
        const entities = []
        for (const [rel, content] of Object.entries(files)) {
            const uri = path.join(dir, rel)
            await mkdir(path.dirname(uri), { recursive: true })
            await writeFile(uri, content)
            entities.push({
                id: `/layouts/${rel}`, name: rel.replace(/\.\w+$/, ''), uri,
                collection: 'layouts', template: rel.endsWith('.liquid') ? 'liquid' : 'mystery',
                format: 'html',
            })
        }
        const inspect = createInspect({
            runtime: { renderers: rendererFor },
            findEntity:   async ({ id }) => entities.find(e => e.id === id) ?? null,
            findEntities: async (q) => entities.filter(e => q.name == null || e.name === q.name),
            useDatabase:  () => null,
            collection:   'layouts',
        })
        const out = (await inspect('/layouts/page.liquid', { samples: 0 })).references.contract
        await rm(dir, { recursive: true, force: true })
        return out
    }

    const liquidOnly = new Map([['liquid', { parseReferences: liquid.parseReferences }]])

    it('says so when an included partial does not exist', async () => {
        const c = await build({ 'page.liquid': '{% include "sections/absent" %}' }, liquidOnly)
        assert.equal(c.complete, false)
        assert.ok(c.incomplete.some(i => i.template === 'sections/absent'),
            `expected the missing partial to be named, got ${JSON.stringify(c.incomplete)}`)
    })

    it('says so when a partial is rendered by an engine that cannot be parsed', async () => {
        // markdown and metatext are real cases: they render content, and have
        // no parseReferences to expose. The closure must degrade loudly.
        const c = await build({
            'page.liquid': '{% include "sections/opaque" %}',
            'sections/opaque.mystery': 'whatever this engine does',
        }, new Map([
            ['liquid', { parseReferences: liquid.parseReferences }],
            ['mystery', { /* a renderer with no parser */ }],
        ]))
        assert.equal(c.complete, false)
        const gap = c.incomplete.find(i => i.template === 'sections/opaque')
        assert.ok(gap, `expected the opaque partial to be named, got ${JSON.stringify(c.incomplete)}`)
        assert.match(gap.reason, /parseReferences/)
    })

    it('still reports everything it COULD read, rather than giving up', async () => {
        const c = await build({
            'page.liquid': '{{ data.meta.title }}{% include "sections/absent" %}',
        }, liquidOnly)
        assert.equal(c.complete, false)
        assert.ok(c.meta.includes('title'), 'a gap in one branch must not discard the others')
    })
})
