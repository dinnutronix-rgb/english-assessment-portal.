# Maintenance & Glitch-Prevention Guide

How the portal behaves under stress, what to watch, and exactly what to do when something goes wrong.

---

## 1. Capacity maths (why 200+ students don't crash it)

| Item | Number |
|---|---|
| Student sync (answers + heartbeat + teacher commands) | 1 request / ~5 s each (± jitter) → **≈ 40 req/s** at 200 students |
| Typical request size | 0.3 – 3 KB (answers are sent only when changed) |
| Server work per request | O(1) in-memory lookup; **no disk and no Google call on the student path** |
| Teacher board | 1 request / 2 s per open console (gzip ≈ 6–10 KB) |
| Google Sheets traffic | **One** webhook call at a time, ≤ 25 rows per call, ≥ 2.5 s apart (≈ 10 rows/s max) – 200 submissions drain in ~25–40 s |
| Memory | ~60–120 MB for 200 students (the load test reports it) |

`npm run loadtest` reproduces this: 200 simulated students, a proctor unlocking in parallel, and a mock Google endpoint that randomly returns **HTTP 429**. Run it before the exam day on the same machine class you deploy to.

---

## 2. How each failure mode is handled

| Failure | What the student sees | What happens | Your action |
|---|---|---|---|
| **Student's Wi-Fi drops** | "Offline – saved locally" pill; they can keep answering | Every click is written to `localStorage`; sync retries with exponential backoff (2 s → 20 s); everything uploads when the link returns | None. Dashboard shows ● *offline Ns* |
| **Student closes/refreshes the tab** | "Welcome back – Resume" | Answers restored from local copy ∪ server copy (higher revision wins); timer continues from the server clock; **listening plays stay consumed** | None |
| **Student's laptop dies** | – | Session goes stale after 45 s → they can log in on another device with the same name + admission + grade and continue | Or use **Details → Release session** to free them instantly |
| **Student opens a 2nd tab** | Older tab: "Session moved" | The newest page wins; the old one is locked out | None |
| **Someone else tries the same Admission No.** | "Already active on another device" | Rejected while the first session is alive; name/grade must also match | – |
| **Violation while offline** | Freezes instantly (local) | The violation is queued in `localStorage` and delivered later; they stay frozen until you unlock | Unlock after verifying |
| **Server restarts / host redeploys mid-exam** | A few seconds of "Offline" | RAM state is rebuilt from `snapshot.json` + `journal.ndjson`. If the host wiped the disk, students re-authenticate silently using their local identity + **signed receipt** → same deadline, same listening plays; local answers re-upload | Wait ~1 minute; check **System** tab |
| **Google Sheets returns 429 / 5xx / quota page / timeout** | Nothing – students never touch Google | Batch is retried with exponential backoff (+ jitter, honours `Retry-After`) and a **smaller batch**; all items stay queued; per-item failures retry after 20 s × attempts | Watch **System → Google Sheets sync**. Use **Export CSV** as the guaranteed backup |
| **Apps Script URL wrong / deployment not updated** | – | Queue grows, last error shown on System tab | Fix `SHEETS_WEBHOOK_URL`, then **Retry now** |
| **Teacher console tab closed** | – | Exam continues untouched; the server is the source of truth | Re-open `/teacher`, log in (tokens last 12 h and survive restarts) |
| **Time runs out** | Auto-submit | Client auto-submits at 0:00; server sweeps and force-submits 8 s later if the client is gone | – |
| **Audio fails to play** | "Audio failed – tell your teacher" | The play counts (strict rule) | **Details → 🎧 +1 play** |

### Why the server can't be overloaded by students
* **Per-session token-bucket rate limit** (burst 12, 3 req/s) – a broken or hostile client can't hammer one endpoint. IP limits are intentionally loose because a whole school shares one public IP.
* **Jittered sync timers** – 200 clients never fire in lock-step; failures back off exponentially.
* **Payload caps** – 300 KB JSON, 300 chars per blank, 30 000 chars per essay, 300 events per student, 30 MB PDF, 40 MB audio.
* **Bounded memory** – event logs capped, warnings capped, play tokens / admin tokens / limiter buckets are swept every 5 s.

---

## 3. Memory-leak & stability checklist

Built in:
- `sweep()` every 5 s: expires play tokens and admin tokens, prunes idle rate-limit buckets, auto-submits expired students.
- `uncaughtException` / `unhandledRejection` are logged and **do not kill** the process; state is flushed.
- `SIGTERM` (host redeploy) writes a final snapshot before exit.
- Journal never grows unbounded: dirty records are appended every 2 s and a **full snapshot + journal truncation every 60 s**.

To monitor during an exam – open **System → Server health** (or `/api/health`):

| Metric | Healthy | Investigate if |
|---|---|---|
| `rssMB` | < 200 and flat | climbs steadily for > 10 min |
| `lagMs` (event-loop lag) | < 50 | > 300 sustained → host is CPU-starved; move to a bigger/other instance |
| `outbox` | drains to 0 after submissions | keeps growing → Sheets problem (see §2) |
| `students` | matches your class | – |

