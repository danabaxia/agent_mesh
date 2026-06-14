# Scheduler MCP Server Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an `agent-mesh serve-scheduler <folder>` MCP server that lets a client create, check, and manage namespaced Windows scheduled tasks safely.

**Architecture:** Same pure-core / thin-impure-shell split as the rest of the repo. Pure modules (name sanitization, schedule normalization, XML generation, run.cmd generation, marker) are unit-tested directly; two impure modules (`schtasks.js`, `query.js`) spawn processes via the existing `spawnFile` helper; an `ops.js` orchestrator wires them; `mcp-scheduler.js` is the stdio JSON-RPC transport, cloned from `src/mcp.js`.

**Tech Stack:** Node ≥ 20, ESM, zero dependencies, `node --test`. Mutations via `schtasks.exe` + generated Task Scheduler XML; status reads via read-only PowerShell `Get-ScheduledTaskInfo | ConvertTo-Json`.

**Spec:** [docs/superpowers/specs/2026-06-08-scheduler-mcp-design.md](../specs/2026-06-08-scheduler-mcp-design.md)

**Conventions for every task below:**
- Run the full suite with `node --test` from the repo root (`c:\AI\agents_mesh`).
- Run a single file with `node --test test/<file>.test.js`.
- Every commit message ends with the trailer line shown in the commit steps:
  `Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>`
- `git add` only the exact paths listed — the working tree has unrelated dirty
  files (dashboard) that must NOT be swept into these commits.
- We are on branch `v0.2-development`; commit there (do not branch, do not touch `main`).

**File structure created by this plan** (all under the repo root):

```
src/scheduler/
  result.js          ok()/err() result shapes
  task-name.js       sanitizeTaskName / slugForRoot / taskPath / taskDir
  schedule-spec.js   normalizeSchedule + DAYS
  run-cmd.js         buildRunCmd / buildCommandLine
  task-xml.js        buildTaskXml
  marker.js          MARKER / buildMarker / parseMarker / isOwned
  schtasks.js        schtasksCreate/Run/Change/Delete   (impure)
  query.js           queryTaskInfo                       (impure)
  scaffold.js        scaffoldTask/readMarkerFile/removeTaskDir/tailLog/listMarkers (impure)
  ops.js             createTask/listTasks/getTask/runTask/enableTask/disableTask/deleteTask/getTaskLogs
  mcp-scheduler.js   createSchedulerMcpServer / handleSchedulerMessage
test/
  scheduler-helpers.js          createFakeBin / createTempRoot (test util)
  scheduler-task-name.test.js
  scheduler-schedule-spec.test.js
  scheduler-run-cmd.test.js
  scheduler-task-xml.test.js
  scheduler-marker.test.js
  scheduler-schtasks.test.js
  scheduler-query.test.js
  scheduler-scaffold.test.js
  scheduler-ops.test.js
  scheduler-tools.test.js
  scheduler-mcp.test.js
  scheduler-cli.test.js
  scheduler-e2e.test.js         (opt-in: AGENT_MESH_SCHEDULER_E2E=1, win32 only)
```
Modified: `src/cli.js` (add `serve-scheduler`), `README.md` (docs).

---

## Task 1: `task-name.js` — name sanitization & namespace helpers

**Files:**
- Create: `src/scheduler/task-name.js`
- Test: `test/scheduler-task-name.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/scheduler-task-name.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { sanitizeTaskName, slugForRoot, taskPath, taskDir } from '../src/scheduler/task-name.js';

test('sanitizeTaskName accepts a normal name', () => {
  assert.deepEqual(sanitizeTaskName('nightly-report'), { ok: true, value: 'nightly-report' });
});

test('sanitizeTaskName rejects path separators and traversal', () => {
  assert.equal(sanitizeTaskName('../evil').ok, false);
  assert.equal(sanitizeTaskName('a/b').ok, false);
  assert.equal(sanitizeTaskName('a\\b').ok, false);
  assert.equal(sanitizeTaskName('..').ok, false);
  assert.equal(sanitizeTaskName('.').ok, false);
});

test('sanitizeTaskName rejects empty, overlong, and bad charset', () => {
  assert.equal(sanitizeTaskName('').ok, false);
  assert.equal(sanitizeTaskName('x'.repeat(101)).ok, false);
  assert.equal(sanitizeTaskName('has space').ok, false);
  assert.equal(sanitizeTaskName('emoji😀').ok, false);
});

test('sanitizeTaskName rejects Windows reserved device names (any case, with extension)', () => {
  assert.equal(sanitizeTaskName('CON').ok, false);
  assert.equal(sanitizeTaskName('nul').ok, false);
  assert.equal(sanitizeTaskName('COM1').ok, false);
  assert.equal(sanitizeTaskName('LPT9.txt').ok, false);
});

test('slugForRoot is deterministic, filesystem-safe, and root-specific', () => {
  const a = slugForRoot('C:\\proj\\alpha');
  const b = slugForRoot('C:\\proj\\beta');
  assert.notEqual(a, b);
  assert.equal(a, slugForRoot('C:\\proj\\alpha'));
  assert.match(a, /^alpha-[0-9a-f]{6}$/);
});

test('taskPath joins namespace, slug, and name with backslashes (no double slash)', () => {
  assert.equal(taskPath('\\AgentMesh', 'alpha-abc123', 'nightly'), '\\AgentMesh\\alpha-abc123\\nightly');
  assert.equal(taskPath('\\AgentMesh\\', 'alpha-abc123', 'nightly'), '\\AgentMesh\\alpha-abc123\\nightly');
});

test('taskDir places tasks under <root>/schedule/<name>', () => {
  assert.equal(taskDir('/r', 'nightly'), join('/r', 'schedule', 'nightly'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/scheduler-task-name.test.js`
Expected: FAIL — `Cannot find module '../src/scheduler/task-name.js'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/scheduler/task-name.js`:

```js
import { createHash } from 'node:crypto';
import { join, basename } from 'node:path';

const NAME_RE = /^[A-Za-z0-9._-]+$/;
const MAX_NAME = 100;
const RESERVED = new Set([
  'CON', 'PRN', 'AUX', 'NUL',
  'COM1', 'COM2', 'COM3', 'COM4', 'COM5', 'COM6', 'COM7', 'COM8', 'COM9',
  'LPT1', 'LPT2', 'LPT3', 'LPT4', 'LPT5', 'LPT6', 'LPT7', 'LPT8', 'LPT9'
]);

export function sanitizeTaskName(name) {
  if (typeof name !== 'string' || name.length === 0) {
    return { ok: false, message: 'name must be a non-empty string.' };
  }
  if (name.length > MAX_NAME) {
    return { ok: false, message: `name must be at most ${MAX_NAME} characters.` };
  }
  if (name === '.' || name === '..') {
    return { ok: false, message: 'name must not be "." or "..".' };
  }
  if (!NAME_RE.test(name)) {
    return { ok: false, message: 'name may contain only letters, digits, ".", "_" and "-".' };
  }
  const stem = name.split('.')[0].toUpperCase();
  if (RESERVED.has(stem)) {
    return { ok: false, message: `name "${name}" is a reserved Windows device name.` };
  }
  return { ok: true, value: name };
}

export function slugForRoot(root) {
  const hash = createHash('sha256').update(root).digest('hex').slice(0, 6);
  const base = basename(root).replace(/[^A-Za-z0-9._-]/g, '_') || 'root';
  return `${base}-${hash}`;
}

export function taskPath(ns, slug, name) {
  const root = ns.endsWith('\\') ? ns.slice(0, -1) : ns;
  return `${root}\\${slug}\\${name}`;
}

export function taskDir(root, name) {
  return join(root, 'schedule', name);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/scheduler-task-name.test.js`
