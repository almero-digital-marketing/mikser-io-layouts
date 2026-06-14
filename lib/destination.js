// Per-layout destination resolution helpers.
//
// `compileDestinationTemplate` caches Handlebars-compiled templates so
// multiple layouts sharing the same `destination:` string share the
// compiled function. `sanitizeDestination` rejects path traversal —
// authors can write whatever they like in frontmatter, but `..`
// segments don't escape the output folder.

import path from 'node:path'
import handlebars from 'handlebars'

const destinationTemplateCache = new Map()

export function compileDestinationTemplate(template) {
    if (!destinationTemplateCache.has(template)) {
        destinationTemplateCache.set(template, handlebars.compile(template))
    }
    return destinationTemplateCache.get(template)
}

// Path-traversal sanitization for destinations resolved from
// frontmatter templates. Rejects anything that would escape the output
// folder via `..` segments. Matches the forms-plugin sanitizer.
export function sanitizeDestination(p) {
    if (p == null) return null
    const s = String(p).replace(/\\/g, '/')
    const leading = s.startsWith('/') ? '/' : ''
    const normalized = path.posix.normalize(s.replace(/^\/+/, ''))
    if (normalized === '..' || normalized.startsWith('../')) {
        throw new Error(`layouts: rejected path-traversal in destination: ${p}`)
    }
    return leading + normalized
}
