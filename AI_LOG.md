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

## 10. Select chevron written as a Tailwind class with spaces (Phase 4)

- **Generated:** The native `<Select>` had its chevron as an arbitrary Tailwind value,
  `bg-[url("data:image/svg+xml,...width='16' height='16'...")]`.
- **What was wrong:** Tailwind splits class names on spaces, so the SVG was broken into junk
  classes and no chevron was ever drawn on any dropdown (Students filters, concession form).
- **How it was detected:** A Playwright walkthrough printed the element's class attribute in a
  locator error, showing fragments like `xmlns='http://www.w3.org/2000/svg'` as separate classes.
- **How it was fixed:** Moved the chevron into a `.select-chevron` CSS class in `globals.css`.

## 11. Drawer and receipt problems found in screenshots (Phase 4)

- **Generated:** First versions of the record-payment drawer, the toast region and the receipt.
- **What was wrong:**
  1. Toasts sat bottom-right, exactly over the drawer's submit button.
  2. The selected option in the segmented controls (mode, gateway outcome) was barely
     distinguishable from the others (white on near-white).
  3. At 390px "Bank transfer" was truncated to "Bank tra...".
  4. The printed A5 receipt spilled its footer onto a second page.
  5. The receipt title was set in uppercase with letter-spacing, which the brief's don'ts rule out.
- **How it was detected:** Items 1 to 4 from Playwright screenshots and a PDF render of the
  receipt; item 5 on re-reading the brief against the receipt code.
- **How it was fixed:** Toasts moved bottom-left; selected segment filled with ink; four-option
  controls wrap to 2 x 2 on phones; tighter print spacing (the densest receipt, 8 lines, now
  prints on one A5 page); the title is sentence case.

## 12. Walkthrough script waited on the wrong signal (Phase 4)

- **Generated:** The scenario walkthrough waited for `?tab=payments` in the URL after the student's
  timed-out payment.
- **What was wrong:** The URL already had that parameter, so the wait returned immediately and the
  log showed the previous toast, which looked like a missing "Payment pending" message.
- **How it was detected:** The logged toast text did not match the action; an API query showed
  the payment had in fact been recorded as PENDING.
- **How it was fixed:** Wait for the "Payment pending" toast itself.

## 13. Dashboard problems found in screenshots (Phase 5)

- **Generated:** First version of the dashboard's needs-attention list, summary strip and trend chart.
- **What was wrong:**
  1. After the sample file was reconciled twice, every open reconciliation item was listed twice.
  2. The badge "Recorded here, missing in settlement" overflowed its 170px column into the text.
  3. The summary said "Needs attention 7" while the panel below said "27 items" (the two counted
     different things).
  4. The trend used a smoothed (`monotone`) curve, which invents shape between daily totals and
     exaggerates spikes; the last point was clipped at the right edge.
  5. In one desktop capture the chart area was empty: Recharts' `ResponsiveContainer` had not
     measured its width before the screenshot.
- **How it was detected:** Reading the 1440px and 390px dashboard screenshots.
- **How it was fixed:** Open items are de-duplicated by bucket and reference (newest run wins);
  short bucket labels for badges; the fourth summary cell is now "Pending payments" and the panel
  spells out each group's count; straight segments and a right margin; `initialDimension` on the
  container so the chart draws on first paint.

## 14. Wrong element read by two walkthrough checks (Phase 5)

- **Generated:** Playwright checks that read `getByRole("alert")` for the upload error and checked
  the auto-opening demo guide immediately after page load.
- **What was wrong:** Next.js's route announcer also has `role="alert"`, so the first check read an
  empty string; the guide opens after hydration, so the second check ran too early. Both reported
  failures in features that worked.
- **How it was detected:** The results contradicted what the screen showed; re-checked with
  targeted locators.
- **How it was fixed:** Filter alerts by text and wait for the dialog instead of checking once.

## 15. Copilot findings cited the wrong evidence (AI-1)

- **Generated:** The Copilot's `check_duplicate_payments`, `search_settlement_file` and
  `find_ref_in_other_runs` tools in `lib/ai/recon-copilot/tools.ts` returned results without an
  evidence id when they found nothing.
- **What was wrong:** In the first live run, the model's finding "No duplicate payments of
  ₹86,500 found" cited `item:MGW7300000005` (the exception itself), because the check it was
  describing had no id to cite. It also wrote the student's internal uuid into the finding.
- **How it was detected:** Reading the streamed output of the first investigation.
- **How it was fixed:** Every check tool now registers a `check:*` evidence id even when it finds
  nothing, and the prompt says a check that found nothing is still evidence. It also says never
  to write internal ids.

## 16. Settlement search reported 36 "similar rows" (AI-1)

- **Generated:** `search_settlement_file` treated any gateway reference within edit distance 2
  as similar.
- **What was wrong:** Gateway references are sequential (`MGW7300000038`, `…039`), so almost every
  row in the file was "similar" to every other. The tool's result was noise.
- **How it was detected:** The live run on the missing-in-settlement item said "36 similar rows".
- **How it was fixed:** A near-identical reference only counts together with the same amount
  (`similarity()` in `lib/ai/recon-copilot/match.ts`, unit tested). The item's own row is skipped.

## 17. The duplicate-risk check accepted "no duplicate" (AI-1)

- **Generated:** In `verifyDiagnosis()`, the "Duplicate risk disclosed" check passed if any text
  in the diagnosis matched `/duplicate|twice|again|retr/`.
- **What was wrong:** A diagnosis saying "No duplicate payments found", the opposite of what the
  tool found, matched the pattern and passed.
- **How it was detected:** A unit test written for this check failed.
- **How it was fixed:** The risk must now appear in `risks` or `nextSteps`.

## 18. The double-payment eval passed while the Copilot missed the duplicate (AI-1)

- **Generated:** `check_duplicate_payments` looked for a same-amount payment within 7 days; the
  eval's double-payment case asserted that the diagnosis text matched `/duplicate|twice|again/`.
- **What was wrong:** The staged counter payment was made 8 days after the stuck UPI payment, so
  the tool found nothing and the Copilot recommended "mark as paid". The eval still reported the
  test as passing, because its text match accepted "no duplicate" (the same mistake as entry 17).
  Only the eval's summary table showed `pass: false`.
- **How it was detected:** The summary table contradicted the test result.
- **How it was fixed:** The tool now flags any same-amount payment made after the stuck one (or up
  to 7 days before it). Each eval test asserts its own pass condition, and the double-payment
  judge checks the root cause, the action and the verifier's check instead of words in the text.
  Result: 4/4, with the double payment escalated as `POSSIBLE_DUPLICATE`.
