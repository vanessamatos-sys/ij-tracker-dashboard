# IJ Tracker Dashboard — Onboarding / Handoff Guide

**Owner as of this handoff:** Leo (taking over from Vanessa Matos)
**Last updated:** 2026-09-29

This document is everything needed to pick up ownership of the Internal Jobs (IJ) Tracker system — the Google Sheet, the automation, and the public dashboard — with no prior context.

---

## 1. What this system is

A tracker + dashboard for Toptal's internal (`[IJ]`) hiring pipeline: every internally-posted job, its SLA funnel (Posted → Claimed → Sent → Hired), Topteam/Core-member status, and offboarding checks.

**Three layers, in order of data flow:**

1. **`Database` tab** (Google Sheet) — raw data, one row per job. Source of truth.
2. **`Talent Tracker` tab** (same Sheet) — every cell is a **formula** referencing `Database` on the same row. No raw data lives here; it's a computed/display layer.
3. **Dashboard** — static HTML/JS on GitHub Pages, reads a JSON snapshot exported from both tabs.

**Key IDs / URLs:**
- Google Sheet: `1n1aqgvOnbdwxJXPzNpe-AMa2mzKBtMeE4q5exXN1rwo` (tabs: `Database`, `Talent Tracker`, `HP`, `Criterias`)
- Dashboard (public): https://vanessamatos-sys.github.io/ij-tracker-dashboard/
- GitHub repo: `vanessamatos-sys/ij-tracker-dashboard` (Leo already added as collaborator)
- ITOps onboarding log (separate sheet, Zapier-fed): `1mGv6dPXpxcnHQEueOGHnX1ISQ4mmTZrCPTCrZqXbJ1g` ("Network Contractor Onboarding Log", tab `zapier-in`)
- Service account: `ij-tracker-dashboard-reader@ethereal-icon-397508.iam.gserviceaccount.com`

---

## 2. The daily automated pipeline

GitHub Actions workflow `.github/workflows/refresh-data.yml`, runs daily at **06:00 UTC** (also runnable on-demand via the Actions tab → "Run workflow"). Steps, in order, in one job:

1. **`scripts/refresh-database.mjs`** — refreshes 3 independent groups in `Database`:
   - **Topteam** (`Database!AB:AH`) — from BigQuery `CDR.TopTeamTalent`. Two-tier join: primary by `TalentId`, fallback by Core/Toptal email (covers ~13/129 Topteam records that have no `TalentId` linked yet, typically very recent Core hires).
   - **High Priority tag** (`Database!BG`) — from BigQuery `CDR.JobNote`, matches `[HP]` (bracketed, to avoid false positives like "PHP") in `NoteTitle`/`NoteComment`.
   - **ITOps Direct Manager** (`Database!AN`) — from the separate "Network Contractor Onboarding Log" sheet (`zapier-in` tab), matched by Job ID parsed out of its Job Link column. **This replaced a Jira-ticket-parsing approach entirely — Jira is no longer queried for this data.**
   - Row count is discovered dynamically each run (not hardcoded), so it stays correct as new rows get added.
   - **Failure isolation by design:** each group is independent. If one fails (bad query, empty/suspicious result), only that group's Sheet values are left untouched — the other groups and the export step still run. Failures write to `refresh-failures.json`, which the next step turns into **one standing GitHub issue** (label `data-refresh-failure`) — not a fresh issue every day. It auto-closes when the group recovers.
2. **`scripts/export-data.mjs`** — reads `Database` + `Talent Tracker`, writes `docs/data/tracker-data.json`.
3. Commits and pushes the JSON (this is what makes the public dashboard update).

**⚠️ Currently open failure:** the Direct Manager group has been failing since it was added — the service account doesn't have read access to the onboarding log sheet yet. See GitHub issue **#1** on the repo. **Action needed:** whoever owns/can manage sharing on `1mGv6dPXpxcnHQEueOGHnX1ISQ4mmTZrCPTCrZqXbJ1g` needs to share it (Viewer is enough) with `ij-tracker-dashboard-reader@ethereal-icon-397508.iam.gserviceaccount.com`. I could not do this myself — Drive API returned "File not found" for me, meaning I only have indirect/link access, not owner rights on that file.

### What is NOT automated (important!)

