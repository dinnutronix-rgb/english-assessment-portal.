/**
 * English Language Assessment Portal - server.js
 * ---------------------------------------------------------------------------
 * Design goals: 200+ concurrent students on a free-tier host, zero Google Sheets 429s.
 *
 *  - ALL live state (students, answers, violations, warnings, play counters) lives in
 *    RAM, so every student request is O(1) and never waits on disk or the network.
 *  - Durability: write-behind "snapshot + append-only journal" (data/snapshot.json +
 *    data/journal.ndjson). Dirty students are appended to the journal every 2s; a full
 *    snapshot is written atomically every 60s and the journal is truncated.
 *  - Google Sheets: a single background dispatcher drains an in-memory outbox in small,
 *    staggered batches with adaptive batch size + exponential backoff (honours 429
 *    Retry-After). Students never talk to Google.
 *  - Students poll /api/student/sync every ~5s (answers + heartbeat + teacher commands),
 *    so it works on any free host (no websockets / sticky sessions needed).
 *  - Signed "receipts" let a student resume with the SAME deadline and SAME listening
 *    plays even if the host wipes its disk and restarts mid-exam.
 */
'use strict';

const express = require('express');
const compression = require('compression');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

/* ============================== Configuration ============================== */
const PORT = parseInt(process.env.PORT, 10) || 3000;
const ADMIN_USER = process.env.ADMIN_USER || 'DREXWEB';
const ADMIN_PASS = process.env.ADMIN_PASS || 'DRDREX';
const SHEETS_URL = process.env.SHEETS_WEBHOOK_URL || '';
const SHEETS_SECRET = process.env.SHEETS_SECRET || '';
const SERVER_SECRET = process.env.SERVER_SECRET || crypto.randomBytes(32).toString('hex');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');
const ARCHIVE_DIR = path.join(DATA_DIR, 'archive');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const SNAP_FILE = path.join(DATA_DIR, 'snapshot.json');
const JOURNAL_FILE = path.join(DATA_DIR, 'journal.ndjson');
const PUBLIC_DIR = path.join(__dirname, 'public');

const GRADES = ['Grade 6', 'Grade 7', 'Grade 8', 'Grade 9', 'Grade 11'];
const STALE_SESSION_MS = 45000;      // another device may take over an Admission No after this silence
const ONLINE_MS = 15000;             // dashboard "online" threshold
const ADMIN_TOKEN_TTL = 12 * 3600 * 1000;
const MAX_EVENTS_PER_STUDENT = 300;
const VIOLATION_TYPES = new Set(['tab_switch', 'window_blur', 'focus_lost', 'shortcut', 'print_screen', 'copy_paste',
  'context_menu', 'fullscreen_exit', 'print', 'devtools', 'other']);

const SHEETS = { MAX_BATCH: 25, MIN_BATCH: 5, GAP_MS: 2500, TIMEOUT_MS: 30000 };

const HEADERS_SUB = ['Submission ID', 'Submitted At', 'Admission No', 'Name', 'Grade', 'Status', 'Total Score', 'Max Score',
  'Section A (MCQ)', 'Section B', 'Section C', 'Correct', 'Incorrect', 'Unattempted', 'Essay Marks (manual)', 'Violations',
  'Time Taken (min)', 'Plays Used', 'Essay Words', 'Answers A', 'Answers C', 'Short Answers', 'Essay'];

/* ================================ Utilities ================================ */
const now = () => Date.now();
const r2 = (x) => Math.round(x * 100) / 100;
const rid = (n = 24) => crypto.randomBytes(n).toString('hex');
const log = (...a) => console.log(new Date().toISOString(), ...a);
const digest = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEq = (a, b) => crypto.timingSafeEqual(digest(a), digest(b));
const cleanText = (s, max) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '').slice(0, max);
const cleanName = (s) => String(s || '').replace(/[\u0000-\u001f<>]/g, '').replace(/\s+/g, ' ').trim().slice(0, 80);
const normName = (s) => cleanName(s).toLowerCase();
const wordCount = (s) => (String(s || '').trim().match(/\S+/g) || []).length;
const num = (v, d, lo, hi) => { const n = Number(v); return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d; };
const fail = (res, status, error, message) => res.status(status).json({ error, message: message || error });

/* ================================= State =================================== */
const DEFAULT_CONFIG = {
  examTitle: 'English Language Assessment',
  examStatus: 'lobby',               // lobby | live | ended
  durationMin: 90,
  mcqCount: 100,                     // Section A (max 300)
  optionsPerQuestion: 4,             // 4 (A-D) or 5 (A-E)
  shortCount: 10,                    // Section B fill-in-the-blank / short answer items
  shortMark: 1,
  essayMaxMarks: 10,
  essayWordHint: '150 - 250 words',
  listeningCount: 10,                // Section C MCQs
  maxPlays: 2,
  marking: { mode: 'standard', correct: 1, negative: 0.25 },
  showResults: true,
  strictShortcuts: true,             // shortcut attempts freeze the exam (otherwise: blocked + logged)
  requireFullscreen: false,          // leaving fullscreen = violation
  paper: { type: 'none', text: '', file: null, version: 0 },
  audio: { file: null, name: '', version: 0 },
  keyAText: '', keyBText: '', keyCText: '',
  keyA: {}, keyB: {}, keyC: {}
};

let cfg = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
let students = {};                   // ADMISSION -> record
let adminTokens = {};                // token -> expiry
let gseq = 0;                        // global violation sequence for the dashboard feed
const tokenIndex = new Map();        // student session token -> ADMISSION
const playTokens = new Map();        // one-play audio stream token -> {adm, exp}
const recentFeed = [];               // last 100 freeze events for the teacher board
const dirty = new Set();
let configDirty = false;

const touch = (rec) => dirty.add(rec.admission);

/* ============================== Persistence ================================ */
function ensureDirs() { for (const d of [DATA_DIR, UPLOAD_DIR, ARCHIVE_DIR]) fs.mkdirSync(d, { recursive: true }); }
function atomicWrite(file, data) { const tmp = file + '.tmp'; fs.writeFileSync(tmp, data); fs.renameSync(tmp, file); }

function saveConfig() { try { atomicWrite(CONFIG_FILE, JSON.stringify(cfg)); } catch (e) { log('saveConfig failed', e.message); } }

function loadState() {
  ensureDirs();
  try {
    const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    cfg = { ...cfg, ...saved, marking: { ...cfg.marking, ...(saved.marking || {}) },
      paper: { ...cfg.paper, ...(saved.paper || {}) }, audio: { ...cfg.audio, ...(saved.audio || {}) } };
  } catch (e) { /* first run */ }
  try {
    const snap = JSON.parse(fs.readFileSync(SNAP_FILE, 'utf8'));
    students = snap.students || {}; adminTokens = snap.adminTokens || {}; gseq = snap.gseq || 0;
  } catch (e) { /* first run */ }
  try {
    const lines = fs.readFileSync(JOURNAL_FILE, 'utf8').split('\n');
    let applied = 0;
    for (const ln of lines) {
      if (!ln) continue;
      try { const j = JSON.parse(ln); if (j.k === 's' && j.r && j.r.admission) { students[j.r.admission] = j.r; applied++; } }
      catch (e) { /* torn last line after crash: ignore */ }
    }
    if (applied) log(`journal replay: ${applied} record updates`);
  } catch (e) { /* no journal */ }
  for (const rec of Object.values(students)) {
    tokenIndex.set(rec.token, rec.admission);
    for (const ev of rec.events) if (ev.freeze && !ev.dup && ev.seq) recentFeed.push({ gseq: ev.gseq || 0, admission: rec.admission, name: rec.name, type: ev.type, ts: ev.ts });
  }
  recentFeed.sort((a, b) => a.gseq - b.gseq); recentFeed.splice(0, Math.max(0, recentFeed.length - 100));
  log(`state loaded: ${Object.keys(students).length} students, exam=${cfg.examStatus}`);
}

