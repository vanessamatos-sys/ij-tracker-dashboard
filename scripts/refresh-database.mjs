// Refreshes the parts of the Database tab that have a verified source:
//   1. Topteam Profile/Position/Dates/Manager/Org-Active (Database!AB:AH) — BigQuery CDR.TopTeamTalent
//   2. High Priority Job [HP] tag (Database!BG) — BigQuery CDR.JobNote
//   3. ITOps Direct Manager (Database!AN) — the "Network Contractor Onboarding Log" Google Sheet
//      (Zapier-fed from ITOps). Replaces the old Jira-ticket-parsing approach entirely — Jira is
//      no longer queried for this.
//
// Everything else in Database (other ITOps/Budget/Trial fields, etc.) has no confirmed source
// yet and is intentionally left untouched — see AGENTS.md / project memory.
//
// Row count is discovered dynamically each run (not hardcoded) since new jobs get appended.
//
// Design: each data group is independent. If a group's BigQuery query fails, or comes back
// looking broken (e.g. the source table is unexpectedly empty), that group's write is SKIPPED
// (existing Sheet values are left as-is) and the failure is recorded — it must never block the
// other group or the dashboard export that runs after this script. Failures are written to
// refresh-failures.json for the workflow's notification step to pick up.
//
// Auth: same GOOGLE_SERVICE_ACCOUNT_KEY service account used by export-data.mjs. It needs two
// scopes here (BigQuery read + Sheets read-write) instead of just Sheets read-only.

import { createSign } from 'node:crypto';
import { writeFile } from 'node:fs/promises';

const SHEET_ID = '1n1aqgvOnbdwxJXPzNpe-AMa2mzKBtMeE4q5exXN1rwo';
const ZAPIER_SHEET_ID = '1mGv6dPXpxcnHQEueOGHnX1ISQ4mmTZrCPTCrZqXbJ1g';
const BQ_PROJECT = 'certified-data-repository';
const failures = [];

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken(scope) {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY env var is not set');
  const key = JSON.parse(keyJson);
  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claims = { iss: key.client_email, scope, aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(key.private_key).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = `${unsigned}.${signature}`;
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: jwt }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  return (await res.json()).access_token;
}

async function bqQuery(token, sql) {
  const res = await fetch(`https://bigquery.googleapis.com/bigquery/v2/projects/${BQ_PROJECT}/queries`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: sql, useLegacySql: false, timeoutMs: 30000 }),
  });
  const json = await res.json();
  if (!res.ok || json.error) throw new Error(`BQ query failed: ${res.status} ${JSON.stringify(json.error || json)}`);
  if (!json.jobComplete) throw new Error('BQ query did not complete within timeout');
  const fields = (json.schema?.fields || []).map((f) => f.name);
  return (json.rows || []).map((r) => Object.fromEntries(r.f.map((c, i) => [fields[i], c.v])));
}

async function fetchRange(token, range, spreadsheetId = SHEET_ID) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets fetch failed for ${range}: ${res.status} ${await res.text()}`);
  return (await res.json()).values || [];
}

async function updateRange(token, range, values, spreadsheetId = SHEET_ID) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(range)}?valueInputOption=USER_ENTERED`;
  const res = await fetch(url, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ values }),
  });
  if (!res.ok) throw new Error(`Sheets write failed for ${range}: ${res.status} ${await res.text()}`);
}

// Database's row count grows over time as new jobs are backfilled — discover it fresh each run
// rather than hardcoding, so newly appended rows are always in scope.
async function getDbRowCount(sheetsToken) {
  const ids = await fetchRange(sheetsToken, 'Database!A2:A5000');
  let n = ids.length;
  while (n > 0 && !ids[n - 1]?.[0]) n--; // trim any trailing blank rows Sheets may include
  if (n === 0) throw new Error('Database appears empty — refusing to proceed');
  return n;
}

// --- Group 1: Topteam data (CDR.TopTeamTalent) ---------------------------------------------
async function refreshTopteam(sheetsToken, bqToken, dbRowCount) {
  const dbRows = await fetchRange(sheetsToken, `Database!A2:BG${dbRowCount + 1}`);
  const ttRows = await bqQuery(
    bqToken,
    `SELECT TalentId, TopTeamTalentId, Email, TopTeamTalentName, PositionName,
            TopTeamStartDate, TopTeamEndDate, IsActive, PrimaryManagerName, PrimaryManagerEmail
     FROM \`CDR.TopTeamTalent\``
  );
  if (ttRows.length === 0) throw new Error('CDR.TopTeamTalent returned 0 rows — treating as a broken/empty read, not a real state');

  const byTalentId = new Map();
  const byEmail = new Map();
  for (const r of ttRows) {
    if (r.TalentId) byTalentId.set(String(r.TalentId), r);
    if (r.Email) byEmail.set(r.Email.toLowerCase(), r);
  }

  const values = [];
  let matched = 0;
  for (let i = 0; i < dbRowCount; i++) {
    const row = dbRows[i] || [];
    const talentId = row[18] || '';
    const toptalEmail = (row[24] || '').toLowerCase();
    const coreEmail = (row[25] || '').toLowerCase();
    const rec = byTalentId.get(talentId) || byEmail.get(toptalEmail) || byEmail.get(coreEmail);
    if (rec) {
      matched++;
      values.push([
        'TRUE',
        rec.PositionName || '',
        rec.TopTeamStartDate || '',
        rec.TopTeamEndDate || '',
        rec.PrimaryManagerName || '',
        rec.PrimaryManagerEmail || '',
        String(rec.IsActive || 'false').toUpperCase(),
      ]);
    } else {
      values.push(['FALSE', '', '', '', '', '', '']);
    }
  }

  // Sanity check: a sudden collapse to ~0 matches almost certainly means the join broke
  // (e.g. columns shifted), not that everyone left Topteam overnight.
  if (matched === 0) throw new Error('Topteam join produced 0 matches — refusing to write, looks like a broken join rather than reality');

  await updateRange(sheetsToken, `Database!AB2:AH${dbRowCount + 1}`, values);
  return { matched, total: dbRowCount };
}