Expected: PASS (all 7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/task-name.js test/scheduler-task-name.test.js
git commit -m "feat(scheduler): task-name sanitization + namespace helpers" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: `schedule-spec.js` — schedule validation & normalization

**Files:**
- Create: `src/scheduler/schedule-spec.js`
- Test: `test/scheduler-schedule-spec.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/scheduler-schedule-spec.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSchedule } from '../src/scheduler/schedule-spec.js';

test('once requires valid date and time, defaults selfDelete=false', () => {
  const r = normalizeSchedule({ type: 'once', date: '2026-06-09', time: '14:30' });
  assert.deepEqual(r, { ok: true, value: { type: 'once', date: '2026-06-09', time: '14:30', selfDelete: false } });
});

test('once accepts self_delete boolean and maps to selfDelete', () => {
  const r = normalizeSchedule({ type: 'once', date: '2026-06-09', time: '00:00', self_delete: true });
  assert.equal(r.value.selfDelete, true);
});

test('once rejects bad date/time', () => {
  assert.equal(normalizeSchedule({ type: 'once', date: '2026-13-01', time: '14:30' }).ok, false);
  assert.equal(normalizeSchedule({ type: 'once', date: '2026-06-09', time: '24:00' }).ok, false);
  assert.equal(normalizeSchedule({ type: 'once', date: '2026-6-9', time: '14:30' }).ok, false);
});

test('daily requires time only', () => {
  assert.deepEqual(normalizeSchedule({ type: 'daily', time: '02:00' }),
    { ok: true, value: { type: 'daily', time: '02:00' } });
  assert.equal(normalizeSchedule({ type: 'daily' }).ok, false);
});

test('weekly normalizes/dedupes/orders days and validates time', () => {
  const r = normalizeSchedule({ type: 'weekly', time: '09:00', days: ['wed', 'Mon', 'mon'] });
  assert.deepEqual(r.value, { type: 'weekly', time: '09:00', days: ['Mon', 'Wed'] });
  assert.equal(normalizeSchedule({ type: 'weekly', time: '09:00', days: [] }).ok, false);
  assert.equal(normalizeSchedule({ type: 'weekly', time: '09:00', days: ['Funday'] }).ok, false);
});

test('logon needs nothing', () => {
  assert.deepEqual(normalizeSchedule({ type: 'logon' }), { ok: true, value: { type: 'logon' } });
});

test('unknown or non-object schedule is rejected', () => {
  assert.equal(normalizeSchedule({ type: 'monthly' }).ok, false);
  assert.equal(normalizeSchedule(null).ok, false);
  assert.equal(normalizeSchedule([]).ok, false);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/scheduler-schedule-spec.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/scheduler/schedule-spec.js`:

```js
const TIME_RE = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function normalizeSchedule(schedule) {
  if (!schedule || typeof schedule !== 'object' || Array.isArray(schedule)) {
    return { ok: false, message: 'schedule must be an object.' };
  }
  const { type } = schedule;

  if (type === 'once') {
    if (!DATE_RE.test(schedule.date || '')) {
      return { ok: false, message: 'once.date must be "YYYY-MM-DD".' };
    }
    if (!TIME_RE.test(schedule.time || '')) {
      return { ok: false, message: 'once.time must be "HH:mm".' };
    }
    const value = { type: 'once', date: schedule.date, time: schedule.time };
    if (schedule.self_delete !== undefined) {
      if (typeof schedule.self_delete !== 'boolean') {
        return { ok: false, message: 'once.self_delete must be a boolean.' };
      }
      value.selfDelete = schedule.self_delete;
    } else {
      value.selfDelete = false;
    }
    return { ok: true, value };
  }

  if (type === 'daily') {
    if (!TIME_RE.test(schedule.time || '')) {
      return { ok: false, message: 'daily.time must be "HH:mm".' };
    }
    return { ok: true, value: { type: 'daily', time: schedule.time } };
  }

  if (type === 'weekly') {
    if (!TIME_RE.test(schedule.time || '')) {
      return { ok: false, message: 'weekly.time must be "HH:mm".' };
    }
    if (!Array.isArray(schedule.days) || schedule.days.length === 0) {
      return { ok: false, message: 'weekly.days must be a non-empty array.' };
    }
    const norm = [];
    for (const d of schedule.days) {
      const match = DAYS.find((day) => day.toLowerCase() === String(d).toLowerCase());
      if (!match) {
        return { ok: false, message: `weekly.days contains an invalid day: ${d}.` };
      }
      if (!norm.includes(match)) norm.push(match);
    }
    norm.sort((a, b) => DAYS.indexOf(a) - DAYS.indexOf(b));
    return { ok: true, value: { type: 'weekly', time: schedule.time, days: norm } };
  }

  if (type === 'logon') {
    return { ok: true, value: { type: 'logon' } };
  }

  return { ok: false, message: 'schedule.type must be one of: once, daily, weekly, logon.' };
}

export { DAYS };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/scheduler-schedule-spec.test.js`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/schedule-spec.js test/scheduler-schedule-spec.test.js
git commit -m "feat(scheduler): schedule validation + normalization" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: `run-cmd.js` — generate the run.cmd launcher

**Files:**
- Create: `src/scheduler/run-cmd.js`
- Test: `test/scheduler-run-cmd.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/scheduler-run-cmd.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildRunCmd, buildCommandLine } from '../src/scheduler/run-cmd.js';

test('buildCommandLine quotes only tokens that need it', () => {
  assert.equal(buildCommandLine('claude', ['-p', 'do the thing']), 'claude -p "do the thing"');
  assert.equal(buildCommandLine('python', ['x.py']), 'python x.py');
  assert.equal(buildCommandLine('C:\\Program Files\\app.exe', []), '"C:\\Program Files\\app.exe"');
});

test('buildRunCmd uses redirection-first echo and captures errorlevel', () => {
  const text = buildRunCmd({ command: 'python', args: ['job.py'] });
  assert.match(text, /^@echo off\r\n/);
  assert.match(text, /cd \/d "%~dp0"/);
  assert.match(text, /if not exist logs mkdir logs/);
  assert.match(text, />>logs\\run\.log echo START %DATE% %TIME%/);
  assert.match(text, /\npython job\.py\r\n/);
  assert.match(text, /set "_rc=%ERRORLEVEL%"/);
  assert.match(text, />>logs\\run\.log echo END \(exit %_rc%\) %DATE% %TIME%/);
  assert.equal(text.includes('pushd'), false);
});

test('buildRunCmd wraps the command in pushd/popd when a workdir is given', () => {
  const text = buildRunCmd({ command: 'python', args: ['job.py'], workdir: 'C:\\work' });
  assert.match(text, /pushd "C:\\work"\r\npython job\.py\r\nset "_rc=%ERRORLEVEL%"\r\npopd/);
});

test('buildRunCmd output is CRLF terminated', () => {
  const text = buildRunCmd({ command: 'x', args: [] });
  assert.ok(text.endsWith('\r\n'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/scheduler-run-cmd.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/scheduler/run-cmd.js`:

```js
function quoteToken(token) {
  if (token === '') return '""';
  return /[\s"&|<>^()%!]/.test(token) ? `"${token.replace(/"/g, '""')}"` : token;
}

export function buildCommandLine(command, args = []) {
  return [quoteToken(command), ...args.map(quoteToken)].join(' ');
}

