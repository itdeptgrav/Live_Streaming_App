// A ready-to-paste brief for an integrator's AI assistant, covering the one
// job people get wrong: opening the screen picker from their own button.
import { PUBLISHER_PROMPT, PUBLISHER_PROMPT_FILENAME } from "@/lib/publisherPrompt";

export const dynamic = "force-static";

export async function GET() {
  return new Response(PUBLISHER_PROMPT, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      // See llms.txt/route.js — content-rewriting extensions were treating
      // these exports as documents and injecting into them.
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename="${PUBLISHER_PROMPT_FILENAME}.txt"`,
      "Cache-Control": "public, max-age=3600",
    },
  });
}
