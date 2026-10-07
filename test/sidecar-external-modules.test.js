// A sidecar's imports that resolve OUTSIDE the layouts folder.
//
// `layouts/lib/context.js` was always handled: it is globbed into the shared
// digest and stamped by the resolve hook, so editing one re-renders its
// layouts and the new code is what runs. `lib/context.js` one level up is the
// same code doing the same job and got neither — reported as an edit that
// rendered nothing, a restart that changed nothing, and `--force` as the only
// way to see the new output.
//
// The set cannot be globbed, because it is "whatever a sidecar imports".
// The resolve hook is the only place it is observable, so these tests are
// about what the hook records and what it stamps. The invalidation that
// record feeds is a scenario test, in core, where a real build runs.

import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'

import {
    installSidecarModuleHook, loadSidecarModule, recordedSidecarModules, sidecarHookInstalled,
} from '../lib/sidecar-modules.js'

describe('a sidecar importing from outside the layouts folder', () => {
    let root, elsewhere, layoutsFolder
    const silent = { debug() {}, error() {} }
    const load = (shared) => loadSidecarModule(
        { name: 'page', inputs: { shared } }, { layoutsFolder, logger: silent })

    before(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'mikser-sidecar-ext-'))
        // A project the working folder does NOT contain, to prove the
        // boundary is the project and not "anything that is not a layout".
        elsewhere = await mkdtemp(path.join(tmpdir(), 'mikser-elsewhere-'))
        layoutsFolder = path.join(root, 'layouts')
        await mkdir(layoutsFolder, { recursive: true })
        await mkdir(path.join(root, 'shared'), { recursive: true })
        await mkdir(path.join(root, 'node_modules', 'pkg'), { recursive: true })

        await writeFile(path.join(root, 'shared', 'context.js'), "export const label = 'FIRST'\n")
        await writeFile(path.join(root, 'shared', 'unimported.js'), "export const idle = true\n")
        await writeFile(path.join(root, 'node_modules', 'pkg', 'index.js'), "export const vendor = 'v1'\n")
        await writeFile(path.join(elsewhere, 'far.js'), "export const far = 'far'\n")
        await writeFile(path.join(layoutsFolder, 'page.js'),
            "import { label } from '../shared/context.js'\n"
            + "import { vendor } from '../node_modules/pkg/index.js'\n"
            + `import { far } from '${path.join(elsewhere, 'far.js')}'\n`
            + 'export const load = () => ({ label, vendor, far })\n')

        installSidecarModuleHook({ layoutsFolder, workingFolder: root, logger: silent })
    })

    after(async () => {
        await rm(root, { recursive: true, force: true })
        await rm(elsewhere, { recursive: true, force: true })
    })

    it('installs on a Node that supports registerHooks', () => {
        assert.equal(sidecarHookInstalled(), true, `not installed on ${process.version}`)
    })

    it('records the helper it imported from the project', async () => {
        const mod = await load('digest-1')
        assert.equal(mod.load().label, 'FIRST')
        assert.ok(
            recordedSidecarModules().includes(path.join(root, 'shared', 'context.js')),
            `shared/context.js was not recorded: ${recordedSidecarModules().join(', ')}`,
        )
    })

    it('does not record a dependency', () => {
        // node_modules is not something an author edits, and hashing it on
        // every scan would be the cost of the whole tree.
        assert.ok(!recordedSidecarModules().some(file => file.includes(`${path.sep}node_modules${path.sep}`)),
            `a node_modules path was recorded: ${recordedSidecarModules().join(', ')}`)
    })

    it('does not record a module outside the working folder', () => {
        assert.ok(!recordedSidecarModules().some(file => file.startsWith(elsewhere)),
            `a module outside the project was recorded: ${recordedSidecarModules().join(', ')}`)
    })

    it('does not record what something other than a sidecar imports', async () => {
        // The window is the sidecar load. Without it the hook would stamp —
        // and so re-evaluate — any project module the engine or the config
        // happened to import, which is a second copy of somebody's singleton.
        await import(path.join(root, 'shared', 'unimported.js'))
        assert.ok(!recordedSidecarModules().includes(path.join(root, 'shared', 'unimported.js')),
            'a module imported outside a sidecar load was recorded')
    })

    it('runs the NEW code after the helper is edited and the stamp moves', async () => {
        // The half that recording alone does not fix: the digest moves, the
        // layout re-renders, and without a stamp on this URL the sidecar
        // imports the copy the process loaded first.
        await writeFile(path.join(root, 'shared', 'context.js'), "export const label = 'SECOND'\n")
        const mod = await load('digest-2')
        assert.equal(mod.load().label, 'SECOND',
            'an out-of-folder helper must be re-evaluated when the stamp changes')
    })

    it('serves the cached copy while the stamp is unchanged', async () => {
        const first = (await load('digest-stable')).load().label
        await writeFile(path.join(root, 'shared', 'context.js'), "export const label = 'NEVER-SEEN'\n")
        assert.equal((await load('digest-stable')).load().label, first,
            'an unchanged stamp must not re-parse the graph')
    })
})
