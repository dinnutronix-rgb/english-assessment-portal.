/**
 * google-apps-script.js
 * ---------------------------------------------------------------------------
 * Paste into: Google Sheet > Extensions > Apps Script (replace Code.gs), then
 *   1. Set SECRET below (same value as the SHEETS_SECRET env var on your server).
 *   2. Run  setup()  once (authorise when asked) - creates the tabs + headers.
 *   3. Deploy > New deployment > type "Web app"
 *        Execute as: Me        Who has access: Anyone
 *      Copy the Web app URL  ->  SHEETS_WEBHOOK_URL on your server.
 *   4. After editing this file later: Deploy > Manage deployments > Edit > New version.
 *
 * Design notes
 *  - The server sends BATCHES ({secret, items:[{id, kind, row}]}) one at a time, so this
 *    script never sees a burst. A script lock still serialises any accidental overlap.
 *  - Writes are bulk (one setValues call per kind per batch), not row-by-row.
 *  - Idempotent: submissions are UPSERTED by "Submission ID"; violation events are
 *    de-duplicated by "Event ID". Safe to retry/re-send.
 *  - Values starting with = + - @ are prefixed with ' so essays can't inject formulas.
 */

const SECRET = 'CHANGE-ME-TO-A-LONG-RANDOM-STRING';

const SUB_SHEET = 'Submissions';
const VIO_SHEET = 'Violations';

const SUB_HEADERS = ['Submission ID', 'Submitted At', 'Admission No', 'Name', 'Grade', 'Status', 'Total Score', 'Max Score',
  'Section A (MCQ)', 'Section B', 'Section C', 'Correct', 'Incorrect', 'Unattempted', 'Essay Marks (manual)', 'Violations',
  'Time Taken (min)', 'Plays Used', 'Essay Words', 'Answers A', 'Answers C', 'Short Answers', 'Essay'];
const VIO_HEADERS = ['Event ID', 'Server Time', 'Client Time', 'Admission No', 'Name', 'Grade', 'Type', 'Detail', 'Violation #'];

/** Run once from the editor. */
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ensureSheet_(ss, SUB_SHEET, SUB_HEADERS);
  ensureSheet_(ss, VIO_SHEET, VIO_HEADERS);
  SpreadsheetApp.flush();
}

function doGet() {
  return json_({ ok: true, service: 'assessment-webhook', time: new Date().toISOString() });
}

function doPost(e) {
  let lock;
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    if (!body.secret || body.secret !== SECRET) return json_({ ok: false, error: 'unauthorized' });
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return json_({ ok: true, results: [] });

    lock = LockService.getScriptLock();
    lock.waitLock(25000);                                   // serialise overlapping calls

    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const subSh = ensureSheet_(ss, SUB_SHEET, SUB_HEADERS);
    const vioSh = ensureSheet_(ss, VIO_SHEET, VIO_HEADERS);
    const results = [];

    // ---------- Submissions: upsert by Submission ID ----------
    const subs = items.filter(function (i) { return i.kind === 'submission'; });
    if (subs.length) {
      const idRows = indexColumn_(subSh);                   // { id: rowNumber }
      const appendRows = [];
      subs.forEach(function (it) {
        try {
          const rowVals = toRow_(SUB_HEADERS, it.row);
          const id = String(it.row['Submission ID']);
          if (idRows[id]) {
            subSh.getRange(idRows[id], 1, 1, SUB_HEADERS.length).setValues([rowVals]);   // update (e.g. regrade)
          } else {
            idRows[id] = -1; appendRows.push(rowVals);
          }
          results.push({ id: it.id, ok: true });
        } catch (err) { results.push({ id: it.id, ok: false, error: String(err) }); }
      });
      if (appendRows.length) {
        subSh.getRange(subSh.getLastRow() + 1, 1, appendRows.length, SUB_HEADERS.length).setValues(appendRows);
      }
    }

    // ---------- Violations: append, de-duplicate by Event ID ----------
    const vios = items.filter(function (i) { return i.kind === 'violation'; });
    if (vios.length) {
      const seen = indexColumn_(vioSh);
      const rows = [];
      vios.forEach(function (it) {
        try {
          const id = String(it.row['Event ID']);
          if (!seen[id]) { seen[id] = -1; rows.push(toRow_(VIO_HEADERS, it.row)); }
          results.push({ id: it.id, ok: true });
        } catch (err) { results.push({ id: it.id, ok: false, error: String(err) }); }
      });
      if (rows.length) {
        vioSh.getRange(vioSh.getLastRow() + 1, 1, rows.length, VIO_HEADERS.length).setValues(rows);
      }
    }

    SpreadsheetApp.flush();
    return json_({ ok: true, results: results });
  } catch (err) {
    return json_({ ok: false, error: String(err) });
  } finally {
    if (lock) { try { lock.releaseLock(); } catch (x) { /* ignore */ } }
  }
}

/* ------------------------------ helpers ------------------------------ */
function ensureSheet_(ss, name, headers) {
  let sh = ss.getSheetByName(name);
  if (!sh) sh = ss.insertSheet(name);
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#4f46e5').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    ['Submission ID', 'Admission No', 'Event ID'].forEach(function (h) {      // plain text: stops Sheets mangling IDs like 2024-0153
      const c = headers.indexOf(h) + 1;
      if (c > 0 && sh.getMaxRows() > 1) sh.getRange(2, c, sh.getMaxRows() - 1, 1).setNumberFormat('@');
    });
  }
  return sh;
}

function indexColumn_(sh) {
  const map = {};
  const last = sh.getLastRow();
  if (last < 2) return map;
  const vals = sh.getRange(2, 1, last - 1, 1).getValues();
  for (let i = 0; i < vals.length; i++) map[String(vals[i][0])] = i + 2;
  return map;
}

function toRow_(headers, obj) {
  return headers.map(function (h) {
    let v = obj[h];
    if (v === undefined || v === null) return '';
    if (typeof v === 'string' && /^[=+\-@]/.test(v)) v = "'" + v;      // formula-injection guard
    if (typeof v === 'string' && v.length > 45000) v = v.slice(0, 45000) + '...[truncated]';
    return v;
  });
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** Optional: run from the editor to verify the sheet side works. */
function selfTest() {
  const fake = { postData: { contents: JSON.stringify({ secret: SECRET, items: [
    { id: 's:TEST', kind: 'submission', row: { 'Submission ID': 'SUB-TEST', 'Submitted At': new Date().toISOString(), 'Admission No': 'TEST', 'Name': 'Test Student', 'Grade': 'Grade 6', 'Status': 'Submitted', 'Total Score': 10, 'Max Score': 100 } },
    { id: 'v:TEST:1', kind: 'violation', row: { 'Event ID': 'v:TEST:1', 'Server Time': new Date().toISOString(), 'Admission No': 'TEST', 'Name': 'Test Student', 'Type': 'tab_switch' } }
  ] }) } };
  Logger.log(doPost(fake).getContent());
}
