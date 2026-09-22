import { z } from 'zod';
import { KnowledgeSearchPort } from './knowledge-search.port';
import type { ToolContext, ToolResult, ToolSpec } from './tool.types';

const searchDocumentationSchema = z.object({
  query: z.string().trim().min(1).max(300),
  limit: z.number().int().min(1).max(10).optional(),
});
export type SearchDocumentationArgs = z.infer<typeof searchDocumentationSchema>;

const DEFAULT_LIMIT = 5;

/**
 * `search_documentation`: retrieves the curated knowledge cards for this profile's
 * segments. No `segment` argument -- which documents an actor may reach is a property of
 * the session (`ToolContext.segments`, from `role-profile.ts#segmentsFor`), never a
 * choice the model makes, the same subject-comes-from-context rule every other tool in
 * this catalogue follows.
 */
export function buildSearchDocumentationTool(
  knowledge: KnowledgeSearchPort,
): ToolSpec<SearchDocumentationArgs> {
  return {
    name: 'search_documentation',
    description:
      'Search the product knowledge base for how something works or what to do next. ' +
      'Returns short cards with a title, a summary and the body text.',
    schema: searchDocumentationSchema,
    async run(ctx: ToolContext, args: SearchDocumentationArgs): Promise<ToolResult> {
      const results = await knowledge.search(args.query, ctx.segments, args.limit ?? DEFAULT_LIMIT);
      const summary =
        results.length === 0
          ? `No documentation matched "${args.query}"`
          : `Found ${results.length} document(s) for "${args.query}"`;
      return {
        ok: true,
        summary,
        resultContent: JSON.stringify({
          results: results.map((result) => ({
            slug: result.slug,
            section: result.section,
            title: result.title,
            summary: result.summary,
            body: result.body,
            actions: result.actions,
          })),
        }),
      };
    },
  };
}
