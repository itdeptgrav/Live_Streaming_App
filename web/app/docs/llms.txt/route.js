// Plain-text export, for pasting into an AI assistant.
// The document itself lives in lib/docsExport.js so every format stays in sync.
import { DOCS_MARKDOWN, DOCS_FILENAME } from "@/lib/docsExport";

export const dynamic = "force-static";

export async function GET() {
  return new Response(DOCS_MARKDOWN, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      // The document contains a literal <script> tag in the SDK example, and
      // content-rewriting browser extensions were treating this response as
      // HTML and injecting their own payload after it — turning a 17 KB
      // reference into a 900 KB mess. These two headers say "opaque download,
      // do not parse", which stopped it.
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="${DOCS_FILENAME}.txt"`,
      "Cache-Control": "public, max-age=3600",
    },
  });
}
