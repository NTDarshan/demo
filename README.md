# Kosha: fee collection and reconciliation

Kosha (Sanskrit/Kannada for "treasury") is a fee ledger for an Indian college. Accountants record
payments against each student's installments, online payments go through a mock gateway that can
succeed, fail or time out, and a daily settlement file from the gateway is reconciled against what
was recorded. Every rupee is traceable: the ledger is append-only, every change is one database
transaction, and every action lands in the audit log.

- **Live demo:** `[Darshan: add the Vercel URL]`
- **Repository:** `[Darshan: add the repository URL]`
- **Documentation (PDF):** [`docs/Kosha_Documentation.pdf`](docs/Kosha_Documentation.pdf) · short version: [`docs/APPROACH.md`](docs/APPROACH.md)

Built for Edumerge Solutions, Assignment 2: Fee Collection & Reconciliation.

## What it does

| Area | What you can do |
|---|---|
| Students | Search and filter 60 students by course and status (overdue, due, paid, advance) |
| Statement | Passbook with running balance, fee-head bars, installments, payments; reversed payments stay visible and link to their reversal |
| Payments | Record cash, UPI, card or bank transfer with an allocation preview; simulate the gateway (succeed, fail, time out); check status; mark failed; reverse (admin) |
| Concessions | Apply a concession to an installment (admin), capped at what is still owed |
| Receipts | Sequential receipt numbers (`KSH/2026-27/000123`), printable A5 receipt with the amount in words |
| Reconciliation | Upload a settlement CSV; rows land in four buckets (matched, amount mismatch, settled but pending here, missing in settlement); resolve each exception |
| Dashboard | Collected this term, outstanding, overdue, pending; 30-day trend; overdue by course; a needs-attention list |
| Audit log | Every money function writes a readable line: who, what, which record, why |

Roles are simulated (real login is out of scope): switch between **Admin**, **Accountant** and
**Student** in the top bar. The server enforces one permission matrix
([`lib/auth/permissions.ts`](lib/auth/permissions.ts)); the UI hides what a role can't do and the
API still answers 403.

## Five-minute demo

The seed tells a story; the **Demo guide** button in the top bar lists the same students.
Start as **Admin**.

1. **Dashboard** (`/`). Note the pending payments and the needs-attention list.
2. **Vikram Singh** (`BCOM26-001`, nothing paid, overdue). *Record payment* → the amount is
   prefilled with what is overdue and the preview says which installments it clears. Choose
   *Cash*, submit: the new passbook row flashes and the balance drops.
3. **Rohan Kulkarni** (`CSE24-001`, partly paid). *Record payment*, choose *UPI*, pick
   *Fail* in the demo control: the drawer stays open with the reason; nothing reaches the ledger.
4. **Sneha Iyer** (`BCA26-002`, UPI payment stuck in pending). Payments tab → row menu →
   *Check status*: the mock gateway confirms it and a receipt is issued.
5. **Reconciliation** (`/reconciliation`). *Download sample file*, then drop it back in. You get
   33 matched, 1 amount mismatch, 2 settled but pending here, 1 missing in settlement. *Mark as
   paid* the pending one; *Mark reviewed* the mismatch with a note.
6. **Arjun Mehta** (`CSE24-003`). His bank transfer was returned: the original row is struck
   through and linked to its reversal, and tuition is overdue again. Open the payment to see the
   state track, allocations and ledger entries.
7. **Priya Nair** (`CSE25-002`) has a merit concession; *Apply concession* on a term 2
   installment. **Karthik Reddy** (`BCOM25-002`) overpaid: the balance reads as an advance.
   **Ananya Rao** (`BCA25-001`) is fully paid: open a receipt and print it.
8. Switch to **Accountant** (no reverse, no concession) and **Student** (own statement only,
   online payments only). **Audit log** shows everything you just did.
9. Demo guide → *Reset demo data* to start over.

## Setup

Requirements: Node.js 22.18 or newer (the database scripts use Node's built-in TypeScript
support), a Supabase project (free tier is fine).

```bash
npm install
cp .env.example .env.local        # then fill in the values below
npm run db:setup                  # creates tables, functions and demo data, then verifies the ledger
npm run dev                       # http://localhost:3000
```

`.env.local`:

| Variable | Where to find it |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | Supabase → Project settings → Data API (`https://<ref>.supabase.co`) |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Project settings → API keys → publishable (or legacy anon) key |
| `SUPABASE_SERVICE_ROLE_KEY` | Same page → secret (or legacy service_role) key. **Server-side only.** |
| `DATABASE_URL` | *Connect* → connection string (direct or session pooler, port 5432). URL-encode special characters in the password (`@` → `%40`, `%` → `%25`). Used only by scripts. If the direct host (`db.<ref>.supabase.co`) does not resolve on your network (it is IPv6-only), use the session pooler. |
| `OPENAI_API_KEY` | Optional: turns on the AI features. **Server-side only.** `OPENAI_MODEL` defaults to `gpt-4.1-mini`. |

A database set up before the AI features existed only needs `npm run db:migrate`.

