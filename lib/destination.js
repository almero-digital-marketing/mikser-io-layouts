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

// An ISOLATED Handlebars instance. Registering helpers on the shared default
// export would leak them into anything else in the process using handlebars —
// including a project's own renderHbs layouts, where a helper named `replace`
// appearing from nowhere would be a genuinely confusing surprise.
const hbs = handlebars.create()

const str = (value) => (value == null ? '' : String(value))

// A destination template can only interpolate whole values without these, so
// a path cannot be derived from PART of entity.name. The case that needs it:
// a catalog holding three languages under documents/{lang}/…, where
// entity.name is `bg/kontakti` and the wanted destination is
// `/kontakti/index.html` — name minus the language segment. Without helpers
// that is inexpressible, and the workarounds are a sidecar mutating the
// entity mid-assembly (a side effect where there should be none) or one
// documents() per language (which empties the catalog of the other languages
// and breaks the hreflang and language switcher that needed one catalog).
//
// Deliberately a small, path-shaped set. These are for slicing a path, not a
// template language: anything more belongs in the layout's .js sidecar.
const helpers = {
    // `{{ after entity.name '/' }}`  bg/kontakti → kontakti
    after:      (value, sep) => { const s = str(value); const i = s.indexOf(str(sep)); return i < 0 ? s : s.slice(i + str(sep).length) },
    // `{{ before entity.name '/' }}` bg/kontakti → bg
    before:     (value, sep) => { const s = str(value); const i = s.indexOf(str(sep)); return i < 0 ? s : s.slice(0, i) },
    afterLast:  (value, sep) => { const s = str(value); const i = s.lastIndexOf(str(sep)); return i < 0 ? s : s.slice(i + str(sep).length) },
    beforeLast: (value, sep) => { const s = str(value); const i = s.lastIndexOf(str(sep)); return i < 0 ? s : s.slice(0, i) },
    // Literal, every occurrence — NOT a regex, because a destination is a
    // path and a stray metacharacter should not silently change the match.
    replace:    (value, search, replacement) => str(value).split(str(search)).join(str(replacement)),
    dirname:    (value) => path.posix.dirname(str(value)),
    basename:   (value, ext) => path.posix.basename(str(value), typeof ext === 'string' ? ext : undefined),
    lower:      (value) => str(value).toLowerCase(),
    upper:      (value) => str(value).toUpperCase(),
}
for (const [name, fn] of Object.entries(helpers)) hbs.registerHelper(name, fn)

export const destinationHelpers = Object.keys(helpers)

export function compileDestinationTemplate(template) {
    if (!destinationTemplateCache.has(template)) {
        destinationTemplateCache.set(template, hbs.compile(template))
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

// The PRIMARY destination for an entity under one layout — page 1 of a
// paginated set, or the only output of an unpaginated one.
//
// Extracted so it can run in TWO places that must agree:
//
//   onProcessed (matching.js)  persists it onto the catalog entity, because
//                              the catalog is only ever written through the
//                              journal and onProcessed is where that happens.
//                              Without this, entity.destination existed only
//                              as a per-render-task field and was never
//                              stored — so runtime.href() had nothing to
//                              resolve a TARGET page's URL from, and returned
//                              the whole entity instead of { url }.
//   onBeforeRender (assembly)  derives each task's destination, including the
//                              per-page variants this function does not cover.
//
// Two copies of this derivation would drift, and the failure mode of drift is
// a URL that resolves to a file that is not there.
export function primaryDestination({ entity, layout, options = {}, endsWith }) {
    const template = layout?.meta?.destination
    if (template) {
        return sanitizeDestination(compileDestinationTemplate(template)({ entity }))
    }
    // A name already carrying its format is a passthrough — the source file
    // IS the output shape (e.g. `robots.txt`).
    if (endsWith(entity.name, entity.format)) return entity.destination ?? null

    const base = '/' + entity.name
    // cleanUrls turns `foo` into `foo/index.html` so the served URL is
    // `/foo/`. Skipped when the layout declares a postprocessor: that HTML
    // render is a throwaway stepping stone with no served URL, and leaving
    // it flat lets the engine's extension swap produce `/foo.<ext>`.
    if (options.cleanUrls
        && !endsWith(entity.name, 'index')
        && layout?.format === 'html'
        && !layout?.postprocessor
    ) {
        return path.posix.join(base, `index.${layout.format}`)
    }
    return `${base}.${layout?.format}`
}
