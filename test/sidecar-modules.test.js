// Module identity for layout sidecars.
//
// Node's ESM registry keys modules by resolved URL. A `?stamp=` on the
// sidecar's own URL therefore re-evaluates the ENTRY and nothing else:
// its `import './lib/context.js'` resolves to a URL with no query and is
// answered from cache for the life of the process.
//
// Under --watch that shows up as a helper that propagates one edit and
// then freezes, and the damage outlives the process: the last render ran
// with the stale module, produced bytes that happened to match what was
// on disk, skipped the write, and recorded "these inputs produced those
// bytes". Revert the source and every check agrees with every other and
// all of them are wrong about the site — only --force recovers.
//
// These tests run in ONE process with a real edit between imports, which
// is the only place the bug exists. A scenario test spawns a fresh
// process per build, so its module cache is empty every time and the
// staleness cannot appear.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import { installSidecarModuleHook, setSidecarStamp, sidecarHookInstalled } from '../lib/sidecar-modules.js'

describe('sidecar module identity', () => {
    let root, layoutsFolder

    before(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'mikser-sidecar-'))
        layoutsFolder = path.join(root, 'layouts')
        await mkdir(path.join(layoutsFolder, 'lib'), { recursive: true })
        // page.js is the sidecar; lib/context.js is the module it imports.
        await writeFile(path.join(layoutsFolder, 'lib', 'context.js'),
            "export const icon = 'filter.svg'\n")
        await writeFile(path.join(layoutsFolder, 'page.js'),
            "import { icon } from './lib/context.js'\nexport const load = () => ({ icon })\n")
        installSidecarModuleHook({ layoutsFolder, logger: { debug() {} } })
    })

    after(async () => { await rm(root, { recursive: true, force: true }) })

    const importSidecar = async (stamp) => {
        setSidecarStamp(stamp)
        const mod = await import(`${path.join(layoutsFolder, 'page.js')}?stamp=${stamp}`)
        return mod.load().icon
    }

    it('installs on a Node that supports registerHooks', () => {
        // The fix depends on node:module.registerHooks (22.15+). If this
        // fails the rest is testing the fallback, so it is worth stating.
        assert.equal(sidecarHookInstalled(), true, `not installed on ${process.version}`)
    })

    it('reads the helper through the sidecar', async () => {
        assert.equal(await importSidecar('digest-1'), 'filter.svg')
    })

    it('picks up an edit to the IMPORTED module when the stamp changes', async () => {
        await writeFile(path.join(layoutsFolder, 'lib', 'context.js'),
            "export const icon = 'x.svg'\n")
        assert.equal(
            await importSidecar('digest-2'), 'x.svg',
            'a transitive import must be re-evaluated when the stamp changes',
        )
    })

    it('picks up a NOVEL value on the second edit', async () => {
        // The case that proves it is not the write-skip masking a reload:
        // a value never seen before cannot match anything already on disk.
        await writeFile(path.join(layoutsFolder, 'lib', 'context.js'),
            "export const icon = 'plus.svg'\n")
        assert.equal(await importSidecar('digest-3'), 'plus.svg')
    })

    it('returns to the original value when the source is reverted', async () => {
        await writeFile(path.join(layoutsFolder, 'lib', 'context.js'),
            "export const icon = 'filter.svg'\n")
        assert.equal(await importSidecar('digest-4'), 'filter.svg')
    })

    it('does NOT re-evaluate when the stamp is unchanged', async () => {
        // The stamp is the shared digest, so an unchanged tree must resolve
        // to the same URLs and re-parse nothing. Editing behind an unchanged
        // stamp is not a real scenario — the digest would have moved — but it
        // is how "cached" is observable.
        const first = await importSidecar('digest-stable')
        await writeFile(path.join(layoutsFolder, 'lib', 'context.js'),
            "export const icon = 'never-seen.svg'\n")
        assert.equal(
            await importSidecar('digest-stable'), first,
            'an unchanged stamp must serve the cached module',
        )
        // Leave the tree as the other tests expect.
        await writeFile(path.join(layoutsFolder, 'lib', 'context.js'),
            "export const icon = 'filter.svg'\n")
    })
})
