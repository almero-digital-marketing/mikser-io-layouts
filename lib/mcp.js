// MCP tool surface for layouts. Registered against the mcp substrate
// at `runtime.options.mcp` when present — same gating pattern other
// siblings use (vector, schemas, preview). When mcp isn't loaded, the
// registration is a no-op.
//
// One tool: `mikser_layouts_inspect`. Surfaces the inspect() primitive
// already exposed at `runtime.options.layouts.inspect`. The schema and
// author-facing description live here because they're MCP-flavor; the
// underlying data shape is owned by lib/inspect.js.

import { z } from 'zod'

export function registerMcpTools({ runtime, useLogger }) {
    const mcp = runtime.options.mcp
    if (!mcp) return   // mcp plugin not loaded — nothing to register
    if (!runtime.options.layouts?.inspect) return   // shouldn't happen if we run after our own inspect setup, but defensive

    const logger = useLogger()

    mcp.simpleTool(
        'mikser_layouts_inspect',
        'Inspect a layout and everything it pulls in. Answers "what does this layout need from a document" '
        + 'before you write one — which saves a guess-and-render-empty cycle, and is the only way to catch a '
        + 'mistyped key before it ships a page with a section silently missing.\n\n'
        + 'START WITH references.contract.meta. It is the list of document meta keys the WHOLE layout tree '
        + 'consumes, resolved through includes and renamings into the vocabulary a document actually writes — '
        + 'so `data.meta.hero.tags` in a partial three files down comes back as `hero.tags`. Compare it against '
        + 'the meta you are about to write: a key in the contract with no value is a gap, and a key you wrote '
        + 'that appears nowhere in it is usually a typo.\n\n'
        + 'Check references.contract.complete before trusting a comparison. When false, some branch could not be '
        + 'read and references.contract.incomplete names each one with a reason.\n\n'
        + 'Also returns the template source, sample entities targeting the layout, and both reference views: '
        + 'runtime (what recent renders actually touched) and static (what the source mentions, including '
        + 'branches no render has taken).',
        {
            id: z.string().describe('Layout id, e.g. "/layouts/reports/royalty.html-pdf.liquid". Use mikser_query_entities with { collection: "layouts" } to discover ids.'),
            samples: z.number().int().min(0).max(10).optional().describe('How many existing entities currently using this layout to include as data-shape examples. Default 3. Only entities with explicit meta.layout match; auto-matched layouts are not surfaced.'),
        },
        async ({ id, samples = 3 }) => {
            try {
                const result = await runtime.options.layouts.inspect(id, { samples })
                return {
                    content: [{
                        type: 'text',
                        text: JSON.stringify({
                            ...result,
                            notes: [
                                'references.contract is the one to read first: the whole layout tree walked, with partial arguments and renamings resolved, so `meta` lists document keys in the form a document writes them. `[]` marks an element — `hero.tags[].label` means each tag has a label, not that the list does.',
                                'references.contract.complete is false when any branch could not be read, and `incomplete` names each with a reason. An incomplete contract is still useful, but a key missing from it may only be missing because that branch was unreadable — do not treat absence as proof.',
                                'references.contract covers TEMPLATES. A layout sidecar is plain JavaScript and cannot be parsed, so a key only it reads will not appear there — look in references.runtime.metaReads instead.',
                                'references.runtime.metaReads is what renders actually READ, sidecars included, unioned across the samples. It sees a sidecar the contract cannot; it does not see a branch no sample took. The two are complements, not alternatives.',
                                'references.runtime is the precise answer from manifest snapshots — what the renderer actually touched in recent renders. Empty if the layout has never rendered.',
                                'references.static is the renderer-plugin walk of THIS FILE only, in this file\'s own vocabulary. references.contract is the same walk followed across every partial and resolved into the author\'s. Prefer the contract.',
                                'samples only includes entities with explicit meta.layout. Auto-matched layouts are not listed; use mikser_query_entities with a filename-pattern filter for those.',
                            ],
                        }, null, 2),
                    }],
                }
            } catch (err) {
                logger.error('MCP mikser_layouts_inspect error: %s', err.message)
                return {
                    isError: true,
                    content: [{ type: 'text', text: err.message }],
                }
            }
        },
    )

    logger.debug('MCP tool registered: mikser_layouts_inspect (layouts plugin)')
}
