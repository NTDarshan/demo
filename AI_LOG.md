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

## 6. Tailwind opacity modifiers on CSS-variable colours (Phase 3)

- **Generated:** Colours mapped as `ink: "var(--ink)"` in `tailwind.config.ts`, then used with
  opacity modifiers such as `bg-ink/25` (drawer overlay) and `bg-accent/5`.
- **What was wrong:** Tailwind 3 cannot apply `/25` to a plain `var()` colour, so those classes
  would generate nothing (an invisible overlay, no row highlight).
- **How it was detected:** Self-review of the component code before the first screenshot.
- **How it was fixed:** Added RGB channel variables (`--ink-rgb: 22 33 58`) and mapped colours as
  `rgb(var(--ink-rgb) / <alpha-value>)`.

## 7. Dates rendered as "24 Sept 2026" and "05 Jan 2027" (Phase 3)

- **Generated:** `formatDate` used `Intl.DateTimeFormat("en-GB", { month: "short" })`; the first
  fix took the day from `formatToParts` with `day: "numeric"`.
- **What was wrong:** Current ICU data abbreviates September as "Sept" in en-GB (the brief asks for
  "24 Sep 2026"); the first fix then produced "05 Jan 2027" because en-GB pads the day.
- **How it was detected:** "Sept" in the dashboard screenshot; "05" by a new unit test in
  `tests/unit/dates.test.ts`.
- **How it was fixed:** Day and year come from Intl (for the IST time zone), the month name from a
  fixed list, and the day is converted with `Number()`.

## 8. Layout problems found in the 1440px / 390px screenshots (Phase 3)

- **Generated:** First versions of the statement and students screens.
- **What was wrong:**
  1. Fee-head bars did not line up across rows: each row's figures column sized itself
     (`minmax(200px, auto)`), so longer text shrank that row's bar.
  2. The concession approver was put in the monospaced Reference column, which squeezed the
     description into a four-line wrap. Mono is meant only for codes.
  3. At 390px roll numbers wrapped mid-code and the amount and balance columns were off-screen.
  4. The fixed sidebar stopped at the viewport height in full-page captures; the college name
     wrapped in the mobile top bar.
  5. The whole balance sentence was red, including the neutral "next installment" part; the
     advance sentence repeated its own label ("Advance ... Advance of ₹2,500").
  6. The command palette showed skeletons for about a second while the roster loaded.
- **How it was detected:** Reading the Playwright screenshots in `docs/assets/screens/`.
- **How it was fixed:** A fixed 300px figures column; approver moved to a muted second line;
  phone layouts (stacked passbook entries, compact student list, `whitespace-nowrap` on codes);
  a sticky sidebar column; a compact wordmark; a split sentence (`sentence` + `followUp`);
  the roster is prefetched when the page is idle.

## 9. Invisible characters in a regex (Phase 3)

- **Generated:** The accent-stripping regex in the command palette ended up containing literal
  combining characters instead of the `̀-ͯ` escape, after a scripted edit of the file.
- **What was wrong:** It worked, but the source was unreadable and would confuse a reviewer.
- **How it was detected:** An odd-looking line in a file diff, confirmed with `od -c`.
- **How it was fixed:** Replaced with `/\p{Diacritic}/gu`, which needs no escapes.
