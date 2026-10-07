// Module identity for layout sidecars.
//
// Node's ESM registry keys modules by resolved URL, so a `?stamp=` on the
// sidecar's own URL re-evaluates the ENTRY and nothing else: its
// `import './lib/context.js'` resolves to a URL with no query, which the
// registry answers from cache for the life of the process. Under --watch
// that leaves an edited helper stale after the first reload:
//
//     import('/layouts/page.js?stamp=1')   // page.js fresh, context.js read
//     …edit lib/context.js…
//     import('/layouts/page.js?stamp=2')   // page.js fresh, context.js CACHED
//
// The stamp has to reach every module in the subgraph, which a resolve
// hook can do and an entry-point query cannot. `module.registerHooks`
// (Node 22.15+) runs synchronously in-thread, so the hook can append the
// current stamp to anything resolving under layoutsFolder.
//
// Consequences worth stating, because they are what make this safe to
// leave installed:
//
//   - the stamp is the shared sidecar digest, so an unchanged tree keeps
//     resolving to the same URLs and nothing is re-parsed. `Date.now()`
//     re-parsed the entry on every render.
//   - only paths under layoutsFolder are touched; the engine's own
//     modules and node_modules resolve untouched.
//   - a URL that already carries a query is left alone, so the entry
//     import's explicit stamp is not doubled.
//
// Where the hook is unavailable, sidecars still reload and their imports
// still go stale — the pre-existing behaviour — and that is said out loud
// once rather than left to be discovered.

import module from 'node:module'
import path from 'node:path'
import { existsSync } from 'node:fs'
import { fileURLToPath, pathToFileURL } from 'node:url'

// Feature-detected rather than imported by name: `import { registerHooks }`
// throws at parse time on a Node that does not export it.
const canRegisterHooks = typeof module.registerHooks === 'function'

let installed = false
let rootUrl = null
let stamp = ''
let projectRoot = null

// A sidecar's imports that resolve OUTSIDE the layouts folder.
//
// The hook below only knew about `layoutsFolder`, and so did the digest:
// `layouts/lib/context.js` is globbed into the shared digest and stamped, so
// editing one re-renders and reloads. `lib/context.js` one level up is the
// same code doing the same job and got neither — the edit changed nothing,
// a restart changed nothing, and only `--force` produced the new output.
// Shared helpers live outside a layouts folder all the time: that is where
// code shared with the config or a script goes.
//
// They cannot be globbed — the set is "whatever a sidecar imports", which
// is unbounded until something imports it. But the resolve hook sees every
// resolution as it happens, so the graph is RECORDED while a sidecar loads
// and read back as an input on the next scan. That is the same bargain
// `readFile`/`glob` tracking already makes: an edge is known from the run
// that used it, and invalidates the run after.
//
// Confined to project-local files: node_modules and the engine's own modules
// resolve untouched, as before.
const recorded = new Set()
let recordDepth = 0

function isProjectModule(file) {
    if (!projectRoot || !file.startsWith(projectRoot)) return false
    return !file.split(path.sep).includes('node_modules')
}

// Absolute paths of everything a sidecar has imported from outside the
// layouts folder so far this process, sorted so a digest over them is stable.
export function recordedSidecarModules() {
    return [...recorded].sort()
}

export function forgetRecordedSidecarModules() {
    recorded.clear()
}

// Register once per process. Idempotent, and a no-op on a Node without
// registerHooks — callers read the return value to decide what to use as
// the entry stamp.
export function installSidecarModuleHook({ layoutsFolder, workingFolder, logger }) {
    if (installed) return true
    if (!layoutsFolder) return false
    if (!canRegisterHooks) {
        logger?.debug(
            'Sidecar modules: node:module.registerHooks is unavailable (Node %s), so a module a '
            + 'sidecar imports keeps its first-loaded copy for the life of the process. Editing one '
            + 'under --watch needs a restart with --force. Node 22.15+ removes the limitation.',
            process.version,
        )
        return false
    }
    rootUrl = pathToFileURL(layoutsFolder).href.replace(/\/?$/, '/')
    projectRoot = workingFolder ? path.resolve(workingFolder) + path.sep : null
    module.registerHooks({
        resolve(specifier, context, nextResolve) {
            const resolved = nextResolve(specifier, context)
            const url = resolved?.url
            if (typeof url !== 'string' || !url.startsWith('file:')) return resolved
            if (url.includes('?')) return resolved
            if (url.startsWith(rootUrl)) return { ...resolved, url: `${url}?stamp=${stamp}` }
            // Outside the layouts folder, and only while a sidecar is
            // loading — so an import the engine or the config performs on
            // the same file is left alone unless it happens to resolve
            // inside this window.
            if (!recordDepth) return resolved
            let file
            try {
                file = fileURLToPath(url)
            } catch {
                return resolved
            }
            if (!isProjectModule(file)) return resolved
            recorded.add(file)
            // Stamped as well as recorded. Recording alone fixes the
            // rebuild and leaves `--watch` broken in the way this started
            // from: the digest moves, the layout re-renders, and the
            // sidecar imports the copy of the module the process loaded
            // first. The consequence is the one that already applies under
            // layouts/ — a module in a sidecar's import graph is evaluated
            // again when layout code changes, so a process-wide singleton
            // does not belong in one.
            return { ...resolved, url: `${url}?stamp=${stamp}` }
        },
    })
    installed = true
    return true
}

// The stamp every subsequent resolution under layoutsFolder is keyed by.
// Set from the layout's `inputs.shared` digest before importing its
// sidecar. Every layout in a cycle carries the same shared digest, so
// concurrent renders set the same value and there is nothing to race.
export function setSidecarStamp(next) {
    stamp = next ?? ''
}

export function sidecarHookInstalled() {
    return installed
}

// Load a layout's sidecar module, or null when it has none.
//
// One implementation, two callers: the render (which then tracks what the
// sidecar reads) and the apps surface (which invokes its action handlers).
// The stamping is the whole reason this is shared — a second copy would drift
// from the digest rule above and reintroduce the failure that rule exists for:
// an edited sidecar that keeps answering from cache.
export async function loadSidecarModule(layout, { layoutsFolder, logger } = {}) {
    if (!layout?.name || !layoutsFolder) return null
    const sidecarPath = path.join(layoutsFolder, `${layout.name}.js`)
    // Existence first, so a real ERR_MODULE_NOT_FOUND from INSIDE the sidecar
    // — it imports a package that is not installed — is not swallowed as
    // "this layout has no sidecar".
    if (!existsSync(sidecarPath)) return null

    const shared = layout.inputs?.shared || ''
    setSidecarStamp(shared)
    // With the resolve hook installed the digest reaches the sidecar's own
    // imports too; without it only the entry reloads, so fall back to a
    // per-call stamp to keep at least that much.
    const entryStamp = sidecarHookInstalled() ? shared : Date.now()
    // The window the resolve hook records in. Depth-counted because layouts
    // render concurrently, so several sidecars are in flight at once and the
    // first to finish must not close the window on the rest.
    recordDepth++
    try {
        return await import(`${pathToFileURL(sidecarPath).href}?stamp=${entryStamp}`)
    } catch (err) {
        logger?.error('Layout sidecar %s failed to load: %s', sidecarPath, err.message)
        throw err
    } finally {
        recordDepth--
    }
}
