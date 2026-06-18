/**
 * src/dashboard/schedule-cadence.js — Pure cadence utilities (ESM).
 *
 * validateCadence(c)         → {ok:true} | {ok:false, message:string}
 * computeNextRun(cadence, after:Date) → Date strictly > after
 * describeCadence(c)         → human-readable string
 *
 * Cadence shapes (LOCKED):
 *   {kind:'daily',  at:'HH:MM'}
 *   {kind:'weekly', day:'mon'|…|'sun', at:'HH:MM'}
 *   {kind:'every',  minutes:int≥5}
 *
 * All time arithmetic uses LOCAL time so that HH:MM means the wall-clock
 * time in the user's timezone — DST-agnostic for fixed-Date tests.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DAYS = Object.freeze({
  sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6,
});

const VALID_DAYS = new Set(Object.keys(DAYS));

/** /^\d{2}:\d{2}$/ plus range checks (HH 00-23, MM 00-59). */
function isValidAt(at) {
  if (typeof at !== 'string') return false;
  if (!/^\d{2}:\d{2}$/.test(at)) return false;
  const hh = parseInt(at.slice(0, 2), 10);
  const mm = parseInt(at.slice(3, 5), 10);
  return hh >= 0 && hh <= 23 && mm >= 0 && mm <= 59;
}

// ---------------------------------------------------------------------------
// validateCadence
// ---------------------------------------------------------------------------

/**
 * @param {unknown} c
 * @returns {{ok:true}|{ok:false,message:string}}
 */
export function validateCadence(c) {
  if (c === null || typeof c !== 'object' || Array.isArray(c)) {
    return { ok: false, message: 'cadence must be a non-null object' };
  }

  const { kind } = c;

  if (kind === 'daily') {
    if (!isValidAt(c.at)) {
      return { ok: false, message: 'daily cadence requires at in HH:MM format (00:00–23:59)' };
    }
    return { ok: true };
  }

  if (kind === 'weekly') {
    if (!VALID_DAYS.has(c.day)) {
      return { ok: false, message: `weekly cadence requires day in {${[...VALID_DAYS].join(',')}}` };
    }
    if (!isValidAt(c.at)) {
      return { ok: false, message: 'weekly cadence requires at in HH:MM format (00:00–23:59)' };
    }
    return { ok: true };
  }

  if (kind === 'every') {
    const { minutes } = c;
    if (minutes === undefined || minutes === null) {
      return { ok: false, message: 'every cadence requires minutes' };
    }
    if (typeof minutes !== 'number' || !Number.isInteger(minutes)) {
      return { ok: false, message: 'every cadence minutes must be an integer' };
    }
    if (minutes < 5) {
      return { ok: false, message: 'every cadence minutes must be ≥ 5' };
    }
    return { ok: true };
  }

  return { ok: false, message: `unknown cadence kind: ${JSON.stringify(kind)}` };
}

// ---------------------------------------------------------------------------
// computeNextRun
// ---------------------------------------------------------------------------

/**
 * Parse 'HH:MM' → [hours, minutes].
 * @param {string} at
 * @returns {[number,number]}
 */
function parseAt(at) {
  return [parseInt(at.slice(0, 2), 10), parseInt(at.slice(3, 5), 10)];
}

/**
 * Return a new Date representing the same calendar date as `base` (local) but
 * with the local time set to [hh, mm, 0, 0].
 * @param {Date} base
 * @param {number} hh
 * @param {number} mm
 * @returns {Date}
 */
function sameLocalDay(base, hh, mm) {
  return new Date(base.getFullYear(), base.getMonth(), base.getDate(), hh, mm, 0, 0);
}

/**
 * Compute the next run Date strictly after `after`.
 *
 * @param {{kind:string, at?:string, day?:string, minutes?:number}} cadence
 * @param {Date} after
 * @returns {Date}
 */
export function computeNextRun(cadence, after) {
  if (cadence.kind === 'every') {
    return new Date(after.getTime() + cadence.minutes * 60000);
  }

  if (cadence.kind === 'daily') {
    const [hh, mm] = parseAt(cadence.at);
    const candidate = sameLocalDay(after, hh, mm);
    if (candidate > after) return candidate;
    // today's slot is past (or exactly at `after`); roll to tomorrow
    return new Date(after.getFullYear(), after.getMonth(), after.getDate() + 1, hh, mm, 0, 0);
  }

  if (cadence.kind === 'weekly') {
    const [hh, mm] = parseAt(cadence.at);
    const targetDow = DAYS[cadence.day];   // 0=Sun … 6=Sat
    const afterDow  = after.getDay();      // local day-of-week
    // Days until the next matching weekday (may be 0 = today)
    let daysAhead = (targetDow - afterDow + 7) % 7;
    const candidate = new Date(
      after.getFullYear(), after.getMonth(), after.getDate() + daysAhead, hh, mm, 0, 0,
    );
    if (candidate > after) return candidate;
    // Same weekday and the time slot is past (or exactly equal) → next week
    return new Date(
      after.getFullYear(), after.getMonth(), after.getDate() + daysAhead + 7, hh, mm, 0, 0,
    );
  }

  throw new Error(`computeNextRun: unsupported cadence kind ${cadence.kind}`);
}

// ---------------------------------------------------------------------------
// describeCadence
// ---------------------------------------------------------------------------

/**
 * @param {{kind:string, at?:string, day?:string, minutes?:number}} cadence
 * @returns {string}
 */
export function describeCadence(cadence) {
  if (cadence.kind === 'daily')  return `daily · ${cadence.at}`;
  if (cadence.kind === 'weekly') return `weekly · ${cadence.day} ${cadence.at}`;
  if (cadence.kind === 'every')  return `every ${cadence.minutes} min`;
  return `unknown cadence (${cadence.kind})`;
}
