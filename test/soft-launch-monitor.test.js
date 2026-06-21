// test/soft-launch-monitor.test.js — pure core tests for the soft-launch monitor (24h clean-clock watchdog).
// TDD: tests written before implementation.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_WINDOW_MS,
  scanDaemonLog,
  scanErrLog,
  scanScheduleState,
  findStrandedEscalations,
  advanceClock,
  summarize,
} from '../src/soft-launch-monitor/core.js';

// Fixed timestamps used throughout — no Date.now() in tests.
const T0 = '2026-06-20T10:00:00.000Z';   // "now" reference
const T_OLD = '2026-06-20T09:00:00.000Z'; // 1h before T0 (qualifies as >= sinceIso in most tests)
const T_BEFORE = '2026-06-20T08:00:00.000Z'; // before a sinceIso of T_OLD

// ---------------------------------------------------------------------------
// scanDaemonLog
// ---------------------------------------------------------------------------

test('scanDaemonLog — detects research-escalation error: line when ts >= sinceIso', () => {
  const log = `${T_OLD} research-escalation error: boom\n`;
  const issues = scanDaemonLog(log, { sinceIso: T_BEFORE });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'error');
  assert.equal(issues[0].signal, 'daemon-log');
  assert.match(issues[0].line, /research-escalation error: boom/);
  assert.equal(issues[0].ts, T_OLD);
});

test('scanDaemonLog — detects research-escalation: line with error in text when ts >= sinceIso', () => {
  const log = `${T_OLD} research-escalation: something error occurred\n`;
  const issues = scanDaemonLog(log, { sinceIso: T_BEFORE });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'error');
  assert.equal(issues[0].signal, 'daemon-log');
});

test('scanDaemonLog — detects advisory #N (analyst) failed line when ts >= sinceIso', () => {
  const log = `${T_OLD} advisory #5 (analyst) failed: some reason\n`;
  const issues = scanDaemonLog(log, { sinceIso: T_BEFORE });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'error');
  assert.equal(issues[0].signal, 'daemon-log');
  assert.match(issues[0].line, /advisory #5 \(analyst\) failed/);
});

test('scanDaemonLog — detects advisory #N (triager) failed line when ts >= sinceIso', () => {
  const log = `${T_OLD} advisory #12 (triager) failed: timeout\n`;
  const issues = scanDaemonLog(log, { sinceIso: T_BEFORE });
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'error');
  assert.equal(issues[0].signal, 'daemon-log');
  assert.match(issues[0].line, /advisory #12 \(triager\) failed/);
});

test('scanDaemonLog — IGNORES matching lines when ts < sinceIso', () => {
  const log = `${T_BEFORE} research-escalation error: old error\n${T_BEFORE} advisory #3 (analyst) failed: too old\n`;
  const issues = scanDaemonLog(log, { sinceIso: T_OLD });
  assert.equal(issues.length, 0);
});

test('scanDaemonLog — IGNORES PASS foo.test.js lines (no ISO prefix)', () => {
  const log = `PASS foo.test.js\nFAIL bar.test.js\n✖ failing tests:\n`;
  const issues = scanDaemonLog(log, { sinceIso: T_BEFORE });
  assert.equal(issues.length, 0);
});

test('scanDaemonLog — IGNORES tester output lines without ISO prefix', () => {
  const log = `  ▶ some suite\n  ✔ passes (1ms)\n  ✖ failing tests:\n    test foo at file.js:10\n`;
  const issues = scanDaemonLog(log, { sinceIso: T_BEFORE });
  assert.equal(issues.length, 0);
});

test('scanDaemonLog — IGNORES normal operational line: → triager (ask) #186', () => {
  const log = `${T_OLD} → triager (ask) #186 assigned\n`;
  const issues = scanDaemonLog(log, { sinceIso: T_BEFORE });
  assert.equal(issues.length, 0);
});

test('scanDaemonLog — respects custom feature arg', () => {
  const log = `${T_OLD} my-feature error: something\n${T_OLD} research-escalation error: should not match\n`;
  const issues = scanDaemonLog(log, { sinceIso: T_BEFORE, feature: 'my-feature' });
  assert.equal(issues.length, 1);
  assert.match(issues[0].line, /my-feature error/);
});

test('scanDaemonLog — returns empty array for empty log', () => {
  assert.deepEqual(scanDaemonLog('', { sinceIso: T_BEFORE }), []);
});

// ---------------------------------------------------------------------------
// scanErrLog
// ---------------------------------------------------------------------------

test('scanErrLog — growth triggers 1 error issue', () => {
  const issues = scanErrLog(100, 200);
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'error');
  assert.equal(issues[0].signal, 'daemon-err');
  assert.match(issues[0].detail, /100->200/);
});