function flushJournal() {
  if (configDirty) { saveConfig(); configDirty = false; }
  if (!dirty.size) return;
  let out = '';
  for (const adm of dirty) if (students[adm]) out += JSON.stringify({ k: 's', r: students[adm] }) + '\n';
  dirty.clear();
  try { if (out) fs.appendFileSync(JOURNAL_FILE, out); } catch (e) { log('journal write failed', e.message); }
}

function writeSnapshot() {
  try {
    flushJournal();
    atomicWrite(SNAP_FILE, JSON.stringify({ students, adminTokens, gseq, at: now() }));
    fs.writeFileSync(JOURNAL_FILE, '');
  } catch (e) { log('snapshot failed', e.message); }
}

/* ============================ Key parsing / grading ======================== */
function parseMcqKey(text, count, options) {
  const maxLetter = String.fromCharCode(64 + options);
  const t = String(text || '').toUpperCase();
  const key = {}; const invalid = []; const outOfRange = [];
  const re = /(\d{1,3})\s*[:=.\-,)\]]?\s*([A-E])(?![A-Z])/g;
  let m; let hits = 0;
  while ((m = re.exec(t))) {
    hits++;
    const q = parseInt(m[1], 10), l = m[2];
    if (q < 1 || q > count) { outOfRange.push(q); continue; }
    if (l > maxLetter) { invalid.push(`${q}:${l}`); continue; }
    key[q] = l;
  }
  if (!hits && /^[A-E\s,;]+$/.test(t) && t.trim()) {   // plain sequence "ABCDDA..." -> sequential
    const letters = t.replace(/[^A-E]/g, '').split('');
    letters.forEach((l, i) => { if (i < count) { if (l > maxLetter) invalid.push(`${i + 1}:${l}`); else key[i + 1] = l; } else outOfRange.push(i + 1); });
  }
  const missing = [];
  for (let i = 1; i <= count; i++) if (!key[i]) missing.push(i);
  return { key, count: Object.keys(key).length, missing, invalid, outOfRange };
}

const normAns = (s) => String(s || '').toLowerCase().replace(/[.,;:!?'"]+$/g, '').replace(/\s+/g, ' ').trim();

function parseShortKey(text, count) {
  const key = {}; const invalid = [];
  for (const ln of String(text || '').split(/\r?\n/)) {
    const m = ln.match(/^\s*(\d{1,3})\s*[:=.)\-]\s*(.+)$/);
    if (!m) { if (ln.trim()) invalid.push(ln.trim().slice(0, 40)); continue; }
    const q = parseInt(m[1], 10);
    if (q < 1 || q > count) { invalid.push(`${q}`); continue; }
    key[q] = m[2].split(/[|;]/).map(normAns).filter(Boolean);
  }
  const missing = []; for (let i = 1; i <= count; i++) if (!key[i]) missing.push(i);
  return { key, count: Object.keys(key).length, missing, invalid, outOfRange: [] };
}

function gradeMcq(ans, key, n) {
  const m = cfg.marking; const neg = m.mode === 'negative' ? m.negative : 0;
  let c = 0, w = 0, u = 0;
  for (let i = 1; i <= n; i++) {
    const v = ans[i]; if (!v) { u++; continue; }
    const k = key[i]; if (!k) continue;
    if (v === k) c++; else w++;
  }
  return { correct: c, wrong: w, unattempted: u, score: r2(c * m.correct - w * neg), max: r2(n * m.correct) };
}

function computeScores(rec) {
  const A = gradeMcq(rec.a, cfg.keyA, cfg.mcqCount);
  const C = gradeMcq(rec.c, cfg.keyC, cfg.listeningCount);
  let hits = 0;
  for (let i = 1; i <= cfg.shortCount; i++) {
    const acc = cfg.keyB[i], given = normAns(rec.b[i]);
    if (acc && given && acc.includes(given)) hits++;
  }
  const shortScore = rec.manual.shortMarks != null ? rec.manual.shortMarks : r2(hits * cfg.shortMark);
  const essayScore = rec.manual.essayMarks != null ? rec.manual.essayMarks : 0;
  const hasShort = Object.values(rec.b).some((v) => String(v).trim());
  const pending = (!!rec.essay.trim() && rec.manual.essayMarks == null) ||
    (hasShort && !Object.keys(cfg.keyB).length && rec.manual.shortMarks == null);
  const B = { score: r2(shortScore + essayScore), max: r2(cfg.shortCount * cfg.shortMark + cfg.essayMaxMarks), short: shortScore, essay: essayScore, pending };
  return { A, B, C, total: r2(A.score + B.score + C.score), maxTotal: r2(A.max + B.max + C.max) };
}

/* ============================ Record helpers =============================== */
const playsRemaining = (rec) => Math.max(0, cfg.maxPlays + rec.playsGranted - rec.playsUsed);

function newRecord(admission, name, grade, ip) {
  return {
    admission, name, grade, token: rid(), tabId: '', createdAt: now(), lastSeen: now(), ip,
    status: 'lobby', startedAt: 0, deadline: 0,
    rev: 0, a: {}, b: {}, c: {}, essay: '', prog: { a: 0, b: 0, c: 0, words: 0 },
    playsUsed: 0, playsGranted: 0, lastPlayAt: 0,
    warnings: [], wseq: 0, events: [], eseq: 0, vCount: 0, frozenAt: 0, freezeReason: '',
    submission: null, manual: { essayMarks: null, shortMarks: null }
  };
}

function recomputeProgress(rec) {
  rec.prog = {
    a: Object.keys(rec.a).length, c: Object.keys(rec.c).length,
    b: Object.values(rec.b).filter((v) => String(v).trim()).length, words: wordCount(rec.essay)
  };
}
const answeredTotal = (rec) => rec.prog.a + rec.prog.b + rec.prog.c + (rec.prog.words ? 1 : 0);

function addEvent(rec, type, detail, o = {}) {
  const ev = { seq: ++rec.eseq, ts: now(), cts: o.cts || 0, type, detail: cleanText(detail, 160), freeze: !!o.freeze, dup: !!o.dup, synced: !o.sheet || !!o.dup };
  if (ev.freeze && !ev.dup) { ev.gseq = ++gseq; recentFeed.push({ gseq: ev.gseq, admission: rec.admission, name: rec.name, type, ts: ev.ts }); if (recentFeed.length > 100) recentFeed.shift(); }
  rec.events.push(ev);
  if (rec.events.length > MAX_EVENTS_PER_STUDENT) rec.events.splice(0, rec.events.length - MAX_EVENTS_PER_STUDENT);
  touch(rec);
  if (!ev.synced) enqueueViolation(rec, ev);
  return ev;
}

function freezeRecord(rec, type, detail, cts, reasonLabel) {
  if (rec.status === 'frozen') { addEvent(rec, type, detail, { cts, freeze: true, dup: true }); return; }
  rec.status = 'frozen'; rec.frozenAt = now(); rec.freezeReason = reasonLabel || type; rec.vCount++;
  addEvent(rec, type, detail, { cts, freeze: true, sheet: true });
  touch(rec);
}

function makeReceipt(rec) {
  const p = Buffer.from(JSON.stringify({ a: rec.admission, st: rec.startedAt, dl: rec.deadline, pu: rec.playsUsed, pg: rec.playsGranted })).toString('base64url');
  return p + '.' + crypto.createHmac('sha256', SERVER_SECRET).update(p).digest('base64url');
}
function verifyReceipt(r) {
  try {
    const [p, sig] = String(r).split('.');
    const good = crypto.createHmac('sha256', SERVER_SECRET).update(p).digest('base64url');
    if (!sig || sig.length !== good.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(good))) return null;
    return JSON.parse(Buffer.from(p, 'base64url').toString());
  } catch (e) { return null; }
}

