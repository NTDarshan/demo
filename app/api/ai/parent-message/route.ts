import { z } from "zod";
import { ApiError } from "@/lib/api/errors";
import { handle, jsonBody } from "@/lib/api/handler";
import { requireRole } from "@/lib/auth/session";
import { aiEnabled } from "@/lib/ai/config";
import { draftParentMessage } from "@/lib/ai/parent-message/draft";
import { buildFacts, CHANNELS, LANGUAGES, PURPOSES } from "@/lib/ai/parent-message/facts";
import { rpc } from "@/lib/data/db";
import { getStudentDetail, resolveStudentId } from "@/lib/data/students";
import { isoDateIST } from "@/lib/dates";

// POST /api/ai/parent-message  { student, purpose, language, channel }
// Drafts a message to the student's parent from the ledger's facts. Nothing is sent; the
// draft is returned for staff to review, edit and copy, and the drafting is audit-logged.

export const runtime = "nodejs";
export const maxDuration = 60;

const bodySchema = z.object({
  student: z.string().trim().min(3).max(64),
  purpose: z.enum(PURPOSES),
  language: z.enum(LANGUAGES),
  channel: z.enum(CHANNELS),
});

export const POST = handle(async (req) => {
  const role = await requireRole("payment.record");
  if (!aiEnabled()) throw new ApiError(503, "ai_unavailable", "Message drafting is off: OPENAI_API_KEY is not set on the server.");
  const body = bodySchema.parse(await jsonBody(req));
  const studentId = await resolveStudentId(body.student);
  const detail = await getStudentDetail(studentId);
  const { facts, amountsPaise, purposes } = buildFacts(detail, isoDateIST());
  const result = await draftParentMessage({ facts, amountsPaise, purpose: body.purpose, check: purposes[body.purpose], language: body.language, channel: body.channel });
  await rpc("log_message_draft", {
    p_actor: role,
    p_student_id: studentId,
    p_details: { purpose: body.purpose, language: body.language, channel: body.channel, model: result.model, checks_passed: result.verification.ok },
  });
  return result;
});
