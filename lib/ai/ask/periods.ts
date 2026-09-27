// Named date ranges resolved in code, so "last week" means the same thing every time.
// (Left to the model, "last week" on a Sunday was sometimes the week that includes today.)
// Pure, unit tested. Weeks run Monday to Sunday; months are calendar months (IST dates).

import { addDays } from "@/lib/dates";

export type Period = { name: string; from: string; to: string };

const monthStart = (d: string) => `${d.slice(0, 7)}-01`;
function monthEnd(d: string): string {
  const [y, m] = d.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return addDays(next, -1);
}

export function namedPeriods(today: string): Period[] {
  const dow = (new Date(`${today}T12:00:00Z`).getUTCDay() + 6) % 7; // Monday = 0
  const thisMon = addDays(today, -dow);
  const lastMonthEnd = addDays(monthStart(today), -1);
  return [
    { name: "today", from: today, to: today },
    { name: "yesterday", from: addDays(today, -1), to: addDays(today, -1) },
    { name: "this week", from: thisMon, to: today },
    { name: "last week", from: addDays(thisMon, -7), to: addDays(thisMon, -1) },
    { name: "the week before last", from: addDays(thisMon, -14), to: addDays(thisMon, -8) },
    { name: "last 7 days", from: addDays(today, -6), to: today },
    { name: "last 30 days", from: addDays(today, -29), to: today },
    { name: "this month", from: monthStart(today), to: today },
    { name: "last month", from: monthStart(lastMonthEnd), to: monthEnd(lastMonthEnd) },
  ];
}

export function periodsText(today: string): string {
  return namedPeriods(today)
    .map((p) => `- ${p.name}: ${p.from === p.to ? p.from : `${p.from} to ${p.to}`}`)
    .join("\n");
}