export function buildRunCmd({ command, args = [], workdir }) {
  const cmdline = buildCommandLine(command, args);
  const lines = [
    '@echo off',
    'cd /d "%~dp0"',
    'if not exist logs mkdir logs',
    '>>logs\\run.log echo START %DATE% %TIME%'
  ];
  if (workdir) lines.push(`pushd "${workdir}"`);
  lines.push(cmdline);
  lines.push('set "_rc=%ERRORLEVEL%"');
  if (workdir) lines.push('popd');
  lines.push('>>logs\\run.log echo END (exit %_rc%) %DATE% %TIME%');
  return lines.join('\r\n') + '\r\n';
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/scheduler-run-cmd.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/run-cmd.js test/scheduler-run-cmd.test.js
git commit -m "feat(scheduler): run.cmd launcher generation" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: `task-xml.js` — generate Task Scheduler XML

**Files:**
- Create: `src/scheduler/task-xml.js`
- Test: `test/scheduler-task-xml.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/scheduler-task-xml.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildTaskXml } from '../src/scheduler/task-xml.js';

const base = {
  runCmdPath: 'C:\\proj\\schedule\\nightly\\run.cmd',
  workingDir: 'C:\\proj\\schedule\\nightly',
  source: 'agent-mesh-scheduler',
  uri: '\\AgentMesh\\proj-abc123\\nightly'
};

test('daily produces a CalendarTrigger with ScheduleByDay and StartWhenAvailable', () => {
  const xml = buildTaskXml({ ...base, schedule: { type: 'daily', time: '14:00' } });
  assert.match(xml, /<CalendarTrigger>/);
  assert.match(xml, /<StartBoundary>2020-01-01T14:00:00<\/StartBoundary>/);
  assert.match(xml, /<ScheduleByDay><DaysInterval>1<\/DaysInterval><\/ScheduleByDay>/);
  assert.match(xml, /<StartWhenAvailable>true<\/StartWhenAvailable>/);
  assert.match(xml, /<LogonType>InteractiveToken<\/LogonType>/);
  assert.match(xml, /<Command>C:\\proj\\schedule\\nightly\\run\.cmd<\/Command>/);
  assert.equal(xml.includes('DeleteExpiredTaskAfter'), false);
});

test('weekly emits the selected day elements', () => {
  const xml = buildTaskXml({ ...base, schedule: { type: 'weekly', time: '09:00', days: ['Mon', 'Wed'] } });
  assert.match(xml, /<ScheduleByWeek>/);
  assert.match(xml, /<DaysOfWeek><Monday \/><Wednesday \/><\/DaysOfWeek>/);
});

test('once emits a TimeTrigger with the explicit start boundary', () => {
  const xml = buildTaskXml({ ...base, schedule: { type: 'once', date: '2026-06-09', time: '15:00', selfDelete: false } });
  assert.match(xml, /<TimeTrigger><StartBoundary>2026-06-09T15:00:00<\/StartBoundary>/);
  assert.equal(xml.includes('EndBoundary'), false);
  assert.equal(xml.includes('DeleteExpiredTaskAfter'), false);
});

test('once with selfDelete adds EndBoundary and DeleteExpiredTaskAfter', () => {
  const xml = buildTaskXml({ ...base, schedule: { type: 'once', date: '2026-06-09', time: '15:00', selfDelete: true } });
  assert.match(xml, /<EndBoundary>2026-06-09T23:59:59<\/EndBoundary>/);
  assert.match(xml, /<DeleteExpiredTaskAfter>PT0S<\/DeleteExpiredTaskAfter>/);
});

test('logon emits a LogonTrigger', () => {
  const xml = buildTaskXml({ ...base, schedule: { type: 'logon' } });
  assert.match(xml, /<LogonTrigger><Enabled>true<\/Enabled><\/LogonTrigger>/);
});

test('description and uri are XML-escaped', () => {
  const xml = buildTaskXml({ ...base, description: 'a & b < c', schedule: { type: 'logon' } });
  assert.match(xml, /<Description>a &amp; b &lt; c<\/Description>/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/scheduler-task-xml.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/scheduler/task-xml.js`:

```js
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const DAY_ELEMENT = {
  Mon: 'Monday', Tue: 'Tuesday', Wed: 'Wednesday', Thu: 'Thursday',
  Fri: 'Friday', Sat: 'Saturday', Sun: 'Sunday'
};

function buildTrigger(schedule) {
  if (schedule.type === 'once') {
    const start = `${schedule.date}T${schedule.time}:00`;
    if (schedule.selfDelete) {
      const end = `${schedule.date}T23:59:59`;
      return `<TimeTrigger><StartBoundary>${start}</StartBoundary>` +
        `<EndBoundary>${end}</EndBoundary><Enabled>true</Enabled></TimeTrigger>`;
    }
    return `<TimeTrigger><StartBoundary>${start}</StartBoundary><Enabled>true</Enabled></TimeTrigger>`;
  }
  if (schedule.type === 'daily') {
    const start = `2020-01-01T${schedule.time}:00`;
    return `<CalendarTrigger><StartBoundary>${start}</StartBoundary><Enabled>true</Enabled>` +
      `<ScheduleByDay><DaysInterval>1</DaysInterval></ScheduleByDay></CalendarTrigger>`;
  }
  if (schedule.type === 'weekly') {
    const start = `2020-01-01T${schedule.time}:00`;
    const days = schedule.days.map((d) => `<${DAY_ELEMENT[d]} />`).join('');
    return `<CalendarTrigger><StartBoundary>${start}</StartBoundary><Enabled>true</Enabled>` +
      `<ScheduleByWeek><DaysOfWeek>${days}</DaysOfWeek><WeeksInterval>1</WeeksInterval></ScheduleByWeek></CalendarTrigger>`;
  }
  return `<LogonTrigger><Enabled>true</Enabled></LogonTrigger>`;
}

export function buildTaskXml({ runCmdPath, workingDir, description = '', schedule, source, uri }) {
  const selfDelete = schedule.type === 'once' && schedule.selfDelete;
  const settings = [
    '<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>',
    '<StartWhenAvailable>true</StartWhenAvailable>',
    '<Enabled>true</Enabled>',
    selfDelete ? '<DeleteExpiredTaskAfter>PT0S</DeleteExpiredTaskAfter>' : ''
  ].filter(Boolean).join('');

  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Source>${esc(source)}</Source>
    <URI>${esc(uri)}</URI>
    <Description>${esc(description)}</Description>
  </RegistrationInfo>
  <Triggers>${buildTrigger(schedule)}</Triggers>
  <Principals>
    <Principal id="Author">
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>${settings}</Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${esc(runCmdPath)}</Command>
      <WorkingDirectory>${esc(workingDir)}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/scheduler-task-xml.test.js`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/task-xml.js test/scheduler-task-xml.test.js
git commit -m "feat(scheduler): Task Scheduler XML generation" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: `marker.js` + `result.js` — ownership marker & result shapes

**Files:**
- Create: `src/scheduler/marker.js`
- Create: `src/scheduler/result.js`
- Test: `test/scheduler-marker.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/scheduler-marker.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { MARKER, buildMarker, parseMarker, isOwned } from '../src/scheduler/marker.js';
import { ok, err } from '../src/scheduler/result.js';

test('buildMarker stamps the marker constant and carries fields', () => {
  const m = buildMarker({
    name: 'nightly', root: '/r', taskPath: '\\AgentMesh\\r-abc\\nightly',
    command: 'python', args: ['j.py'], schedule: { type: 'daily', time: '02:00' }, createdAt: 'T0'
  });
  assert.equal(m.marker, MARKER);
  assert.equal(m.name, 'nightly');
  assert.deepEqual(m.args, ['j.py']);
  assert.equal(m.createdAt, 'T0');
});

test('parseMarker round-trips and rejects junk', () => {
  const m = buildMarker({ name: 'n', root: '/r', taskPath: 'p', command: 'c', args: [], schedule: {}, createdAt: 'T' });
  const parsed = parseMarker(JSON.stringify(m));
  assert.equal(parsed.ok, true);
  assert.equal(parsed.value.name, 'n');
  assert.equal(parseMarker('not json').ok, false);
  assert.equal(parseMarker('[]').ok, false);
});

test('isOwned only accepts our marker', () => {
  assert.equal(isOwned({ marker: MARKER }), true);
  assert.equal(isOwned({ marker: 'something-else' }), false);
  assert.equal(isOwned(null), false);
});

test('result helpers produce the canonical shapes', () => {
  assert.deepEqual(ok({ name: 'n' }), { status: 'ok', name: 'n' });
  assert.deepEqual(err('bad_name', 'nope'), { status: 'error', error: { code: 'bad_name', message: 'nope' } });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/scheduler-marker.test.js`
Expected: FAIL — modules not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/scheduler/result.js`:

```js
export function ok(payload = {}) {
  return { status: 'ok', ...payload };
}

export function err(code, message) {
  return { status: 'error', error: { code, message } };
}
```

Create `src/scheduler/marker.js`:

```js
export const MARKER = 'agent-mesh-scheduler';

export function buildMarker({ name, root, taskPath, command, args = [], schedule, createdAt }) {
  return { marker: MARKER, name, root, taskPath, command, args, schedule, createdAt };
}

export function parseMarker(text) {
  try {
    const obj = JSON.parse(text);
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return { ok: false };
    return { ok: true, value: obj };
  } catch {
    return { ok: false };
  }
}

export function isOwned(marker) {
  return Boolean(marker) && marker.marker === MARKER;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/scheduler-marker.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/marker.js src/scheduler/result.js test/scheduler-marker.test.js
git commit -m "feat(scheduler): ownership marker + result shapes" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: `schtasks.js` — schtasks.exe wrappers + fake-binary test harness

**Files:**
- Create: `src/scheduler/schtasks.js`
- Create: `test/scheduler-helpers.js`
- Test: `test/scheduler-schtasks.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/scheduler-helpers.js` (shared util, reused by later impure tests):

```js
import { chmod, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Write a node script as a fake external binary. spawnFile() runs *.mjs through
// the current node on every platform (see src/process.js), so this works on
// Windows too — same trick as createFakeClaude in test/delegate.test.js.
export async function createFakeBin(body) {
  const dir = await mkdtemp(join(tmpdir(), 'sched-fake-'));
  const path = join(dir, 'fake.mjs');
  await writeFile(path, `#!/usr/bin/env node\n${body}\n`, 'utf8');
  await chmod(path, 0o755);
  return path;
}

export async function createTempRoot() {
  return mkdtemp(join(tmpdir(), 'sched-root-'));
}

// A fake schtasks that appends each call's argv (JSON) to SCHTASKS_CAPTURE and
// exits with SCHTASKS_EXIT (default 0). SCHTASKS_STDERR is written to stderr.
export const FAKE_SCHTASKS = `
const fs = await import('node:fs/promises');
if (process.env.SCHTASKS_CAPTURE) {
  await fs.appendFile(process.env.SCHTASKS_CAPTURE, JSON.stringify(process.argv.slice(2)) + '\\n');
}
if (process.env.SCHTASKS_STDERR) process.stderr.write(process.env.SCHTASKS_STDERR);
process.exit(Number(process.env.SCHTASKS_EXIT || '0'));
`;
```

Create `test/scheduler-schtasks.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFakeBin, createTempRoot, FAKE_SCHTASKS } from './scheduler-helpers.js';
import { schtasksCreate, schtasksRun, schtasksChange, schtasksDelete } from '../src/scheduler/schtasks.js';

