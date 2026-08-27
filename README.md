# Internal Jobs Tracker Dashboard

Live view of the [IJ Tracker Google Sheet](https://docs.google.com/spreadsheets/d/1n1aqgvOnbdwxJXPzNpe-AMa2mzKBtMeE4q5exXN1rwo) — KPI dashboard plus Job-level and Talent-level tracker views, with the Decision field editable directly from the page.

Live URL: https://vanessamatos-sys.github.io/ij-tracker-dashboard/

## How it works

- `docs/index.html` is a static, dependency-free page. It reads `docs/data/tracker-data.json` for all display data.
- `scripts/export-data.mjs` pulls the Database + Talent Tracker tabs from the Sheet and writes that JSON file. It authenticates as a Google **service account** (read-only), via `node:crypto` — no npm dependencies.
- `.github/workflows/refresh-data.yml` runs the export script daily (06:00 UTC) and commits the refreshed JSON, so GitHub Pages always serves current data without anyone needing to run anything manually.
- Editing "Decision" on the Talent Level view writes straight back to the Sheet's `Decision` cell using **the signed-in user's own Google account** (Google Identity Services, client-side) — governed by whatever access that person already has on the Sheet. The Sheet's existing formulas recalculate the Offboarding columns instantly; the page re-reads that one row and updates in place.

## One-time setup required (not yet done)

Two pieces of Google Cloud configuration can't be created from this session — they need a few minutes in the Google Cloud Console:

### 1. OAuth Client ID (for the "Save" button)

1. Console → **APIs & Services → Credentials → Create Credentials → OAuth client ID**.
2. Application type: **Web application**.
3. Authorized JavaScript origins: `https://vanessamatos-sys.github.io`
4. Copy the resulting Client ID and paste it into `docs/index.html`, replacing `REPLACE_WITH_OAUTH_CLIENT_ID.apps.googleusercontent.com`.
5. Make sure the **Google Sheets API** is enabled on that project (APIs & Services → Library).

Anyone who clicks "Save" on a Decision will get a one-time Google sign-in prompt; only people already granted edit access on the Sheet will be able to actually save.

### 2. Service account (for the daily automated refresh)

1. Console → **IAM & Admin → Service Accounts → Create Service Account** (any project you control).
2. Create a JSON key for it and download it.
3. Share the Google Sheet with that service account's email address — **Viewer** access is enough (Sheets → Share).
4. In this repo: **Settings → Secrets and variables → Actions → New repository secret**, name it `GOOGLE_SERVICE_ACCOUNT_KEY`, and paste the full JSON key as the value.
5. Trigger the workflow once manually (Actions tab → "Refresh tracker data" → Run workflow) to confirm it works, or wait for the next 06:00 UTC run.

Until both of these are done: the dashboard displays correctly from the data snapshot already committed, but the daily auto-refresh and the Decision "Save" button won't function.

## Data notes

- **HP jobs** (the 15 currently-tracked priority jobs) are highlighted with a light grey row background in both views and sorted to the top.
- Job-level SLA columns show the flag and day-count together in one badge (e.g. `18d 🟡`) to avoid doubling the column count.
- KPI growth badges compare the selected period to the immediately preceding period of the same length, computed client-side from each job's Posted Date — no historical snapshots are stored.