If memory ever creeps on a long-lived free host, a **restart between exams** is safe – state reloads from disk. **Never restart mid-exam unless necessary** (students recover automatically, but it's disruptive).

---

## 4. Pre-exam checklist (print this)

- [ ] `ADMIN_PASS` and `SERVER_SECRET` set (not the defaults)
- [ ] Teacher console login works from the invigilator's laptop
- [ ] Paper, audio and **all keys** saved; key preview says *N/N*; marking scheme confirmed
- [ ] `SHEETS_WEBHOOK_URL`/`SHEETS_SECRET` set; **System** tab says *Configured*; a rehearsal submission appears in the Sheet
- [ ] Auto-deploy **off**; nobody pushes code during the exam
- [ ] UptimeRobot (or similar) pinging `/api/health` every 5 min; site opened 10 min early to wake the free instance
- [ ] `npm run loadtest` passed on the target environment (or at least a 20-device rehearsal)
- [ ] Students use Chrome/Edge, fullscreen, notifications off, charger plugged in, headphones for Section C
- [ ] Wired Ethernet or strong Wi-Fi for the lab; a mobile hotspot ready as backup for the teacher
- [ ] Previous batch exported (**Export CSV**) and cleared (**Archive & clear students**)

---

## 5. During the exam – proctor playbook

1. Keep **Live Proctor** in front; sound alerts on. Frozen rows are pinned to the top and pulse red.
2. A student freezes → look at them / check the **Last incident** column → **🔓 Unlock** (or **⚠ Warn** first: *Warning 1: Return to exam tab immediately*).
3. Repeat offenders: the **Violations** counter turns red at 2+. The full timeline is in **Details**.
4. Mass false alarm (e.g. a school-wide pop-up): **🔓 Unlock all frozen**, then **📣 Broadcast warning**.
5. Tech faults: **+5 min**, **+1 play**, **Release session**, or **Force submit**.
6. Don't close the console tab before the last student submits; at the end use **End & auto-submit all**.

---

## 6. After the exam

1. **Results → ⬇ Export CSV** (keep this as the primary backup).
2. **System** tab → *Google Sheets sync* shows **Queue: 0**. If not, click **Retry now**; if a row is missing use **Re-send ALL submissions** (safe – upserts by Submission ID).
3. Grade essays: enter *Essay marks* in **Results** – totals recalculate and the Sheet row updates.
4. **Setup → Archive & clear students** (type `RESET`). A timestamped JSON is stored in `data/archive/`.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Teacher login says *Admin session expired* | Server restarted before token was persisted, or 12 h passed | Log in again |
| *"Too many requests"* on login (admin) | 8 failed attempts / 5 min lockout | Wait 5 minutes |
| Student stuck on *"Already active"* | Old tab still open / crashed within 45 s | Wait 45 s or **Release session** |
| Student: *"Registered with a different name/grade"* | Typo at first login | Teacher **Details → Remove** (only possible before they start) or ask them to use the exact original details |
| PDF paper blank | Corrupt PDF or blocked worker script | Re-export the PDF; or paste text paper. The viewer falls back to a CDN copy of pdf.js |
| Sheet empty, queue growing | Wrong URL, Script not redeployed as *Anyone*, secret mismatch | Open the URL in a browser (should say `ok:true`); compare `SECRET` / `SHEETS_SECRET`; redeploy a **new version** |
| Everyone freezes at once | OS notification/pop-up stole focus, or screen-saver | Unlock all + broadcast; enable Focus Assist / Do Not Disturb on lab PCs |
| Slow first page after idle (free host) | Cold start | Keep uptime pinger active; open site before the exam |
| Student's timer differs from others | Each student's timer starts at *their* Start press | Expected. Use **+5 min** to compensate faults |

---

## 8. Honest limitations (so you can plan around them)

* A web page **cannot** block OS-level Alt+Tab, the Windows key, or a second phone/device. The portal **detects** focus loss, tab switches, minimising and blur on dual-monitor setups and freezes immediately, but it cannot see a phone on the desk. Combine with a physically supervised lab.
* Browsers may deliver `blur` for legitimate reasons (OS pop-ups, password-manager prompts, extensions). That's why the teacher unlocks manually and there is **Unlock all**.
* Screenshots by external tools (phone camera, OS snipping tools that don't send a key event) can't be detected; the PrintScreen key, clipboard copy and printing are blocked/flagged.
* The offline-first cache protects **answers**; the **page itself** needs the network the first time it loads (no service-worker shell). Students who lose Wi-Fi mid-exam keep working; students who refresh while offline cannot reload the page until the connection returns.
* Free hosts can sleep, restart or throttle. Signed receipts + local copies + the Sheets/CSV backups cover data, but a paid always-on instance (or a school PC + Cloudflare Tunnel) is the safest choice for high-stakes exams.
* Session security is "passwordless by design": the Admission Number + exact name + grade act as the identity. If you need stronger identity, hand out per-student PINs (add a PIN field to the `/api/student/login` route).
* The teacher password is a shared credential. Change it via `ADMIN_PASS`, don't share `/teacher`, and sign out when finished.

---

## 9. Files on disk (`DATA_DIR`, default `./data`)

| File | Content |
|---|---|
| `config.json` | Exam settings, keys, paper/audio metadata |
| `snapshot.json` | Full student state + admin tokens (rewritten every 60 s) |
| `journal.ndjson` | Append-only changes since the last snapshot (replayed on boot) |
| `uploads/` | Paper PDF and listening audio |
| `archive/` | Timestamped dumps created by *Archive & clear students* |

Back up the folder by copying it while the server is stopped (or just rely on CSV + Sheets exports).
