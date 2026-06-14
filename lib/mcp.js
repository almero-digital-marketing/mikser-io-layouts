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
        'Inspect a layout: template source, references (runtime: precise refClosure from recent renders via the manifest; static: variables / partials / iterations / helpers parsed from source by the renderer plugin), and sample entities currently targeting it. Use this to answer "what does this layout need from an entity" before drafting a preview render — saves a guess-and-render-empty cycle.',
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
                                'references.runtime is the precise answer from manifest snapshots — what the renderer actually touched in recent renders. Empty if the layout has never rendered.',
                                'references.static is the renderer-plugin AST walk of the template source — what the source mentions, including unexercised conditional branches. Empty when the renderer does not expose parseReferences (markdown / metatext / custom).',
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
