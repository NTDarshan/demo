import type { NextRequest } from "next/server";
import { parseId } from "@/lib/api/access";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { requireRole } from "@/lib/auth/session";
import { aiEnabled } from "@/lib/ai/config";
import { investigateReconItem } from "@/lib/ai/recon-copilot/run";
import type { CopilotEvent } from "@/lib/ai/recon-copilot/types";

// POST /api/ai/recon-items/:id/investigate
// Streams the Copilot's progress as newline-delimited JSON (one CopilotEvent per line) and
// ends with a "done" event carrying the saved investigation. Nothing here changes money:
// the proposal is only applied when a person accepts it (see /api/ai/investigations/:id/decide).

export const runtime = "nodejs";
export const maxDuration = 60;

// One investigation per item at a time in this server process.
const inFlight = new Set<string>();

export async function POST(_req: NextRequest, ctx: { params: Promise<{ id: string }> }) {
  let itemId: string;
  let role;
  try {
    role = await requireRole("reconciliation.run");
    itemId = parseId((await ctx.params).id, "Reconciliation item");
    if (!aiEnabled()) throw new ApiError(503, "ai_unavailable", "The Copilot is off: OPENAI_API_KEY is not set on the server.");
    if (inFlight.has(itemId)) throw new ApiError(409, "ai_busy", "The Copilot is already investigating this item.");
  } catch (err) {
    return errorResponse(err);
  }

  inFlight.add(itemId);
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: CopilotEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
      try {
        await investigateReconItem(itemId, role, send);
      } catch (err) {
        const e = err instanceof ApiError ? err : null;
        if (!e) console.error("Copilot failed", err);
        const openAiDown = !e && err instanceof Error && /api key|401|429|quota|rate limit|timeout|ECONN|fetch failed/i.test(err.message);
        send({
          type: "error",
          code: e?.code ?? (openAiDown ? "ai_provider_error" : "ai_failed"),
          message: e?.message ?? (openAiDown ? "The AI service did not respond. Nothing was changed; try again in a minute." : "The Copilot hit an unexpected error. Nothing was changed."),
        });
      } finally {
        inFlight.delete(itemId);
        controller.close();
      }
    },
  });

  return new Response(body, {
    headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" },
  });
}
