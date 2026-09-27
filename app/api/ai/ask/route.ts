import type { NextRequest } from "next/server";
import { z } from "zod";
import { ApiError, errorResponse } from "@/lib/api/errors";
import { jsonBody } from "@/lib/api/handler";
import { requireRole } from "@/lib/auth/session";
import { aiEnabled } from "@/lib/ai/config";
import { askKosha } from "@/lib/ai/ask/run";
import type { AskEvent } from "@/lib/ai/ask/types";

// POST /api/ai/ask  { question, history? }
// Streams newline-delimited JSON AskEvents and ends with { type: "done", result }.
// Read-only: the agent's tools can only query the database.

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({
  question: z.string().trim().min(2, "Type a question.").max(500, "Keep the question under 500 characters."),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(4000) }))
    .max(12)
    .default([]),
});

export async function POST(req: NextRequest) {
  let body: z.infer<typeof bodySchema>;
  try {
    await requireRole("dashboard.view");
    if (!aiEnabled()) throw new ApiError(503, "ai_unavailable", "Ask Kosha is off: OPENAI_API_KEY is not set on the server.");
    body = bodySchema.parse(await jsonBody(req));
  } catch (err) {
    return errorResponse(err);
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (e: AskEvent) => controller.enqueue(encoder.encode(`${JSON.stringify(e)}\n`));
      try {
        await askKosha(body.question, body.history, send);
      } catch (err) {
        const e = err instanceof ApiError ? err : null;
        if (!e) console.error("Ask Kosha failed", err);
        send({ type: "error", code: e?.code ?? "ai_failed", message: e?.message ?? "Ask Kosha could not answer that right now. Try again in a moment." });
      } finally {
        controller.close();
      }
    },
  });
  return new Response(stream, { headers: { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-accel-buffering": "no" } });
}