async function harness() {
  const fake = await createFakeBin(FAKE_SCHTASKS);
  const cap = join(await createTempRoot(), 'cap.txt');
  const env = { ...process.env, AGENT_MESH_SCHTASKS: fake, SCHTASKS_CAPTURE: cap };
  return { env, cap };
}

async function calls(cap) {
  const text = await readFile(cap, 'utf8');
  return text.trim().split('\n').map((l) => JSON.parse(l));
}

test('schtasksCreate passes /Create /TN <path> /XML <xml> /F', async () => {
  const { env, cap } = await harness();
  const res = await schtasksCreate({ env, taskPath: '\\AgentMesh\\p-abc\\n', xmlPath: 'C:/x/task.xml' });
  assert.equal(res.code, 0);
  assert.deepEqual((await calls(cap))[0], ['/Create', '/TN', '\\AgentMesh\\p-abc\\n', '/XML', 'C:/x/task.xml', '/F']);
});

test('schtasksRun passes /Run /TN', async () => {
  const { env, cap } = await harness();
  await schtasksRun({ env, taskPath: '\\AgentMesh\\p-abc\\n' });
  assert.deepEqual((await calls(cap))[0], ['/Run', '/TN', '\\AgentMesh\\p-abc\\n']);
});

test('schtasksChange toggles /ENABLE and /DISABLE', async () => {
  const { env, cap } = await harness();
  await schtasksChange({ env, taskPath: '\\AgentMesh\\p-abc\\n', enable: true });
  await schtasksChange({ env, taskPath: '\\AgentMesh\\p-abc\\n', enable: false });
  const c = await calls(cap);
  assert.deepEqual(c[0], ['/Change', '/TN', '\\AgentMesh\\p-abc\\n', '/ENABLE']);
  assert.deepEqual(c[1], ['/Change', '/TN', '\\AgentMesh\\p-abc\\n', '/DISABLE']);
});

