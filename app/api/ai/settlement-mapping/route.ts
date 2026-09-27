import { z } from "zod";
import { ApiError } from "@/lib/api/errors";
import { handle, jsonBody } from "@/lib/api/handler";
import { requireRole } from "@/lib/auth/session";
import { aiEnabled } from "@/lib/ai/config";
import { proposeMapping } from "@/lib/ai/settlement-mapper";

// POST /api/ai/settlement-mapping  { headers, rows }
// Proposes how an unfamiliar settlement file's columns map to Kosha's format. The browser sends
// only the header and a sample of rows (at most 25). Nothing is saved or reconciled here.

export const runtime = "nodejs";
export const maxDuration = 60;

const cell = z.string().max(300);
const bodySchema = z.object({
  headers: z.array(z.string().trim().min(1).max(120)).min(2, "The file needs at least two columns.").max(40, "The file has too many columns."),
  rows: z.array(z.record(cell)).min(1, "The file has no data rows.").max(25),
});

export const POST = handle(async (req) => {
  await requireRole("reconciliation.run");
  if (!aiEnabled()) throw new ApiError(503, "ai_unavailable", "Smart import is off: OPENAI_API_KEY is not set on the server.");
  const { headers, rows } = bodySchema.parse(await jsonBody(req));
  if (new Set(headers).size !== headers.length) throw new ApiError(422, "duplicate_headers", "Two columns in the file have the same name. Rename one and try again.");
  return proposeMapping(headers, rows);
});
