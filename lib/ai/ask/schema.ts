// The shape of an Ask Kosha answer. Filled by OpenAI structured output, then checked by
// verifyAnswer() before it is shown. Lengths are trimmed in tidyAnswer() (strict schema mode
// does not allow min/max).

import { z } from "zod";

export const answerSchema = z.object({
  answer: z
    .string()
    .describe("The answer in 1 to 4 short paragraphs of plain English. Lead with the direct answer and the key number. **bold** allowed; lines starting with '- ' become a list. No markdown tables here."),
  table: z
    .object({
      title: z.string().describe("Short title, or empty string when there is no table."),
      columns: z.array(z.string()).describe("Column headings. Empty when there is no table."),
      rows: z
        .array(
          z.object({
            cells: z.array(z.string()).describe("One value per column, copied exactly from the tool results."),
            ref: z.string().describe("Evidence id of the student or payment this row is about (e.g. student:CSE24-001), or empty string."),
          }),
        )
        .describe("Up to 15 rows."),
    })
    .describe("A table when the answer is a list of students, payments or groups (3 or more items). Otherwise title '', columns [] and rows []."),
  sources: z.array(z.string()).describe("Evidence ids from the tool results that the answer relies on (reports, students, payments)."),
  followUps: z.array(z.string()).describe("2 or 3 short follow-up questions the user might ask next, answerable with the same tools."),
});

export type Answer = z.infer<typeof answerSchema>;

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1).trimEnd()}…` : s);

export function tidyAnswer(a: Answer): Answer {
  const columns = a.table.columns.slice(0, 6).map((c) => clip(c.trim(), 40));
  return {
    answer: clip(a.answer.trim(), 2000),
    table: {
      title: clip(a.table.title.trim(), 120),
      columns,
      rows: columns.length === 0 ? [] : a.table.rows.slice(0, 15).map((r) => ({ cells: r.cells.slice(0, columns.length).map((c) => clip(c.trim(), 120)), ref: r.ref.trim() })),
    },
    sources: [...new Set(a.sources.map((s) => s.trim()))].slice(0, 12),
    followUps: a.followUps.slice(0, 3).map((f) => clip(f.trim(), 140)),
  };
}