`npm run db:reset` drops only Kosha's own tables, views and functions (never the whole `public`
schema) and reapplies everything. The same reset is available in the app for admins.

## Scripts

| Script | What it does |
|---|---|
| `npm run dev` / `build` / `start` | Next.js development server, production build, production server |
| `npm run typecheck` | `tsc --noEmit` (strict) |
| `npm run lint` | ESLint, zero warnings allowed |
| `npm test` | All Vitest tests: unit, plus integration against the database (skipped if `.env.local` is missing) |
| `npm run test:unit` / `test:integration` | One suite only |
| `npm run e2e` | Playwright end-to-end smoke tests (starts `npm run dev` if nothing is running on port 3000) |
| `npm run db:setup` / `db:reset` / `db:verify` | Apply migrations / drop and reapply / run [`scripts/verify-ledger.sql`](scripts/verify-ledger.sql) |
| `npm run db:migrate` | Apply `004_ai.sql` to a database that already has 001 to 003 (idempotent) |
| `npm run eval:ai` | Run the Reconciliation Copilot and Ask Kosha evaluations against OpenAI and the demo database (the Copilot eval resets demo data) |
| `npm run db:sample` | Regenerate `public/samples/settlement_sample.csv` from freshly seeded data |
| `npm run docs:pdf` | Capture fresh screenshots and build `docs/Kosha_Documentation.pdf` (needs the app running) |

## Tests

- **Unit** (`tests/unit`, 165 tests): the AI verifiers (made-up figures, unknown evidence,
  forbidden actions, undisclosed duplicates), date periods for Ask Kosha, the file search and audit sentences; payment state machine (every legal and illegal transition,
  and a check that the TypeScript table matches the SQL one), reconciliation bucketing (duplicates,
  bad rows, amount formats, the settlement window, CSV edge cases), `toPaise`/`formatINR`/amount in
  words, allocation preview, statement builder, permission matrix, dates, error mapping.
- **Integration** (`tests/integration`, 13 tests, real database): same idempotency key twice (and
  three times in parallel) creates one payment; timeout then confirm writes exactly one ledger entry;
  two confirms racing post one entry; reversing reopens the installment; a concession above what is
  owed is rejected; six parallel payments on one student allocate correctly; the API role cannot
  write the ledger directly; `verify-ledger.sql` passes afterwards.
- **End to end** (`tests/e2e`, 3 tests): record a cash payment; an online payment times out and a
  settlement file resolves it; an admin reverses a payment (an accountant cannot).
- **Ledger verification** (`npm run db:verify`): nine invariants, including balance = SUM(ledger)
  for every student, allocations never exceed demand, and the ledger rejecting UPDATE and DELETE.

## AI features

Kosha has one rule for AI: **it never moves money.** Agents read and propose; a person decides,
and the decision goes through the same locked, audited SQL functions as every other write.
They use OpenAI through LangChain and LangGraph, on the server only (the key is read in route handlers, never in the browser).
Without `OPENAI_API_KEY` the AI features are simply hidden.

### Reconciliation Copilot

On a reconciliation run, each open exception has an **Investigate** button, and **Investigate
all** works through every open exception in turn. The Copilot:

1. **Investigates** with read-only tools (a LangGraph agent loop, at most 5 rounds):
   the gateway's own record, the payment's status history, the student's account, a search for a
   second payment of the same amount, a search of the file for the same amount under a mistyped
   reference, and other settlement files that contain the reference.
2. **Diagnoses** with structured output: headline, root cause, confidence, findings that cite
   evidence, a suggested action with a ready-to-save note and, when the gateway must be asked, a
   drafted support message.
3. **Verifies in code** before anyone sees it: every ₹ figure must be one the tools returned,
   every cited evidence id must exist, the action must be allowed for the bucket and the
   payment's current status, and a possible duplicate payment must be disclosed. On a failed
   check the model gets one retry with the failures as feedback. If it still fails, the suggestion
   becomes a low-confidence escalation.
4. **Waits for a person.** Accept runs `decide_ai_investigation()`, which calls
   `resolve_recon_item()` in the same transaction. Dismiss needs a reason. Escalations cannot be
   accepted, only resolved by hand. Every step is in the audit log.

```
START → investigate ⇄ tools → diagnose → verify ─(failed once)→ diagnose
                                            └──────────────────→ END (saved as a proposal)
```

Code: [`lib/ai/recon-copilot`](lib/ai/recon-copilot) (graph, tools, prompts, schema, verifier),
[`supabase/migrations/004_ai.sql`](supabase/migrations/004_ai.sql) (`ai_investigations`,
`save_ai_investigation`, `decide_ai_investigation`), the streaming route
[`app/api/ai/recon-items/[id]/investigate`](app/api/ai/recon-items/[id]/investigate/route.ts) (NDJSON)
and [`components/ai`](components/ai).

**Evaluation:** `npm run eval:ai` resets the demo data, reconciles the sample file and runs
the real model on each exception with a known right answer. It also stages a double payment (the
parent pays again at the counter) through `record_payment()`. Current result with `gpt-4.1-mini`:
4/4, about 6 to 8 seconds and 5,000 to 6,000 tokens per investigation.

