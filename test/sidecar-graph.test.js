// The stored sidecar import graph.
//
// Its one hard rule: NOTICING a module must not move the digest. The graph is
// only observable once a sidecar has loaded, so every project gains entries on
// its first build after the upgrade — and if the digest were a hash of the
// list, that first build would be followed by a full re-render of every
// layout, for nothing. Each path is therefore stored with the checksum it had
// when it was found, and only a checksum that stops matching moves anything.

import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { createSidecarGraph } from '../lib/sidecar-graph.js'

describe('the stored sidecar module graph', () => {
    let root, runtimeFolder, helper, other
    const logger = () => ({ debug() {} })
    const graph = () => createSidecarGraph({ runtime: { options: { runtimeFolder } }, logger })

    before(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'mikser-graph-'))
        runtimeFolder = path.join(root, 'runtime')
        await mkdir(runtimeFolder, { recursive: true })
        helper = path.join(root, 'context.js')
        other = path.join(root, 'other.js')
    })

    beforeEach(async () => {
        await rm(path.join(runtimeFolder, 'layouts-modules.json'), { force: true })
        await writeFile(helper, "export const label = 'FIRST'\n")
        await writeFile(other, "export const n = 1\n")
    })

    after(async () => { await rm(root, { recursive: true, force: true }) })

    it('contributes nothing when no sidecar has imported anything', async () => {
        // An empty contribution is what keeps a project that never leaves its
        // layouts folder hashing exactly as it did before any of this existed.
        assert.equal(await graph().digest(), '')
    })

    it('still contributes nothing after a module is discovered', async () => {
        const subject = graph()
        assert.equal(await subject.discover([helper]), true)
        assert.equal(await subject.digest(), '',
            'discovering a module must not look like a change to it')
    })

    it('moves once the discovered module changes', async () => {
        const subject = graph()
        await subject.discover([helper])
        await subject.digest()
        await writeFile(helper, "export const label = 'SECOND'\n")
        const moved = await subject.digest()
        assert.notEqual(moved, '', 'an edited module must move the digest')
        assert.equal(await subject.digest(), moved, 'and then settle at the new value')
    })

    it('reads the graph back in a later run', async () => {
        // A one-shot build exits between the render that observes the graph
        // and the scan that uses it, which is why this is on disk at all.
        await graph().discover([helper])
        await writeFile(helper, "export const label = 'SECOND'\n")
        assert.notEqual(await graph().digest(), '')
    })

    it('drops a module that is gone instead of remembering it as missing', async () => {
        const subject = graph()
        await subject.discover([helper, other])
        await subject.digest()
        await rm(other)
        const moved = await subject.digest()
        assert.notEqual(moved, '', 'a vanished input is a change')
        const stored = JSON.parse(await readFile(path.join(runtimeFolder, 'layouts-modules.json'), 'utf8'))
        assert.deepEqual(Object.keys(stored.modules), [helper],
            'a renamed helper must not leave an entry that can never match again')
        assert.equal(await subject.digest(), moved, 'and the digest settles')
    })

    it('does not record a module that cannot be read', async () => {
        const subject = graph()
        assert.equal(await subject.discover([path.join(root, 'absent.js')]), false)
        assert.deepEqual(await subject.tracked(), [])
    })

    it('reports what it tracks, for the watcher to follow', async () => {
        const subject = graph()
        await subject.discover([other, helper])
        assert.deepEqual(await subject.tracked(), [helper, other].sort())
    })
})