function publicConfig() {
  return {
    examTitle: cfg.examTitle, durationMin: cfg.durationMin, mcqCount: cfg.mcqCount, optionsPerQuestion: cfg.optionsPerQuestion,
    shortCount: cfg.shortCount, listeningCount: cfg.listeningCount, essayWordHint: cfg.essayWordHint, maxPlays: cfg.maxPlays,
    strictShortcuts: cfg.strictShortcuts, requireFullscreen: cfg.requireFullscreen,
    marking: cfg.marking.mode === 'negative' ? `Negative marking: wrong answer = -${cfg.marking.negative}` : 'Standard marking: no penalty for wrong answers',
    paper: { type: cfg.paper.type, version: cfg.paper.version }, hasAudio: !!cfg.audio.file
  };
}

function studentResult(rec) {
  if (!rec.submission) return null;
  const s = rec.submission, sc = s.scores;
  const base = { submitted: true, mode: s.mode, submittedAt: s.at, name: rec.name, admission: rec.admission, grade: rec.grade, released: cfg.showResults };
  if (!cfg.showResults) return base;
  return { ...base, total: sc.total, max: sc.maxTotal, mcq: { score: sc.A.score, max: sc.A.max },
    sections: { A: sc.A, B: { score: sc.B.score, max: sc.B.max, pending: sc.B.pending }, C: sc.C } };
}

function sessionState(rec, clientRev) {
  const t = now();
  const o = {
    status: rec.status, examStatus: cfg.examStatus, serverNow: t, rev: rec.rev,
    remainingMs: rec.deadline ? Math.max(0, rec.deadline - t) : null,
    playsRemaining: playsRemaining(rec), maxPlays: cfg.maxPlays,
    warnings: rec.warnings.filter((w) => !w.acked).map((w) => ({ id: w.id, msg: w.msg, ts: w.ts })),
    freeze: rec.status === 'frozen' ? { at: rec.frozenAt, reason: rec.freezeReason, count: rec.vCount } : null
  };
  if (rec.status !== 'lobby') o.receipt = makeReceipt(rec);
  if (rec.submission) o.result = studentResult(rec);
  if (clientRev != null && rec.rev > clientRev) o.data = { rev: rec.rev, a: rec.a, b: rec.b, c: rec.c, essay: rec.essay };
  return o;
}

function sanitizeData(d) {
  const out = { a: {}, b: {}, c: {} };
  const maxA = String.fromCharCode(64 + cfg.optionsPerQuestion);
  const mc = (src, dst, n) => {
    if (!src || typeof src !== 'object') return;
    for (const k of Object.keys(src)) {
      const q = parseInt(k, 10), v = String(src[k]).toUpperCase();
      if (q >= 1 && q <= n && /^[A-E]$/.test(v) && v <= maxA) dst[q] = v;
    }
  };
  mc(d.a, out.a, cfg.mcqCount); mc(d.c, out.c, cfg.listeningCount);
  if (d.b && typeof d.b === 'object') for (const k of Object.keys(d.b)) {
    const q = parseInt(k, 10); if (q >= 1 && q <= cfg.shortCount) { const v = cleanText(d.b[k], 300); if (v.trim()) out.b[q] = v; }
  }
  out.essay = cleanText(d.essay, 30000);
  return out;
}

function submitRecord(rec, mode) {
  if (rec.submission) return rec.submission;
  rec.status = 'submitted';
  rec.submission = { id: 'SUB-' + rec.admission, version: 1, at: now(), mode, scores: computeScores(rec) };
  addEvent(rec, 'submitted', mode);
  touch(rec); enqueueSubmission(rec);
  return rec.submission;
}

function regradeAll() {
  for (const rec of Object.values(students)) if (rec.submission) {
    rec.submission.scores = computeScores(rec); rec.submission.version++; touch(rec); enqueueSubmission(rec);
  }
}

/* ============================ Google Sheets outbox ========================= */
const outbox = new Map(); // key -> {key, kind, adm, seq, v, attempts, nextAt, prio, queuedAt}
const sh = { fails: 0, nextAt: 0, batch: SHEETS.MAX_BATCH, inflight: false, sent: 0, lastOk: 0, lastErr: '', lastErrAt: 0 };

function enqueueSubmission(rec) {
  if (!SHEETS_URL) return;
  outbox.set('s:' + rec.admission, { key: 's:' + rec.admission, kind: 'submission', adm: rec.admission, attempts: 0, nextAt: 0, prio: 0, queuedAt: now() });
}
function enqueueViolation(rec, ev) {
  if (!SHEETS_URL) return;
  const key = `v:${rec.admission}:${ev.seq}`;
  outbox.set(key, { key, kind: 'violation', adm: rec.admission, seq: ev.seq, attempts: 0, nextAt: 0, prio: 1, queuedAt: now() });
}
function enqueueAllUnsynced(force) {
  if (!SHEETS_URL) return 0;
  let n = 0;
  for (const rec of Object.values(students)) {
    if (rec.submission && (force || rec.sheetVersion !== rec.submission.version)) { enqueueSubmission(rec); n++; }
    for (const ev of rec.events) if (!ev.synced) { enqueueViolation(rec, ev); n++; }
  }
  return n;
}

const sortKeys = (o) => Object.keys(o).map(Number).sort((x, y) => x - y);
function submissionRow(rec) {
  const s = rec.submission, sc = s.scores;
  const statusLabel = { manual: 'Submitted', auto: 'Auto-submitted (time up)', ended: 'Auto-submitted (exam ended)', teacher: 'Submitted by teacher' }[s.mode] || s.mode;
  return {
    'Submission ID': s.id, 'Submitted At': new Date(s.at).toISOString(), 'Admission No': rec.admission, 'Name': rec.name, 'Grade': rec.grade,
    'Status': statusLabel, 'Total Score': sc.total, 'Max Score': sc.maxTotal, 'Section A (MCQ)': sc.A.score, 'Section B': sc.B.score + (sc.B.pending ? ' (pending review)' : ''),
    'Section C': sc.C.score, 'Correct': sc.A.correct + sc.C.correct, 'Incorrect': sc.A.wrong + sc.C.wrong, 'Unattempted': sc.A.unattempted + sc.C.unattempted,
    'Essay Marks (manual)': rec.manual.essayMarks == null ? '' : rec.manual.essayMarks, 'Violations': rec.vCount,
    'Time Taken (min)': rec.startedAt ? r2((s.at - rec.startedAt) / 60000) : '', 'Plays Used': rec.playsUsed, 'Essay Words': wordCount(rec.essay),
    'Answers A': sortKeys(rec.a).map((q) => `${q}:${rec.a[q]}`).join(', '), 'Answers C': sortKeys(rec.c).map((q) => `${q}:${rec.c[q]}`).join(', '),
    'Short Answers': sortKeys(rec.b).map((q) => `${q}: ${rec.b[q]}`).join(' | '), 'Essay': rec.essay
  };
}
function violationRow(rec, ev) {
  return { 'Event ID': `v:${rec.admission}:${ev.seq}`, 'Server Time': new Date(ev.ts).toISOString(), 'Client Time': ev.cts ? new Date(ev.cts).toISOString() : '',
    'Admission No': rec.admission, 'Name': rec.name, 'Grade': rec.grade, 'Type': ev.type, 'Detail': ev.detail, 'Violation #': rec.vCount };
}