test('scanErrLog — same size returns 0 issues', () => {
  assert.deepEqual(scanErrLog(200, 200), []);
});

test('scanErrLog — shrink returns 0 issues', () => {
  assert.deepEqual(scanErrLog(300, 200), []);
});

test('scanErrLog — 0 prev and 0 curr returns 0 issues', () => {
  assert.deepEqual(scanErrLog(0, 0), []);
});

// ---------------------------------------------------------------------------
// scanScheduleState
// ---------------------------------------------------------------------------

test('scanScheduleState — lastStatus fail triggers issue', () => {
  const state = { 'research-escalation': { lastStatus: 'fail', consecutiveFailures: 1 } };
  const issues = scanScheduleState(state, 'research-escalation');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'error');
  assert.equal(issues[0].signal, 'schedule-state');
  assert.match(issues[0].detail, /lastStatus=fail/);
});

test('scanScheduleState — consecutiveFailures > 0 triggers issue', () => {
  const state = { 'research-escalation': { lastStatus: 'ok', consecutiveFailures: 2 } };
  const issues = scanScheduleState(state, 'research-escalation');
  assert.equal(issues.length, 1);
  assert.equal(issues[0].severity, 'error');
  assert.equal(issues[0].signal, 'schedule-state');
  assert.match(issues[0].detail, /consecutiveFailures=2/);
});

test('scanScheduleState — never-run entry { nextRunAt, running:false } → 0 issues', () => {
  const state = { 'research-escalation': { nextRunAt: '2026-06-21T00:00:00.000Z', running: false } };
  const issues = scanScheduleState(state, 'research-escalation');
  assert.equal(issues.length, 0);
});

test('scanScheduleState — lastStatus ok, no failures → 0 issues', () => {
  const state = { 'research-escalation': { lastStatus: 'ok', consecutiveFailures: 0 } };
  const issues = scanScheduleState(state, 'research-escalation');
  assert.equal(issues.length, 0);
});

test('scanScheduleState — missing jobId entry → 0 issues', () => {
  assert.deepEqual(scanScheduleState({}, 'research-escalation'), []);
  assert.deepEqual(scanScheduleState(null, 'research-escalation'), []);
  assert.deepEqual(scanScheduleState(undefined, 'research-escalation'), []);
});

// ---------------------------------------------------------------------------
// findStrandedEscalations
// ---------------------------------------------------------------------------

const NOW_MS = Date.parse(T0); // 2026-06-20T10:00:00.000Z

