// Builds public/samples/gateway_report_sep_2026.csv: the same settlements as
// settlement_sample.csv, but laid out the way a payment gateway's own dashboard exports them,
// to demo smart import. Different column names, DD/MM/YYYY 12-hour dates, gross/fee/net
// columns, a payout UTR that looks like a reference, a transaction date next to the settlement
// date, and one failed transaction.
// Run right after `npm run db:reset`: node scripts/make-gateway-report.ts
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
if (!process.env.DATABASE_URL && existsSync(join(root, ".env.local"))) process.loadEnvFile(join(root, ".env.local"));

const sample = readFileSync(join(root, "public", "samples", "settlement_sample.csv"), "utf8").trim().split("\n").slice(1).map((l) => l.split(","));

const client = new pg.Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
try {
  const { rows: pays } = await client.query<{ gateway_ref: string; mode: string; name: string; created_at: Date; status: string; amount_paise: string }>(
    `select p.gateway_ref, p.mode, s.name, p.created_at, p.status, p.amount_paise from payments p join students s on s.id = p.student_id where p.gateway_ref is not null`,
  );
  const byRef = new Map(pays.map((p) => [p.gateway_ref, p]));

  const pad = (n: number) => String(n).padStart(2, "0");
  const ist = (d: Date) => new Date(d.getTime() + 5.5 * 3600_000);
  const fmt = (d: Date) => {
    const t = ist(d);
    const h = t.getUTCHours();
    return `${pad(t.getUTCDate())}/${pad(t.getUTCMonth() + 1)}/${t.getUTCFullYear()} ${pad(((h + 11) % 12) + 1)}:${pad(t.getUTCMinutes())} ${h < 12 ? "AM" : "PM"}`;
  };
  const money = (p: number) => `${Math.floor(p / 100).toLocaleString("en-IN")}.${pad(p % 100)}`;
  const q = (s: string) => (/[",]/.test(s) ? `"${s}"` : s);

  const lines = ["Settlement Date,Txn Date,Txn Reference,Customer Name,Payment Method,Gross Amount (Rs),MDR,GST on MDR,Net Settled (Rs),Settlement UTR,Txn Status"];
  let batch = 0;
  let lastDay = "";
  for (const [ref, amount, , settled] of sample) {
    const p = byRef.get(ref!)!;
    const gross = Math.round(Number(amount) * 100);
    const mdr = p.mode === "CARD" ? Math.round(gross * 0.018) : 0;
    const gst = Math.round(mdr * 0.18);
    const day = settled!.slice(0, 10);
    if (day !== lastDay) {
      batch += 1;
      lastDay = day;
    }
    lines.push(
      [fmt(new Date(settled!)), fmt(p.created_at), ref!, p.name, p.mode === "CARD" ? "Card" : "UPI", money(gross), money(mdr), money(gst), money(gross - mdr - gst), `SETL${day.replace(/-/g, "")}${pad(batch)}7731`, "Captured"].map(q).join(","),
    );
  }
  // One failed transaction the gateway lists for completeness (not a settlement).
  const failed = pays.find((p) => p.status === "FAILED");
  if (failed) {
    const gross = Number(failed.amount_paise);
    const lastSettled = sample[sample.length - 1]![3]!;
    lines.push([fmt(new Date(lastSettled)), fmt(failed.created_at), failed.gateway_ref, failed.name, failed.mode === "CARD" ? "Card" : "UPI", money(gross), "0.00", "0.00", "0.00", "", "Failed"].map(q).join(","));
  }
  const out = join(root, "public", "samples", "gateway_report_sep_2026.csv");
  writeFileSync(out, lines.join("\n") + "\n");
  console.log(`Wrote ${lines.length - 1} rows to ${out}`);
} finally {
  await client.end();
}