- **New job rows are not added automatically.** The daily pipeline only refreshes columns on *existing* rows (Topteam, HP tag, Direct Manager). Nobody currently re-runs the "pull in brand-new jobs" step on a schedule.
- On 2026-09-27/28, I did a **one-time manual backfill** of 75 new internal jobs (postings from Aug 28 – Sep 24 that weren't yet in the Sheet) using the Toptal Platform staff-api (GraphQL), not BigQuery — see §4. This should be repeated periodically (weekly? monthly?) until/unless it gets built into the daily automation. **This is the single biggest thing Leo should decide on early:** either (a) periodically re-run this manual backfill, or (b) invest in wiring it into `refresh-database.mjs` as a 4th automated group.
- Several `Database` fields have no confirmed automatable source at all (see §5 — Known Gaps).

---

## 3. Critical gotchas — read before editing formulas or rows

1. **Row alignment is NOT uniformly "Talent Tracker row = Database row + 1."** It's `+1` for `Talent Tracker` rows 3–21, then a flat **same row number** (`Database!X{N}` for `Talent Tracker` row `N`) from row 22 onward, all the way through the current end of data. This is because `Database` row 21 (Job ID `505871`) has no matching `Talent Tracker` row at all — an orphaned row from before my involvement, pre-existing, not something introduced during this work. Every column in the existing sheet is internally consistent with this (I verified across many columns), but if you ever need to hand-write a new formula referencing `Database` from `Talent Tracker`, **don't assume a single fixed offset** — check a neighboring row's existing formula first.
2. **When adding new rows to `Database`, extend `Talent Tracker` via `copyPaste` (formula paste type) from the last existing row**, not by hand-writing formulas — this correctly carries the "same row number" pattern forward via Google Sheets' relative-reference adjustment. Example (row 1133 was the last existing row when I extended to 1134–1208):
   ```
   copyPaste: source = TalentTracker!A1133:BD1133 (all columns), destination = A1134:BD1208, pasteType = PASTE_FORMULA
   ```
3. **The `gws`/`bq` CLI wrapper argv length limit.** Large JSON payloads (bulk Sheet writes, big Docs batchUpdate) can hit "Argument list too long" — not because the payload itself is too big, but because this session's environment variables (various tokens) are large and combine with the argv. Fix: chunk writes into batches (~150 rows or ~80 requests worked reliably), or pass JSON via a file if the tool supports `@file` (not all do — test first).
4. **GitHub Actions cannot push to `.github/workflows/*.yml` without `workflow` OAuth scope.** This session's GitHub connector doesn't have it. Any workflow file change has to be pasted manually via the GitHub web UI (logged in as a human) — normal `git push` from the agent will be rejected with a clear error naming the missing scope.
5. **GitHub Pages CDN lag.** After a commit, the public dashboard URL can take a few minutes to reflect it. Always verify a fix via the raw committed blob (`raw.githubusercontent.com/vanessamatos-sys/ij-tracker-dashboard/<commit-sha>/docs/data/tracker-data.json`) before concluding something didn't work.
6. **`CLOUDSDK_AUTH_ACCESS_TOKEN` ambient credential trap.** If you're testing the service account's *own* permissions (vs. your personal session credentials), explicitly unset this env var (`env -u CLOUDSDK_AUTH_ACCESS_TOKEN ...`) or you'll silently test under your own identity instead and get false-positive results. This bit me once this session.

---

## 4. Data source reference

| Data | Source | Notes |
|---|---|---|
| Topteam Profile/Position/Dates/Manager/OrgActive | BigQuery `certified-data-repository.CDR.TopTeamTalent` | Small table (~129 rows), pull all of it, join by `TalentId` then email. Automated daily. |
| High Priority `[HP]` tag | BigQuery `certified-data-repository.CDR.JobNote` | `NoteTitle`/`NoteComment LIKE '%[HP]%'`. Automated daily. |
| ITOps Direct Manager | Google Sheet `1mGv6dPXpxcnHQEueOGHnX1ISQ4mmTZrCPTCrZqXbJ1g` (`zapier-in` tab) | Zapier-fed from ITOps onboarding forms. Automated daily (once sharing is fixed — see §2). |
| Job Title, Link, Status, Posted/Claimed dates, Engagement (Start/End/Commitment/Weekly Hours), hired Talent identity | **Toptal Platform staff-api (GraphQL)**, NOT BigQuery | `CDR.Job`/`CDR.Engagement` in BigQuery **structurally exclude internal jobs** (confirmed empirically: 0/1128 tracked job IDs found there). The staff-api `jobs(filter: { parentClientId: "VjEtQ2xpZW50LTUyMTUx", postedAt: {...} })` query is the way to enumerate internal jobs — that `parentClientId` is Toptal's own internal "Client" record (plainId `52151`, name "Toptal"). See §4a for the exact query pattern used. **Not yet wired into daily automation** — was a one-time manual script run. |
| Job Status Updated At (for REMOVED/CLOSED jobs' day-count formulas) | staff-api `Job.statusChangedAt` | Only needed for non-active terminal-status jobs. |
| Job Posted/Claimed **precise timestamps**, if you need finer grain than staff-api gives | BigQuery `Staging.JobStatus` (status transitions) and `Staging.JobClaimingHistory` | These DO include internal jobs (unlike `CDR.Job`) because `Staging` is pre-filter raw data. `pending_claim` = Posted, `pending_engineer` = Claimed, `active` = Hired. |
| **Talent Sent At** | **Unresolved — no reliable automated source found** | See §5, first item. Extensively investigated; still manual/best-guess. |

### 4a. staff-api query pattern for internal jobs (used for the 75-job backfill)

```graphql
query($from: Date, $till: Date, $limit: Int!, $offset: Int!) {
  jobs(filter: { parentClientId: "VjEtQ2xpZW50LTUyMTUx", postedAt: { from: $from, till: $till } },
       pagination: { limit: $limit, offset: $offset }, order: { field: POSTED_AT, direction: ASC }) {
    totalCount
    nodes {
      plainId title postedAt claimedAt status cumulativeStatus statusChangedAt
      webResource { url }
      currentEngagement {
        plainId status commitment weeklyHours startDate endDate trialStatus trialEndDate
        talent { plainId fullName status email averageWorkingHours allocatedHours toptalEmailV2 { value suspended } }
      }
    }
  }
}
```
Paginate with `limit`/`offset` (I used 25 at a time). **Do not** widen the `postedAt` range too much in one call without a client filter — an unscoped broad query triggered a "heavy usage, prefer BigQuery" warning from the staff-api gateway once. Scoped to `parentClientId` + a date range, it's fine (75 results, no warning).

Note: not every job under this filter is `[IJ]`-titled — some are `[TCP]` or untitled variants. **The correct scope is "all jobs under this Client," not "titles containing `[IJ]`"** — I confirmed this by checking that 5 already-tracked rows have `TCP` in the title, so the tracker's own scope has never been IJ-title-only.

---

## 5. Known gaps / open items

1. **Talent Sent At has no confirmed automated source.** Extensively investigated across BigQuery (`CDR`, `Staging`, `Matching` datasets) and the staff-api candidate pipeline (Availability Requests, Job Applications, `TalentJobEdge`). Findings:
   - The platform's formal "candidate sent to client" status (`sending_away` job status / `CANDIDATE_SENT` availability-request status) essentially never fires for internal jobs (1 occurrence out of 1,128 tracked jobs).
   - For the actual hired talent on jobs I checked, they don't appear in the job's Availability Requests or Applications list at all — suggesting internal hires are often **directly assigned** (referral/direct outreach) rather than sourced through the open apply/invite flow, which is why the formal pipeline doesn't have a record.
   - Vanessa is confident this event "is recorded 100%, maybe under another name" — she was mid-investigation with me on this when the handoff happened. **Next step for Leo:** ask Vanessa or the matching/ITOps team directly what tool/action a matcher uses to notify a hiring manager about a candidate for an internal job — it may be a Slack step, an email tool, or something entirely outside the Platform/BigQuery.
2. **Engagement End Date** — no clean automated source identified yet either (lower priority than Sent).
3. **Budget, Cost Center, Approver** for newly-backfilled rows — left blank; no confirmed source.
4. **Job Title/Link discovery for future new jobs** — works via staff-api (§4a) but is a manual script, not scheduled.
5. **New-row backfill cadence** — see §2, "What is NOT automated."

---

## 6. Bugs fixed this engagement (context for git history / in case they resurface)

- **SLA metric**: switched between median/average twice per explicit user direction; currently **average**, excluding negative-day rows (a data-integrity artifact — an engagement start date recorded before the job's own posted date; some staff can backdate this).
- **Topteam Profile Removed status** and **Core Email Removed status**: both had the same systemic Google Sheets bug — comparing a real boolean cell to the *text string* `"TRUE"`/`"FALSE"` (`Database!AH2="TRUE"` type expressions), which is always false in Sheets since a boolean never equals its text representation. Fixed by removing the quotes. This had silently made these two status columns incapable of ever showing red/removed, across all 1,132 rows, until caught via a real user bug report (Thanasis Polychronakis' case).
- **Dashboard's inline "Save Decision" feature** was writing to the wrong cell (`Talent Tracker!AK`, a formula cell) instead of the real Decision cell (`AM`) — a drift from an earlier column insertion that was never propagated to that hardcoded reference in `docs/index.html`. Fixed; verified no data had actually been corrupted (the target cell was still 100% intact formulas when caught).
- Various dashboard features added this engagement: High Priority filter (both views), End Date column, "Export to Excel" (CSV, respects active filters), HRS filter (Talent view).

---

## 7. Access checklist — what else Leo needs

- [x] GitHub repo collaborator access (done by Vanessa)
- [ ] **Google Sheet edit access** — confirm Leo has Editor (not just Viewer) on `1n1aqgvOnbdwxJXPzNpe-AMa2mzKBtMeE4q5exXN1rwo`. Separate from GitHub; Vanessa needs to share it directly in Google Sheets if not already done.
- [ ] **Onboarding log sheet access** — Leo may also want direct read access to `1mGv6dPXpxcnHQEueOGHnX1ISQ4mmTZrCPTCrZqXbJ1g` for his own visibility (separate from the service account fix in §2, which is what the *automation* needs).
- [ ] **BigQuery access** — Leo needs his own access to `certified-data-repository` (datasets `CDR`, `Staging` at minimum) if he'll run any manual queries/backfills himself, separate from the service account used by the automation.
- [ ] **Toptal Platform staff-api access** — needed if Leo will run the job-backfill script himself (uses his own Platform login via the session's connector, no separate credential to hand off).
- [ ] **Fix the Direct Manager sharing permission** (§2) — the one concrete blocking action item.
- [ ] **Decide on new-job backfill cadence** (§2) — manual repeat vs. automate.
- [ ] Optionally: rotate/regenerate a fresh `GOOGLE_SERVICE_ACCOUNT_KEY` for the GitHub secret if there's ever a concern about key hygiene — the current key works fine, no action needed unless there's a specific reason.
