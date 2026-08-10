// Markdown export — the same document as /docs/llms.txt, typed as Markdown so
// it drops straight into a README, a wiki, or a repository.
import { DOCS_MARKDOWN, DOCS_FILENAME } from "@/lib/docsExport";

export const dynamic = "force-static";

export async function GET() {
  return new Response(DOCS_MARKDOWN, {
    headers: {
      "Content-Type": "text/markdown; charset=utf-8",
      // See llms.txt/route.js — a literal <script> tag in the SDK example made
      // content-rewriting extensions treat this as a document to modify.
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="${DOCS_FILENAME}.md"`,
      "Cache-Control": "public, max-age=3600",
    },
  });
}
