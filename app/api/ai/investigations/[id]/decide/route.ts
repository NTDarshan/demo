import { parseId } from "@/lib/api/access";
import { handle, jsonBody } from "@/lib/api/handler";
import { decideSchema } from "@/lib/api/schemas";
import { requireRole } from "@/lib/auth/session";
import { decideInvestigation } from "@/lib/data/ai";

// POST /api/ai/investigations/:id/decide  { decision: ACCEPT | DISMISS, note? }
// ACCEPT resolves the reconciliation item through resolve_recon_item(), in the same
// transaction that marks the suggestion accepted. The person can edit the note first.
export const POST = handle<{ id: string }>(async (req, { id }) => {
  const role = await requireRole("reconciliation.run");
  const { decision, note } = decideSchema.parse(await jsonBody(req));
  return decideInvestigation(parseId(id, "Investigation"), decision, role, note ?? null);
});