async function sendBatch(items) {
  const payload = []; const meta = [];
  for (const it of items) {
    const rec = students[it.adm];
    if (!rec) { outbox.delete(it.key); continue; }
    if (it.kind === 'submission') {
      if (!rec.submission) { outbox.delete(it.key); continue; }
      it.v = rec.submission.version; payload.push({ id: it.key, kind: 'submission', row: submissionRow(rec) });
    } else {
      const ev = rec.events.find((e) => e.seq === it.seq);
      if (!ev) { outbox.delete(it.key); continue; }
      payload.push({ id: it.key, kind: 'violation', row: violationRow(rec, ev) });
    }
    meta.push(it);
  }
  if (!payload.length) return;
  sh.inflight = true;
  try {
    const resp = await fetch(SHEETS_URL, {
      method: 'POST', redirect: 'follow', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify({ secret: SHEETS_SECRET, items: payload }), signal: AbortSignal.timeout(SHEETS.TIMEOUT_MS)
    });
    if (resp.status === 429 || resp.status >= 500) {
      const ra = parseInt(resp.headers.get('retry-after'), 10);
      throw Object.assign(new Error('HTTP ' + resp.status), { retryAfter: Number.isFinite(ra) ? ra * 1000 : 0 });
    }
    let data; try { data = JSON.parse(await resp.text()); } catch (e) { throw new Error('non-JSON reply from Apps Script (quota page or wrong deployment?)'); }
    if (!data || data.ok !== true) throw new Error('Apps Script rejected: ' + (data && data.error));
    const results = new Map((data.results || []).map((r) => [r.id, r]));
    for (const it of meta) {
      const r = results.get(it.key);
      if (r && r.ok) {
        const rec = students[it.adm];
        if (it.kind === 'submission') {
          if (rec && rec.submission && rec.submission.version === it.v) { rec.sheetVersion = it.v; outbox.delete(it.key); touch(rec); } else it.attempts = 0;
        } else {
          const ev = rec && rec.events.find((e) => e.seq === it.seq); if (ev) { ev.synced = true; touch(rec); }
          outbox.delete(it.key);
        }
        sh.sent++;
      } else { it.attempts++; it.nextAt = now() + Math.min(300000, 20000 * it.attempts); sh.lastErr = `item ${it.key}: ${r && r.error || 'no result'}`; sh.lastErrAt = now(); }
    }
    sh.fails = 0; sh.lastOk = now(); sh.batch = Math.min(SHEETS.MAX_BATCH, sh.batch + 5);
    sh.nextAt = now() + SHEETS.GAP_MS + Math.floor(Math.random() * 800);
  } catch (e) {
    sh.fails++; sh.lastErr = String(e.message || e); sh.lastErrAt = now();
    sh.batch = Math.max(SHEETS.MIN_BATCH, Math.floor(sh.batch / 2));
    const backoff = Math.min(90000, 2000 * 2 ** Math.min(sh.fails, 6)) + Math.floor(Math.random() * 1500);
    sh.nextAt = now() + Math.max(backoff, e.retryAfter || 0);
    for (const it of meta) it.attempts++;
    log(`sheets batch failed (#${sh.fails}): ${sh.lastErr}; retry in ${Math.round((sh.nextAt - now()) / 1000)}s, batch=${sh.batch}`);
  } finally { sh.inflight = false; }
}

async function sheetsLoop() {
  try {
    if (SHEETS_URL && !sh.inflight && now() >= sh.nextAt && outbox.size) {
      const t = now();
      const ready = [...outbox.values()].filter((i) => i.nextAt <= t).sort((a, b) => a.prio - b.prio || a.queuedAt - b.queuedAt).slice(0, sh.batch);
      if (ready.length) await sendBatch(ready);
    }
  } catch (e) { log('sheetsLoop error', e.message); }
  setTimeout(sheetsLoop, 1000);
}

/* ============================== Rate limiting ============================== */
const allBuckets = [];
function limiter({ capacity, refillPerSec, keyFn }) {
  const buckets = new Map(); allBuckets.push(buckets);
  return (req, res, next) => {
    const k = keyFn(req), t = now(); let b = buckets.get(k);
    if (!b) { b = { tokens: capacity, ts: t }; buckets.set(k, b); }
    b.tokens = Math.min(capacity, b.tokens + ((t - b.ts) / 1000) * refillPerSec); b.ts = t;
    if (b.tokens < 1) { res.set('Retry-After', '2'); return fail(res, 429, 'rate_limited', 'Too many requests, slow down.'); }
    b.tokens -= 1; next();
  };
}
// NOTE: students on one school network share ONE public IP (200 students ~ 40+ req/s), so the IP limit is only a
// flood guard; the per-session limiters below do the real protection.
const ipLimiter = limiter({ capacity: 4000, refillPerSec: 500, keyFn: (r) => 'ip:' + r.ip });
const studentLimiter = limiter({ capacity: 12, refillPerSec: 3, keyFn: (r) => 's:' + (r.headers['x-session'] || r.ip) });
const loginIpLimiter = limiter({ capacity: 300, refillPerSec: 8, keyFn: (r) => 'li:' + r.ip });
const loginAdmLimiter = limiter({ capacity: 15, refillPerSec: 0.2, keyFn: (r) => 'la:' + String((r.body && r.body.admission) || '').toUpperCase() });
const adminLoginLimiter = limiter({ capacity: 8, refillPerSec: 8 / 300, keyFn: (r) => 'al:' + r.ip });
const adminLimiter = limiter({ capacity: 60, refillPerSec: 20, keyFn: (r) => 'a:' + (r.headers.authorization || r.ip) });
const audioLimiter = limiter({ capacity: 20, refillPerSec: 2, keyFn: (r) => 'au:' + r.ip });

/* ================================= Express ================================= */
const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');
app.use(compression({ filter: (req, res) => (req.path.includes('/audio') ? false : compression.filter(req, res)) }));
app.use((req, res, next) => {
  res.set({ 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'X-Frame-Options': 'DENY' });
  if (req.path.startsWith('/api/')) res.set('Cache-Control', 'no-store');
  next();
});
app.use('/api', ipLimiter, express.json({ limit: '300kb' }));

function adminAuth(req, res, next) {
  const t = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const exp = adminTokens[t];
  if (!t || !exp || exp < now()) return fail(res, 401, 'unauthorized', 'Admin session expired. Please log in again.');
  req.adminToken = t; next();
}

function studentAuth(req, res, next) {
  const adm = tokenIndex.get(req.headers['x-session']);
  const rec = adm && students[adm];
  if (!rec) return fail(res, 401, 'invalid_session', 'Session not found. Please log in again.');
  if (req.headers['x-tab'] !== rec.tabId) return fail(res, 409, 'superseded', 'This exam is open in another tab or window.');
  rec.lastSeen = now(); req.rec = rec; next();
}
// /resume (page reload) is the only call allowed to claim the tab id: the newest page wins, older tabs get 'superseded'.
function studentResumeAuth(req, res, next) {
  const adm = tokenIndex.get(req.headers['x-session']);
  const rec = adm && students[adm];
  if (!rec) return fail(res, 401, 'invalid_session', 'Session not found. Please log in again.');
  rec.tabId = String(req.headers['x-tab'] || rid(6)).slice(0, 40); rec.lastSeen = now(); req.rec = rec; next();
}