test('findStrandedEscalations — old + undiagnosed is flagged', () => {
  const createdAtMs = NOW_MS - 7 * 3600_000; // 7h ago
  const issues = [{ number: 42, createdAtMs, hasDiagnosis: false }];
  const flags = findStrandedEscalations(issues, NOW_MS, { minAgeMs: 6 * 3600_000 });
  assert.equal(flags.length, 1);
  assert.equal(flags[0].severity, 'warn');
  assert.equal(flags[0].signal, 'stranded');
  assert.equal(flags[0].number, 42);
  assert.match(flags[0].detail, /needs-human #42/);
  assert.match(flags[0].detail, /undiagnosed for >6h/);
});

test('findStrandedEscalations — young + undiagnosed is NOT flagged', () => {
  const createdAtMs = NOW_MS - 2 * 3600_000; // 2h ago
  const issues = [{ number: 7, createdAtMs, hasDiagnosis: false }];
  const flags = findStrandedEscalations(issues, NOW_MS, { minAgeMs: 6 * 3600_000 });
  assert.equal(flags.length, 0);
});

test('findStrandedEscalations — old + diagnosed is NOT flagged', () => {
  const createdAtMs = NOW_MS - 8 * 3600_000;
  const issues = [{ number: 99, createdAtMs, hasDiagnosis: true }];
  const flags = findStrandedEscalations(issues, NOW_MS, { minAgeMs: 6 * 3600_000 });
  assert.equal(flags.length, 0);
});

test('findStrandedEscalations — empty list → []', () => {
  assert.deepEqual(findStrandedEscalations([], NOW_MS), []);
});

test('findStrandedEscalations — uses default minAgeMs of 6h', () => {
  const just_over = NOW_MS - (6 * 3600_000 + 1);
  const flags = findStrandedEscalations([{ number: 1, createdAtMs: just_over, hasDiagnosis: false }], NOW_MS);
  assert.equal(flags.length, 1);
});

// ---------------------------------------------------------------------------
// advanceClock
// ---------------------------------------------------------------------------

const ISO_START = '2026-06-20T10:00:00.000Z';
const ISO_LATER = '2026-06-20T16:00:00.000Z';  // 6h after start
const ISO_FULL  = '2026-06-21T10:00:00.000Z';  // 24h after start

test('advanceClock — first call (no prev) sets liveSince=cleanSince=nowIso, status clean', () => {
  const state = advanceClock(null, [], ISO_START);
  assert.equal(state.liveSince, ISO_START);
  assert.equal(state.cleanSince, ISO_START);
  assert.equal(state.status, 'clean');
  assert.equal(state.lastCheck, ISO_START);
  assert.deepEqual(state.lastIssues, []);
  assert.equal(state.feature, 'research-escalation');
});

test('advanceClock — with issues → status issues, cleanSince reset to nowIso', () => {
  const prev = { feature: 'research-escalation', liveSince: ISO_START, cleanSince: ISO_START, status: 'clean', lastCheck: ISO_START, lastIssues: [], cleanForMs: 0, windowMs: DEFAULT_WINDOW_MS };
  const foundIssues = [{ severity: 'error', signal: 'daemon-log', ts: ISO_START, line: 'test error' }];
  const state = advanceClock(prev, foundIssues, ISO_LATER);
  assert.equal(state.status, 'issues');
  assert.equal(state.cleanSince, ISO_LATER);  // reset to now
  assert.deepEqual(state.lastIssues, foundIssues);
  assert.equal(state.lastCheck, ISO_LATER);
});

test('advanceClock — clean and (now - cleanSince) < windowMs → status clean', () => {
  const prev = { feature: 'research-escalation', liveSince: ISO_START, cleanSince: ISO_START, status: 'clean', lastCheck: ISO_START, lastIssues: [], cleanForMs: 0, windowMs: DEFAULT_WINDOW_MS };
  const state = advanceClock(prev, [], ISO_LATER, DEFAULT_WINDOW_MS);
  assert.equal(state.status, 'clean');
  assert.equal(state.cleanSince, ISO_START);  // NOT reset since no issues
});

test('advanceClock — clean and (now - cleanSince) >= windowMs → status validated', () => {
  const prev = { feature: 'research-escalation', liveSince: ISO_START, cleanSince: ISO_START, status: 'clean', lastCheck: ISO_LATER, lastIssues: [], cleanForMs: 0, windowMs: DEFAULT_WINDOW_MS };
  const state = advanceClock(prev, [], ISO_FULL, DEFAULT_WINDOW_MS);
  assert.equal(state.status, 'validated');
  assert.equal(state.cleanSince, ISO_START);
});

test('advanceClock — cleanForMs is calculated correctly', () => {
  const prev = { feature: 'research-escalation', liveSince: ISO_START, cleanSince: ISO_START, status: 'clean', lastCheck: ISO_START, lastIssues: [], cleanForMs: 0, windowMs: DEFAULT_WINDOW_MS };
  const state = advanceClock(prev, [], ISO_LATER, DEFAULT_WINDOW_MS);
  const expectedMs = Date.parse(ISO_LATER) - Date.parse(ISO_START);
  assert.equal(state.cleanForMs, expectedMs);
});

test('advanceClock — windowMs is stored in state', () => {
  const state = advanceClock(null, [], ISO_START, DEFAULT_WINDOW_MS);
  assert.equal(state.windowMs, DEFAULT_WINDOW_MS);
});

// ---------------------------------------------------------------------------
// summarize
// ---------------------------------------------------------------------------

test('summarize — clean state', () => {
  const state = {
    status: 'clean',
    cleanForMs: 4.2 * 3600_000,
    windowMs: DEFAULT_WINDOW_MS,
    lastIssues: [],
  };
  const s = summarize(state);
  assert.match(s, /STATUS: clean/);
  assert.match(s, /0 issues/);
  assert.match(s, /4\.2h/);
  assert.match(s, /24\.0h/);
});

test('summarize — issues state', () => {
  const state = {
    status: 'issues',
    cleanForMs: 0,
    windowMs: DEFAULT_WINDOW_MS,
    lastIssues: [
      { signal: 'daemon-log' },
      { signal: 'schedule-state' },
    ],
  };
  const s = summarize(state);
  assert.match(s, /STATUS: issues/);
  assert.match(s, /clock reset/);
  assert.match(s, /2 issue\(s\)/);
  assert.match(s, /daemon-log/);
  assert.match(s, /schedule-state/);
});

test('summarize — validated state', () => {
  const state = {
    status: 'validated',
    cleanForMs: DEFAULT_WINDOW_MS,
    windowMs: DEFAULT_WINDOW_MS,
    lastIssues: [],
  };
  const s = summarize(state);
  assert.match(s, /STATUS: validated/);
  assert.match(s, /24\.0h clean/);
  assert.match(s, /feature validated/);
});

test('DEFAULT_WINDOW_MS is 24 hours in ms', () => {
  assert.equal(DEFAULT_WINDOW_MS, 24 * 60 * 60 * 1000);
});