| Case | Expected | Result |
|---|---|---|
| Settled at the gateway, pending here | Mark as paid | Mark as paid: gateway confirmed after the timeout |
| Settled ₹500 short | Never mark as paid | Escalate: settlement short, with a drafted message to the gateway |
| Paid here, missing from the file | Never mark as paid | Escalate: searched the file and other runs |
| Pending, and the parent paid again | Catch the duplicate | Escalate: possible duplicate payment |

### Ask Kosha

Plain-English questions about the college's fees, from a panel on every page (top bar, or
Ctrl+J), with example questions on the dashboard. For example: *"Which BCA students are overdue by more
than 30 days?"*, *"How much did we collect last week compared with the week before, by mode?"*,
*"What falls due in the next 30 days?"*, then follow-ups like *"only the second years"*.

- **No text-to-SQL.** A LangGraph agent chooses among six typed, read-only tools
  ([`lib/ai/ask/tools.ts`](lib/ai/ask/tools.ts)): `search_students`, `get_student_account`,
  `collections` (grouping and period comparison), `list_payments`, `fee_overview` and
  `reconciliation_overview`. It cannot read anything else and cannot write.
- **Arithmetic happens in code.** Totals, differences, percentages and ties are computed by the
  tools, and relative dates ("last week") are resolved in code
  ([`periods.ts`](lib/ai/ask/periods.ts)).
- **Verified answers.** The answer is structured output: text, an optional table whose rows link
  to students and payments, sources and follow-up questions. Every ₹ figure in it and every
  reference is checked against the tool results. On a failure, the agent goes back to look up what
  was missing; if it still fails, the answer is shown with a warning naming the unchecked
  figures.
- **Stateless follow-ups.** The browser sends the recent conversation with each question, so it
  works on serverless hosting without a session store.
- **Eval:** `npm run eval:ai` also asks 8 questions whose answers are computed straight from the
  database views: counts, totals, the top debtor (with ties), last week's collections, pending
  payments, a two-turn follow-up and a refusal. Current result: 8/8.

## How it is built

Next.js 15 (App Router) + TypeScript (strict) + Tailwind + shadcn-style components on Radix +
Supabase Postgres, deployed on Vercel.

- **Money is integer paise** everywhere (`BIGINT` in Postgres, `number` in TypeScript), formatted
  only at the edge.
- **The database is the source of truth for money rules.** Each money-changing operation is one
  plpgsql function called through `supabase.rpc`, so it runs in one transaction and locks the
  student row. Constraints and triggers make the ledger and allocations append-only and reject
  illegal payment transitions even if someone bypasses the API. The service role can read tables
  and execute those functions, nothing else.
- **Validation twice:** zod at every API route, constraints and function checks in the database.
- **Reconciliation matching is a pure TypeScript function** ([`lib/domain/reconcile.ts`](lib/domain/reconcile.ts)); persisting runs and resolving items go through SQL functions.

```
app/
  (app)/                 pages: dashboard, students, statement, payments, receipt, reconciliation, audit
  api/                   route handlers (zod validation, role checks, one error shape)
components/              ui primitives, shell, statement, payments, reconciliation, dashboard
lib/
  domain/                pure logic: payment-state, reconcile, allocation, statement, audit-text
  data/                  queries (server only), rpc wrapper
  auth/                  permission matrix, role cookie, page guards
  money.ts, dates.ts     paise formatting and parsing, IST dates
supabase/migrations/     001_schema.sql, 002_functions.sql, 003_seed.sql
scripts/                 db-setup, verify-ledger.sql, sample CSV, screenshots, PDF build
tests/                   unit, integration, e2e
docs/                    documentation source, PDF, APPROACH.md, screenshots
```

## Deploying to Vercel

1. Push the repository to GitHub and import it in Vercel (framework preset: Next.js; build command
   `npm run build`; no other settings needed).
2. In *Project settings → Environment variables* add `NEXT_PUBLIC_SUPABASE_URL`,
   `NEXT_PUBLIC_SUPABASE_ANON_KEY` and `SUPABASE_SERVICE_ROLE_KEY` for Production and Preview.
   `DATABASE_URL` is not needed on Vercel; it is only used by the local scripts.
3. Run `npm run db:setup` once from your machine against the same Supabase project, then deploy.
4. Suggested region: `bom1` (Mumbai), close to an `ap-south-1` Supabase project.

The service role key is read only in server code (`lib/env.ts` throws if called in the browser).
Anyone with the demo link can reset the demo data as Admin; that is intended for a demo and is
listed under future work.

## Scope

Out of scope, and listed as future work in the documentation: a real payment gateway, real
authentication and per-user row-level security, late fees, a fee-structure editor, multiple
institutions, email/SMS, partial refunds.

## AI usage

This project was built with an AI coding assistant. Every time its output was wrong, the mistake,
how it was found and how it was fixed is recorded in [`AI_LOG.md`](AI_LOG.md).
