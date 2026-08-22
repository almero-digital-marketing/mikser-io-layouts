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
import { pathToFileURL } from 'node:url'

// Feature-detected rather than imported by name: `import { registerHooks }`
// throws at parse time on a Node that does not export it.
const canRegisterHooks = typeof module.registerHooks === 'function'

let installed = false
let rootUrl = null
let stamp = ''

// Register once per process. Idempotent, and a no-op on a Node without
// registerHooks — callers read the return value to decide what to use as
// the entry stamp.
export function installSidecarModuleHook({ layoutsFolder, logger }) {
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
    module.registerHooks({
        resolve(specifier, context, nextResolve) {
            const resolved = nextResolve(specifier, context)
            if (!resolved?.url?.startsWith(rootUrl)) return resolved
            if (resolved.url.includes('?')) return resolved
            return { ...resolved, url: `${resolved.url}?stamp=${stamp}` }
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
