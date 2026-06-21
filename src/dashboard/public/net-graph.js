// net-graph.js — Obsidian-style force-directed mesh graph (board2 network view).
//
// Dynamic floating dots with a small custom physics sim (repulsion + springs +
// center gravity, alpha-cooled). Agents are dots sized by collaboration volume;
// CLICKING an agent dot SPLITS it into its skill dots (per-agent) and MCP dots
// (SHARED — one dot per server, linked to every expanded agent that holds the
// grant), each with their own connections. Frequency is shown the Obsidian way:
// node size + link thickness/opacity — never numeric labels.
//
// Interactions: drag any dot · click agent dot = expand/collapse · click the
// agent NAME = open workspace · click a skill/MCP dot = info callback · click
// an agent-agent link = pair-analytics callback · hover = highlight neighbors.

import { nodeRadius } from './net-graph-layout.js';

const REPULSE = 2600;        // Coulomb constant
const SPRING = 0.06;         // spring stiffness
const GRAVITY = 0.015;       // pull toward canvas center
const DAMPING = 0.88;
const ALPHA_DECAY = 0.985;
const ALPHA_MIN = 0.015;
const REST = { peer: 150, child: 52 };
const CLICK_SLOP = 5;        // px of movement that still counts as a click

export function createNetGraph(svg, cb = {}) {
  const NS = 'http://www.w3.org/2000/svg';
  const nodes = new Map();   // id → node {id,kind,label,color,r,x,y,vx,vy,fixed,meta}
  const links = [];          // {a,b,kind:'peer'|'child', w, active}
  const expanded = new Set();
  let data = { agents: [], links: [] };
  let alpha = 0, raf = 0;
  let W = 900, H = 430;

  const gLinks = document.createElementNS(NS, 'g');
  const gNodes = document.createElementNS(NS, 'g');
  svg.append(gLinks, gNodes);

  // ── data assembly ──────────────────────────────────────────────────────────
  function update(d) {
    data = d;
    const vb = svg.viewBox?.baseVal;
    if (vb?.width) { W = vb.width; H = vb.height; }
    const keep = new Set();
    const maxVol = Math.max(1, ...d.agents.map((a) => a.volume));
    for (const a of d.agents) {
      keep.add(a.name);
      const r = nodeRadius(a.volume, maxVol);
      const n = ensure(a.name, 'agent', a.name, a.color, r);
      n.r = r;
      n.meta = a;
    }
    rebuildLinks(keep);
    for (const id of [...nodes.keys()]) if (!keep.has(id)) nodes.delete(id);
    wake(0.6);
  }

  function rebuildLinks(keepAgents) {
    links.length = 0;
    const seen = new Set();
    for (const l of data.links) {
      const key = [l.a, l.b].sort().join('|');
      if (seen.has(key) || !nodes.has(l.a) || !nodes.has(l.b)) continue;
      seen.add(key);
      links.push({ a: l.a, b: l.b, kind: 'peer', w: l.w, active: l.active });
    }
    // children of expanded agents — dot size scales with USAGE frequency
    // (Obsidian idiom: heavier-used = bigger). Shared MCP dots aggregate the
    // counts of every expanded agent that holds the grant.
    const mcpUse = new Map();   // mcp id → summed count across expanded agents
    for (const name of [...expanded]) {
      const agent = data.agents.find((a) => a.name === name);
      if (!agent) { expanded.delete(name); continue; }
      for (const sk of agent.skills) {
        const id = `skill:${name}/${sk.name}`;
        keepAgents.add(id);
        const n = ensure(id, 'skill', sk.name, agent.color, 4, name);
        n.meta = sk;
        n.r = 3.5 + Math.min(6, Math.sqrt(sk.count ?? 0) * 1.8);
        links.push({ a: name, b: id, kind: 'child', w: 0 });
      }
      for (const m of agent.mcps) {
        const id = `mcp:${m.name}`;
        keepAgents.add(id);
        const n = ensure(id, 'mcp', m.name, '#0f766e', 5.5, name);
        n.meta = m;
        mcpUse.set(id, (mcpUse.get(id) ?? 0) + (m.count ?? 0));
        links.push({ a: name, b: id, kind: 'child', w: 0 });
      }
    }
    for (const [id, total] of mcpUse) {
      const n = nodes.get(id);
      if (n) {
        n.r = 5 + Math.min(9, Math.sqrt(total) * 1.6);
        n.meta = { ...n.meta, count: total };
      }
    }
  }

  function ensure(id, kind, label, color, r, nearAgent) {
    let n = nodes.get(id);
    if (!n) {
      const base = nearAgent ? nodes.get(nearAgent) : null;
      const ang = Math.random() * Math.PI * 2;
      const d0 = base ? base.r + 30 : Math.min(W, H) * 0.3;
      n = {
        id, kind, label, color, r,
        x: (base ? base.x : W / 2) + Math.cos(ang) * d0,
        y: (base ? base.y : H / 2) + Math.sin(ang) * d0,
        vx: 0, vy: 0, fixed: false, meta: null
      };
      nodes.set(id, n);
    }
    return n;
  }

  function toggleExpand(name) {
    if (expanded.has(name)) expanded.delete(name);
    else expanded.add(name);
    const keep = new Set(data.agents.map((a) => a.name));
    rebuildLinks(keep);
    for (const id of [...nodes.keys()]) if (!keep.has(id)) nodes.delete(id);
    wake(0.9);
  }

  // ── physics ───────────────────────────────────────────────────────────────
  function tick() {
    const list = [...nodes.values()];
    for (let i = 0; i < list.length; i++) {
      const a = list[i];
      for (let j = i + 1; j < list.length; j++) {
        const b = list[j];
        let dx = a.x - b.x, dy = a.y - b.y;
        let d2 = dx * dx + dy * dy;
        if (d2 < 1) { dx = Math.random() - 0.5; dy = Math.random() - 0.5; d2 = 1; }
        const f = (REPULSE * alpha) / d2;
        const d = Math.sqrt(d2);
        const fx = (dx / d) * f, fy = (dy / d) * f;
        if (!a.fixed) { a.vx += fx; a.vy += fy; }
        if (!b.fixed) { b.vx -= fx; b.vy -= fy; }
      }
    }
    for (const l of links) {
      const a = nodes.get(l.a), b = nodes.get(l.b);
      if (!a || !b) continue;
      const rest = REST[l.kind] + (l.kind === 'child' ? a.r : 0);
      const dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.max(1, Math.hypot(dx, dy));
      const f = SPRING * alpha * (d - rest) / d;
      if (!a.fixed) { a.vx += dx * f; a.vy += dy * f; }
      if (!b.fixed) { b.vx -= dx * f; b.vy -= dy * f; }
    }
    for (const n of list) {
      if (n.fixed) continue;
      n.vx += (W / 2 - n.x) * GRAVITY * alpha;
      n.vy += (H / 2 - n.y) * GRAVITY * alpha;
      n.vx *= DAMPING; n.vy *= DAMPING;
      n.x = Math.max(n.r + 2, Math.min(W - n.r - 2, n.x + n.vx));
      n.y = Math.max(n.r + 12, Math.min(H - n.r - 14, n.y + n.vy));
    }
    alpha *= ALPHA_DECAY;
  }

  function wake(a) {
    alpha = Math.max(alpha, a);
    if (!raf) loop();
  }

  function loop() {
    raf = requestAnimationFrame(() => {
      raf = 0;
      tick();
      render();
      if (alpha > ALPHA_MIN) loop();
    });
  }

  // ── rendering (incremental SVG) ───────────────────────────────────────────
  const linkEls = new Map(), nodeEls = new Map();

  function render() {
    const wantLinks = new Set();
    links.forEach((l, i) => {
      const key = `${l.a}|${l.b}`;
      wantLinks.add(key);
      let el = linkEls.get(key);
      if (!el) {
        el = document.createElementNS(NS, 'line');
        el.dataset.a = l.a; el.dataset.b = l.b;
        gLinks.appendChild(el);
        linkEls.set(key, el);
      }
      const a = nodes.get(l.a), b = nodes.get(l.b);
      el.setAttribute('x1', a.x); el.setAttribute('y1', a.y);
      el.setAttribute('x2', b.x); el.setAttribute('y2', b.y);
      el.setAttribute('class', `ng-link ng-${l.kind}${l.active ? ' live' : ''}`);
      if (l.kind === 'peer') {
        // Obsidian idiom: strength = thickness + presence, no numbers.
        el.style.strokeWidth = (1 + Math.min(5, Math.log2(1 + l.w) * 1.5)).toFixed(2);
        el.style.strokeOpacity = (l.w > 0 ? 0.35 + Math.min(0.5, l.w * 0.08) : 0.16).toFixed(2);
      }
    });
    for (const [key, el] of linkEls) if (!wantLinks.has(key)) { el.remove(); linkEls.delete(key); }

    const wantNodes = new Set();
    for (const n of nodes.values()) {
      wantNodes.add(n.id);
      let el = nodeEls.get(n.id);
      if (!el) {
        el = document.createElementNS(NS, 'g');
        el.classList.add('ng-node', `ng-k-${n.kind}`);
        el.dataset.id = n.id;
        // transparent enlarged hit-target FIRST (under the visual dot): dots
        // float, so clicks need slack or they land on the background.
        const h = document.createElementNS(NS, 'circle');
        h.classList.add('hit');
        h.setAttribute('fill', 'transparent');
        const c = document.createElementNS(NS, 'circle');
        c.classList.add('dot');
        const t = document.createElementNS(NS, 'text');
        t.classList.add('lbl');
        el.append(h, c, t);
        gNodes.appendChild(el);
        nodeEls.set(n.id, el);
      }
      el.setAttribute('transform', `translate(${n.x},${n.y})`);
      const [h, c, t] = el.children;
      h.setAttribute('r', n.r + 8);
      c.setAttribute('r', n.r);
      c.style.fill = n.color;
      c.style.fillOpacity = n.kind === 'agent' ? 0.85 : 0.9;
      if (n.kind === 'agent') {
        el.classList.toggle('expanded', expanded.has(n.id));
        c.style.stroke = n.meta?.state === 'working' ? '#b45309' : n.meta?.state === 'live' ? '#15803d' : 'transparent';
      }
      t.textContent = n.label;
      t.setAttribute('y', n.r + (n.kind === 'agent' ? 13 : 9));
    }
    for (const [id, el] of nodeEls) if (!wantNodes.has(id)) { el.remove(); nodeEls.delete(id); }
  }

  // ── interactions: drag / click / hover ────────────────────────────────────
  let drag = null;
  // setPointerCapture retargets the FOLLOW-UP click event to the svg element
  // itself — without suppression, every node click would read as a background
  // click and instantly close the panel the node click just opened.
  let suppressNextClick = false;
  function svgPoint(ev) {
    const pt = svg.createSVGPoint();
    pt.x = ev.clientX; pt.y = ev.clientY;
    const m = svg.getScreenCTM();
    return m ? pt.matrixTransform(m.inverse()) : pt;
  }

  svg.addEventListener('pointerdown', (ev) => {
    const g = ev.target.closest('.ng-node');
    if (!g) return;
    const n = nodes.get(g.dataset.id);
    if (!n) return;
    const isLabel = ev.target.classList.contains('lbl');
    drag = { n, isLabel, x0: ev.clientX, y0: ev.clientY, moved: false };
    n.fixed = true;
    svg.setPointerCapture(ev.pointerId);
    ev.preventDefault();
  });
  svg.addEventListener('pointermove', (ev) => {
    if (!drag) return;
    if (Math.hypot(ev.clientX - drag.x0, ev.clientY - drag.y0) > CLICK_SLOP) drag.moved = true;
    if (drag.moved) {
      const p = svgPoint(ev);
      drag.n.x = p.x; drag.n.y = p.y;
      drag.n.vx = drag.n.vy = 0;
      wake(0.25);
    }
  });
  svg.addEventListener('pointerup', () => {
    if (!drag) return;
    suppressNextClick = true;
    const { n, isLabel, moved } = drag;
    n.fixed = false;
    drag = null;
    if (moved) { wake(0.3); return; }
    // a CLICK:
    if (n.kind === 'agent') {
      if (isLabel) cb.onOpenAgent?.(n.id);
      else toggleExpand(n.id);
    } else {
      cb.onNodeInfo?.(n);
    }
  });
  svg.addEventListener('click', (ev) => {
    if (suppressNextClick) { suppressNextClick = false; return; }
    const line = ev.target.closest('.ng-link.ng-peer');
    if (line) { cb.onEdgeClick?.(line.dataset.a, line.dataset.b); return; }
    if (ev.target === svg) cb.onBackground?.();
  });
  svg.addEventListener('pointerover', (ev) => {
    const g = ev.target.closest('.ng-node');
    if (!g) return;
    const id = g.dataset.id;
    const near = new Set([id]);
    for (const l of links) {
      if (l.a === id) near.add(l.b);
      if (l.b === id) near.add(l.a);
    }
    for (const [nid, el] of nodeEls) el.classList.toggle('ng-dim', !near.has(nid));
    for (const [key, el] of linkEls) {
      const [a, b] = key.split('|');
      el.classList.toggle('ng-dim', !(a === id || b === id));
    }
  });
  svg.addEventListener('pointerout', (ev) => {
    if (ev.target.closest('.ng-node')) {
      for (const el of nodeEls.values()) el.classList.remove('ng-dim');
      for (const el of linkEls.values()) el.classList.remove('ng-dim');
    }
  });

  return {
    update,
    isExpanded: (name) => expanded.has(name),
    destroy() {
      if (raf) cancelAnimationFrame(raf);
      gLinks.remove(); gNodes.remove();
      nodes.clear(); linkEls.clear(); nodeEls.clear();
    }
  };
}
