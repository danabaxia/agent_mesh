import test from 'node:test';
import assert from 'node:assert/strict';
import { followTarget, isUserOrigin } from '../src/dashboard/public/follow-policy.js';

const row = (id, { origin = 'cli', active = false, endedAt = 0 } = {}) =>
  ({ id, originSource: origin, active, endedAt });

test('isUserOrigin: cli and dashboard yes; peer/worker no; headroom yes', () => {
  assert.equal(isUserOrigin('cli'), true);
  assert.equal(isUserOrigin('dashboard'), true);
  assert.equal(isUserOrigin('peer:B'), false);
  assert.equal(isUserOrigin('worker:digest'), false);
  assert.equal(isUserOrigin('headroom'), true); // rotated-in generations are user threads
});

test('pin wins over everything', () => {
  const rows = [row('live', { active: true, endedAt: 100 }), row('pinned')];
  const got = followTarget(rows, { currentId: 'live', pinnedId: 'pinned', lastSeen: {}, canonicalId: 'live' });
  assert.equal(got, 'pinned');
});

test('a grown user-origin session beats canonical; worker/peer growth never followed', () => {
  const rows = [
    row('canon', { origin: 'dashboard', endedAt: 50 }),
    row('mine', { origin: 'cli', active: true, endedAt: 200 }),
    row('digestrun', { origin: 'worker:digest', active: true, endedAt: 300 }),
    row('peer', { origin: 'peer:B', active: true, endedAt: 400 })
  ];
  const got = followTarget(rows, { currentId: null, pinnedId: null, canonicalId: 'canon',
    lastSeen: { mine: 100, digestrun: 100, peer: 100 } });
  assert.equal(got, 'mine');
});

test('sticky: current stays while active even if another user session grew', () => {
  const rows = [
    row('a', { active: true, endedAt: 300 }),
    row('b', { active: true, endedAt: 500 })
  ];
  const got = followTarget(rows, { currentId: 'a', pinnedId: null, canonicalId: null,
    lastSeen: { a: 200, b: 200 } });
  assert.equal(got, 'a');
});

test('quiet current + grown other → switch; fallback chain canonical → newest', () => {
  const rows = [row('a', { active: false, endedAt: 100 }), row('b', { active: true, endedAt: 500 })];
  assert.equal(followTarget(rows, { currentId: 'a', pinnedId: null, canonicalId: null, lastSeen: { b: 400 } }), 'b');
  const quietRows = [row('x', { endedAt: 10 }), row('canon', { origin: 'dashboard', endedAt: 5 })];
  assert.equal(followTarget(quietRows, { currentId: null, pinnedId: null, canonicalId: 'canon', lastSeen: {} }), 'canon');
  assert.equal(followTarget(quietRows, { currentId: null, pinnedId: null, canonicalId: 'gone', lastSeen: {} }), 'x');
  assert.equal(followTarget([], { currentId: null, pinnedId: null, canonicalId: null, lastSeen: {} }), null);
});
