import test from 'node:test';
import assert from 'node:assert/strict';
import { escapeHtml, safeUrl, imgProxyUrl, renderMarkdownSafe } from '../src/dashboard/render-core.js';

test('escapeHtml neutralizes tags/quotes', () => {
  assert.equal(escapeHtml(`<script>"'&`), '&lt;script&gt;&quot;&#39;&amp;');
});

test('safeUrl allows http(s), rejects javascript/data', () => {
  assert.equal(safeUrl('https://x.test/a'), 'https://x.test/a');
  assert.equal(safeUrl('javascript:alert(1)'), null);
  assert.equal(safeUrl('data:text/html,x'), null);
});

test('renderMarkdownSafe escapes raw HTML, keeps bold/code, rewrites remote img to /api/img', () => {
  const html = renderMarkdownSafe('**hi** <img src=x onerror=alert(1)> `c` ![a](https://covers.test/x.png)');
  assert.ok(html.includes('<b>hi</b>'));
  // The raw <img onerror=…> is neutralized by ESCAPING (shown as inert text), not by
  // deleting the user's text: there must be no LIVE tag/handler, though the literal
  // characters may survive as escaped text.
  assert.ok(html.includes('&lt;img'));              // escaped, not a real element
  assert.ok(!/<img[^>]*onerror/i.test(html));       // no live <img> with an onerror handler
  assert.ok(html.includes('<code>c</code>'));
  assert.ok(html.includes('/api/img?url=https%3A%2F%2Fcovers.test%2Fx.png')); // proxied
});

