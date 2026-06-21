/**
 * src/dashboard/auto-sync.js — PURE-ish coordinator for managed-wiring auto-sync
 * (2026-06-13 spec §4). Debounce-coalesces triggers, serializes runs (one
 * in-flight; a trigger arriving mid-run schedules exactly ONE coalesced rerun),
 * and reports every completed run via onResult({ ok, result?, error? }). The
 * emit-only-on-change filter lives in the SERVER's onResult (checks
 * result.fixed.length), so this stays generic. Never throws.
 */
// `debounceMs` must be a number — the server passes DEFAULT_AUTOSYNC_DEBOUNCE_MS;
// undefined would degrade to setTimeout(fn, 0).
export function createAutoSync({ runSync, schedule = setTimeout, clearSchedule = clearTimeout, debounceMs, onResult, log = () => {} }) {
  let timer = null;
  let running = false;
  let pendingRerun = false;
  let stopped = false;
  let activeRun = null;   // promise of the current execute() chain (for stop() to drain)

  async function execute() {
    if (stopped) return;
    if (running) { pendingRerun = true; return; }   // backstop: runNow racing a run
    running = true;
    const run = (async () => {
      let report;
      try { report = { ok: true, result: await runSync() }; }
      catch (error) { report = { ok: false, error }; log(`auto-sync failed: ${error?.message}`); }
      running = false;
      // onResult OBSERVES only — it must not call trigger()/runNow() back into the
      // coordinator (it would see running=false and arm a spurious extra run). The
      // server's onResult only calls sse.emitSync, which honors this.
      try { onResult(report); } catch { /* observer must not break the loop */ }
      if (pendingRerun && !stopped) { pendingRerun = false; await execute(); }
    })();
    activeRun = run;
    await run;
  }

  function trigger() {
    if (stopped) return;
    // Mid-run: coalesce into ONE rerun via the flag — do NOT also arm a timer
    // (that would double-run: pendingRerun fires it AND the timer fires it).
    if (running) { pendingRerun = true; return; }
    if (timer) clearSchedule(timer);
    // async so the returned promise resolves when the run completes — the test's
    // fake schedule awaits this to sequence deterministically; execute() catches
    // internally so it never rejects (no unhandled-rejection from the real timer).
    timer = schedule(async () => { timer = null; await execute(); }, debounceMs);
    timer?.unref?.();
  }

  async function runNow() {
    if (stopped) return;
    await execute();
  }

  // Async so callers (the dashboard's close()) can DRAIN an in-flight runSync
  // before tearing down — otherwise a fire-and-forget startup doctor write can
  // land after close() returns and race a caller's directory cleanup (the
  // Windows ci-schedules-route ENOTEMPTY flake). Setting `stopped` first prevents
  // any further reruns, so awaiting the current chain is bounded.
  async function stop() {
    stopped = true;
    if (timer) { try { clearSchedule(timer); } catch { /* fake timers */ } timer = null; }
    if (activeRun) { try { await activeRun; } catch { /* observer-safe; never throws */ } }
  }

  return { trigger, runNow, stop };
}