/* ---------------------------- Student: login/resume ----------------------- */
function issueSession(rec, req) {
  rec.tabId = String(req.headers['x-tab'] || rid(6)).slice(0, 40);
  rec.lastSeen = now(); rec.ip = req.ip;
  return rec;
}

app.post('/api/student/login', loginIpLimiter, loginAdmLimiter, (req, res) => {
  const b = req.body || {};
  const name = cleanName(b.name), admission = String(b.admission || '').trim().toUpperCase(), grade = String(b.grade || '');
  if (name.length < 2) return fail(res, 400, 'bad_name', 'Please enter your full name.');
  if (!/^[A-Z0-9][A-Z0-9\-_/]{0,19}$/.test(admission)) return fail(res, 400, 'bad_admission', 'Admission Number may contain letters, digits, - _ / only (max 20).');
  if (!GRADES.includes(grade)) return fail(res, 400, 'bad_grade', 'Please select a valid grade.');
  let rec = students[admission];
  const t = now();

  if (rec) {
    const sameDevice = b.token && b.token === rec.token;
    if (!sameDevice) {
      if (normName(rec.name) !== normName(name) || rec.grade !== grade)
        return fail(res, 403, 'identity_mismatch', 'This Admission Number is registered with a different name/grade. Check your details or ask your teacher.');
      if (rec.status !== 'submitted' && t - rec.lastSeen < STALE_SESSION_MS)
        return fail(res, 409, 'already_active', 'This Admission Number already has an active session on another device or tab. Close it, or wait ~45 seconds and try again.');
      rec.token = rid(); tokenIndex.set(rec.token, admission);   // takeover (old token dies below)
      addEvent(rec, 'session_takeover', 'Re-login from ' + req.ip, { sheet: true });
    }
    for (const [tk, adm] of tokenIndex) if (adm === admission && tk !== rec.token) tokenIndex.delete(tk);
    tokenIndex.set(rec.token, admission);
  } else {
    if (cfg.examStatus === 'ended') return fail(res, 403, 'ended', 'This assessment has ended.');
    rec = students[admission] = newRecord(admission, name, grade, req.ip);
    tokenIndex.set(rec.token, admission);
    const rc = b.receipt ? verifyReceipt(b.receipt) : null;       // restore after a server data wipe
    if (rc && rc.a === admission && rc.dl > t - 30 * 60000 && cfg.examStatus !== 'ended') {
      rec.status = 'active'; rec.startedAt = rc.st; rec.deadline = rc.dl; rec.playsUsed = rc.pu || 0; rec.playsGranted = rc.pg || 0;
      addEvent(rec, 'restored', 'Session restored from signed receipt after server restart', { sheet: true });
    }
  }
  issueSession(rec, req); touch(rec);
  res.json({ token: rec.token, student: { name: rec.name, admission, grade: rec.grade }, config: publicConfig(), state: sessionState(rec, -1) });
});

app.post('/api/student/resume', studentResumeAuth, (req, res) => {
  const rec = req.rec;
  if (rec.status === 'active' || rec.status === 'frozen') addEvent(rec, 'page_reload', 'Page reloaded / resumed');
  res.json({ student: { name: rec.name, admission: rec.admission, grade: rec.grade }, config: publicConfig(), state: sessionState(rec, -1) });
});

app.post('/api/student/start', studentAuth, studentLimiter, (req, res) => {
  const rec = req.rec;
  if (rec.status === 'lobby') {
    if (cfg.examStatus !== 'live') return fail(res, 409, 'not_live', 'The assessment has not been started by your teacher yet.');
    rec.status = 'active'; rec.startedAt = now(); rec.deadline = rec.startedAt + cfg.durationMin * 60000;
    addEvent(rec, 'exam_started', 'Student started the assessment'); touch(rec);
  }
  res.json({ state: sessionState(rec, -1) });
});

app.post('/api/student/sync', studentAuth, studentLimiter, (req, res) => {
  const rec = req.rec, b = req.body || {};
  if (rec.status === 'active' || rec.status === 'frozen') {
    const d = b.data;
    if (d && Number.isInteger(d.rev) && d.rev > rec.rev) {
      const s = sanitizeData(d); rec.a = s.a; rec.b = s.b; rec.c = s.c; rec.essay = s.essay; rec.rev = d.rev;
      recomputeProgress(rec); touch(rec);
    }
  }
  if (Array.isArray(b.ackWarnings) && b.ackWarnings.length) {
    for (const id of b.ackWarnings.slice(0, 20)) { const w = rec.warnings.find((x) => x.id === id); if (w && !w.acked) { w.acked = true; w.ackAt = now(); touch(rec); } }
  }
  res.json(sessionState(rec, Number.isInteger(b.rev) ? b.rev : null));
});

app.post('/api/student/violation', studentAuth, studentLimiter, (req, res) => {
  const rec = req.rec; const list = Array.isArray(req.body.events) ? req.body.events.slice(0, 20) : [req.body];
  if (rec.status === 'active' || rec.status === 'frozen') {
    for (const e of list) {
      const type = VIOLATION_TYPES.has(e.type) ? e.type : 'other';
      const label = { tab_switch: 'Tab switch', window_blur: 'Window lost focus', focus_lost: 'Window lost focus', shortcut: 'Blocked shortcut', print_screen: 'Screenshot attempt',
        copy_paste: 'Copy/paste attempt', context_menu: 'Right-click', fullscreen_exit: 'Left fullscreen', print: 'Print attempt', devtools: 'Developer tools' }[type] || 'Violation';
      if (e.info) addEvent(rec, type, e.detail, { cts: Number(e.cts) || 0 });       // logged, no freeze
      else freezeRecord(rec, type, cleanText(e.detail, 160), Number(e.cts) || 0, label);
    }
  }
  res.json(sessionState(rec, null));
});

app.post('/api/student/submit', studentAuth, studentLimiter, (req, res) => {
  const rec = req.rec, d = req.body && req.body.data;
  if (!rec.submission) {
    if (rec.status === 'lobby') return fail(res, 409, 'not_started', 'You have not started the assessment.');
    if (d && Number.isInteger(d.rev) && d.rev >= rec.rev) { const s = sanitizeData(d); rec.a = s.a; rec.b = s.b; rec.c = s.c; rec.essay = s.essay; rec.rev = d.rev; recomputeProgress(rec); }
    submitRecord(rec, req.body.auto ? 'auto' : 'manual');
  }
  res.json(sessionState(rec, null));
});

/* ---- paper & audio (token protected) ---- */
function canViewPaper(rec) { return rec.status === 'active' || rec.status === 'frozen'; }

app.get('/api/student/paper', studentAuth, (req, res) => {
  if (!canViewPaper(req.rec)) return fail(res, 403, 'forbidden', 'Paper is not available.');
  res.json({ type: cfg.paper.type, version: cfg.paper.version, text: cfg.paper.type === 'text' ? cfg.paper.text : '' });
});
app.get('/api/student/paper/file', studentAuth, (req, res) => {
  if (!canViewPaper(req.rec) || cfg.paper.type !== 'pdf' || !cfg.paper.file) return fail(res, 404, 'no_paper', 'No PDF available.');
  res.set({ 'Cache-Control': 'private, max-age=3600', 'Content-Type': 'application/pdf', 'Content-Disposition': 'inline' });
  res.sendFile(path.join(UPLOAD_DIR, cfg.paper.file));
});

