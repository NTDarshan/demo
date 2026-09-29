import { handle } from "@/lib/api/handler";
import { requireRole } from "@/lib/auth/session";
import { writeBrief } from "@/lib/ai/brief/brief";
import { loadBriefInput, saveBrief } from "@/lib/data/brief";

// POST /api/ai/brief  write today's brief from the ledger and save it (a refresh adds a new one).
// Works without an OpenAI key: the brief is then written by rules.
export const runtime = "nodejs";
export const maxDuration = 60;

export const POST = handle(async () => {
  const role = await requireRole("dashboard.view");
  const content = await writeBrief(await loadBriefInput());
  return saveBrief(role, content);
});
