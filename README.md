# mikser-io-layouts

The SSG-flavor task-production policy for [mikser-io](https://github.com/almero-digital-marketing/mikser-io). Manages HTML/template layouts: every layout whose pattern hits an entity contributes a render task — multi-match by default, no "best match wins" tiebreaker. One source entity can produce multiple outputs of different formats simply by being matched by multiple layouts.

This is the **canonical recipe** for the static-site case. A mikser project doesn't have to use it — the engine is renderer-agnostic — but every project that *does* produce rendered output from template-engine layouts uses this plugin.

## Install

```bash
npm install mikser-io-layouts
```

## Usage

```js
// mikser.config.js
import { documents, frontMatter, yaml, renderHbs } from 'mikser-io'
import { layouts } from 'mikser-io-layouts'

export default {
  plugins: [
    documents(),
    frontMatter(),
    yaml(),
    layouts({ autoLayouts: true }),
    renderHbs(),
  ],
}
```

## Factory options

Every value below is the **default**; pass an option only to change it.

```js
layouts({
  layoutsFolder: 'layouts',

  // Each pattern that matches contributes a render task. Multi-match:
  // an entity at /blog/welcome.md matches both '@/blog/*' (post) AND
  // '@/**' (default) → two render tasks, one per layout.
  match: {
    '@/blog/*':  'post',
    '@/pages/*': 'page',
    '@/**':      'default',
  },

  autoLayouts: true,           // Auto-match by name (single-match fallback; see below)
  cleanUrls: true,             // /page → /page/index.html, so the served URL is /page/
})
```

`cleanUrls` already special-cases names ending in `index` (`index` stays
`/index.html`, it does not become `/index/index.html`). Reaching for a
`destination:` template to get pretty URLs reinvents this — and breaks index
pages, because the template fully overrides the transform.

`match` has no default: with no patterns and `autoLayouts` on, layouts are
found by name.

```js
```

## Per-entity selection — `meta.layout` / `meta.layouts`

An entity can override match-based assignment via frontmatter:

```yaml
---
layout: post              # single — pick exactly one
---
```

```yaml
---
layouts: [post, post-email]   # multiple — render the entity through each
---
```

`layout` and `layouts` are mutually exclusive — both set is an error. When neither is set, the plugin falls back to `options.match` (multi-match) then `autoLayouts` (single-match peel ladder).

## Auto-layout matching (`autoLayouts: true`) — single-match fallback

Only runs when no `options.match` pattern hit the entity. The peel ladder is a most-specific-name search by design and stays first-wins (not multi-match):

| Entity (`entity.name`) | Candidates tried in order | Matches if layout exists at |
|---|---|---|
| `nginx.conf` | `nginx.conf`, `nginx` | `layouts/nginx.conf.*` or `layouts/nginx.*` |
| `styles/post.css` | `styles/post.css`, `styles/post` | `layouts/styles/post.css.*` or `layouts/styles/post.*` |
| `posts/article.md` | `posts/article.md`, `posts/article` | `layouts/posts/article.*` |

Cross-directory auto-matching is intentionally not supported — pair `posts/article.md` with a top-level `article.eta` via `meta.layout: 'article'` or a `layouts.match` rule.

## Per-layout destination override

A layout's frontmatter can declare a `destination:` template. The template is Handlebars (path-shaped — substitutions only, no body rendering); it gets `{ entity }` as the context, is compiled once and cached, and the result is path-sanitized (`..` segments rejected). This fully overrides the default `entity.name + .format` derivation (and the cleanUrls folder transform).

A small set of path-shaping helpers is available, so a destination can be
derived from *part* of a value rather than only interpolating whole ones:

| helper | |
| --- | --- |
| `after v sep` / `before v sep` | split at the **first** separator |
| `afterLast v sep` / `beforeLast v sep` | split at the **last** separator |
| `replace v search replacement` | literal, every occurrence — not a regex |
| `dirname v` / `basename v` | POSIX path parts |
| `lower v` / `upper v` | case |

The case they exist for is per-language output roots. With three languages in
one catalog under `documents/{lang}/…`, `entity.name` is `bg/kontakti` and each
language wants its own document root:

```yaml
destination: /{{ after entity.name '/' }}/index.html   # → /kontakti/index.html
```

They are registered on an **isolated** Handlebars instance, so nothing appears
in your own `renderHbs` layouts. Anything more than path slicing belongs in the
layout's `.js` sidecar rather than in a template.

```yaml
# layouts/post-card.html.hbs
---
match: '@/blog/*'
destination: '/cards/{{entity.name}}.html'
---
```

### `match:` — a layout claiming its own entities

A layout can declare the pattern that selects it, instead of the config
naming it from the other side. These two are the same rule:

```js
layouts({ match: { '@/blog/*': 'post-card' } })
```

```yaml
# layouts/post-card.html.hbs
---
match: '@/blog/*'          # or a list: ['@/blog/*', '@/news/*']
---
```

They are **peers**, not alternatives — an entity matched by a config pattern
and by a layout's own pattern gets both layouts, exactly as two config
patterns would. A document's own `meta.layout` still wins over both, and
auto-layout still only runs when nothing matched at all.

Patterns follow the same rule everywhere: `matchEntity` globs `entity.name`
only for a pattern starting `@/`; anything else globs `entity.id`, which
carries the `/<collection>/` prefix and the extension. A pattern that selects
nothing is reported once per run on a full cycle, naming the layout that
declared it.

```yaml
# Pull from meta
---
destination: '/{{entity.meta.year}}/{{entity.name}}.summary.html'
---
```

```yaml
# Use pagination context (when the sidecar paginates)
---
destination: '/archive/page-{{entity.page}}.html'
---
```

## Destination collisions — fail-fast

When two layouts match the same entity AND resolve to the same destination, the plugin logs a named-names error and drops every render task for that entity for the cycle. No winner — disambiguation is the author's call. The build continues for other entities.

```
Layout collision for /documents/blog/welcome.md:
  - post → /blog/welcome.html
  - post-card → /blog/welcome.html
Set a `destination:` override on one of them, or change one's format.
Skipping this entity for the cycle.
```

The common cases that hit this are:
1. Two layouts produce the same format (`.html` from both `post.html.hbs` and `post-card.html.hbs`). Fix: set `destination:` on one.
2. Two layouts with the same name in the same directory — file-system collision, not engine collision. Rename one.

## Postprocess chains

A layout's filename encodes a postprocessor chain after the format segment: `<name>.<format>-<post1>[-<post2>...].<template>`. Each `post*` segment names a `mikser-io-post-<name>` plugin. Stages run in order, threading file paths (not buffers) between them; the final extension comes from the last stage's `output:`.

```
layouts/welcome.html-mjml-email.hbs    # renderer → MJML, post-mjml → HTML, post-email → EML
```

Same shape as frontmatter on the source entity:

```yaml
---
postprocessors: [mjml, email]
---
```

See the [mikser-io rendering docs](https://github.com/almero-digital-marketing/mikser-io/blob/main/documentation/rendering.md#postprocess) for the per-stage contract and failure semantics.

## `inspect()` primitive

`runtime.options.layouts.inspect(layoutId, { samples, partials })` returns a layout's template source, sample entities, and three views of what it depends on:

- **`references.contract`** — the whole layout tree walked, with partial arguments and renamings resolved, so `meta` lists document keys in the form a document writes them. Pass `partials` (the ids a render actually used, from the manifest) to scope it to one page: a layout that dispatches sections through a registry otherwise resolves statically to *every* section in the project.
- **`references.runtime`** — what recent renders actually touched, including `metaReads`, which sees a layout sidecar that no parser can.
- **`references.static`** — the single-file parse, in that file's own vocabulary.

`contract.complete` is false when a branch could not be read, and `incomplete` names each with a reason. An incomplete contract is still useful, but absence is not proof.

## Checking a document — `mikser_check_entity`

Answers "does this document have what its layout needs", before the mistake ships. A mistyped key does not fail a build: the section it named simply does not render.

It classifies the entity first, because not every document is a page — `page`, `data` (never renders, but other entities query it; reports who, and what they read off it) or `unreferenced` (nothing in the catalog reads it, which is not an error — the catalog is readable over the API).

Read `missing` first, but check **`missingFrom`**:

- `schema` — a [zod schema](https://www.npmjs.com/package/mikser-io-schemas) declares the key required. Authoritative, and it needed no template parsing.
- `inferred` — read out of the templates. Strong evidence, not proof: it models one engine's semantics and a guard it cannot see makes a fine document look broken.

With a schema you also get `drift`: `readButNotDeclared` (layouts consume a key nothing declares — a schema gap, or a template typo) and `declaredButNotRead` (declared, unread — dead, or served over the API).

Everything else means "you may want to look", never "this is broken": `missingOptional` is guarded and safe to omit, `unused` may be consumed by another layout or an API client, `untraceable` means an ancestor was read but its members could not be followed, and `unresolvedSections` names a section that matched no template.

## Entity properties

**Set on documents (by this plugin):**
- `layout`: The first matched layout (back-compat alias).
- `layouts`: Array of all matched layouts (canonical under multi-match).
- `destination`: Resolved output path — per-task; iterating `entity.layouts` lets you see each.
- `page` / `pages`: Pagination info (if the layout's sidecar provides pages data).

**Set on layouts (by this plugin):**
- `id`, `uri`, `source`: Path info
- `collection`: `'layouts'`
- `type`: `'layout'`
- `format`: Template format (`'hbs'`, `'html'`, etc.)
- `name`: Layout name without extension
- `template`: Same as `format`

## Watch support

Yes — layout file changes trigger re-rendering of dependent documents via the refs system.

### What a sidecar imports is an input too

A layout's `.js` sidecar is part of that layout's checksum, and so is every
`.js` file under the layouts folder — editing `layouts/lib/context.js`
re-renders the layouts that depend on it.

Sidecars also import helpers from **outside** the layouts folder, which is
where code shared with `mikser.config.js` or a script lives. Those cannot be
globbed, because the set is whatever a sidecar happens to import, so they are
recorded as they resolve: the first build that loads a sidecar learns its
import graph, stores it in the runtime folder, and from then on editing one of
those modules re-renders the layouts that reach it, under `--watch` and on a
plain rebuild alike. This is the same bargain `readFile` and `glob` tracking
make — an edge is learned from the run that used it.

Two consequences worth knowing:

- **Only project files count.** `node_modules` and anything outside the
  working folder are left alone: they are not what you are editing, and
  hashing them on every scan would cost the whole tree. Bump the dependency
  and rebuild.
- **A module in a sidecar's import graph is re-evaluated when layout code
  changes.** That is what makes an edit take effect in a long-running
  `--watch` process rather than serving the copy loaded at boot. It also means
  a process-wide singleton — a connection pool, a cache — does not belong in
  one. Import it lazily inside the function that needs it, or keep it out of
  the graph.

The first build after upgrading discovers the graph and **does not** re-render
anything for it: each module is stored with the checksum it already had, so
only a later edit moves anything.

## Href lookups

The href resolution path goes through `runtime.lookupHref(href)` — a sync function that hits the `meta_href` index on `mikser_entities`. Render workers open their own read-only sqlite handle on first task and call the same primitive; templates stay sync. The `href` render plugin uses this; layout-side code can call it directly.

## License

MIT