app.post('/api/student/audio/play', studentAuth, studentLimiter, (req, res) => {
  const rec = req.rec;
  if (rec.status !== 'active') return fail(res, 403, 'not_active', 'Audio can only be played during an active exam.');
  if (!cfg.audio.file) return fail(res, 404, 'no_audio', 'No listening audio has been uploaded.');
  if (now() - rec.lastPlayAt < 3000) return fail(res, 429, 'too_fast', 'Please wait a moment.');
  if (playsRemaining(rec) <= 0) return fail(res, 403, 'no_plays', 'No plays remaining.');
  rec.playsUsed++; rec.lastPlayAt = now(); touch(rec);
  for (const [k, v] of playTokens) if (v.adm === rec.admission) playTokens.delete(k);   // new play invalidates the old stream
  const pt = rid(16); playTokens.set(pt, { adm: rec.admission, exp: now() + 30 * 60000 });
  addEvent(rec, 'audio_play', `Play ${rec.playsUsed}`);
  res.json({ url: `/api/audio/stream/${pt}`, playsRemaining: playsRemaining(rec), version: cfg.audio.version });
});

app.get('/api/audio/stream/:pt', audioLimiter, (req, res) => {
  const t = playTokens.get(req.params.pt);
  if (!t || t.exp < now() || !cfg.audio.file) return fail(res, 403, 'expired', 'Audio link expired.');
  res.set({ 'Cache-Control': 'no-store', 'Content-Disposition': 'inline' });
  res.sendFile(path.join(UPLOAD_DIR, cfg.audio.file), (err) => { if (err && !res.headersSent) fail(res, 404, 'missing', 'Audio missing.'); });
});

app.get('/api/student/result', studentAuth, (req, res) => {
  if (!req.rec.submission) return fail(res, 409, 'not_submitted', 'Not submitted yet.');
  res.json(studentResult(req.rec));
});

/* ------------------------------ Admin: auth ------------------------------- */
app.post('/api/admin/login', adminLoginLimiter, (req, res) => {
  const { userId, password } = req.body || {};
  const ok = safeEq(String(userId || ''), ADMIN_USER) & safeEq(String(password || ''), ADMIN_PASS);   // evaluate both (no short-circuit)
  if (!ok) return fail(res, 401, 'bad_credentials', 'Invalid User ID or Password.');
  const tok = rid(32); adminTokens[tok] = now() + ADMIN_TOKEN_TTL;
  res.json({ token: tok, expiresAt: adminTokens[tok] });
});
app.post('/api/admin/logout', adminAuth, (req, res) => { delete adminTokens[req.adminToken]; res.json({ ok: true }); });

/* ---------------------------- Admin: live board --------------------------- */
function boardRow(rec, t) {
  const last = [...rec.events].reverse().find((e) => e.freeze && !e.dup);
  return {
    admission: rec.admission, name: rec.name, grade: rec.grade, status: rec.status, online: t - rec.lastSeen < ONLINE_MS, lastSeen: rec.lastSeen,
    answered: rec.prog, answeredTotal: answeredTotal(rec), vCount: rec.vCount, lastViolation: last ? { type: last.type, ts: last.ts, detail: last.detail } : null,
    frozenAt: rec.frozenAt, freezeReason: rec.freezeReason, playsRemaining: playsRemaining(rec),
    warnPending: rec.warnings.filter((w) => !w.acked).length, warnTotal: rec.warnings.length,
    remainingMs: rec.deadline && rec.status !== 'submitted' ? Math.max(0, rec.deadline - t) : null,
    submitted: rec.submission ? { at: rec.submission.at, mode: rec.submission.mode, total: rec.submission.scores.total, max: rec.submission.scores.maxTotal,
      A: rec.submission.scores.A.score, B: rec.submission.scores.B.score, C: rec.submission.scores.C.score, pending: rec.submission.scores.B.pending,
      correct: rec.submission.scores.A.correct + rec.submission.scores.C.correct, wrong: rec.submission.scores.A.wrong + rec.submission.scores.C.wrong,
      blank: rec.submission.scores.A.unattempted + rec.submission.scores.C.unattempted, essayMarks: rec.manual.essayMarks, shortMarks: rec.manual.shortMarks } : null
  };
}
app.get('/api/admin/board', adminAuth, adminLimiter, (req, res) => {
  const t = now(); const list = Object.values(students).map((r) => boardRow(r, t));
  const stats = { registered: list.length, lobby: 0, active: 0, frozen: 0, submitted: 0, offline: 0, violations: 0 };
  for (const s of list) { stats[s.status]++; if (!s.online && s.status !== 'submitted') stats.offline++; stats.violations += s.vCount; }
  res.json({ now: t, exam: { status: cfg.examStatus, title: cfg.examTitle, durationMin: cfg.durationMin }, stats, students: list, feed: recentFeed.slice(-30), sheets: sheetsStatus() });
});

app.get('/api/admin/student/:adm', adminAuth, (req, res) => {
  const rec = students[String(req.params.adm).toUpperCase()];
  if (!rec) return fail(res, 404, 'not_found', 'No such student.');
  res.json({ ...boardRow(rec, now()), events: rec.events.slice(-100).reverse(), warnings: rec.warnings.slice(-20), essayWords: wordCount(rec.essay), essay: rec.essay,
    short: rec.b, scores: rec.submission ? rec.submission.scores : null, playsUsed: rec.playsUsed, playsGranted: rec.playsGranted });
});

function targets(body, filterFn) {
  if (body.admission === 'all') return Object.values(students).filter(filterFn || (() => true));
  const rec = students[String(body.admission || '').toUpperCase()]; return rec ? [rec] : [];
}
const liveOnly = (r) => r.status === 'active' || r.status === 'frozen';

app.post('/api/admin/unlock', adminAuth, (req, res) => {
  let n = 0;
  for (const rec of targets(req.body, (r) => r.status === 'frozen')) {
    if (rec.status !== 'frozen') continue;
    rec.status = 'active'; rec.freezeReason = ''; addEvent(rec, 'unlocked', 'Unlocked by teacher', { sheet: true }); touch(rec); n++;
  }
  res.json({ ok: true, unlocked: n });
});

app.post('/api/admin/freeze', adminAuth, (req, res) => {
  let n = 0;
  for (const rec of targets(req.body, (r) => r.status === 'active')) if (rec.status === 'active') { freezeRecord(rec, 'other', 'Suspended by teacher', 0, 'Suspended by teacher'); n++; }
  res.json({ ok: true, frozen: n });
});

app.post('/api/admin/warn', adminAuth, (req, res) => {
  const msg = cleanText(req.body.message, 300).trim();
  if (!msg) return fail(res, 400, 'empty', 'Message is empty.');
  let n = 0;
  for (const rec of targets(req.body, liveOnly)) {
    rec.warnings.push({ id: ++rec.wseq, msg, ts: now(), acked: false }); if (rec.warnings.length > 30) rec.warnings.shift();
    addEvent(rec, 'warned', msg, { sheet: true }); n++;
  }
  res.json({ ok: true, sent: n });
});