test('schtasksDelete passes /Delete /TN /F and surfaces a non-zero exit', async () => {
  const fake = await createFakeBin(FAKE_SCHTASKS);
  const cap = join(await createTempRoot(), 'cap.txt');
  const env = { ...process.env, AGENT_MESH_SCHTASKS: fake, SCHTASKS_CAPTURE: cap, SCHTASKS_EXIT: '1', SCHTASKS_STDERR: 'boom' };
  const res = await schtasksDelete({ env, taskPath: '\\AgentMesh\\p-abc\\n' });
  assert.equal(res.code, 1);
  assert.match(res.stderr, /boom/);
  assert.deepEqual((await calls(cap))[0], ['/Delete', '/TN', '\\AgentMesh\\p-abc\\n', '/F']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/scheduler-schtasks.test.js`
Expected: FAIL — `src/scheduler/schtasks.js` not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/scheduler/schtasks.js`:

```js
import { spawnFile } from '../process.js';

function bin(env) {
  return env.AGENT_MESH_SCHTASKS || 'schtasks.exe';
}

export async function schtasksCreate({ env, taskPath, xmlPath }) {
  return spawnFile(bin(env), ['/Create', '/TN', taskPath, '/XML', xmlPath, '/F'], { env });
}

export async function schtasksRun({ env, taskPath }) {
  return spawnFile(bin(env), ['/Run', '/TN', taskPath], { env });
}

export async function schtasksChange({ env, taskPath, enable }) {
  return spawnFile(bin(env), ['/Change', '/TN', taskPath, enable ? '/ENABLE' : '/DISABLE'], { env });
}

export async function schtasksDelete({ env, taskPath }) {
  return spawnFile(bin(env), ['/Delete', '/TN', taskPath, '/F'], { env });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/scheduler-schtasks.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/schtasks.js test/scheduler-helpers.js test/scheduler-schtasks.test.js
git commit -m "feat(scheduler): schtasks.exe wrappers + fake-binary harness" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 7: `query.js` — read-only PowerShell status query

**Files:**
- Create: `src/scheduler/query.js`
- Test: `test/scheduler-query.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/scheduler-query.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFakeBin, createTempRoot } from './scheduler-helpers.js';
import { queryTaskInfo } from '../src/scheduler/query.js';

// Fake powershell: records argv (JSON) to PS_CAPTURE, emits PS_OUTPUT on stdout.
const FAKE_PS = `
const fs = await import('node:fs/promises');
if (process.env.PS_CAPTURE) await fs.writeFile(process.env.PS_CAPTURE, JSON.stringify(process.argv.slice(2)));
process.stdout.write(process.env.PS_OUTPUT || '{"found":false}');
`;

test('queryTaskInfo parses ConvertTo-Json and splits TaskPath/TaskName', async () => {
  const fake = await createFakeBin(FAKE_PS);
  const cap = join(await createTempRoot(), 'ps.txt');
  const env = {
    ...process.env, AGENT_MESH_POWERSHELL: fake, PS_CAPTURE: cap,
    PS_OUTPUT: '{"found":true,"state":"Ready","lastRunTime":"t","lastTaskResult":0,"nextRunTime":"u"}'
  };
  const out = await queryTaskInfo({ env, taskPath: '\\AgentMesh\\p-abc\\nightly' });
  assert.deepEqual(out, { found: true, state: 'Ready', lastRunTime: 't', lastTaskResult: 0, nextRunTime: 'u' });

  const argv = JSON.parse(await readFile(cap, 'utf8'));
  assert.ok(argv.includes('-NoProfile'));
  assert.ok(argv.includes('-NonInteractive'));
  const script = argv[argv.indexOf('-Command') + 1];
  assert.match(script, /TaskPath '\\AgentMesh\\p-abc\\'/);
  assert.match(script, /TaskName 'nightly'/);
});

test('queryTaskInfo returns {found:false} on unparseable output', async () => {
  const fake = await createFakeBin(FAKE_PS);
  const env = { ...process.env, AGENT_MESH_POWERSHELL: fake, PS_OUTPUT: 'garbage' };
  const out = await queryTaskInfo({ env, taskPath: '\\AgentMesh\\p-abc\\nightly' });
  assert.deepEqual(out, { found: false });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/scheduler-query.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/scheduler/query.js`:

```js
import { spawnFile } from '../process.js';

function bin(env) {
  return env.AGENT_MESH_POWERSHELL || 'powershell.exe';
}

function splitTaskPath(taskPath) {
  const idx = taskPath.lastIndexOf('\\');
  return { folder: taskPath.slice(0, idx + 1), name: taskPath.slice(idx + 1) };
}

export async function queryTaskInfo({ env, taskPath }) {
  const { folder, name } = splitTaskPath(taskPath);
  const script =
    `$ErrorActionPreference='Stop';` +
    `try{` +
    `$t=Get-ScheduledTask -TaskPath '${folder}' -TaskName '${name}';` +
    `$i=$t|Get-ScheduledTaskInfo;` +
    `[pscustomobject]@{found=$true;state="$($t.State)";lastRunTime="$($i.LastRunTime)";` +
    `lastTaskResult=$i.LastTaskResult;nextRunTime="$($i.NextRunTime)"}|ConvertTo-Json -Compress` +
    `}catch{'{"found":false}'}`;
  const res = await spawnFile(bin(env), ['-NoProfile', '-NonInteractive', '-Command', script], { env });
  try {
    const parsed = JSON.parse((res.stdout || '').trim());
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : { found: false };
  } catch {
    return { found: false };
  }
}
```

Note: the task `name` and `folder` are already sanitized (`[A-Za-z0-9._-]` and a hex-suffixed slug), so neither can contain a single quote — the single-quoted PowerShell strings cannot be broken out of.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/scheduler-query.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/query.js test/scheduler-query.test.js
git commit -m "feat(scheduler): read-only PowerShell status query" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 8: `scaffold.js` — filesystem scaffolding & log tail

**Files:**
- Create: `src/scheduler/scaffold.js`
- Test: `test/scheduler-scaffold.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/scheduler-scaffold.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createTempRoot } from './scheduler-helpers.js';
import { scaffoldTask, readMarkerFile, removeTaskDir, tailLog, listMarkers } from '../src/scheduler/scaffold.js';
import { buildMarker } from '../src/scheduler/marker.js';

test('scaffoldTask writes run.cmd (utf8), marker (json), task.xml (utf16+BOM) and logs dir', async () => {
  const root = await createTempRoot();
  const dir = join(root, 'schedule', 'nightly');
  const marker = buildMarker({ name: 'nightly', root, taskPath: 'p', command: 'c', args: [], schedule: {}, createdAt: 'T' });
  await scaffoldTask({ dir, runCmd: '@echo off\r\n', marker, xml: '<Task/>' });

  assert.equal(await readFile(join(dir, 'run.cmd'), 'utf8'), '@echo off\r\n');
  assert.equal(JSON.parse(await readFile(join(dir, '.agent-mesh-task.json'), 'utf8')).name, 'nightly');
  const xmlBuf = await readFile(join(dir, 'task.xml'));
  assert.equal(xmlBuf[0], 0xff); // UTF-16LE BOM
  assert.equal(xmlBuf[1], 0xfe);
  assert.ok((await stat(join(dir, 'logs'))).isDirectory());
});

test('readMarkerFile returns null when absent', async () => {
  const root = await createTempRoot();
  assert.equal(await readMarkerFile({ dir: join(root, 'nope') }), null);
});

test('tailLog returns the last N non-empty lines, [] when missing', async () => {
  const root = await createTempRoot();
  const dir = join(root, 'schedule', 'nightly');
  await mkdir(join(dir, 'logs'), { recursive: true });
  await writeFile(join(dir, 'logs', 'run.log'), 'a\r\nb\r\nc\r\n\r\n', 'utf8');
  assert.deepEqual(await tailLog({ dir, lines: 2 }), ['b', 'c']);
  assert.deepEqual(await tailLog({ dir: join(root, 'gone'), lines: 2 }), []);
});

test('removeTaskDir deletes the folder', async () => {
  const root = await createTempRoot();
  const dir = join(root, 'schedule', 'nightly');
  await mkdir(dir, { recursive: true });
  await removeTaskDir({ dir });
  await assert.rejects(stat(dir));
});

test('listMarkers returns only owned marker objects', async () => {
  const root = await createTempRoot();
  const okDir = join(root, 'schedule', 'good');
  const badDir = join(root, 'schedule', 'foreign');
  await mkdir(okDir, { recursive: true });
  await mkdir(badDir, { recursive: true });
  const marker = buildMarker({ name: 'good', root, taskPath: 'p', command: 'c', args: [], schedule: {}, createdAt: 'T' });
  await writeFile(join(okDir, '.agent-mesh-task.json'), JSON.stringify(marker), 'utf8');
  await writeFile(join(badDir, '.agent-mesh-task.json'), JSON.stringify({ marker: 'other' }), 'utf8');

  const found = await listMarkers({ root });
  assert.equal(found.length, 1);
  assert.equal(found[0].name, 'good');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/scheduler-scaffold.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/scheduler/scaffold.js`:

```js
import { mkdir, writeFile, readFile, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { parseMarker, isOwned } from './marker.js';

export async function scaffoldTask({ dir, runCmd, marker, xml }) {
  await mkdir(join(dir, 'logs'), { recursive: true });
  await writeFile(join(dir, 'run.cmd'), runCmd, 'utf8');
  await writeFile(join(dir, '.agent-mesh-task.json'), JSON.stringify(marker, null, 2), 'utf8');
  // schtasks reads the XML file; UTF-16LE + BOM is the Task Scheduler-native form.
  await writeFile(join(dir, 'task.xml'), '﻿' + xml, 'utf16le');
}

export async function readMarkerFile({ dir }) {
  try {
    return await readFile(join(dir, '.agent-mesh-task.json'), 'utf8');
  } catch {
    return null;
  }
}

export async function removeTaskDir({ dir }) {
  await rm(dir, { recursive: true, force: true });
}

export async function tailLog({ dir, lines = 50 }) {
  let text;
  try {
    text = await readFile(join(dir, 'logs', 'run.log'), 'utf8');
  } catch {
    return [];
  }
  const all = text.split(/\r?\n/).filter((l) => l.length > 0);
  return all.slice(-lines);
}

export async function listMarkers({ root }) {
  const base = join(root, 'schedule');
  let entries;
  try {
    entries = await readdir(base, { withFileTypes: true });
  } catch {
    return [];
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const text = await readMarkerFile({ dir: join(base, e.name) });
    if (!text) continue;
    const parsed = parseMarker(text);
    if (parsed.ok && isOwned(parsed.value)) out.push(parsed.value);
  }
  return out;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/scheduler-scaffold.test.js`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/scaffold.js test/scheduler-scaffold.test.js
git commit -m "feat(scheduler): filesystem scaffolding + log tail" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 9: `ops.js` — orchestration of all tool operations

**Files:**
- Create: `src/scheduler/ops.js`
- Test: `test/scheduler-ops.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/scheduler-ops.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createFakeBin, createTempRoot, FAKE_SCHTASKS } from './scheduler-helpers.js';
import {
  createTask, listTasks, getTask, runTask, enableTask, disableTask, deleteTask, getTaskLogs
} from '../src/scheduler/ops.js';

const FAKE_PS_FOUND = `
process.stdout.write('{"found":true,"state":"Ready","lastTaskResult":0,"nextRunTime":"soon"}');
`;

async function ctx({ schtasksExit = '0' } = {}) {
  const root = await createTempRoot();
  const schtasks = await createFakeBin(FAKE_SCHTASKS);
  const ps = await createFakeBin(FAKE_PS_FOUND);
  const cap = join(await createTempRoot(), 'cap.txt');
  const env = {
    ...process.env,
    AGENT_MESH_SCHTASKS: schtasks, AGENT_MESH_POWERSHELL: ps,
    SCHTASKS_CAPTURE: cap, SCHTASKS_EXIT: schtasksExit
  };
  return { root, env, cap };
}

const daily = { type: 'daily', time: '02:00' };

test('createTask scaffolds files, registers, and returns ok', async () => {
  const { root, env } = await ctx();
  const res = await createTask({ root, env, input: { name: 'nightly', command: 'python', args: ['j.py'], schedule: daily } });
  assert.equal(res.status, 'ok');
  assert.match(res.taskPath, /\\AgentMesh\\.+\\nightly$/);
  const dir = join(root, 'schedule', 'nightly');
  assert.ok((await stat(join(dir, 'run.cmd'))).isFile());
  assert.ok((await stat(join(dir, 'task.xml'))).isFile());
  const marker = JSON.parse(await readFile(join(dir, '.agent-mesh-task.json'), 'utf8'));
  assert.equal(marker.command, 'python');
});

test('createTask refuses a duplicate name without overwrite', async () => {
  const { root, env } = await ctx();
  await createTask({ root, env, input: { name: 'dup', command: 'c', schedule: daily } });
  const again = await createTask({ root, env, input: { name: 'dup', command: 'c', schedule: daily } });
  assert.equal(again.status, 'error');
  assert.equal(again.error.code, 'name_exists');
  const ovr = await createTask({ root, env, input: { name: 'dup', command: 'c', schedule: daily, overwrite: true } });
  assert.equal(ovr.status, 'ok');
});

test('createTask validates name, command, and schedule', async () => {
  const { root, env } = await ctx();
  assert.equal((await createTask({ root, env, input: { name: '../x', command: 'c', schedule: daily } })).error.code, 'bad_name');
  assert.equal((await createTask({ root, env, input: { name: 'ok', command: '', schedule: daily } })).error.code, 'bad_input');
  assert.equal((await createTask({ root, env, input: { name: 'ok', command: 'c', schedule: { type: 'monthly' } } })).error.code, 'bad_schedule');
});

test('createTask surfaces a schtasks failure as register_failed', async () => {
  const { root, env } = await ctx({ schtasksExit: '1' });
  const res = await createTask({ root, env, input: { name: 'boom', command: 'c', schedule: daily } });
  assert.equal(res.status, 'error');
  assert.equal(res.error.code, 'register_failed');
});

test('getTask returns not_found, then live state after create', async () => {
  const { root, env } = await ctx();
  assert.equal((await getTask({ root, env, input: { name: 'nope' } })).error.code, 'not_found');
  await createTask({ root, env, input: { name: 'nightly', command: 'c', schedule: daily } });
  const got = await getTask({ root, env, input: { name: 'nightly' } });
  assert.equal(got.status, 'ok');
  assert.equal(got.live.found, true);
  assert.equal(got.live.lastTaskResult, 0);
  assert.deepEqual(got.log_tail, []);
});

test('listTasks merges markers with live state', async () => {
  const { root, env } = await ctx();
  await createTask({ root, env, input: { name: 'a', command: 'c', schedule: daily } });
  await createTask({ root, env, input: { name: 'b', command: 'c', schedule: daily } });
  const res = await listTasks({ root, env });
  assert.equal(res.status, 'ok');
  assert.equal(res.tasks.length, 2);
  assert.ok(res.tasks.every((t) => t.live.found === true));
});

test('run/enable/disable call schtasks for managed tasks', async () => {
  const { root, env, cap } = await ctx();
  await createTask({ root, env, input: { name: 'n', command: 'c', schedule: daily } });
  assert.equal((await runTask({ root, env, input: { name: 'n' } })).status, 'ok');
  assert.equal((await enableTask({ root, env, input: { name: 'n' } })).status, 'ok');
  assert.equal((await disableTask({ root, env, input: { name: 'n' } })).status, 'ok');
  const lines = (await readFile(cap, 'utf8')).trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((c) => c[0] === '/Run'));
  assert.ok(lines.some((c) => c[0] === '/Change' && c.includes('/ENABLE')));
  assert.ok(lines.some((c) => c[0] === '/Change' && c.includes('/DISABLE')));
});

test('deleteTask removes the folder, keep_logs preserves it', async () => {
  const { root, env } = await ctx();
  await createTask({ root, env, input: { name: 'gone', command: 'c', schedule: daily } });
  const res = await deleteTask({ root, env, input: { name: 'gone' } });
  assert.equal(res.status, 'ok');
  await assert.rejects(stat(join(root, 'schedule', 'gone')));

  await createTask({ root, env, input: { name: 'kept', command: 'c', schedule: daily } });
  await deleteTask({ root, env, input: { name: 'kept', keep_logs: true } });
  assert.ok((await stat(join(root, 'schedule', 'kept'))).isDirectory());
});

test('getTaskLogs tails the run.log of a managed task', async () => {
  const { root, env } = await ctx();
  await createTask({ root, env, input: { name: 'n', command: 'c', schedule: daily } });
  const { writeFile } = await import('node:fs/promises');
  await writeFile(join(root, 'schedule', 'n', 'logs', 'run.log'), 'one\r\ntwo\r\n', 'utf8');
  const res = await getTaskLogs({ root, env, input: { name: 'n', lines: 1 } });
  assert.deepEqual(res.lines, ['two']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/scheduler-ops.test.js`
Expected: FAIL — `src/scheduler/ops.js` not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/scheduler/ops.js`:

```js
import { join } from 'node:path';
import { ok, err } from './result.js';
import { sanitizeTaskName, slugForRoot, taskPath as buildTaskPath, taskDir } from './task-name.js';
import { normalizeSchedule } from './schedule-spec.js';
import { buildRunCmd } from './run-cmd.js';
import { buildTaskXml } from './task-xml.js';
import { buildMarker, parseMarker, isOwned, MARKER } from './marker.js';
import { schtasksCreate, schtasksRun, schtasksChange, schtasksDelete } from './schtasks.js';
import { queryTaskInfo } from './query.js';
import { scaffoldTask, readMarkerFile, removeTaskDir, tailLog, listMarkers } from './scaffold.js';

function ns(env) {
  return env.AGENT_MESH_SCHEDULER_NS || '\\AgentMesh';
}

function nowIso() {
  return new Date().toISOString();
}

async function loadOwnedMarker({ root, name }) {
  const dir = taskDir(root, name);
  const text = await readMarkerFile({ dir });
  if (!text) return { ok: false };
  const parsed = parseMarker(text);
  if (!parsed.ok || !isOwned(parsed.value)) return { ok: false };
  return { ok: true, value: parsed.value, dir };
}

export async function createTask({ root, env, input }) {
  const nameCheck = sanitizeTaskName(input?.name);
  if (!nameCheck.ok) return err('bad_name', nameCheck.message);
  const name = nameCheck.value;

  if (typeof input.command !== 'string' || input.command.length === 0) {
    return err('bad_input', 'command must be a non-empty string.');
  }
  const args = input.args === undefined ? [] : input.args;
  if (!Array.isArray(args) || args.some((a) => typeof a !== 'string')) {
    return err('bad_input', 'args must be an array of strings.');
  }
  if (input.workdir !== undefined && typeof input.workdir !== 'string') {
    return err('bad_input', 'workdir must be a string.');
  }

  const sched = normalizeSchedule(input.schedule);
  if (!sched.ok) return err('bad_schedule', sched.message);

  const slug = slugForRoot(root);
  const tp = buildTaskPath(ns(env), slug, name);
  const dir = taskDir(root, name);

  const existing = await readMarkerFile({ dir });
  if (existing && input.overwrite !== true) {
    return err('name_exists', `task "${name}" already exists; pass overwrite:true to replace it.`);
  }

  const createdAt = nowIso();
  const runCmd = buildRunCmd({ command: input.command, args, workdir: input.workdir });
  const xml = buildTaskXml({
    runCmdPath: join(dir, 'run.cmd'),
    workingDir: dir,
    description: typeof input.description === 'string' ? input.description : '',
    schedule: sched.value,
    source: MARKER,
    uri: tp
  });
  const marker = buildMarker({
    name, root, taskPath: tp,
    command: input.command, args, schedule: sched.value, createdAt
  });

  await scaffoldTask({ dir, runCmd, marker, xml });

  const res = await schtasksCreate({ env, taskPath: tp, xmlPath: join(dir, 'task.xml') });
  if (res.code !== 0) {
    return err('register_failed', (res.stderr || res.stdout || '').trim() || `schtasks exited ${res.code}`);
  }
  return ok({ name, taskPath: tp, dir, schedule: sched.value });
}

export async function listTasks({ root, env }) {
  const markers = await listMarkers({ root });
  const tasks = [];
  for (const m of markers) {
    const live = await queryTaskInfo({ env, taskPath: m.taskPath });
    tasks.push({ name: m.name, schedule: m.schedule, taskPath: m.taskPath, command: m.command, args: m.args, live });
  }
  return ok({ tasks });
}

export async function getTask({ root, env, input }) {
  const nameCheck = sanitizeTaskName(input?.name);
  if (!nameCheck.ok) return err('bad_name', nameCheck.message);
  const found = await loadOwnedMarker({ root, name: nameCheck.value });
  if (!found.ok) return err('not_found', `no managed task "${nameCheck.value}".`);
  const live = await queryTaskInfo({ env, taskPath: found.value.taskPath });
  const log_tail = await tailLog({ dir: found.dir, lines: 20 });
  return ok({
    name: found.value.name, schedule: found.value.schedule, taskPath: found.value.taskPath,
    command: found.value.command, args: found.value.args, live, log_tail
  });
}

export async function runTask({ root, env, input }) {
  const nameCheck = sanitizeTaskName(input?.name);
  if (!nameCheck.ok) return err('bad_name', nameCheck.message);
  const found = await loadOwnedMarker({ root, name: nameCheck.value });
  if (!found.ok) return err('not_found', `no managed task "${nameCheck.value}".`);
  const res = await schtasksRun({ env, taskPath: found.value.taskPath });
  if (res.code !== 0) return err('run_failed', (res.stderr || res.stdout || '').trim() || `schtasks exited ${res.code}`);
  return ok({ name: found.value.name, taskPath: found.value.taskPath });
}

async function setEnabled({ root, env, input, enable }) {
  const nameCheck = sanitizeTaskName(input?.name);
  if (!nameCheck.ok) return err('bad_name', nameCheck.message);
  const found = await loadOwnedMarker({ root, name: nameCheck.value });
  if (!found.ok) return err('not_found', `no managed task "${nameCheck.value}".`);
  const res = await schtasksChange({ env, taskPath: found.value.taskPath, enable });
  if (res.code !== 0) return err('change_failed', (res.stderr || res.stdout || '').trim() || `schtasks exited ${res.code}`);
  return ok({ name: found.value.name, enabled: enable });
}

export function enableTask(ctx) { return setEnabled({ ...ctx, enable: true }); }
export function disableTask(ctx) { return setEnabled({ ...ctx, enable: false }); }

export async function deleteTask({ root, env, input }) {
  const nameCheck = sanitizeTaskName(input?.name);
  if (!nameCheck.ok) return err('bad_name', nameCheck.message);
  const found = await loadOwnedMarker({ root, name: nameCheck.value });
  if (!found.ok) return err('not_found', `no managed task "${nameCheck.value}".`);
  const res = await schtasksDelete({ env, taskPath: found.value.taskPath });
  if (res.code !== 0) {
    // An already-gone task (e.g. an expired self-deleting one-off) is tolerable —
    // still clean up the folder. A real failure is reported.
    const msg = (res.stderr || res.stdout || '').toLowerCase();
    const gone = msg.includes('cannot find') || msg.includes('does not exist');
    if (!gone) return err('delete_failed', (res.stderr || res.stdout || '').trim() || `schtasks exited ${res.code}`);
  }
  if (input.keep_logs !== true) {
    await removeTaskDir({ dir: found.dir });
  }
  return ok({ name: found.value.name, removed: input.keep_logs !== true });
}

export async function getTaskLogs({ root, input }) {
  const nameCheck = sanitizeTaskName(input?.name);
  if (!nameCheck.ok) return err('bad_name', nameCheck.message);
  const found = await loadOwnedMarker({ root, name: nameCheck.value });
  if (!found.ok) return err('not_found', `no managed task "${nameCheck.value}".`);
  const lines = Number.isInteger(input.lines) && input.lines > 0 ? input.lines : 50;
  const log = await tailLog({ dir: found.dir, lines });
  return ok({ name: found.value.name, lines: log });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/scheduler-ops.test.js`
Expected: PASS (9 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/ops.js test/scheduler-ops.test.js
git commit -m "feat(scheduler): tool operation orchestration" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 10: `tools.js` — MCP tool definitions

**Files:**
- Create: `src/scheduler/tools.js`
- Test: `test/scheduler-tools.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/scheduler-tools.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSchedulerTools } from '../src/scheduler/tools.js';

test('exposes the 8 scheduler tools', () => {
  const names = buildSchedulerTools().map((t) => t.name).sort();
  assert.deepEqual(names, [
    'create_task', 'delete_task', 'disable_task', 'enable_task',
    'get_task', 'get_task_logs', 'list_tasks', 'run_task'
  ]);
});

test('every tool has an object input schema with additionalProperties:false', () => {
  for (const t of buildSchedulerTools()) {
    assert.equal(t.inputSchema.type, 'object');
    assert.equal(t.inputSchema.additionalProperties, false);
    assert.equal(typeof t.description, 'string');
  }
});

test('create_task requires name, command, schedule', () => {
  const create = buildSchedulerTools().find((t) => t.name === 'create_task');
  assert.deepEqual(create.inputSchema.required, ['name', 'command', 'schedule']);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/scheduler-tools.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/scheduler/tools.js`:

```js
export function buildSchedulerTools() {
  const nameOnly = {
    type: 'object', additionalProperties: false, required: ['name'],
    properties: { name: { type: 'string', minLength: 1, maxLength: 100 } }
  };
  return [
    {
      name: 'create_task',
      description: 'Create a Windows scheduled task (namespaced under \\AgentMesh\\). Scaffolds schedule/<name>/ with run.cmd + logs and registers it. "command" is the program and "args" its arguments (a Claude task is command:"claude", args:["-p","..."]).',
      inputSchema: {
        type: 'object', additionalProperties: false,
        required: ['name', 'command', 'schedule'],
        properties: {
          name: { type: 'string', minLength: 1, maxLength: 100 },
          command: { type: 'string', minLength: 1, maxLength: 8192 },
          args: { type: 'array', items: { type: 'string' } },
          schedule: {
            type: 'object',
            description: 'One of: {type:"once",date:"YYYY-MM-DD",time:"HH:mm",self_delete?:bool} | {type:"daily",time:"HH:mm"} | {type:"weekly",days:["Mon",...],time:"HH:mm"} | {type:"logon"}'
          },
          workdir: { type: 'string' },
          description: { type: 'string', maxLength: 512 },
          overwrite: { type: 'boolean' }
        }
      }
    },
    {
      name: 'list_tasks',
      description: 'List scheduled tasks managed in this folder, each with live last-run / next-run state.',
      inputSchema: { type: 'object', additionalProperties: false, properties: {} }
    },
    { name: 'get_task', description: 'Get full status of one managed task incl. last result and a tail of its run log.', inputSchema: nameOnly },
    { name: 'run_task', description: 'Run a managed task now.', inputSchema: nameOnly },
    { name: 'enable_task', description: 'Enable a managed task.', inputSchema: nameOnly },
    { name: 'disable_task', description: 'Disable a managed task.', inputSchema: nameOnly },
    {
      name: 'delete_task',
      description: 'Delete a managed task and its folder (set keep_logs:true to keep the folder).',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['name'],
        properties: { name: { type: 'string', minLength: 1, maxLength: 100 }, keep_logs: { type: 'boolean' } }
      }
    },
    {
      name: 'get_task_logs',
      description: 'Tail the run.log of a managed task.',
      inputSchema: {
        type: 'object', additionalProperties: false, required: ['name'],
        properties: { name: { type: 'string', minLength: 1, maxLength: 100 }, lines: { type: 'integer', minimum: 1 } }
      }
    }
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/scheduler-tools.test.js`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/tools.js test/scheduler-tools.test.js
git commit -m "feat(scheduler): MCP tool definitions" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 11: `mcp-scheduler.js` — stdio JSON-RPC server

**Files:**
- Create: `src/scheduler/mcp-scheduler.js`
- Test: `test/scheduler-mcp.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/scheduler-mcp.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { join } from 'node:path';
import { createFakeBin, createTempRoot, FAKE_SCHTASKS } from './scheduler-helpers.js';
import { handleSchedulerMessage } from '../src/scheduler/mcp-scheduler.js';

async function env() {
  const schtasks = await createFakeBin(FAKE_SCHTASKS);
  const ps = await createFakeBin(`process.stdout.write('{"found":true,"state":"Ready","lastTaskResult":0}');`);
  return { ...process.env, AGENT_MESH_SCHTASKS: schtasks, AGENT_MESH_POWERSHELL: ps };
}

test('initialize returns the scheduler serverInfo', async () => {
  const res = await handleSchedulerMessage({ message: { jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }, root: '/r', env: {} });
  assert.equal(res.result.serverInfo.name, 'agent-mesh-scheduler');
});

test('tools/list returns 8 tools', async () => {
  const res = await handleSchedulerMessage({ message: { jsonrpc: '2.0', id: 2, method: 'tools/list' }, root: '/r', env: {} });
  assert.equal(res.result.tools.length, 8);
});

test('tools/call create_task wraps the ops result as MCP text content', async () => {
  const root = await createTempRoot();
  const res = await handleSchedulerMessage({
    message: { jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'create_task', arguments: { name: 'n', command: 'c', schedule: { type: 'daily', time: '02:00' } } } },
    root, env: await env()
  });
  const payload = JSON.parse(res.result.content[0].text);
  assert.equal(payload.status, 'ok');
  assert.ok((await stat(join(root, 'schedule', 'n', 'run.cmd'))).isFile());
});

test('unknown tool → JSON-RPC -32602; unknown method → -32601', async () => {
  const bad = await handleSchedulerMessage({ message: { jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'nope' } }, root: '/r', env: {} });
  assert.equal(bad.error.code, -32602);
  const meth = await handleSchedulerMessage({ message: { jsonrpc: '2.0', id: 5, method: 'frobnicate' }, root: '/r', env: {} });
  assert.equal(meth.error.code, -32601);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/scheduler-mcp.test.js`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

Create `src/scheduler/mcp-scheduler.js`:

```js
import { StdioTransport, rpcError } from '../mcp.js';
import { mcpTextResult } from '../contract.js';
import { buildSchedulerTools } from './tools.js';
import * as ops from './ops.js';

export async function createSchedulerMcpServer({ root, env }) {
  return {
    async start(input, output) {
      const transport = new StdioTransport(input, output, async (message) => {
        const response = await handleSchedulerMessage({ message, root, env });
        if (response) transport.send(response);
      });
      transport.start();
      await new Promise((resolve) => input.on('end', resolve));
    }
  };
}

export async function handleSchedulerMessage({ message, root, env }) {
  if (!message || typeof message !== 'object') return null;
  const { id, method, params } = message;

  if (method === 'initialize') {
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: params?.protocolVersion || '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'agent-mesh-scheduler', version: '0.1.0' }
      }
    };
  }

  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };

  if (method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: buildSchedulerTools() } };
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const input = params?.arguments || {};
    const handlers = {
      create_task: () => ops.createTask({ root, env, input }),
      list_tasks: () => ops.listTasks({ root, env }),
      get_task: () => ops.getTask({ root, env, input }),
      run_task: () => ops.runTask({ root, env, input }),
      enable_task: () => ops.enableTask({ root, env, input }),
      disable_task: () => ops.disableTask({ root, env, input }),
      delete_task: () => ops.deleteTask({ root, env, input }),
      get_task_logs: () => ops.getTaskLogs({ root, env, input })
    };
    const handler = handlers[name];
    if (!handler) return rpcError(id, -32602, `Unknown tool: ${name}`);
    const result = await handler();
    return { jsonrpc: '2.0', id, result: mcpTextResult(result) };
  }

  if (id === undefined) return null;
  return rpcError(id, -32601, `Unknown method: ${method}`);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/scheduler-mcp.test.js`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/scheduler/mcp-scheduler.js test/scheduler-mcp.test.js
git commit -m "feat(scheduler): stdio JSON-RPC MCP server" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 12: CLI wiring — `serve-scheduler` subcommand

**Files:**
- Modify: `src/cli.js` (add the `serve-scheduler` block + usage lines)
- Test: `test/scheduler-cli.test.js`

- [ ] **Step 1: Write the failing test**

Create `test/scheduler-cli.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createFakeBin, createTempRoot, FAKE_SCHTASKS } from './scheduler-helpers.js';

const binPath = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-mesh.js');

// Drive the real CLI over stdio: initialize, then read one JSON-RPC line back.
test('serve-scheduler responds to an MCP initialize handshake', async () => {
  const root = await createTempRoot();
  const schtasks = await createFakeBin(FAKE_SCHTASKS);
  const child = spawn(process.execPath, [binPath, 'serve-scheduler', root], {
    env: { ...process.env, AGENT_MESH_SCHTASKS: schtasks },
    stdio: ['pipe', 'pipe', 'pipe']
  });

  const line = await new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error('timeout waiting for response')), 10000);
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      const nl = buf.indexOf('\n');
      if (nl !== -1) { clearTimeout(timer); resolve(buf.slice(0, nl)); }
    });
    child.on('error', reject);
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: {} }) + '\n');
  });

  child.stdin.end();
  child.kill();
  const msg = JSON.parse(line);
  assert.equal(msg.result.serverInfo.name, 'agent-mesh-scheduler');
});

test('serve-scheduler without a folder exits non-zero', async () => {
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, [binPath, 'serve-scheduler'], { stdio: ['ignore', 'ignore', 'ignore'] });
    child.on('exit', (c) => resolve(c));
  });
  assert.notEqual(code, 0);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/scheduler-cli.test.js`
Expected: FAIL — the first test times out / serverInfo mismatch (usage printed instead), the CLI has no `serve-scheduler` route yet.

- [ ] **Step 3: Add the subcommand to `src/cli.js`**

In `src/cli.js`, add this block immediately BEFORE the final guard line
`if ((command !== 'serve' && command !== 'serve-a2a' && command !== 'serve-peer-bridge') || !folder) {` (currently near line 399):

```js
  if (command === 'serve-scheduler') {
    if (!folder) {
      process.stderr.write(`${usage()}\n`);
      process.exitCode = 2;
      return;
    }
    const schedRoot = await realpath(folder);
    const { createSchedulerMcpServer } = await import('./scheduler/mcp-scheduler.js');
    try {
      const server = await createSchedulerMcpServer({ root: schedRoot, env });
      await server.start(process.stdin, process.stdout);
    } catch (err) {
      process.stderr.write(`error: ${err.message}\n`);
      process.exitCode = 1;
    }
    return;
  }

```

Then add a usage line. In the `usage()` array, after the `'  agent-mesh serve-a2a <folder>'` entry, add:

```js
    '  agent-mesh serve-scheduler <folder>   # MCP server: manage namespaced Windows scheduled tasks',
```

And in the `Environment:` section of `usage()`, after the `AGENT_MESH_CLAUDE=claude` line, add:

```js
    '  AGENT_MESH_SCHTASKS=schtasks.exe         (scheduler: task mutation binary)',
    '  AGENT_MESH_POWERSHELL=powershell.exe     (scheduler: read-only status query binary)',
    '  AGENT_MESH_SCHEDULER_NS=\\AgentMesh       (scheduler: Task Scheduler namespace root)',
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/scheduler-cli.test.js`
Expected: PASS (2 tests).

- [ ] **Step 5: Run the full suite to confirm no regressions**

Run: `node --test`
Expected: PASS — all prior suites plus the new scheduler suites green.

- [ ] **Step 6: Commit**

```bash
git add src/cli.js test/scheduler-cli.test.js
git commit -m "feat(scheduler): wire serve-scheduler subcommand into the CLI" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 13: Opt-in real-machine e2e + README docs

**Files:**
- Create: `test/scheduler-e2e.test.js`
- Modify: `README.md`

- [ ] **Step 1: Write the opt-in e2e test**

Create `test/scheduler-e2e.test.js`:

```js
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTask, runTask, getTask, deleteTask } from '../src/scheduler/ops.js';

// Real-machine regression net: actually registers, runs, and deletes a task via
// the real schtasks.exe + PowerShell. Gated — touches the live Task Scheduler.
const RUN = process.env.AGENT_MESH_SCHEDULER_E2E === '1' && process.platform === 'win32';

test('e2e: register → run → observe run.log → delete', { skip: !RUN }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'sched-e2e-'));
  const env = { ...process.env };
  const name = 'amE2eProbe';

  const created = await createTask({
    root, env,
    input: {
      name,
      command: 'cmd',
      args: ['/c', 'echo', 'probe-ok'],
      // A future one-off; run_task fires it now regardless of the trigger time.
      schedule: { type: 'once', date: '2099-01-01', time: '00:00', self_delete: false }
    }
  });
  assert.equal(created.status, 'ok');

  try {
    const ran = await runTask({ root, env, input: { name } });
    assert.equal(ran.status, 'ok');

    // Poll the run log (the task runs asynchronously under Task Scheduler).
    let sawEnd = false;
    for (let i = 0; i < 20 && !sawEnd; i++) {
      const got = await getTask({ root, env, input: { name } });
      sawEnd = (got.log_tail || []).some((l) => l.startsWith('END'));
      if (!sawEnd) await new Promise((r) => setTimeout(r, 500));
    }
    assert.ok(sawEnd, 'run.log should contain an END line after the task runs');
  } finally {
    const del = await deleteTask({ root, env, input: { name } });
    assert.equal(del.status, 'ok');
  }
});
```

- [ ] **Step 2: Verify the e2e test is skipped by default**

Run: `node --test test/scheduler-e2e.test.js`
Expected: PASS with the test reported as skipped (no `AGENT_MESH_SCHEDULER_E2E`).

- [ ] **Step 3: (Windows only, manual) verify the e2e really works**

Run (PowerShell): `$env:AGENT_MESH_SCHEDULER_E2E=1; node --test test/scheduler-e2e.test.js`
Expected: PASS (not skipped). If it fails at the register step with an XML/encoding
error, the fix is in `src/scheduler/scaffold.js` — the `task.xml` is written
UTF-16LE+BOM with an `encoding="UTF-16"` declaration; confirm both still match.
Clean up any leftover probe task with:
`schtasks /Delete /TN "\AgentMesh\*amE2eProbe*" /F` (or via Task Scheduler UI under the `\AgentMesh\` folder).

- [ ] **Step 4: Document the subcommand in `README.md`**

Add a section to `README.md` (place it after the existing `serve` / `serve-a2a`
description; match the surrounding heading style):

````markdown
## Scheduler MCP server (Windows)

`agent-mesh serve-scheduler <folder>` is an MCP server that creates, checks, and
manages **namespaced Windows scheduled tasks** for one project folder. Every task
is scaffolded under `<folder>/schedule/<name>/` (with `run.cmd` and a durable
`logs/run.log`) and registered under the `\AgentMesh\` Task Scheduler namespace —
the server only ever touches tasks it created.

Register it with an MCP client:

```json
{
  "mcpServers": {
    "agent-mesh-scheduler": {
      "command": "node",
      "args": ["c:/AI/agents_mesh/bin/agent-mesh.js", "serve-scheduler", "c:/path/to/project"]
    }
  }
}
```

Tools: `create_task`, `list_tasks`, `get_task`, `run_task`, `enable_task`,
`disable_task`, `delete_task`, `get_task_logs`.

Schedules: `{type:"once",date,time,self_delete?}`, `{type:"daily",time}`,
`{type:"weekly",days,time}`, `{type:"logon"}`. A one-off Claude task is just
`create_task` with `command:"claude"`, `args:["-p","<prompt>"]`, and a
`once` schedule (optionally `self_delete:true`).

Env: `AGENT_MESH_SCHTASKS` (default `schtasks.exe`), `AGENT_MESH_POWERSHELL`
(default `powershell.exe`, status reads only), `AGENT_MESH_SCHEDULER_NS`
(default `\AgentMesh`). The opt-in real-machine test runs with
`AGENT_MESH_SCHEDULER_E2E=1` on Windows.
````

- [ ] **Step 5: Run the full suite once more**

Run: `node --test`
Expected: PASS (scheduler e2e skipped, everything else green).

- [ ] **Step 6: Commit**

```bash
git add test/scheduler-e2e.test.js README.md
git commit -m "feat(scheduler): opt-in real-machine e2e + README docs" -m "Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Done criteria

- `node --test` is green (scheduler e2e skipped by default).
- `agent-mesh serve-scheduler <folder>` completes an MCP `initialize` handshake
  and lists 8 tools.
- On a real Windows host, `AGENT_MESH_SCHEDULER_E2E=1 node --test test/scheduler-e2e.test.js`
  registers, runs, observes, and deletes a probe task.
- All eight tools return structured `{status:'ok'|'error'}` data; no tool throws
  to the client; no user `command`/`args` value ever reaches a command line we
  assemble (only generated `task.xml` / `run.cmd` files carry them).
