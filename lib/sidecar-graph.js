// What a sidecar imported last time, kept across runs.
//
// The resolve hook records the graph while a sidecar LOADS, which is after
// the scan that decides whether to render it. So the set this run observed
// is only useful to the next one, and it has to survive a restart — the
// reported symptom was that a restart did not help either.
//
// It lives beside the other derived state in the runtime folder rather than
// in the catalog, because the scan needs it before it has read a single
// layout entity, and because a catalog wipe should not cost a full re-render
// of every layout that imports a shared helper.
//
// DISCOVERY MUST NOT MOVE THE DIGEST. Storing a path and hashing the list
// would mean the first build after an upgrade re-rendered everything, and
// again the first time any new helper appeared. So each path is stored WITH
// the checksum it had when it was discovered, and the digest only moves when
// a stored checksum stops matching the file. A project whose sidecars import
// nothing outside the layouts folder has an empty store and a digest of '',
// which is appended nowhere — its layouts hash exactly as they did before.

import path from 'node:path'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { checksum as fileChecksum, checksumOf } from 'mikser-io'

const FILE = 'layouts-modules.json'

export function createSidecarGraph({ runtime, logger }) {
    let store = null

    const storeFile = () => path.join(runtime.options.runtimeFolder, FILE)

    // null means "not there any more", which is a change like any other.
    const sumOf = async (file) => {
        try {
            return await fileChecksum(file)
        } catch {
            return null
        }
    }

    const recompute = (modules) => {
        const lines = Object.keys(modules).sort().map(file => `${file}:${modules[file]}`)
        return lines.length ? checksumOf(lines.join('\n')) : ''
    }

    async function read() {
        if (store) return store
        try {
            store = JSON.parse(await readFile(storeFile(), 'utf8'))
        } catch {
            store = {}
        }
        if (!store.modules || typeof store.modules !== 'object') store.modules = {}
        if (typeof store.digest !== 'string') store.digest = ''
        return store
    }

    async function write() {
        try {
            await mkdir(path.dirname(storeFile()), { recursive: true })
            await writeFile(storeFile(), JSON.stringify(store, null, 2))
        } catch (err) {
            // Losing the store costs one extra render of every layout, next
            // run. It must not cost the build.
            logger?.().debug('Layouts could not store the sidecar module graph: %s', err.message)
        }
    }

    return {
        // The value folded into the shared digest. '' when nothing is
        // tracked, so an unaffected project's layouts hash is untouched.
        async digest() {
            const current = await read()
            const files = Object.keys(current.modules)
            if (!files.length) return ''
            let moved = false
            for (const file of files) {
                const sum = await sumOf(file)
                if (sum === current.modules[file]) continue
                moved = true
                // A module that is gone is not an input any more. Dropping it
                // rather than remembering it as missing means a renamed helper
                // costs one rebuild instead of leaving a permanent entry that
                // can never match.
                if (sum === null) delete current.modules[file]
                else current.modules[file] = sum
            }
            if (moved) {
                current.digest = recompute(current.modules)
                await write()
            }
            return current.digest
        },

        // Paths the resolve hook saw this run. Stored with their CURRENT
        // checksum, so nothing newly discovered is reported as changed.
        async discover(files) {
            const current = await read()
            let added = false
            for (const file of files ?? []) {
                if (Object.hasOwn(current.modules, file)) continue
                const sum = await sumOf(file)
                if (sum === null) continue
                current.modules[file] = sum
                added = true
            }
            if (added) await write()
            return added
        },

        async tracked() {
            return Object.keys((await read()).modules).sort()
        },
    }
}