app.post('/api/admin/grant-play', adminAuth, (req, res) => {
  const rec = students[String(req.body.admission || '').toUpperCase()];
  if (!rec) return fail(res, 404, 'not_found', 'No such student.');
  rec.playsGranted += Math.floor(num(req.body.count, 1, 1, 5)); addEvent(rec, 'play_granted', 'Teacher granted extra play'); touch(rec);
  res.json({ ok: true, playsRemaining: playsRemaining(rec) });
});

app.post('/api/admin/extend', adminAuth, (req, res) => {
  const min = num(req.body.minutes, 5, -60, 120); let n = 0;
  for (const rec of targets(req.body, liveOnly)) { rec.deadline += min * 60000; addEvent(rec, 'time_extended', `${min} min`); n++; }
  res.json({ ok: true, updated: n });
});

app.post('/api/admin/force-submit', adminAuth, (req, res) => {
  let n = 0; for (const rec of targets(req.body, liveOnly)) { submitRecord(rec, 'teacher'); n++; }
  res.json({ ok: true, submitted: n });
});

app.post('/api/admin/reset-session', adminAuth, (req, res) => {
  const adm = String(req.body.admission || '').toUpperCase(); const rec = students[adm];
  if (!rec) return fail(res, 404, 'not_found', 'No such student.');
  if (req.body.remove) {
    if (rec.status !== 'lobby') return fail(res, 409, 'started', 'Only students who have not started can be removed.');
    tokenIndex.delete(rec.token); delete students[adm]; return res.json({ ok: true, removed: true });
  }
  rec.lastSeen = 0; addEvent(rec, 'session_reset', 'Session released by teacher'); touch(rec);
  res.json({ ok: true });
});

app.post('/api/admin/grade', adminAuth, (req, res) => {
  const rec = students[String(req.body.admission || '').toUpperCase()];
  if (!rec || !rec.submission) return fail(res, 404, 'not_found', 'No submission for that student.');
  const clamp = (v, max) => (v === '' || v == null ? null : r2(num(v, 0, 0, max)));
  if ('essayMarks' in req.body) rec.manual.essayMarks = clamp(req.body.essayMarks, cfg.essayMaxMarks);
  if ('shortMarks' in req.body) rec.manual.shortMarks = clamp(req.body.shortMarks, cfg.shortCount * cfg.shortMark);
  rec.submission.scores = computeScores(rec); rec.submission.version++; touch(rec); enqueueSubmission(rec);
  res.json({ ok: true, scores: rec.submission.scores });
});

/* ------------------------- Admin: exam configuration ---------------------- */
function adminConfigView() {
  return { ...cfg, paper: { type: cfg.paper.type, version: cfg.paper.version, text: cfg.paper.text }, audio: { name: cfg.audio.name, version: cfg.audio.version, has: !!cfg.audio.file },
    keyA: undefined, keyB: undefined, keyC: undefined,
    keyStatus: { A: keySummary(cfg.keyA, cfg.mcqCount), B: keySummary(cfg.keyB, cfg.shortCount), C: keySummary(cfg.keyC, cfg.listeningCount) },
    grades: GRADES, sheetsConfigured: !!SHEETS_URL };
}
const keySummary = (k, n) => ({ count: Object.keys(k).length, total: n });

app.get('/api/admin/config', adminAuth, (req, res) => res.json(adminConfigView()));

app.post('/api/admin/config', adminAuth, (req, res) => {
  const b = req.body || {};
  if (b.examTitle != null) cfg.examTitle = cleanText(b.examTitle, 120) || cfg.examTitle;
  if (b.durationMin != null) cfg.durationMin = Math.round(num(b.durationMin, cfg.durationMin, 1, 600));
  if (b.mcqCount != null) cfg.mcqCount = Math.round(num(b.mcqCount, cfg.mcqCount, 0, 300));
  if (b.optionsPerQuestion != null) cfg.optionsPerQuestion = Number(b.optionsPerQuestion) === 5 ? 5 : 4;
  if (b.shortCount != null) cfg.shortCount = Math.round(num(b.shortCount, cfg.shortCount, 0, 50));
  if (b.listeningCount != null) cfg.listeningCount = Math.round(num(b.listeningCount, cfg.listeningCount, 0, 100));
  if (b.shortMark != null) cfg.shortMark = num(b.shortMark, cfg.shortMark, 0, 20);
  if (b.essayMaxMarks != null) cfg.essayMaxMarks = num(b.essayMaxMarks, cfg.essayMaxMarks, 0, 100);
  if (b.essayWordHint != null) cfg.essayWordHint = cleanText(b.essayWordHint, 40);
  if (b.maxPlays != null) cfg.maxPlays = Math.round(num(b.maxPlays, cfg.maxPlays, 1, 5));
  if (b.showResults != null) cfg.showResults = !!b.showResults;
  if (b.strictShortcuts != null) cfg.strictShortcuts = !!b.strictShortcuts;
  if (b.requireFullscreen != null) cfg.requireFullscreen = !!b.requireFullscreen;
  if (b.marking) {
    cfg.marking.mode = b.marking.mode === 'negative' ? 'negative' : 'standard';
    cfg.marking.correct = num(b.marking.correct, cfg.marking.correct, 0, 20);
    cfg.marking.negative = num(b.marking.negative, cfg.marking.negative, 0, 20);
  }
  // re-parse stored key text against the (possibly changed) counts
  cfg.keyA = parseMcqKey(cfg.keyAText, cfg.mcqCount, cfg.optionsPerQuestion).key;
  cfg.keyC = parseMcqKey(cfg.keyCText, cfg.listeningCount, cfg.optionsPerQuestion).key;
  cfg.keyB = parseShortKey(cfg.keyBText, cfg.shortCount).key;
  configDirty = true; regradeAll(); flushJournal();
  res.json(adminConfigView());
});

app.post('/api/admin/key', adminAuth, (req, res) => {
  const { section, text, dry } = req.body || {};
  if (!['A', 'B', 'C'].includes(section)) return fail(res, 400, 'bad_section', 'Section must be A, B or C.');
  const t = cleanText(text, 60000);
  const r = section === 'A' ? parseMcqKey(t, cfg.mcqCount, cfg.optionsPerQuestion) : section === 'C' ? parseMcqKey(t, cfg.listeningCount, cfg.optionsPerQuestion) : parseShortKey(t, cfg.shortCount);
  const summary = { count: r.count, total: section === 'A' ? cfg.mcqCount : section === 'C' ? cfg.listeningCount : cfg.shortCount, missing: r.missing.slice(0, 60), invalid: r.invalid.slice(0, 30), outOfRange: r.outOfRange.slice(0, 30) };
  if (!dry) {
    cfg['key' + section] = r.key; cfg['key' + section + 'Text'] = t; configDirty = true; regradeAll(); flushJournal();
  }
  res.json({ ok: true, saved: !dry, ...summary });
});

app.post('/api/admin/paper/text', adminAuth, (req, res) => {
  const text = cleanText(req.body.text, 200000);
  if (!text.trim()) return fail(res, 400, 'empty', 'Paper text is empty.');
  removeFile(cfg.paper.file); cfg.paper = { type: 'text', text, file: null, version: now() }; configDirty = true; flushJournal();
  res.json({ ok: true, version: cfg.paper.version });
});

function removeFile(f) { if (f) fs.unlink(path.join(UPLOAD_DIR, f), () => {}); }

