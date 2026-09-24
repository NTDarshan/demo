# AI log

Every time AI-generated output turned out to be wrong, it is recorded here: what was generated,
what was wrong, how it was detected, and how it was fixed. Entries are factual and in order.
This log is the source for the AI usage report in the documentation.

## 1. Seed payment dates clustered on a few days (Phase 1)

- **Generated:** In `003_seed.sql`, generic students' payment dates were computed as
  `date '2026-08-09' + ((i * 11) % 44)`.
- **What was wrong:** 11 and 44 share a factor of 11, so the expression only takes 4 distinct
  values (0, 11, 22, 33 days). 13 payments landed on 9 Aug and 12 on 31 Aug, which would have
  made the dashboard's collection trend look spiky and fake.
- **How it was detected:** A dry run of the migrations against an in-memory Postgres (PGlite),
  followed by a query grouping SUCCESS payments by day.
- **How it was fixed:** Changed to `(i * 17) % 45` (17 and 45 are coprime), which spreads the
  payments over 9 Aug to 22 Sep with at most 3 on any day. Re-ran the verification script.

## 2. Query row types clashed with supabase-js inference (Phase 2)

- **Generated:** Data-layer functions in `lib/data/*.ts` passed Supabase query builders to a
  helper typed `run<T>(query: PromiseLike<{ data: T | null; ... }>)`, with row types that model
  embedded relations (`students(name, roll_no)`) as single objects.
- **What was wrong:** Without generated database types, supabase-js infers every embedded
  relation as an array, so four call sites failed to compile.
- **How it was detected:** `npm run typecheck` (tsc) errors in `dashboard.ts`, `payments.ts`
  and `students.ts`.
- **How it was fixed:** `run()` now accepts an untyped query result and returns the row type the
  call site declares; the comment in `lib/data/db.ts` explains why.

## 3. Payment search tried to OR across an embedded table (Phase 2)

- **Generated:** `listPayments` built `.or("receipt_no.ilike...,name.ilike...,roll_no.ilike...")`
  on the `payments` query, where `name` and `roll_no` belong to the embedded `students` table.
- **What was wrong:** PostgREST cannot combine columns of an embedded table in a top-level
  `or()` filter; searching by student name would have returned an error.
- **How it was detected:** Re-reading the query code before running it.
- **How it was fixed:** Look up matching student ids first, then OR on
  `receipt_no`, `gateway_ref` and `student_id.in.(...)`.

## 4. Cached demo-student id would go stale after a reset (Phase 2)

- **Generated:** `getDemoStudentId()` cached the student role's account id in a module variable.
- **What was wrong:** `reset_demo()` recreates students with new uuids, so after a reset the
  student role would have been locked out of its own statement until the server restarted.
- **How it was detected:** Self-review while writing the reset route.
- **How it was fixed:** Removed the cache; the id is looked up by roll number each time.

## 5. Awkward generated copy in audit sentences and errors (Phase 2)

- **Generated:** Audit text "Accountant marked as paid settled but pending here MGW7300000008",
  "Accountant confirmed payment ..." directly after "recorded a cash payment", and the error
  "This payment is already success".
- **What was wrong:** Ungrammatical or redundant sentences on a screen meant to be readable.
- **How it was detected:** Reading the output of the API smoke tests (`/api/audit`, check-status).
- **How it was fixed:** Rewrote the sentences ("Accountant marked MGW7300000008 as paid from
  reconciliation", "Receipt KSH/2026-27/000041 issued for ₹5,000 ...", "already paid"), and
  switched SQL error messages from "Rs" to "₹" to match the UI.
