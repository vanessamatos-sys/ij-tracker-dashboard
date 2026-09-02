// Pulls Database + Talent Tracker from the IJ Tracker Google Sheet and writes
// docs/data/tracker-data.json for the static dashboard to consume.
//
// Auth: a Google service-account key (JSON) provided via the
// GOOGLE_SERVICE_ACCOUNT_KEY env var, with Viewer access shared on the Sheet.
// No external dependencies — signs its own JWT with node:crypto.

import { createSign } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';

const SHEET_ID = '1n1aqgvOnbdwxJXPzNpe-AMa2mzKBtMeE4q5exXN1rwo';
const DATABASE_RANGE = 'Database!A2:BG3000';
const TRACKER_RANGE = "Talent Tracker!A3:AY3000";

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function getAccessToken() {
  const keyJson = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_KEY env var is not set');
  const key = JSON.parse(keyJson);

  const header = { alg: 'RS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);
  const claims = {
    iss: key.client_email,
    scope: 'https://www.googleapis.com/auth/spreadsheets.readonly',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600,
  };
  const unsigned = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(claims))}`;
  const signer = createSign('RSA-SHA256');
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(key.private_key).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const jwt = `${unsigned}.${signature}`;

  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!res.ok) throw new Error(`Token exchange failed: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.access_token;
}

async function fetchRange(token, range) {
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${SHEET_ID}/values/${encodeURIComponent(range)}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error(`Sheets fetch failed for ${range}: ${res.status} ${await res.text()}`);
  const json = await res.json();
  return json.values || [];
}

function num(v) {
  if (v === undefined || v === null || v === '') return null;
  // Budget columns render as currency strings (e.g. "$145,600"); strip formatting before parsing.
  const n = Number(String(v).replace(/[$,%]/g, ''));
  return Number.isFinite(n) ? n : null;
}

function buildJobs(dbRows) {
  const byJob = new Map();
  for (const r of dbRows) {
    const jobId = r[0];
    if (!jobId) continue;
    if (!byJob.has(jobId)) byJob.set(jobId, []);
    byJob.get(jobId).push(r);
  }

  const jobs = [];
  for (const [jobId, rows] of byJob) {
    // Prefer the row whose engagement actually led to a hire; otherwise last row.
    const hired = rows.find((r) => r[12]); // Engagement Start Date present
    const primary = hired || rows[rows.length - 1];
    jobs.push({
      jobId,
      jobLink: primary[1] || `https://staff.toptal.com/jobs/${jobId}`,
      jobTitle: primary[2] || '',
      jobStatus: primary[3] || '',
      postedDate: primary[5] || null,
      claimedDate: primary[6] || null,
      arSent: num(primary[53]),
      confirmedApplications: num(primary[54]),
      talentsSent: num(primary[55]),
      costCenter: primary[56] || '',
      approver: primary[57] || '',
      isHighPriority: primary[58] === 'TRUE',
    });
  }
  return jobs;
}

function buildTalents(trackerRows) {
  return trackerRows
    .filter((r) => r[0])
    .map((r, idx) => ({
      rowRef: idx + 3, // Talent Tracker!AK{rowRef} is the Decision cell
      jobId: r[0],
      postedDate: r[1] || null,
      jobTitle: r[2] || '',
      jobLink: r[3] || '',
      jobStatus: r[4] || '',
      costCenter: r[5] || '',
      approver: r[6] || '',
      postedToClaimedDays: num(r[7]),
      postedToClaimedFlag: r[8] || '',
      claimedToSentDays: num(r[9]),
      claimedToSentFlag: r[10] || '',
      sentToHireDays: num(r[11]),
      sentToHireFlag: r[12] || '',
      postedToHireDays: num(r[13]),
      postedToHireFlag: r[14] || '',
      talentName: r[18] || '',
      engagementStatus: r[19] || '',
      commitmentType: r[20] || '',
      weeklyHours: num(r[21]),
      hoursWarning: r[22] || '',
      onboardingStatus: r[23] || '', // no longer shown as its own table column, but still backs the "Onboarding Status" tracker filter
      itopsTicketStatus: r[25] || '',
      coreEmailStatus: r[27] || '',
      topteamProfile: r[28] || '',
      correctReportTopteam: r[29] || '',
      budgetApproved: num(r[30]),
      budgetUsed: num(r[31]),
      pctUsed: num(r[33]),
      budgetStatus: r[34] || '',
      decisionDate: r[37] || null,
      decision: r[38] || '',
      decisionWarning: r[39] || '',
      required: r[40] || '',
      jobClosedStatus: r[42] || '',
      hoursRemovedStatus: r[44] || '',
      coreEmailRemovedStatus: r[46] || '',
      topteamRemovedStatus: r[48] || '',
      offboardingWarning: r[49] || '',
      isHighPriority: r[50] === 'TRUE',
    }));
}

async function main() {
  const token = await getAccessToken();
  const [dbRows, trackerRows] = await Promise.all([
    fetchRange(token, DATABASE_RANGE),
    fetchRange(token, TRACKER_RANGE),
  ]);

  const data = {
    generatedAt: new Date().toISOString(),
    jobs: buildJobs(dbRows),
    talents: buildTalents(trackerRows),
  };

  await mkdir('docs/data', { recursive: true });
  await writeFile('docs/data/tracker-data.json', JSON.stringify(data));
  console.log(`Wrote ${data.jobs.length} jobs and ${data.talents.length} talent rows.`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