app.put('/api/admin/paper/pdf', adminAuth, express.raw({ type: () => true, limit: '30mb' }), (req, res) => {
  const buf = req.body;
  if (!Buffer.isBuffer(buf) || buf.length < 100 || buf.slice(0, 5).toString() !== '%PDF-') return fail(res, 400, 'not_pdf', 'That file is not a valid PDF.');
  const v = now(), file = `paper-${v}.pdf`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), buf); removeFile(cfg.paper.file);
  cfg.paper = { type: 'pdf', text: '', file, version: v }; configDirty = true; flushJournal();
  res.json({ ok: true, version: v, bytes: buf.length });
});

const AUDIO_EXT = new Set(['mp3', 'm4a', 'wav', 'ogg', 'aac', 'webm', 'mp4']);
app.put('/api/admin/audio', adminAuth, express.raw({ type: () => true, limit: '40mb' }), (req, res) => {
  const orig = String(req.headers['x-filename'] || 'audio.mp3').replace(/[^\w.\- ]/g, '_').slice(0, 80);
  const ext = (orig.split('.').pop() || '').toLowerCase();
  if (!AUDIO_EXT.has(ext)) return fail(res, 400, 'bad_ext', 'Use mp3, m4a, wav, ogg, aac or webm.');
  if (!Buffer.isBuffer(req.body) || req.body.length < 1000) return fail(res, 400, 'empty', 'Audio file is empty.');
  const v = now(), file = `audio-${v}.${ext}`;
  fs.writeFileSync(path.join(UPLOAD_DIR, file), req.body); removeFile(cfg.audio.file);
  cfg.audio = { file, name: orig, version: v }; configDirty = true; flushJournal();
  res.json({ ok: true, name: orig, bytes: req.body.length });
});

app.post('/api/admin/exam/status', adminAuth, (req, res) => {
  const s = req.body.status;
  if (!['lobby', 'live', 'ended'].includes(s)) return fail(res, 400, 'bad_status', 'Invalid status.');
  cfg.examStatus = s; configDirty = true; if (s === 'ended') sweep(); flushJournal();
  res.json({ ok: true, status: s });
});

app.post('/api/admin/new-exam', adminAuth, (req, res) => {
  if (req.body.confirm !== 'RESET') return fail(res, 400, 'confirm', 'Type RESET to confirm.');
  writeSnapshot();
  try { fs.copyFileSync(SNAP_FILE, path.join(ARCHIVE_DIR, `attempts-${new Date().toISOString().replace(/[:.]/g, '-')}.json`)); } catch (e) { return fail(res, 500, 'archive_failed', e.message); }
  students = {}; tokenIndex.clear(); outbox.clear(); playTokens.clear(); recentFeed.length = 0; cfg.examStatus = 'lobby'; configDirty = true;
  writeSnapshot();
  res.json({ ok: true, archived: true });
});

/* ------------------------------ Admin: export ----------------------------- */
const csvCell = (v) => { let s = String(v == null ? '' : v); if (/^[=+\-@]/.test(s)) s = "'" + s; return '"' + s.replace(/"/g, '""') + '"'; };
app.get('/api/admin/export.csv', adminAuth, (req, res) => {
  const rows = [HEADERS_SUB.map(csvCell).join(',')];
  for (const rec of Object.values(students)) if (rec.submission) { const r = submissionRow(rec); rows.push(HEADERS_SUB.map((h) => csvCell(r[h])).join(',')); }
  res.set({ 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="results.csv"' });
  res.send('\ufeff' + rows.join('\r\n'));
});

function sheetsStatus() {
  return { configured: !!SHEETS_URL, queued: outbox.size, inflight: sh.inflight, sent: sh.sent, fails: sh.fails, batch: sh.batch, lastOk: sh.lastOk, lastErr: sh.lastErr, lastErrAt: sh.lastErrAt, nextInMs: Math.max(0, sh.nextAt - now()) };
}
app.get('/api/admin/sheets', adminAuth, (req, res) => res.json(sheetsStatus()));
app.post('/api/admin/sheets/resync', adminAuth, (req, res) => {
  if (!SHEETS_URL) return fail(res, 400, 'not_configured', 'SHEETS_WEBHOOK_URL is not set on the server.');
  sh.nextAt = 0; sh.fails = 0; for (const it of outbox.values()) it.nextAt = 0;
  res.json({ ok: true, queued: enqueueAllUnsynced(!!req.body.force) });
});

/* ------------------------------ Health & static --------------------------- */
let lagMs = 0, lastTick = now();
setInterval(() => { const t = now(); lagMs = Math.max(0, t - lastTick - 500); lastTick = t; }, 500).unref();
app.get('/api/health', (req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()), students: Object.keys(students).length, rssMB: Math.round(process.memoryUsage().rss / 1048576), lagMs, outbox: outbox.size });
});

app.use('/vendor/pdfjs', express.static(path.join(__dirname, 'node_modules', 'pdfjs-dist', 'build'), { maxAge: '7d' }));
app.use(express.static(PUBLIC_DIR, { maxAge: 0, etag: true, setHeaders: (res) => res.set('Cache-Control', 'no-cache') }));
app.get('/teacher', (req, res) => res.sendFile(path.join(PUBLIC_DIR, 'teacher.html')));
app.use('/api', (req, res) => fail(res, 404, 'not_found', 'Unknown endpoint.'));
app.use((err, req, res, next) => {
  if (err && err.type === 'entity.too.large') return fail(res, 413, 'too_large', 'Upload is too large.');
  if (err && err.type === 'entity.parse.failed') return fail(res, 400, 'bad_json', 'Malformed request.');
  log('unhandled', err && err.stack || err); if (!res.headersSent) fail(res, 500, 'server_error', 'Server error.');
});

/* ================================ Sweeper ================================== */
function sweep() {
  const t = now();
  for (const rec of Object.values(students)) {
    if (rec.status === 'active' || rec.status === 'frozen') {
      if (cfg.examStatus === 'ended') submitRecord(rec, 'ended');
      else if (rec.deadline && t > rec.deadline + 8000) submitRecord(rec, 'auto');   // 8s grace for the client's own final submit
    }
  }
  for (const [k, v] of playTokens) if (v.exp < t) playTokens.delete(k);
  for (const [k, v] of Object.entries(adminTokens)) if (v < t) delete adminTokens[k];
  for (const b of allBuckets) for (const [k, v] of b) if (t - v.ts > 300000) b.delete(k);
}

/* ================================== Boot =================================== */
loadState();
if (SHEETS_URL) { const n = enqueueAllUnsynced(false); if (n) log(`queued ${n} unsynced items for Google Sheets`); }
setInterval(flushJournal, 2000);
setInterval(writeSnapshot, 60000);
setInterval(sweep, 5000);
sheetsLoop();

const server = app.listen(PORT, () => {
  log(`Assessment portal on http://localhost:${PORT}  (teacher: /teacher)  sheets=${SHEETS_URL ? 'ON' : 'OFF'}`);
  if (!process.env.SERVER_SECRET) log('WARN: SERVER_SECRET not set - session receipts will not survive a restart.');
  if (ADMIN_PASS === 'DRDREX' && process.env.NODE_ENV === 'production') log('WARN: using default admin credentials.');
});
server.keepAliveTimeout = 65000; server.headersTimeout = 70000;

function shutdown(sig) { log(`${sig}: flushing state`); writeSnapshot(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 4000).unref(); }
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('uncaughtException', (e) => { log('uncaughtException', e && e.stack || e); try { flushJournal(); } catch (_) { /* ignore */ } });
process.on('unhandledRejection', (e) => log('unhandledRejection', e && e.stack || e));