test('renderMarkdownSafe: a javascript: link becomes inert text', () => {
  const html = renderMarkdownSafe('[click](javascript:alert(1))');
  assert.ok(!/href="javascript/.test(html));
  assert.ok(html.includes('click'));
});

test('imgProxyUrl: rewrites https, rejects non-http(s)/empty', () => {
  assert.equal(imgProxyUrl('https://h.test/a.png'), '/api/img?url=https%3A%2F%2Fh.test%2Fa.png');
  assert.equal(imgProxyUrl('javascript:alert(1)'), null);
  assert.equal(imgProxyUrl(''), null);
});

test('renderMarkdownSafe: link with & in query is NOT double-encoded (I2)', () => {
  const html = renderMarkdownSafe('[s](https://g.test/x?q=a&lang=en)');
  assert.ok(html.includes('href="https://g.test/x?q=a&amp;lang=en"')); // single-escaped &amp;, not &amp;amp;
  assert.ok(!html.includes('&amp;amp;'));
});

test('renderMarkdownSafe: consecutive `- ` lines are wrapped in a single <ul>', () => {
  const html = renderMarkdownSafe('intro\n- one\n- two **bold**\n- three\nafter');
  // Single open + close ul wrapping exactly the three items
  assert.equal((html.match(/<ul class="rc-ul">/g) || []).length, 1);
  assert.equal((html.match(/<\/ul>/g) || []).length, 1);
  assert.equal((html.match(/<li class="rc-li">/g) || []).length, 3);
  assert.ok(html.includes('<li class="rc-li">two <b>bold</b></li>'));
  // Paragraphs before/after the list stay paragraphs
  assert.ok(html.includes('<p class="rc-p">intro</p>'));
  assert.ok(html.includes('<p class="rc-p">after</p>'));
});

test('renderMarkdownSafe: GFM pipe table → <table class="rc-table">', () => {
  const src = [
    'On **shelf 3**:',
    '',
    '| Title | Author | Shelf |',
    '|-------|--------|------:|',
    '| Dune | Frank Herbert | 3 |',
    '| Dune Messiah | Frank Herbert | 3 |',
    '',
    'end'
  ].join('\n');
  const html = renderMarkdownSafe(src);
  assert.ok(html.includes('<table class="rc-table">'),  'renders a real table, not raw pipes');
  assert.ok(html.includes('<th>Title</th>'),            'header cells in <th>');
  assert.ok(html.includes('<th class="r">Shelf</th>'),  'right-align column from `------:` separator');
  assert.ok(html.includes('<td>Dune</td>'),             'body cells in <td>');
  assert.ok(html.includes('<td class="r">3</td>'),      'right-aligned cell carries the .r class');
  assert.ok(!/^<p class="rc-p">\| Title \| Author/m.test(html), 'no leftover pipe paragraph');
  // surrounding prose still rendered
  assert.ok(html.includes('<p class="rc-p">On <b>shelf 3</b>:</p>'));
  assert.ok(html.includes('<p class="rc-p">end</p>'));
});

test('renderMarkdownSafe: user text containing a fake placeholder is not corrupted (I1)', () => {
  // a forged @@B0@@ / @@RC_*_0@@ must render literally, never "undefined" or a dup block
  assert.ok(renderMarkdownSafe('the value @@B0@@ here').includes('@@B0@@'));
  const dup = renderMarkdownSafe('```\ncode\n```\n@@RC_x_0@@');
  assert.ok(!dup.includes('undefined'));
  assert.equal((dup.match(/<pre/g) || []).length, 1); // real code block once; forged token didn't dup it
  assert.ok(dup.includes('@@RC_x_0@@'));              // forged token (wrong nonce) stays literal
});

// ── Task 2: renderChartSvg ───────────────────────────────────────────────────
import { renderChartSvg } from '../src/dashboard/render-core.js';

test('renderChartSvg: valid bar spec → SVG with escaped labels', () => {
  const svg = renderChartSvg({ type: 'bar', labels: ['Jan', '<b>Feb</b>'], values: [3, 7] });
  assert.ok(svg.startsWith('<svg'));
  assert.ok(svg.includes('&lt;b&gt;Feb'));     // label escaped
  assert.ok(/<rect/.test(svg));
});

test('renderChartSvg: line spec → polyline', () => {
  assert.ok(/<polyline/.test(renderChartSvg({ type: 'line', labels: ['a','b','c'], values: [1,2,3] })));
});

test('renderChartSvg: rejects malformed/oversized/non-numeric → null', () => {
  assert.equal(renderChartSvg({ type: 'pie', labels: [], values: [] }), null);     // unsupported type
  assert.equal(renderChartSvg({ type: 'bar', labels: ['a'], values: ['x'] }), null); // non-numeric
  assert.equal(renderChartSvg({ type: 'bar', labels: Array(500).fill('a'), values: Array(500).fill(1) }), null); // too many
  assert.equal(renderChartSvg('not an object'), null);
});

// ── Task 3: lineRecordToHtml + copyTextForBlock ──────────────────────────────
import { lineRecordToHtml, copyTextForBlock } from '../src/dashboard/render-core.js';

test('lineRecordToHtml renders each event type with a copy affordance', () => {
  const html = lineRecordToHtml({ seq: 7, events: [
    { type: 'user_text', text: 'find dune' },
    { type: 'tool_use', name: 'search_books', input: { q: 'dune' } },
    { type: 'tool_result', content: 'Dune — shelf 3' },
    { type: 'text', text: '**Dune** by Herbert' }
  ]});
  assert.ok(html.includes('rc-you'));               // user bubble
  assert.ok(html.includes('search_books'));         // tool card
  assert.ok(html.includes('<b>Dune</b>'));          // assistant markdown
  assert.ok((html.match(/data-copy=/g) || []).length >= 3); // per-block copy affordances
});

test('lineRecordToHtml renders a chart fence inside text as SVG', () => {
  const html = lineRecordToHtml({ seq: 1, events: [{ type: 'text', text: '```chart\n{"type":"bar","labels":["a"],"values":[2]}\n```' }] });
  assert.ok(html.includes('<svg'));
});

test('copyTextForBlock returns the source text for text/code/table', () => {
  assert.equal(copyTextForBlock('text', '**hi**'), '**hi**');
});

// ── board/activity channel split ─────────────────────────────────────────────
import { eventChannel, lineRecordToChannels } from '../src/dashboard/render-core.js';

test('eventChannel routes conversation→board, process→activity, tools→both', () => {
  assert.equal(eventChannel('user_text'), 'board');
  assert.equal(eventChannel('text'), 'board');
  // tool calls/results are dual-lane: a polished card on the chat board AND a
  // compact event in the activity side panel (so the chat tells a complete
  // story while activity remains the canonical operations log).
  assert.equal(eventChannel('tool_use'), 'both');
  assert.equal(eventChannel('tool_result'), 'both');
  assert.equal(eventChannel('init'), 'activity');
  assert.equal(eventChannel('turn_done'), 'activity');
  assert.equal(eventChannel('turn_done', { result: 'hello' }), 'board');
  assert.equal(eventChannel('error'), 'activity');
  assert.equal(eventChannel('raw'), 'activity');
  assert.equal(eventChannel('thinking'), 'activity');   // unknown/future → activity
});

test('lineRecordToChannels splits the clean blackboard from the process panel (tools land in both)', () => {
  const { board, activity } = lineRecordToChannels({ seq: 1, events: [
    { type: 'user_text', text: 'find dune' },
    { type: 'init', sessionId: 'abcdef12', model: 'opus' },
    { type: 'tool_use', name: 'search_books', input: { q: 'dune' } },
    { type: 'tool_result', content: 'Dune — shelf 3' },
    { type: 'text', text: '**Dune** by Herbert' },
    { type: 'turn_done' },
    { type: 'error', code: 'oops', message: 'bad' },
    { type: 'raw', raw: '{"x":1}' }
  ]});
  // board: conversation + tool cards (both lanes)
  assert.ok(board.includes('rc-you'));
  assert.ok(board.includes('<b>Dune</b>'));
  assert.ok(board.includes('search_books'));     // tool_use also on the board now
  assert.ok(board.includes('Dune — shelf 3') || board.includes('shelf 3')); // tool_result also
  assert.ok(!board.includes('end of turn'));     // process noise stays activity-only
  assert.ok(!board.includes('session abcdef12'));// init meta stays activity-only
  // activity: process noise + tools (both lanes)
  assert.ok(activity.includes('search_books'));   // tool_use
  assert.ok(activity.includes('Dune — shelf 3') || activity.includes('shelf 3'));
  assert.ok(activity.includes('session abcdef12'));
  assert.ok(activity.includes('end of turn'));
  assert.ok(activity.includes('oops'));
  assert.ok(activity.includes('"x":1') || activity.includes('x'));
  assert.ok(!activity.includes('rc-you'));        // user prompt NOT in activity
});

test('lineRecordToChannels renders a final turn_done result on the board', () => {
  const { board, activity } = lineRecordToChannels({ seq: 1, events: [
    { type: 'turn_done', result: 'Hi from Claude', isError: false }
  ]});
  assert.ok(board.includes('Hi from Claude'));
  assert.ok(board.includes('rc-text'));
  assert.equal(activity, '');
});

test('lineRecordToChannels: empty/invalid rec → both channels empty', () => {
  assert.deepEqual(lineRecordToChannels(null), { board: '', activity: '' });
  assert.deepEqual(lineRecordToChannels({ seq: 1 }), { board: '', activity: '' });
});

test('lineRecordToHtml embeds exact source in data-raw (escaped) for copy fidelity', () => {
  const html = lineRecordToHtml({ seq: 1, events: [{ type: 'text', text: '**bold** & <x>' }] });
  assert.ok(html.includes('data-raw="**bold** &amp; &lt;x&gt;"')); // original markdown, attr-escaped
});
