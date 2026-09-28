import { describe, expect, it } from "vitest";
import { namedPeriods } from "@/lib/ai/ask/periods";
import { tidyAnswer, type Answer } from "@/lib/ai/ask/schema";
import { verifyAnswer, type AnswerContext } from "@/lib/ai/ask/verify";

const period = (today: string, name: string) => namedPeriods(today).find((p) => p.name === name)!;

describe("named periods", () => {
  it("on a Sunday, last week is the previous Monday to Sunday, not the week that includes today", () => {
    // 27 Sep 2026 is a Sunday.
    expect(period("2026-09-27", "this week")).toMatchObject({ from: "2026-09-21", to: "2026-09-27" });
    expect(period("2026-09-27", "last week")).toMatchObject({ from: "2026-09-14", to: "2026-09-20" });
    expect(period("2026-09-27", "the week before last")).toMatchObject({ from: "2026-09-07", to: "2026-09-13" });
  });
  it("on a Monday, this week is just today", () => {
    expect(period("2026-09-28", "this week")).toMatchObject({ from: "2026-09-28", to: "2026-09-28" });
    expect(period("2026-09-28", "last week")).toMatchObject({ from: "2026-09-21", to: "2026-09-27" });
  });
  it("handles month and year boundaries", () => {
    expect(period("2026-03-05", "last month")).toMatchObject({ from: "2026-02-01", to: "2026-02-28" });
    expect(period("2027-01-02", "last month")).toMatchObject({ from: "2026-12-01", to: "2026-12-31" });
    expect(period("2027-01-02", "yesterday")).toMatchObject({ from: "2027-01-01", to: "2027-01-01" });
  });
});

const answer = (over: Partial<Answer> = {}): Answer => ({
  answer: "12 students owe more than ₹1,00,000 and are overdue, ₹7,21,000 overdue in total.",
  table: { title: "", columns: [], rows: [] },
  sources: ["report:x"],
  followUps: [],
  ...over,
});
const ctx = (over: Partial<AnswerContext> = {}): AnswerContext => ({
  knownAmountsPaise: new Set([72_100_000, 10_000_000]),
  evidenceIds: new Set(["report:x", "student:CSE24-001"]),
  usedTools: true,
  questionAmountsPaise: new Set([10_000_000]),
  ...over,
});

describe("verifyAnswer", () => {
  it("passes figures that came from the tools or from the question", () => {
    expect(verifyAnswer(answer(), ctx()).ok).toBe(true);
  });
  it("flags a figure in a table cell that no tool returned", () => {
    const a = answer({ table: { title: "t", columns: ["Name", "Owes"], rows: [{ cells: ["Rohan", "₹1,42,000"], ref: "student:CSE24-001" }] } });
    const v = verifyAnswer(a, ctx());
    expect(v.ok).toBe(false);
    expect(v.unverifiedAmounts).toEqual(["₹1,42,000"]);
  });
  it("flags table rows and sources that point at unknown records", () => {
    const a = answer({ sources: ["student:XYZ99-001"], table: { title: "t", columns: ["Name"], rows: [{ cells: ["Someone"], ref: "payment:MADEUP" }] } });
    expect(verifyAnswer(a, ctx()).checks.find((c) => c.name === "Sources exist")?.ok).toBe(false);
  });
  it("flags money figures given without any lookup, but not the user's own figure quoted back", () => {
    expect(verifyAnswer(answer({ answer: "You owe ₹7,21,000." }), ctx({ usedTools: false })).ok).toBe(false);
    expect(verifyAnswer(answer({ answer: "I cannot record the ₹1,00,000 payment.", sources: [] }), ctx({ usedTools: false })).ok).toBe(true);
  });
});

describe("tidyAnswer", () => {
  it("drops rows when there are no columns and trims cells to the column count", () => {
    const a = tidyAnswer(answer({ table: { title: "x", columns: ["A"], rows: [{ cells: ["1", "2"], ref: "" }] } }));
    expect(a.table.rows[0]!.cells).toEqual(["1"]);
    expect(tidyAnswer(answer({ table: { title: "", columns: [], rows: [{ cells: ["1"], ref: "" }] } })).table.rows).toEqual([]);
  });
});
