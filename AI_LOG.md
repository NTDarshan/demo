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
