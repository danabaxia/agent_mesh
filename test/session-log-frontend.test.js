/**
 * test/session-log-frontend.test.js
 *
 * Regression coverage for the dashboard chat pane composition. When the
 * session-log capability is enabled, the right pane intentionally has two
 * interaction surfaces:
 *   - the dashboard-native chat composer; and
 *   - the session-log / CLI mirror.
 *
 * The important invariant is that the dashboard-native composer must drive the
 * session-resume endpoint, not the one-shot A2A /message endpoint.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

function fakeElement(id) {
  const listeners = {};
  const el = {
    id,
    innerHTML: '',
    title: '',
    textContent: '',
    value: '',
    style: {},
    dataset: {},
    _width: 320,
    attrs: new Map(),
    setAttribute(name, value) { this.attrs.set(name, String(value)); },
    getAttribute(name) { return this.attrs.get(name) || null; },
    getBoundingClientRect() {
      const width = Number.parseFloat(this.style.width) || this._width || 0;
      return { width };
    },
    addEventListener(type, cb) { listeners[type] = cb; },
    removeEventListener(type) { delete listeners[type]; },
    dispatch(type, event = {}) { listeners[type]?.(event); },
    listeners,
    classList: {
      values: new Set(),
      add(...names) { for (const name of names) this.values.add(name); },
      remove(...names) { for (const name of names) this.values.delete(name); },
      toggle(name, force) {
        const on = force === undefined ? !this.values.has(name) : !!force;
        if (on) this.values.add(name); else this.values.delete(name);
        return on;
      },
      contains(name) { return this.values.has(name); }
    },
    querySelector(selector) {
      if (selector === '#sl-mount' && this.innerHTML.includes('id="sl-mount"')) {
        return fakeElement('sl-mount');
      }
      return null;
    },
    querySelectorAll() { return []; },
    appendChild() {},
    remove() {}
  };
  return el;
}

function fakeCard(agentName) {
  const el = fakeElement(`card-${agentName}`);
  let livebar = null;
  el.setAttribute('data-agent', agentName);
  el.querySelector = (selector) => {
    if (selector === 'h3') return { textContent: agentName };
    if (selector === '.livebar') return livebar;
    return null;
  };
  el.insertAdjacentHTML = (_position, html) => {
    livebar = fakeElement(`livebar-${agentName}`);
    livebar.innerHTML = html;
    livebar.remove = () => { livebar = null; };
  };
  el.getLivebarHtml = () => livebar?.innerHTML || '';
  return el;
}

function fakeCardsElement(cards) {
  const el = fakeElement('cards');
  el.querySelectorAll = (selector) => (selector === '.card' || selector === '.card[data-agent]') ? cards : [];
  return el;
}

async function loadDashboardApp(options = {}) {
  const code = await readFile(resolve('src/dashboard/public/app.js'), 'utf8');
  const inspect = options.elements?.inspect || fakeElement('inspect');
  const elements = { inspect, ...(options.elements || {}) };
  const mounts = [];
  const fetchCalls = [];
  const documentListeners = {};
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    window: {
      mountSessionLog(el, name) {
        mounts.push({ el, name });
        return { destroy() {} };
      },
      removeEventListener() {},
      addEventListener() {}
    },
    document: {
      getElementById(id) { return elements[id] || null; },
      addEventListener(type, cb) { documentListeners[type] = cb; },
      removeEventListener(type, cb) {
        if (!cb || documentListeners[type] === cb) delete documentListeners[type];
      },
      createElement(tag) { return fakeElement(tag); },
      querySelectorAll(selector) {
        return options.querySelectorAll ? options.querySelectorAll(selector) : [];
      },
      body: { style: {} }
    },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: options.fetch || (async (url, options) => {
      fetchCalls.push({ url, options });
      return { ok: true, status: 202, json: async () => ({ ok: true, turnId: 'T1' }) };
    }),
    EventSource: undefined
  };
  const api = vm.runInNewContext(`${code}
({
  applyScope,
  initResizable,
  setChatAgent,
  wireConsole,
  resetChatPane,
  setMeshData(value) { meshData = value; },
  setBoardType(value) { boardType = value; },
  setActivity(value) { activity = value; },
  setSessionLogEnabled(value) { sessionLogEnabled = value; },
  setChatEnabled(value) { chatEnabled = value; },
  updateAgentActivityCards,
  getInspect() { return document.getElementById('inspect'); }
});`, sandbox);
  return { api, inspect, mounts, fetchCalls, documentListeners };
}

test('session-log mode keeps the dashboard chat and the CLI mirror pane', async () => {
  const { api, inspect, mounts } = await loadDashboardApp();

  api.setSessionLogEnabled(true);
  api.setChatEnabled(true); // in-dashboard chat is opt-in (off by default); this test covers the chat-on path
  api.setChatAgent('alpha', 'served', ['ask']);

  assert.match(inspect.innerHTML, /id="sl-mount"/);
  assert.match(inspect.innerHTML, /class="console"/);
  assert.match(inspect.innerHTML, /id="composer"/);
  assert.doesNotMatch(inspect.innerHTML, /class="insp-head"/);
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].name, 'alpha');
  assert.equal(inspect.classList.contains('has-sl'), true);
});

test('read-only session-log mode mounts only the CLI mirror pane', async () => {
  const { api, inspect, mounts } = await loadDashboardApp();

  api.setSessionLogEnabled(true);
  api.setChatEnabled(false);
  api.setChatAgent('alpha', 'served', ['ask']);

  assert.match(inspect.innerHTML, /id="sl-mount"/);
  assert.doesNotMatch(inspect.innerHTML, /class="insp-head"/);
  assert.doesNotMatch(inspect.innerHTML, /Chat disabled/);
  assert.doesNotMatch(inspect.innerHTML, /read-only/);
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0].name, 'alpha');
  assert.equal(inspect.classList.contains('has-sl'), true);
});

test('scope change filters agent cards before the explorer tree finishes loading', async () => {
  const knowledgeCard = fakeCard('knowledge');
  const dataCard = fakeCard('data-analyst');
  const never = new Promise(() => {});
  const { api } = await loadDashboardApp({
    elements: {
      scope: fakeElement('scope'),
      explorer: fakeElement('explorer'),
      exph: fakeElement('exph'),
      cards: fakeCardsElement([knowledgeCard, dataCard]),
      'card-detail': fakeElement('card-detail')
    },
    fetch: async () => never
  });

  api.setMeshData({
    agents: [
      { name: 'knowledge', status: 'served', modes: ['ask'] },
      { name: 'data-analyst', status: 'served', modes: ['ask'] }
    ]
  });
  api.setBoardType('agent');
  api.setSessionLogEnabled(false);
  api.setChatEnabled(false);
  api.applyScope('data-analyst');

  assert.equal(knowledgeCard.classList.contains('scope-hidden'), true);
  assert.equal(dataCard.classList.contains('scope-hidden'), false);
});

test('activity updates mutate agent card overlays without rebuilding the cards container', async () => {
  const alphaCard = fakeCard('alpha');
  const betaCard = fakeCard('beta');
  const cards = fakeCardsElement([alphaCard, betaCard]);
  cards.innerHTML = '<div class="card" data-agent="alpha">stable</div>';

  const { api } = await loadDashboardApp({
    elements: { cards }
  });

  api.setActivity({
    agents: [{ name: 'alpha', state: 'working', route: 'tool' }],
    edges: [],
    events: []
  });
  api.updateAgentActivityCards();

  assert.equal(cards.innerHTML, '<div class="card" data-agent="alpha">stable</div>');
  assert.equal(alphaCard.classList.contains('pulse'), true);
  assert.match(alphaCard.getLivebarHtml(), /working/);
  assert.equal(betaCard.getLivebarHtml(), '');

  api.setActivity({
    agents: [{ name: 'alpha', state: 'done', route: 'orchestrate' }],
    edges: [],
    events: []
  });
  api.updateAgentActivityCards();

  assert.equal(cards.innerHTML, '<div class="card" data-agent="alpha">stable</div>');
  assert.equal(alphaCard.classList.contains('pulse'), false);
  assert.match(alphaCard.getLivebarHtml(), /done/);
});

test('dashboard chat posts to the session-resume endpoint in session-log mode', async () => {
  const { api, fetchCalls } = await loadDashboardApp();

  api.setSessionLogEnabled(true);

  const listeners = {};
  const form = { addEventListener(type, cb) { listeners[type] = cb; } };
  const input = {
    value: 'continue from the current session',
    disabled: false,
    focus() {},
    addEventListener() {}
  };
  const sendBtn = { disabled: false };
  const log = { appendChild() {}, scrollTop: 0, scrollHeight: 0 };
  const desk = {
    querySelector(selector) {
      if (selector === '#composer') return form;
      if (selector === '#cinput') return input;
      if (selector === '#csend') return sendBtn;
      if (selector === '#clog') return log;
      return null;
    }
  };

  api.wireConsole(desk, 'alpha', 'served', ['ask']);
  listeners.submit({ preventDefault() {} });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(fetchCalls.length, 1);
  assert.equal(fetchCalls[0].url, '/api/agent/alpha/session/message');
  assert.deepEqual(JSON.parse(fetchCalls[0].options.body), {
    text: 'continue from the current session'
  });
});

test('horizontal gutters resize adjacent Files/Board/Chat panes as pairs', async () => {
  const tree = fakeElement('pane-tree');
  const center = fakeElement('pane-center');
  const inspect = fakeElement('inspect');
  const leftGutter = fakeElement('gutter-tree');
  const rightGutter = fakeElement('gutter-inspect');
  const preset = fakeElement('lay-all');
  leftGutter.dataset.g = 'tree';
  rightGutter.dataset.g = 'inspect';
  tree._width = 240;
  center._width = 600;
  inspect._width = 340;
  inspect.classList.add('wide-50');
  preset.classList.add('on');

  const { api, documentListeners } = await loadDashboardApp({
    elements: { 'pane-tree': tree, 'pane-center': center, inspect },
    querySelectorAll(selector) {
      if (selector === '.gutter') return [leftGutter, rightGutter];
      if (selector === '.layoutpre button') return [preset];
      return [];
    }
  });

  api.initResizable();

  leftGutter.dispatch('mousedown', { preventDefault() {}, clientX: 100 });
  documentListeners.mousemove({ clientX: 150 });
  assert.equal(tree.style.width, '290px');
  assert.equal(center.style.width, '550px');
  assert.equal(tree.style.flex, 'none');
  assert.equal(center.style.flex, 'none');

  center._width = 550;
  inspect._width = 340;
  center.style.width = '';
  inspect.style.width = '';
  rightGutter.dispatch('mousedown', { preventDefault() {}, clientX: 300 });
  documentListeners.mousemove({ clientX: 220 });
  assert.equal(center.style.width, '470px');
  assert.equal(inspect.style.width, '420px');
  assert.equal(inspect.classList.contains('wide-50'), false);
  assert.equal(preset.classList.contains('on'), false);
});

// ---------------------------------------------------------------------------
// Activity feed rendering — a2a event template
// ---------------------------------------------------------------------------

test('renderActivityFeed: a2a event renders from→to and never "undefined"', async () => {
  const code = await readFile(resolve('src/dashboard/public/app.js'), 'utf8');
  const feed = fakeElement('feed');
  const sandbox = {
    console,
    setTimeout,
    clearTimeout,
    window: { removeEventListener() {}, addEventListener() {} },
    document: {
      getElementById(id) { return id === 'feed' ? feed : null; },
      addEventListener() {},
      removeEventListener() {},
      createElement(tag) { return fakeElement(tag); },
      querySelectorAll() { return []; },
      body: { style: {} }
    },
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async () => ({ ok: true, status: 200, json: async () => ({}) }),
    EventSource: undefined
  };
  const api = vm.runInNewContext(`${code}
({
  setActivity(value) { activity = value; },
  renderActivityFeed,
});`, sandbox);

  // Inject a mix: one a2a event and one regular done event.
  api.setActivity({
    events: [
      { kind: 'a2a', from: 'data-analyst', to: 'knowledge', mode: 'ask', status: 'completed', at: '2026-06-09T10:00:01Z' },
      { kind: 'done', agent: 'app', route: 'orchestrate', at: '2026-06-09T10:00:02Z' }
    ]
  });
  api.renderActivityFeed();

  const html = feed.innerHTML;
  // a2a event: must show from → to, not "undefined"
  assert.ok(html.includes('data-analyst'), 'from agent present');
  assert.ok(html.includes('knowledge'), 'to agent present');
  assert.ok(html.includes('→'), 'arrow separator present');
  assert.ok(html.includes('⇄ a2a ✓'), 'completed status label present');
  assert.ok(!html.includes('undefined'), 'no literal "undefined" in rendered output');
  // Regular done event still renders normally
  assert.ok(html.includes('✓ done'), 'done event still renders');
});