// --- Group 2: High Priority Job [HP] tag (CDR.JobNote) --------------------------------------
async function refreshHighPriority(sheetsToken, bqToken, dbRowCount) {
  const dbRows = await fetchRange(sheetsToken, `Database!A2:A${dbRowCount + 1}`);
  const jobIds = [...new Set(dbRows.map((r) => r[0]).filter(Boolean))];
  if (jobIds.length === 0) throw new Error('No Job IDs found in Database — refusing to query JobNote');

  const noteRows = await bqQuery(
    bqToken,
    `SELECT DISTINCT JobId FROM \`CDR.JobNote\`
     WHERE JobId IN (${jobIds.join(',')})
       AND (NoteTitle LIKE '%[HP]%' OR NoteComment LIKE '%[HP]%')`
  );
  const hpJobIds = new Set(noteRows.map((r) => String(r.JobId)));

  const values = dbRows.map((r) => [hpJobIds.has(r[0]) ? 'TRUE' : 'FALSE']);
  await updateRange(sheetsToken, `Database!BG2:BG${dbRowCount + 1}`, values);
  return { hpCount: hpJobIds.size, total: jobIds.length };
}

// --- Group 3: ITOps Direct Manager (Network Contractor Onboarding Log, Zapier-fed) ----------
// Replaces the old Jira-ticket-layout-parsing approach — Jira is no longer queried for this.
// Only rows with a resolvable Job ID and a non-blank Direct Manager are touched; every other
// row's existing value (including ones this sheet doesn't cover) is left as-is.
async function refreshDirectManager(sheetsToken, dbRowCount) {
  const logRows = await fetchRange(sheetsToken, 'zapier-in!A2:R1010', ZAPIER_SHEET_ID);
  if (logRows.length === 0) throw new Error('Network Contractor Onboarding Log returned 0 rows — refusing to write');

  const byJobId = new Map();
  for (const r of logRows) {
    const jobLink = r[1] || '';
    const directManager = r[4] || '';
    const jobId = jobLink.match(/jobs\/(\d+)/)?.[1];
    if (jobId && directManager) byJobId.set(jobId, directManager); // later rows (updates) win
  }
  if (byJobId.size === 0) throw new Error('No Job ID + Direct Manager pairs resolved from the onboarding log — refusing to write');

  const dbJobIds = await fetchRange(sheetsToken, `Database!A2:A${dbRowCount + 1}`);
  let updated = 0;
  const updates = [];
  dbJobIds.forEach((r, i) => {
    const dm = byJobId.get(r[0]);
    if (dm) {
      updates.push({ row: i + 2, value: dm });
      updated++;
    }
  });

  for (const u of updates) {
    await updateRange(sheetsToken, `Database!AN${u.row}`, [[u.value]]);
  }
  return { updated, sourceRows: byJobId.size };
}

async function main() {
  const sheetsToken = await getAccessToken('https://www.googleapis.com/auth/spreadsheets');
  const bqToken = await getAccessToken('https://www.googleapis.com/auth/bigquery.readonly');
  const dbRowCount = await getDbRowCount(sheetsToken);
  console.log(`Database has ${dbRowCount} data rows.`);

  const results = {};
  for (const [name, fn] of [
    ['topteam', () => refreshTopteam(sheetsToken, bqToken, dbRowCount)],
    ['highPriority', () => refreshHighPriority(sheetsToken, bqToken, dbRowCount)],
    ['directManager', () => refreshDirectManager(sheetsToken, dbRowCount)],
  ]) {
    try {
      results[name] = await fn();
      console.log(`[${name}] OK:`, JSON.stringify(results[name]));
    } catch (err) {
      console.error(`[${name}] FAILED, leaving existing Sheet values untouched:`, err.message);
      failures.push({ group: name, error: err.message, timestamp: new Date().toISOString() });
    }
  }

  await writeFile('refresh-failures.json', JSON.stringify(failures, null, 2));
  if (failures.length) {
    console.error(`${failures.length} group(s) failed — see refresh-failures.json. Continuing to dashboard export regardless.`);
  }
}

main().catch(async (err) => {
  // A truly unexpected/catastrophic error (e.g. can't even authenticate) — still record it so
  // the notification step fires, but don't throw away partial results already written above.
  failures.push({ group: 'fatal', error: err.message, timestamp: new Date().toISOString() });
  await writeFile('refresh-failures.json', JSON.stringify(failures, null, 2));
  console.error(err);
  // Exit 0: a failed Database refresh must not block the dashboard export step that follows.
});
