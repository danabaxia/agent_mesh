// test/md-lite.test.js — tiny markdown renderer (1:1 port of gen_real_demo.py md()/inline()).
import test from 'node:test';
import assert from 'node:assert/strict';
import { mdToHtml } from '../src/dashboard/public/md-lite.js';

test('pipe table (header + :--- separator) renders th/td', () => {
  const html = mdToHtml('| name | count |\n| :--- | ---: |\n| foo | 1 |\n| bar | 2 |');
  assert.ok(html.includes('<table>'));
  assert.ok(html.includes('<th>name</th>'));
  assert.ok(html.includes('<th>count</th>'));
  assert.ok(html.includes('<td>foo</td>'));
  assert.ok(html.includes('<td>2</td>'));
  assert.ok(html.includes('</table>'));
});

test('fenced code block -> <pre class="cb"><code> and escapes content', () => {
  const html = mdToHtml('```\nconst ok = 1 < 2 && "x";\n```');
  assert.ok(html.includes('<pre class="cb"><code>'));
  assert.ok(html.includes('1 &lt; 2 &amp;&amp;'));
  assert.ok(html.includes('</code></pre>'));
  assert.ok(!html.includes('1 < 2')); // raw form must not survive
});

test('hostile <script> input is escaped — no executable script tag in output', () => {
  const html = mdToHtml('<script>alert(1)</script>');
  assert.ok(!/<script\b/i.test(html));
  assert.ok(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'));
});

test('headings #..#### map to h3..h5 (capped at h5)', () => {
  assert.ok(mdToHtml('# Top').includes('<h3>Top</h3>'));
  assert.ok(mdToHtml('## Second').includes('<h4>Second</h4>'));
  assert.ok(mdToHtml('### Third').includes('<h5>Third</h5>'));
  assert.ok(mdToHtml('#### Fourth').includes('<h5>Fourth</h5>')); // capped
});

test('inline bold + code inside a paragraph', () => {
  const html = mdToHtml('a **bold** word and `some_code` here');
  assert.ok(html.startsWith('<p>'));
  assert.ok(html.includes('<b>bold</b>'));
  assert.ok(html.includes('<code>some_code</code>'));
});

test('bullet/numbered lists and hr', () => {
  const html = mdToHtml('- one\n- two\n\n---\n\n1. first\n2. second');
  assert.ok(html.includes('<ul>'));
  assert.ok(html.includes('<li>one</li>'));
  assert.ok(html.includes('<li>two</li>'));
  assert.ok(html.includes('</ul>'));
  assert.ok(html.includes('<hr>'));
  assert.ok(html.includes('<ol>'));
  assert.ok(html.includes('<li>second</li>'));
  assert.ok(html.includes('</ol>'));
});
