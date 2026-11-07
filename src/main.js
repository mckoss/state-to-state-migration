import './style.css';
import * as d3 from 'd3';
import { feature } from 'topojson-client';
import us from 'us-atlas/states-albers-10m.json';

const BASE = import.meta.env.BASE_URL;
document.getElementById('version').textContent = `v${__APP_VERSION__}`;

// ---------- formatting ----------
const fmtInt = d3.format(',');
const MINUS = '−';
const fmtSigned = (v) => (v > 0 ? '+' : v < 0 ? MINUS : '') + fmtInt(Math.abs(v));
function fmtCompact(v) {
  const a = Math.abs(v);
  const s = v < 0 ? MINUS : '';
  if (a >= 1e6) return `${s}${(a / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${s}${Math.round(a / 1e3)}k`;
  if (a >= 1e3) return `${s}${(a / 1e3).toFixed(1)}k`;
  return `${s}${a}`;
}
const fmtRate = (v) => (v === null || v === undefined || Number.isNaN(v) ? '—' : (v > 0 ? '+' : v < 0 ? MINUS : '') + Math.abs(v).toFixed(1));
const moeOf = (...m) => Math.round(Math.sqrt(m.reduce((s, x) => s + (x || 0) ** 2, 0)));
// ACS margins of error are 90% intervals: an estimate is statistically
// different from zero only when it is larger than its margin of error.
const isSig = (v, moe) => Math.abs(v) > (moe || 0);
/** Tooltip note on an estimate's 90% range; `flow` estimates can't be negative. */
function rangeNote(v, moe, kind = 'net') {
  const lo = kind === 'flow' ? Math.max(0, v - moe) : v - moe;
  const f = kind === 'flow' ? fmtInt : fmtSigned;
  const range = `${f(lo)} to ${f(v + moe)}`;
  if (isSig(v, moe)) return { text: `90% range: ${range}.` };
  return {
    warn: true,
    text: kind === 'flow'
      ? `Not statistically significant: the 90% range is ${range}, so this flow may be close to zero.`
      : `Not statistically significant: the 90% range, ${range}, includes zero, so the survey can't tell whether this is a gain or a loss.`,
  };
}

// ---------- DOM helpers ----------
function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'style') node.style.cssText = v;
    else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return node;
}
const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

// ---------- tooltip ----------
const tip = document.getElementById('tooltip');
function showTip(event, title, rows, note) {
  tip.replaceChildren(
    el('div', { class: 'tt-title' }, title),
    ...rows.map(([k, v, color]) =>
      el('div', { class: 'tt-row' },
        el('span', { class: 'k' }, color ? el('span', { class: 'tt-key', style: `border-color:${color}` }) : null, k),
        el('span', { class: 'v' }, v))),
    ...[note].flat().filter(Boolean).map((n) =>
      el('div', { class: typeof n === 'object' && n.warn ? 'tt-note tt-warn' : 'tt-note' }, typeof n === 'object' ? n.text : n)),
  );
  tip.hidden = false;
  moveTip(event);
}
function moveTip(event) {
  if (tip.hidden) return;
  const pad = 14;
  let x = event.clientX + pad;
  let y = event.clientY + pad;
  const r = tip.getBoundingClientRect();
  if (x + r.width > window.innerWidth - 8) x = event.clientX - r.width - pad;
  if (y + r.height > window.innerHeight - 8) y = event.clientY - r.height - pad;
  tip.style.left = `${Math.max(8, x)}px`;
  tip.style.top = `${Math.max(8, y)}px`;
}
function hideTip() {
  tip.hidden = true;
}
function tipAtElement(node, title, rows, note) {
  const r = node.getBoundingClientRect();
  showTip({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 }, title, rows, note);
}

// ---------- app state ----------
const app = {
  index: null,
  states: [],
  byFips: new Map(),
  byAbbr: new Map(),
  acs: new Map(),
  popest: null,
  year: null,
  sel: -1,
  mode: 'net',
  topN: 12,
  popestYear: null,
  peMeasure: 'netmig',
  peUnits: 'people',
  sorts: { flows: null, popest: { key: 'domesticmig', dir: -1 } },
};

async function getJson(file) {
  const res = await fetch(`${BASE}data/${file}`);
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  return res.json();
}

// A dataset key is a survey year (2024) or a combined key ('last5', 'last10').
const comboMeta = (key) => app.index.combined?.find((c) => c.key === key) ?? null;
const isCombined = (key = app.year) => typeof key === 'string';
/** Short label for titles: "2024" or "2019–2024 combined". */
const dsLabel = (key = app.year) => (isCombined(key) ? comboMeta(key).short : String(key));
/** Survey years in a dataset. */
const dsYears = (key = app.year) => (isCombined(key) ? comboMeta(key).years : [key]);
function parseDsKey(v) {
  if (comboMeta(v)) return v;
  const y = Number(v);
  return app.index.acs.some((a) => a.year === y) ? y : null;
}

async function getAcs(key) {
  if (!app.acs.has(key)) {
    const meta = isCombined(key) ? comboMeta(key) : app.index.acs.find((a) => a.year === key);
    app.acs.set(key, getJson(meta.file));
  }
  return app.acs.get(key);
}

// ---------- flow math ----------
// est[d][o]: people living in d now who lived in o one year earlier.
const flow = (m, o, d) => m.est[d][o] ?? 0;
const flowMoe = (m, o, d) => m.moe[d][o] ?? 0;
const isSuppressed = (m, o, d) => o !== d && m.est[d][o] === null;

function totals(m) {
  const n = m.est.length;
  return d3.range(n).map((i) => {
    let inflow = 0;
    let outflow = 0;
    let mi = 0;
    let mo = 0;
    for (let j = 0; j < n; j++) {
      if (j === i) continue;
      inflow += flow(m, j, i);
      outflow += flow(m, i, j);
      mi += flowMoe(m, j, i) ** 2;
      mo += flowMoe(m, i, j) ** 2;
    }
    return {
      i,
      inflow,
      outflow,
      net: inflow - outflow,
      // Prefer the Census Bureau's published total MOEs; the root-sum-of-squares
      // approximation over 51 partner flows overstates them by roughly 5-15%.
      ...(() => {
        const inMoe = m.inMoe?.[i] ?? Math.round(Math.sqrt(mi));
        const outMoe = m.outMoe?.[i] ?? Math.round(Math.sqrt(mo));
        return { inMoe, outMoe, netMoe: moeOf(inMoe, outMoe) };
      })(),
    };
  });
}

function partners(m, s) {
  return d3.range(m.est.length)
    .filter((j) => j !== s)
    .map((j) => {
      const inflow = flow(m, j, s);
      const outflow = flow(m, s, j);
      return {
        i: j,
        inflow,
        outflow,
        net: inflow - outflow,
        inMoe: flowMoe(m, j, s),
        outMoe: flowMoe(m, s, j),
        netMoe: moeOf(flowMoe(m, j, s), flowMoe(m, s, j)),
        inSup: isSuppressed(m, j, s),
        outSup: isSuppressed(m, s, j),
      };
    });
}

// ---------- map ----------
const svg = d3.select('#map');
const path = d3.geoPath();
const statesGeo = feature(us, us.objects.states).features;
const gStates = svg.append('g');
const gAbbr = svg.append('g');
const gArrows = svg.append('g');
const gLabels = svg.append('g');

// Visual anchors for arrows; centroids are adjusted where a state's shape
// pulls its centroid somewhere awkward.
const ANCHOR_OVERRIDES = {
  '12': [798, 532], // Florida: on the peninsula, not the panhandle
  '26': [692, 188], // Michigan: lower peninsula
  '22': [566, 470], // Louisiana: away from the delta
  '16': [202, 165], // Idaho: southern half
};
const PR_POS = [880, 585];
const anchors = new Map();
const PR_FIPS = '72';

const shapes = [
  ...statesGeo.map((f) => ({ fips: f.id, d: path(f) })),
  // Puerto Rico is not in the Albers USA projection; draw a placeholder tile.
  { fips: PR_FIPS, d: `M${PR_POS[0] - 11},${PR_POS[1] - 7}h22v14h-22z` },
];
// Too small to label without overlapping their neighbors.
const SKIP_LABEL = new Set(['11', '44', '10']);
const labelY = (s) => (s.fips === PR_FIPS ? PR_POS[1] + 16 : anchors.get(s.fips)[1]);

function initMap() {
  for (const f of statesGeo) anchors.set(f.id, ANCHOR_OVERRIDES[f.id] || path.centroid(f));
  anchors.set(PR_FIPS, PR_POS);

  gStates.selectAll('path')
    .data(shapes)
    .join('path')
    .attr('class', 'state')
    .attr('d', (s) => s.d)
    .attr('tabindex', 0)
    .attr('role', 'button')
    .attr('aria-label', (s) => app.byFips.get(s.fips).name)
    .on('click', (e, s) => toggleState(app.byFips.get(s.fips).i))
    .on('keydown', (e, s) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        toggleState(app.byFips.get(s.fips).i);
      }
    })
    .on('pointermove', (e, s) => stateTip(e, app.byFips.get(s.fips).i))
    .on('focus', function (e, s) {
      stateTip(null, app.byFips.get(s.fips).i, this);
    })
    .on('pointerleave blur', hideTip);

  gAbbr.selectAll('text')
    .data(shapes.filter((s) => !SKIP_LABEL.has(s.fips)))
    .join('text')
    .attr('class', 'abbr')
    .attr('x', (s) => anchors.get(s.fips)[0])
    .attr('y', labelY)
    .text((s) => app.byFips.get(s.fips).abbr);
}

function niceStep(v) {
  if (v <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(v));
  const f = v / p;
  const nf = f < 1.5 ? 1 : f < 2.25 ? 2 : f < 3.5 ? 2.5 : f < 7.5 ? 5 : 10;
  return nf * p;
}

function divergingScale(values, gainVar = '--gain') {
  const max = d3.max(values, (v) => Math.abs(v)) || 1;
  const breaks = [...new Set([0.08, 0.25, 0.55].map((k) => niceStep(max * k)))].sort((a, b) => a - b);
  const gains = [1, 2, 3, 4].map((k) => css(`${gainVar}-${k}`));
  const losses = ['--loss-1', '--loss-2', '--loss-3', '--loss-4'].map(css);
  const bin = (a) => {
    let k = 0;
    while (k < breaks.length && a > breaks[k]) k++;
    return k;
  };
  const color = (v) => {
    if (v === null || v === undefined) return css('--no-data');
    if (v === 0) return css('--div-mid');
    return v > 0 ? gains[bin(v)] : losses[bin(-v)];
  };
  return { color, breaks, gains: gains.slice(0, breaks.length + 1), losses: losses.slice(0, breaks.length + 1) };
}

function quadPoint(p0, c, p1, t) {
  const u = 1 - t;
  return [u * u * p0[0] + 2 * u * t * c[0] + t * t * p1[0], u * u * p0[1] + 2 * u * t * c[1] + t * t * p1[1]];
}

function arrowGeometry(a, b, width, bend = 0.2, r0 = 5, r1 = 7) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const p0 = [a[0] + ux * r0, a[1] + uy * r0];
  const p1 = [b[0] - ux * r1, b[1] - uy * r1];
  // Perpendicular offset: A->B and B->A bow to opposite sides automatically.
  const l = Math.hypot(p1[0] - p0[0], p1[1] - p0[1]);
  const c = [(p0[0] + p1[0]) / 2 - uy * l * bend, (p0[1] + p1[1]) / 2 + ux * l * bend];
  const tx = p1[0] - c[0];
  const ty = p1[1] - c[1];
  const tl = Math.hypot(tx, ty) || 1;
  const hx = tx / tl;
  const hy = ty / tl;
  const headLen = 7 + width * 1.3;
  const headW = 4.5 + width * 1.1;
  const base = [p1[0] - hx * headLen, p1[1] - hy * headLen];
  const shaftEnd = [p1[0] - hx * headLen * 0.6, p1[1] - hy * headLen * 0.6];
  const head = [
    p1,
    [base[0] - hy * headW, base[1] + hx * headW],
    [base[0] + hy * headW, base[1] - hx * headW],
  ];
  return {
    shaft: `M${p0[0]},${p0[1]}Q${c[0]},${c[1]} ${shaftEnd[0]},${shaftEnd[1]}`,
    head: `M${head.map((p) => p.join(',')).join('L')}Z`,
    at: (t) => quadPoint(p0, c, p1, t),
  };
}

function buildArrows(m, tot) {
  const st = app.states;
  const n = st.length;
  const arrows = [];
  if (app.sel < 0) {
    if (app.mode === 'net') {
      const pairs = [];
      for (let i = 0; i < n; i++) {
        for (let j = i + 1; j < n; j++) {
          const net = flow(m, i, j) - flow(m, j, i);
          if (net !== 0) pairs.push({ i, j, net });
        }
      }
      pairs.sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
      for (const p of pairs.slice(0, app.topN)) {
        const [o, d] = p.net > 0 ? [p.i, p.j] : [p.j, p.i];
        const moe = moeOf(flowMoe(m, p.i, p.j), flowMoe(m, p.j, p.i));
        arrows.push({ o, d, value: Math.abs(p.net), moe, color: '--arrow-neutral', kind: 'netpair' });
      }
    } else {
      const all = [];
      for (let o = 0; o < n; o++) for (let d = 0; d < n; d++) if (o !== d) all.push({ o, d, value: flow(m, o, d) });
      all.sort((a, b) => b.value - a.value);
      for (const f of all.slice(0, app.topN)) arrows.push({ ...f, moe: flowMoe(m, f.o, f.d), color: '--arrow-neutral', kind: 'gross' });
    }
  } else {
    const s = app.sel;
    const ps = partners(m, s);
    if (app.mode === 'net') {
      ps.sort((a, b) => Math.abs(b.net) - Math.abs(a.net));
      for (const p of ps.slice(0, app.topN)) {
        if (p.net === 0) continue;
        arrows.push(p.net > 0
          ? { o: p.i, d: s, value: p.net, moe: p.netMoe, color: '--arrow-in', kind: 'netsel', p }
          : { o: s, d: p.i, value: -p.net, moe: p.netMoe, color: '--arrow-out', kind: 'netsel', p });
      }
    } else {
      ps.sort((a, b) => b.inflow + b.outflow - (a.inflow + a.outflow));
      for (const p of ps.slice(0, app.topN)) {
        if (p.inflow) arrows.push({ o: p.i, d: s, value: p.inflow, moe: p.inMoe, color: '--arrow-in', kind: 'in', p });
        if (p.outflow) arrows.push({ o: s, d: p.i, value: p.outflow, moe: p.outMoe, color: '--arrow-out', kind: 'out', p });
      }
    }
  }
  for (const a of arrows) {
    a.sig = isSig(a.value, a.moe);
    // A net whose 90% range spans zero has no known direction: draw it neutral.
    if (!a.sig && (a.kind === 'netpair' || a.kind === 'netsel')) a.color = '--arrow-ns';
  }
  return arrows.filter((a) => st[a.o] && st[a.d]);
}

function arrowTip(event, a, m) {
  const st = app.states;
  const O = st[a.o];
  const D = st[a.d];
  const sel = app.sel;
  if (a.kind === 'in' || a.kind === 'out' || a.kind === 'netsel') {
    const S = st[sel];
    const P = a.o === sel ? D : O;
    const p = a.p;
    const net = p.inflow - p.outflow;
    const title = a.kind === 'in' ? `Into ${S.name} from ${P.name}`
      : a.kind === 'out' ? `Out of ${S.name} to ${P.name}`
        : `Net ${net >= 0 ? 'gain to' : 'loss from'} ${S.name}: ${P.name}`;
    showTip(event, title, [
      [`Into ${S.abbr} from ${P.abbr}`, p.inSup ? 'N (suppressed)' : `${fmtInt(p.inflow)} ± ${fmtInt(p.inMoe)}`, css('--arrow-in')],
      [`Out of ${S.abbr} to ${P.abbr}`, p.outSup ? 'N (suppressed)' : `${fmtInt(p.outflow)} ± ${fmtInt(p.outMoe)}`, css('--arrow-out')],
      [`Net for ${S.abbr}`, `${fmtSigned(net)} ± ${fmtInt(p.netMoe)}`],
    ], [
      a.kind === 'netsel' ? rangeNote(net, p.netMoe) : rangeNote(a.value, a.moe, 'flow'),
      `ACS ${isCombined() ? comboMeta(app.year).label : app.year}; ± is the 90% margin of error (see "About the ± numbers" below). Click to focus on ${P.name}.`,
    ]);
    return;
  }
  if (a.kind === 'netpair') {
    const ab = flow(m, a.o, a.d);
    const ba = flow(m, a.d, a.o);
    showTip(event, `Net ${O.name} → ${D.name}`, [
      ['Net movers', fmtInt(a.value)],
      [`${O.abbr} → ${D.abbr}`, `${fmtInt(ab)} ± ${fmtInt(flowMoe(m, a.o, a.d))}`],
      [`${D.abbr} → ${O.abbr}`, `${fmtInt(ba)} ± ${fmtInt(flowMoe(m, a.d, a.o))}`],
      ['Margin of error', `± ${fmtInt(a.moe)}`],
    ], [rangeNote(a.value, a.moe), `Click to focus on ${D.name}.`]);
  } else {
    showTip(event, `${O.name} → ${D.name}`, [
      ['Movers', `${fmtInt(a.value)} ± ${fmtInt(flowMoe(m, a.o, a.d))}`],
      [`Reverse (${D.abbr} → ${O.abbr})`, fmtInt(flow(m, a.d, a.o))],
    ], [rangeNote(a.value, a.moe, 'flow'), isCombined()
      ? `Moves from ${O.name} to ${D.name}, summed over the ${dsYears().length} surveys ${dsLabel().replace(' combined', '')}. Click to focus on ${D.name}.`
      : `Lived in ${O.name} in ${app.year - 1}, ${D.name} in ${app.year}. Click to focus on ${D.name}.`]);
  }
}

function placeLabels(items) {
  // Greedy collision avoidance: slide a label along its curve until it fits.
  const placed = [];
  const tries = [0.5, 0.4, 0.6, 0.32, 0.68, 0.25, 0.75];
  for (const it of items) {
    const w = it.text.length * 6.6 + 6;
    const h = 14;
    let best = null;
    for (const t of tries) {
      const [x, y] = it.geom.at(t);
      const box = { x0: x - w / 2, x1: x + w / 2, y0: y - h / 2, y1: y + h / 2 };
      const hit = placed.some((b) => box.x0 < b.x1 && box.x1 > b.x0 && box.y0 < b.y1 && box.y1 > b.y0);
      if (!best) best = { x, y, box };
      if (!hit) {
        best = { x, y, box };
        break;
      }
    }
    placed.push(best.box);
    it.x = best.x;
    it.y = best.y;
  }
}

function renderMap(m) {
  const st = app.states;
  const tot = totals(m);
  app.current = { m, tot };
  const sel = app.sel;
  let values;
  let moes;
  if (sel < 0) {
    values = tot.map((t) => t.net);
    moes = tot.map((t) => t.netMoe);
  } else {
    values = new Array(st.length).fill(null);
    moes = new Array(st.length).fill(null);
    for (const p of partners(m, sel)) {
      values[p.i] = p.net;
      moes[p.i] = p.netMoe;
    }
  }
  const scale = divergingScale(values.filter((v, i) => i !== sel && v !== null), sel < 0 ? '--gain' : '--in');

  gStates.selectAll('path.state')
    .classed('selected', (s) => app.byFips.get(s.fips).i === sel)
    .attr('fill', (s) => {
      const i = app.byFips.get(s.fips).i;
      if (i === sel) return css('--selected-fill');
      if (values[i] !== null && !isSig(values[i], moes[i])) return css('--div-mid');
      return scale.color(values[i]);
    });
  gAbbr.selectAll('text').classed('on-selected', (s) => app.byFips.get(s.fips).i === sel);

  const arrows = buildArrows(m, tot);
  app.current.anyNs = arrows.some((a) => !a.sig);
  const maxV = d3.max(arrows, (a) => a.value) || 1;
  const MAX_W = 10;
  for (const a of arrows) {
    a.w = Math.max(1, (MAX_W * a.value) / maxV);
    a.geom = arrowGeometry(
      anchors.get(st[a.o].fips),
      anchors.get(st[a.d].fips),
      a.w,
      app.mode === 'both' && sel >= 0 ? 0.22 : 0.18,
      a.o === sel ? 10 : 5,
      a.d === sel ? 12 : 7,
    );
    a.text = fmtCompact(a.value);
  }
  // Draw thin arrows on top so they aren't hidden under thick ones.
  arrows.sort((a, b) => b.value - a.value);

  const groups = gArrows.selectAll('g.arrow')
    .data(arrows)
    .join((enter) => {
      const g = enter.append('g').attr('class', 'arrow');
      g.append('path').attr('class', 'halo');
      g.append('path').attr('class', 'head-halo');
      g.append('path').attr('class', 'shaft');
      g.append('path').attr('class', 'head');
      g.append('path').attr('class', 'hit');
      return g;
    });
  groups.select('.halo').attr('d', (a) => a.geom.shaft).attr('stroke-width', (a) => a.w + 3);
  groups.select('.head-halo').attr('d', (a) => a.geom.head);
  groups.classed('ns', (a) => !a.sig);
  groups.select('.shaft').attr('d', (a) => a.geom.shaft).attr('stroke-width', (a) => a.w).attr('stroke', (a) => css(a.color))
    .attr('stroke-dasharray', (a) => (a.sig ? null : `${Math.max(3, a.w * 1.5)} ${Math.max(3, a.w * 1.2)}`))
    .attr('stroke-linecap', (a) => (a.sig ? null : 'butt'));
  groups.select('.head').attr('d', (a) => a.geom.head).attr('fill', (a) => css(a.color));
  groups.select('.hit').attr('d', (a) => a.geom.shaft);
  const setHover = (a) => {
    svg.classed('has-hover', !!a);
    groups.classed('hover', (x) => x === a);
    gLabels.selectAll('text').classed('hover', (x) => x === a);
  };
  groups
    .on('pointerenter', function (e, a) {
      d3.select(this).raise();
      setHover(a);
    })
    .on('pointermove', (e, a) => arrowTip(e, a, m))
    .on('pointerleave', () => {
      setHover(null);
      hideTip();
    })
    // Arrows cover their endpoints, so clicking one focuses the far state.
    .on('click', (e, a) => setState(a.o === sel ? a.d : a.d === sel ? a.o : a.d));

  // Values that aren't statistically significant are left unlabeled (they're on hover).
  const labelItems = arrows.filter((a) => a.sig).sort((a, b) => b.value - a.value);
  placeLabels(labelItems);
  gLabels.selectAll('text')
    .data(labelItems)
    .join('text')
    .attr('class', 'arrow-label')
    .attr('x', (a) => a.x)
    .attr('y', (a) => a.y)
    .text((a) => a.text);

  renderLegend(scale);
  renderHeader(tot);
}

function renderLegend(scale) {
  const fmtB = (v) => fmtCompact(v);
  const sel = app.sel;
  const sw = (c) => el('span', { class: 'swatch', style: `background:${c}` });
  const lossSide = [...scale.losses].reverse();
  const title = sel < 0 ? 'Net interstate migration' : `Net for ${app.states[sel].abbr}`;
  const b = scale.breaks;
  document.getElementById('legend').replaceChildren(
    el('div', { class: 'scale' },
      el('span', {}, title),
      el('span', {}, `Loss`),
      el('span', { class: 'swatches', title: `Breaks at ${b.map(fmtB).join(', ')}` },
        lossSide.map(sw), sw(css('--div-mid')), scale.gains.map(sw)),
      el('span', {}, 'Gain'),
    ),
    el('span', {}, `Steps: ${b.map(fmtB).join(' · ')}`),
    el('span', { class: 'key', title: 'The 90% margin of error is larger than the net, so it could be a gain or a loss' },
      sw(css('--div-mid')), 'Not statistically significant'),
  );

  const line = (color) => {
    const s = d3.create('svg').attr('width', 30).attr('height', 10);
    s.append('path').attr('d', 'M2,5H22').attr('stroke', css(color)).attr('stroke-width', 2.5);
    s.append('path').attr('d', 'M28,5L20,1L20,9Z').attr('fill', css(color));
    return s.node();
  };
  let keys;
  if (sel < 0) {
    keys = [el('span', { class: 'key' }, line('--arrow-neutral'),
      app.mode === 'net' ? 'Largest net flows between pairs of states' : 'Largest one-way flows')];
  } else {
    const ab = app.states[sel].abbr;
    keys = [
      el('span', { class: 'key' }, line('--arrow-in'), app.mode === 'net' ? `In: net gain to ${ab}` : `In: moved to ${ab}`),
      el('span', { class: 'key' }, line('--arrow-out'), app.mode === 'net' ? `Out: net loss from ${ab}` : `Out: left ${ab}`),
    ];
  }
  if (app.current?.anyNs) {
    const s = d3.create('svg').attr('width', 30).attr('height', 10);
    const netMode = app.mode === 'net';
    s.append('path').attr('d', 'M2,5H26').attr('stroke', css(netMode ? '--arrow-ns' : '--text-secondary'))
      .attr('stroke-width', 2.5).attr('stroke-dasharray', '4 3');
    keys.push(el('span', { class: 'key', title: 'The 90% margin of error is larger than the estimate; hover for the value' }, s.node(),
      netMode ? 'Gray dashed: direction not significant' : 'Dashed: not statistically significant'));
  }
  document.getElementById('arrow-legend').replaceChildren(...keys, el('span', {}, 'Width proportional to movers · hover for values'));
}

function stat(label, value, moe, ns = false) {
  return el('div', { class: `stat${ns ? ' ns' : ''}` },
    el('span', { class: 'label' }, label),
    el('span', { class: 'value', title: ns ? 'Not statistically significant: the margin of error is larger than the estimate' : null }, value),
    moe !== undefined
      ? el('a', { class: 'moe', href: '#margins', title: '90% margin of error: what does this mean?' }, `± ${fmtInt(moe)}${ns ? ' · not significant' : ''}`)
      : null);
}

function renderHeader(tot) {
  const sel = app.sel;
  const y = dsLabel();
  const title = document.getElementById('map-title');
  const sub = document.getElementById('map-sub');
  const stats = document.getElementById('stats');
  if (sel < 0) {
    title.textContent = `Migration between states, ${y}`;
    sub.textContent = app.mode === 'net'
      ? `States shaded by net interstate migration. Arrows: the ${app.topN} largest net flows between two states.`
      : `States shaded by net interstate migration. Arrows: the ${app.topN} largest one-way flows.`;
    const movers = d3.sum(tot, (t) => t.inflow);
    stats.replaceChildren(stat(isCombined() ? `Interstate moves, ${dsYears().length} surveys` : 'Interstate movers', fmtInt(movers)));
  } else {
    const S = app.states[sel];
    const t = tot[sel];
    title.textContent = `${S.name}: migration with other states, ${y}`;
    sub.textContent = app.mode === 'net'
      ? `Partners shaded by net exchange with ${S.abbr}. Arrows: the ${app.topN} partners with the largest net exchange.`
      : `Partners shaded by net exchange with ${S.abbr}. Arrows: inflow and outflow for the ${app.topN} largest partners.`;
    stats.replaceChildren(
      stat('Moved in', fmtInt(t.inflow), t.inMoe),
      stat('Moved out', fmtInt(t.outflow), t.outMoe),
      stat('Net', fmtSigned(t.net), t.netMoe, !isSig(t.net, t.netMoe)),
    );
  }
}

function stateTip(event, i, node) {
  if (!app.current) return;
  const { m, tot } = app.current;
  const S = app.states[i];
  const sel = app.sel;
  let rows;
  let title = S.name;
  let note;
  if (sel < 0 || sel === i) {
    const t = tot[i];
    rows = [
      ['Moved in', `${fmtInt(t.inflow)} ± ${fmtInt(t.inMoe)}`, css('--arrow-in')],
      ['Moved out', `${fmtInt(t.outflow)} ± ${fmtInt(t.outMoe)}`, css('--arrow-out')],
      ['Net', `${fmtSigned(t.net)} ± ${fmtInt(t.netMoe)}`],
    ];
    note = [rangeNote(t.net, t.netMoe), sel === i ? 'Click to show all states' : 'Click to focus on this state'];
  } else {
    const T = app.states[sel];
    const inflow = flow(m, i, sel);
    const outflow = flow(m, sel, i);
    title = `${S.name} ⇄ ${T.name}`;
    rows = [
      [`${S.abbr} → ${T.abbr}`, isSuppressed(m, i, sel) ? 'N (suppressed)' : `${fmtInt(inflow)} ± ${fmtInt(flowMoe(m, i, sel))}`, css('--arrow-in')],
      [`${T.abbr} → ${S.abbr}`, isSuppressed(m, sel, i) ? 'N (suppressed)' : `${fmtInt(outflow)} ± ${fmtInt(flowMoe(m, sel, i))}`, css('--arrow-out')],
      [`Net for ${T.abbr}`, `${fmtSigned(inflow - outflow)} ± ${fmtInt(moeOf(flowMoe(m, i, sel), flowMoe(m, sel, i)))}`],
    ];
    note = [rangeNote(inflow - outflow, moeOf(flowMoe(m, i, sel), flowMoe(m, sel, i))), `Click to focus on ${S.name}`];
  }
  if (node) tipAtElement(node, title, rows, note);
  else showTip(event, title, rows, note);
}

// ---------- history chart ----------
async function renderHistory() {
  const box = document.getElementById('history');
  const all = await Promise.all(app.index.acs.map((a) => getAcs(a.year)));
  const sel = app.sel;
  const pe = app.popest;
  const acsYears = app.index.acs.map((a) => a.year);
  const firstYear = d3.min(acsYears);
  const lastYear = Math.max(d3.max(acsYears), d3.max(pe.years));
  const years = d3.range(firstYear, lastYear + 1);

  const acsVals = new Map();
  all.forEach((m, k) => {
    const t = totals(m);
    if (sel < 0) acsVals.set(acsYears[k], { v: d3.sum(t, (x) => x.inflow), moe: null });
    else acsVals.set(acsYears[k], { v: t[sel].net, moe: t[sel].netMoe });
  });
  const peVals = new Map();
  if (sel >= 0) {
    const rec = pe.states.find((s) => s.fips === app.states[sel].fips);
    if (rec) pe.years.forEach((y, k) => { if (y > pe.years[0]) peVals.set(y, rec.domesticmig[k]); });
  }

  const title = document.getElementById('history-title');
  const sub = document.getElementById('history-sub');
  if (sel < 0) {
    title.textContent = 'Interstate movers by year';
    sub.textContent = 'Total people living in a different state than one year earlier (ACS 1-year). Click a bar to view that year. No ACS 1-year table for 2020.';
  } else {
    const S = app.states[sel];
    title.textContent = `${S.name}: net migration by year`;
    sub.textContent = `Bars: net migration with other states from the ACS 1-year tables. Dots: net domestic migration from the Vintage ${app.popest.vintage} population estimates (July–June years). Click a bar to view that year.`;
  }

  const W = 960;
  const H = 230;
  const M = { t: 22, r: 8, b: 26, l: 56 };
  const x = d3.scaleBand(years, [M.l, W - M.r]).padding(0.25);
  const vals = [...[...acsVals.values()].map((d) => d.v), ...peVals.values(), 0];
  const y = d3.scaleLinear(d3.extent(vals), [H - M.b, M.t]).nice();

  const s = d3.create('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img')
    .attr('aria-label', title.textContent);
  s.append('g').attr('class', 'grid tick')
    .selectAll('g').data(y.ticks(5)).join('g')
    .call((g) => g.append('line').attr('x1', M.l).attr('x2', W - M.r).attr('y1', (d) => y(d)).attr('y2', (d) => y(d)))
    .call((g) => g.append('text').attr('x', M.l - 8).attr('y', (d) => y(d)).attr('text-anchor', 'end')
      .attr('dominant-baseline', 'central').text((d) => fmtCompact(d)));
  s.append('line').attr('class', 'baseline').attr('x1', M.l).attr('x2', W - M.r).attr('y1', y(0)).attr('y2', y(0));

  const barColor = (v, moe = null) => {
    if (sel < 0) return css('--accent');
    if (moe !== null && !isSig(v, moe)) return css('--arrow-ns');
    return v >= 0 ? css('--in-3') : css('--loss-3');
  };
  const r = Math.min(4, x.bandwidth() / 2);
  const barPath = (yr, v) => {
    const x0 = x(yr);
    const w = x.bandwidth();
    const y0 = y(0);
    const y1 = y(v);
    const h = Math.abs(y1 - y0);
    const rr = Math.min(r, h);
    if (v >= 0) return `M${x0},${y0}V${y1 + rr}Q${x0},${y1} ${x0 + rr},${y1}H${x0 + w - rr}Q${x0 + w},${y1} ${x0 + w},${y1 + rr}V${y0}Z`;
    return `M${x0},${y0}V${y1 - rr}Q${x0},${y1} ${x0 + rr},${y1}H${x0 + w - rr}Q${x0 + w},${y1} ${x0 + w},${y1 - rr}V${y0}Z`;
  };

  const tipFor = (e, yr) => {
    const a = acsVals.get(yr);
    const p = peVals.get(yr);
    const rows = [];
    if (a) rows.push([sel < 0 ? 'ACS interstate movers' : 'ACS net', a.moe !== null ? `${fmtSigned(a.v)} ± ${fmtInt(a.moe)}` : fmtInt(a.v), barColor(a.v, a.moe)]);
    else rows.push(['ACS', 'no 1-year table']);
    if (p !== undefined) rows.push(['PopEst net domestic', fmtSigned(p), css('--arrow-neutral')]);
    showTip(e, String(yr), rows, [a && a.moe !== null ? rangeNote(a.v, a.moe) : null, a ? 'Click to view this year' : null]);
  };

  s.append('g').selectAll('path').data(years.filter((yr) => acsVals.has(yr))).join('path')
    .attr('class', 'bar')
    .attr('d', (yr) => barPath(yr, acsVals.get(yr).v))
    .attr('fill', (yr) => barColor(acsVals.get(yr).v, acsVals.get(yr).moe))
    .attr('opacity', (yr) => (dsYears().includes(yr) ? 1 : 0.55))
    .on('click', (e, yr) => setYear(yr))
    .on('pointermove', tipFor)
    .on('pointerleave', hideTip);
  // Wider invisible hit areas for each year column.
  s.append('g').selectAll('rect').data(years).join('rect')
    .attr('x', (yr) => x(yr) - (x.step() * x.padding()) / 2).attr('width', x.step())
    .attr('y', M.t).attr('height', H - M.t - M.b).attr('fill', 'transparent')
    .style('cursor', (yr) => (acsVals.has(yr) ? 'pointer' : 'default'))
    .on('click', (e, yr) => acsVals.has(yr) && setYear(yr))
    .on('pointermove', tipFor)
    .on('pointerleave', hideTip);

  s.append('g').selectAll('circle').data([...peVals.entries()]).join('circle')
    .attr('cx', ([yr]) => x(yr) + x.bandwidth() / 2)
    .attr('cy', ([, v]) => y(v))
    .attr('r', 4.5)
    .attr('fill', css('--arrow-neutral'))
    .attr('stroke', css('--surface'))
    .attr('stroke-width', 2)
    .attr('pointer-events', 'none');

  // Direct label on the year shown on the map; every other value is on hover.
  const cur = isCombined() ? null : acsVals.get(app.year);
  if (cur) {
    const above = cur.v >= 0;
    s.append('text')
      .attr('x', x(app.year) + x.bandwidth() / 2)
      // Losses are labeled at the baseline, clear of the bar end and the dots.
      .attr('y', above ? y(cur.v) - 6 : y(0) - 6)
      .attr('text-anchor', 'middle')
      .style('font-size', '12px')
      .style('font-weight', 650)
      .style('fill', css('--text-primary'))
      .style('paint-order', 'stroke')
      .style('stroke', css('--surface'))
      .style('stroke-width', '3px')
      .style('font-variant-numeric', 'tabular-nums')
      .text(sel < 0 ? fmtCompact(cur.v) : fmtSigned(cur.v));
  }

  s.append('g').attr('class', 'tick').selectAll('text').data(years).join('text')
    .attr('x', (yr) => x(yr) + x.bandwidth() / 2)
    .attr('y', H - 8)
    .attr('text-anchor', 'middle')
    .style('font-weight', (yr) => (dsYears().includes(yr) ? 700 : 400))
    .style('fill', (yr) => (dsYears().includes(yr) ? css('--text-primary') : null))
    .text((yr) => (years.length > 14 ? `'${String(yr).slice(2)}` : yr));

  box.replaceChildren(s.node());

  const legend = document.getElementById('history-legend');
  if (sel < 0) legend.replaceChildren();
  else {
    legend.replaceChildren(
      el('span', { class: 'key' }, el('span', { class: 'swatch', style: `background:${css('--in-3')};width:10px` }),
        el('span', { class: 'swatch', style: `background:${css('--loss-3')};width:10px` }), 'ACS net (gain / loss)'),
      el('span', { class: 'key' }, el('span', { class: 'swatch', style: `background:${css('--arrow-ns')};width:10px` }), 'Not significant'),
      el('span', { class: 'key' }, el('span', { class: 'swatch', style: `background:${css('--arrow-neutral')};width:9px;height:9px;border-radius:50%` }), 'PopEst net domestic'),
    );
  }
}

// ---------- tables ----------
function sortableTable(table, name, columns, rows, footer, rowAttrs) {
  const sort = app.sorts[name] || { key: columns.find((c) => c.defaultSort)?.key, dir: -1 };
  const col = columns.find((c) => c.key === sort.key) || columns[0];
  const val = col.sortVal || ((r) => r[col.key]);
  const sorted = [...rows].sort((a, b) => {
    const va = val(a);
    const vb = val(b);
    if (typeof va === 'string') return sort.dir * va.localeCompare(vb);
    return sort.dir * ((va ?? -Infinity) - (vb ?? -Infinity));
  });
  const thead = el('thead', {}, el('tr', {}, columns.map((c) => {
    const active = c.key === col.key;
    const th = el('th', {
      class: c.sortable === false ? '' : 'sortable',
      scope: 'col',
      title: c.title,
      'aria-sort': active ? (sort.dir > 0 ? 'ascending' : 'descending') : null,
    }, c.label, c.sortable === false ? null : el('span', { class: 'arrow-ind' }, active ? (sort.dir > 0 ? '▲' : '▼') : ''));
    if (c.sortable !== false) {
      th.tabIndex = 0;
      const go = () => {
        app.sorts[name] = { key: c.key, dir: active ? -sort.dir : c.key === 'name' ? 1 : -1 };
        sortableTable(table, name, columns, rows, footer, rowAttrs);
      };
      th.addEventListener('click', go);
      th.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          go();
        }
      });
    }
    return th;
  })));
  const tbody = el('tbody', {}, sorted.map((r) => el('tr', rowAttrs(r), columns.map((c) => {
    const content = c.render ? c.render(r) : r[c.key];
    return el('td', { class: c.cls ? c.cls(r) : c.barcell ? 'barcell' : null }, content);
  }))));
  const tfoot = footer ? el('tfoot', {}, el('tr', {}, columns.map((c) => el('td', { class: c.cls && footer.__row ? c.cls(footer.__row) : null }, footer[c.key] ?? '')))) : null;
  table.replaceChildren(thead, tbody, ...(tfoot ? [tfoot] : []));
}

const signCls = (v) => (v > 0 ? 'pos' : v < 0 ? 'neg' : 'muted');
// Net cells: colored by sign, grayed when not statistically significant.
const netCls = (v, moe) => `${signCls(v)}${isSig(v, moe) ? '' : ' ns'}`;
const NS_NOTE = 'Gray italic net values are not statistically different from zero (90% margin of error larger than the estimate).';
function minibar(v, max) {
  const pct = max ? Math.min(50, (Math.abs(v) / max) * 50) : 0;
  return el('div', { class: 'minibar', role: 'presentation' }, v ? el('span', { class: v > 0 ? 'pos' : 'neg', style: `width:${pct}%` }) : null);
}

function renderFlowsTable(m) {
  const table = document.getElementById('flows-table');
  const title = document.getElementById('flows-title');
  const sub = document.getElementById('flows-sub');
  const st = app.states;
  const sel = app.sel;
  const rowAttrs = (r) => ({
    class: r.i === sel ? 'selected' : null,
    onclick: () => toggleState(r.i),
    onpointerenter: () => highlightArrows(r.i),
    onpointerleave: () => highlightArrows(-1),
  });
  table.classList.toggle('focus', sel >= 0);
  if (sel < 0) {
    const tot = totals(m);
    const rows = tot.map((t) => ({ ...t, name: st[t.i].name }));
    const max = d3.max(rows, (r) => Math.abs(r.net));
    title.textContent = `All states, ${dsLabel()}`;
    sub.textContent = `People who moved in from, and out to, other states (including D.C. and Puerto Rico). ${NS_NOTE} Click a row to focus on a state.`;
    sub.append(' ', el('a', { href: '#margins' }, 'Why can the ± margins be so large?'));
    sortableTable(table, 'flowsAll', [
      { key: 'name', label: 'State' },
      { key: 'inflow', label: 'Moved in', render: (r) => fmtInt(r.inflow) },
      { key: 'inMoe', label: '±', render: (r) => fmtInt(r.inMoe), cls: () => 'muted', title: '90% margin of error' },
      { key: 'outflow', label: 'Moved out', render: (r) => fmtInt(r.outflow) },
      { key: 'outMoe', label: '±', render: (r) => fmtInt(r.outMoe), cls: () => 'muted', title: '90% margin of error' },
      { key: 'net', label: 'Net', render: (r) => fmtSigned(r.net), cls: (r) => netCls(r.net, r.netMoe), defaultSort: true },
      { key: 'netMoe', label: '±', render: (r) => fmtInt(r.netMoe), cls: () => 'muted', title: '90% margin of error' },
      { key: 'bar', label: '', sortable: false, barcell: true, render: (r) => minibar(r.net, max) },
    ], rows, { name: 'Total', inflow: fmtInt(d3.sum(rows, (r) => r.inflow)), outflow: fmtInt(d3.sum(rows, (r) => r.outflow)) }, rowAttrs);
  } else {
    const S = st[sel];
    const rows = partners(m, sel).map((p) => ({ ...p, name: st[p.i].name }));
    const max = d3.max(rows, (r) => Math.abs(r.net));
    const sup = (flag, v) => (flag ? 'N' : fmtInt(v));
    title.textContent = `${S.name} and each other state, ${dsLabel()}`;
    sub.textContent = `Moved in: lived in the partner state a year earlier and in ${S.name} now. N = suppressed by the Census Bureau. ${NS_NOTE} Click a row to switch to that state.`;
    sub.append(' ', el('a', { href: '#margins' }, 'Why can the ± margins be so large?'));
    const t = totals(m)[sel];
    sortableTable(table, 'flowsSel', [
      { key: 'name', label: 'Partner state' },
      { key: 'inflow', label: `Into ${S.abbr}`, render: (r) => sup(r.inSup, r.inflow) },
      { key: 'inMoe', label: '±', render: (r) => fmtInt(r.inMoe), cls: () => 'muted', title: '90% margin of error' },
      { key: 'outflow', label: `Out of ${S.abbr}`, render: (r) => sup(r.outSup, r.outflow) },
      { key: 'outMoe', label: '±', render: (r) => fmtInt(r.outMoe), cls: () => 'muted', title: '90% margin of error' },
      { key: 'net', label: `Net for ${S.abbr}`, render: (r) => fmtSigned(r.net), cls: (r) => netCls(r.net, r.netMoe), sortVal: (r) => r.net, defaultSort: true },
      { key: 'netMoe', label: '±', render: (r) => fmtInt(r.netMoe), cls: () => 'muted', title: '90% margin of error' },
      { key: 'bar', label: '', sortable: false, barcell: true, render: (r) => minibar(r.net, max) },
    ], rows, {
      name: 'Total', inflow: fmtInt(t.inflow), inMoe: fmtInt(t.inMoe), outflow: fmtInt(t.outflow), outMoe: fmtInt(t.outMoe),
      net: fmtSigned(t.net), netMoe: fmtInt(t.netMoe), __row: t,
    }, rowAttrs);
  }
}

function highlightArrows(i) {
  gArrows.selectAll('g.arrow').classed('hl', (a) => i >= 0 && (a.o === i || a.d === i));
  gStates.selectAll('path.state').attr('stroke', (s) => (i >= 0 && app.byFips.get(s.fips).i === i ? css('--text-primary') : null))
    .attr('stroke-width', (s) => (i >= 0 && app.byFips.get(s.fips).i === i ? 2 : null));
}

function renderPopest() {
  const pe = app.popest;
  const k = pe.years.indexOf(app.popestYear);
  const y = app.popestYear;
  const sub = document.getElementById('popest-sub');
  sub.textContent = y === pe.years[0]
    ? `Vintage ${pe.vintage} estimates for April 1 – June 30, ${y} (a partial year). Net domestic = moves between states; net international includes moves from abroad.`
    : `Vintage ${pe.vintage} estimates for July 1, ${y - 1} – June 30, ${y}. Net domestic = moves between states; net international includes moves from abroad. Rates per 1,000 residents. Click a row to show that state on the map.`;
  const rows = pe.states.map((s) => {
    const i = app.byFips.get(s.fips).i;
    return {
      i,
      name: app.states[i].name,
      pop: s.popestimate[k],
      chg: s.npopchg[k],
      natural: s.naturalchg[k],
      domesticmig: s.domesticmig[k],
      rdom: s.rdomesticmig[k],
      intl: s.internationalmig[k],
      rintl: s.rinternationalmig[k],
      netmig: s.netmig[k],
      rnet: s.rnetmig[k],
    };
  });
  const max = d3.max(rows, (r) => Math.abs(r.domesticmig));
  const sum = (key) => d3.sum(rows.filter((r) => app.states[r.i].fips !== PR_FIPS), (r) => r[key]);
  const table = document.getElementById('popest-table');
  sortableTable(table, 'popest', [
    { key: 'name', label: 'State' },
    { key: 'pop', label: `Population, July ${y}`, render: (r) => fmtInt(r.pop) },
    { key: 'chg', label: 'Change', render: (r) => fmtSigned(r.chg), cls: (r) => signCls(r.chg) },
    { key: 'domesticmig', label: 'Net domestic', render: (r) => fmtSigned(r.domesticmig), cls: (r) => signCls(r.domesticmig) },
    { key: 'rdom', label: 'per 1k', render: (r) => fmtRate(r.rdom), cls: () => 'muted', title: 'Net domestic migration per 1,000 residents' },
    { key: 'bar', label: '', sortable: false, barcell: true, render: (r) => minibar(r.domesticmig, max) },
    { key: 'intl', label: 'Net international', render: (r) => fmtSigned(r.intl) },
    { key: 'rintl', label: 'per 1k', render: (r) => fmtRate(r.rintl), cls: () => 'muted', title: 'Net international migration per 1,000 residents' },
    { key: 'netmig', label: 'Net migration', render: (r) => fmtSigned(r.netmig), cls: (r) => signCls(r.netmig) },
    { key: 'rnet', label: 'per 1k', render: (r) => fmtRate(r.rnet), cls: () => 'muted', title: 'Total net migration per 1,000 residents' },
  ], rows, {
    name: 'United States',
    pop: fmtInt(pe.usPopulation[k]),
    intl: fmtSigned(pe.usInternationalMig[k]),
    domesticmig: fmtSigned(sum('domesticmig')),
  }, (r) => ({
    class: r.i === app.sel ? 'selected' : null,
    onclick: () => {
      setState(r.i);
      document.querySelector('.map-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
    },
  }));
}

// ---------- population-estimates map ----------
const PE_MEASURES = {
  netmig: { label: 'Net migration', rate: 'rnetmig', short: 'net' },
  domesticmig: { label: 'Net domestic migration', rate: 'rdomesticmig', short: 'domestic' },
  internationalmig: { label: 'Net international migration', rate: 'rinternationalmig', short: 'international' },
};
const peSvg = d3.select('#pe-map');
const fmtSignedCompact = (v) => (v > 0 ? '+' : '') + fmtCompact(v);
const fmtBreak = (v) => (Math.abs(v) < 100 ? String(+v.toFixed(1)) : fmtCompact(v));

function pePeriod(y) {
  return y === app.popest.years[0] ? `April–June ${y}` : `July ${y - 1} – June ${y}`;
}

function initPeMap() {
  const stateOf = (s) => app.byFips.get(s.fips).i;
  peSvg.append('g').selectAll('path')
    .data(shapes)
    .join('path')
    .attr('class', 'state')
    .attr('d', (s) => s.d)
    .attr('tabindex', 0)
    .attr('role', 'button')
    .attr('aria-label', (s) => app.byFips.get(s.fips).name)
    .on('click', (e, s) => focusFromPe(stateOf(s)))
    .on('keydown', (e, s) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        focusFromPe(stateOf(s));
      }
    })
    .on('pointermove', (e, s) => peTip(e, stateOf(s)))
    .on('focus', function (e, s) {
      peTip(null, stateOf(s), this);
    })
    .on('pointerleave blur', hideTip);

  // Values are printed only on states big enough to hold them; the rest are on hover.
  const roomy = new Set(statesGeo.filter((f) => {
    const [[x0, y0], [x1, y1]] = path.bounds(f);
    return x1 - x0 > 42 && y1 - y0 > 28;
  }).map((f) => f.id));
  const labelled = shapes.filter((sh) => !SKIP_LABEL.has(sh.fips));
  const g = peSvg.append('g');
  g.selectAll('text.abbr').data(labelled).join('text')
    .attr('class', 'abbr')
    .attr('x', (sh) => anchors.get(sh.fips)[0])
    .attr('y', (sh) => labelY(sh) - (roomy.has(sh.fips) ? 6 : 0))
    .text((sh) => app.byFips.get(sh.fips).abbr);
  g.selectAll('text.val').data(labelled.filter((sh) => roomy.has(sh.fips))).join('text')
    .attr('class', 'val')
    .attr('x', (sh) => anchors.get(sh.fips)[0])
    .attr('y', (sh) => labelY(sh) + 5);
}

function peValues() {
  const pe = app.popest;
  const k = pe.years.indexOf(app.popestYear);
  const key = app.peUnits === 'rate' ? PE_MEASURES[app.peMeasure].rate : app.peMeasure;
  const vals = new Map();
  for (const st of pe.states) vals.set(app.byFips.get(st.fips).i, st[key][k] ?? null);
  return vals;
}

function renderPeMap() {
  const rate = app.peUnits === 'rate';
  const meas = PE_MEASURES[app.peMeasure];
  const vals = peValues();
  const scale = divergingScale([...vals.values()].filter((v) => v !== null), '--in');
  const idx = (sh) => app.byFips.get(sh.fips).i;
  peSvg.selectAll('path.state')
    .attr('fill', (sh) => scale.color(vals.get(idx(sh))))
    .classed('selected', (sh) => idx(sh) === app.sel);
  peSvg.selectAll('text.val').text((sh) => {
    const v = vals.get(idx(sh));
    if (v === null || v === undefined) return '';
    return rate ? fmtRate(v) : fmtSignedCompact(v);
  });

  document.getElementById('pe-map-title').textContent =
    `${meas.label}${rate ? ' per 1,000 residents' : ''}, ${pePeriod(app.popestYear)}`;
  for (const [id, cur] of [['pe-measure', app.peMeasure], ['pe-units', app.peUnits]]) {
    for (const b of document.querySelectorAll(`#${id} button`)) b.setAttribute('aria-checked', String(b.dataset.value === cur));
  }

  const sw = (c) => el('span', { class: 'swatch', style: `background:${c}` });
  const missing = [...vals.values()].every((v) => v === null);
  document.getElementById('pe-legend').replaceChildren(
    el('div', { class: 'scale' },
      el('span', {}, rate ? `${meas.label} per 1,000` : meas.label),
      el('span', {}, 'Loss'),
      el('span', { class: 'swatches' }, [...scale.losses].reverse().map(sw), sw(css('--div-mid')), scale.gains.map(sw)),
      el('span', {}, 'Gain')),
    missing
      ? el('span', {}, 'Rates are not published for the partial 2020 period.')
      : el('span', {}, `Steps: ${scale.breaks.map(fmtBreak).join(' · ')}`),
  );
}

function peTip(event, i, node) {
  const pe = app.popest;
  const k = pe.years.indexOf(app.popestYear);
  const st = pe.states.find((x) => x.fips === app.states[i].fips);
  if (!st) return;
  const withRate = (v, r) => (r === null || r === undefined ? fmtSigned(v) : `${fmtSigned(v)}  (${fmtRate(r)}/1k)`);
  const rows = [
    ['Net migration', withRate(st.netmig[k], st.rnetmig[k])],
    ['Domestic (other states)', withRate(st.domesticmig[k], st.rdomesticmig[k])],
    ['International', withRate(st.internationalmig[k], st.rinternationalmig[k])],
    ['Births − deaths', fmtSigned(st.naturalchg[k])],
    [`Population, July ${app.popestYear}`, fmtInt(st.popestimate[k])],
  ];
  const note = [`Vintage ${pe.vintage} estimates, ${pePeriod(app.popestYear)}.`, 'Click to show this state\'s flows on the map above.'];
  if (node) tipAtElement(node, app.states[i].name, rows, note);
  else showTip(event, app.states[i].name, rows, note);
}

function focusFromPe(i) {
  setState(i);
  document.querySelector('.map-card').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

// ---------- controls & routing ----------
const yearSel = document.getElementById('year');
const stateSel = document.getElementById('state');
const popestSel = document.getElementById('popest-year');
const topN = document.getElementById('topn');
const topNOut = document.getElementById('topn-out');
const modeBtns = [...document.querySelectorAll('.controls .segmented button')];

function writeHash() {
  const p = new URLSearchParams();
  p.set('year', app.year);
  if (app.sel >= 0) p.set('state', app.states[app.sel].abbr);
  if (app.mode !== 'net') p.set('mode', app.mode);
  if (app.topN !== 12) p.set('top', app.topN);
  if (app.popestYear !== d3.max(app.popest.years)) p.set('pe', app.popestYear);
  if (app.peMeasure !== 'netmig') p.set('pem', PE_MEASURES[app.peMeasure].short);
  if (app.peUnits === 'rate') p.set('peu', 'rate');
  history.replaceState(null, '', `#${p}`);
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const key = parseDsKey(p.get('year'));
  if (key !== null) app.year = key;
  const s = app.byAbbr.get((p.get('state') || '').toUpperCase());
  app.sel = s ? s.i : -1;
  app.mode = p.get('mode') === 'both' ? 'both' : 'net';
  const t = Number(p.get('top'));
  if (t >= 3 && t <= 30) app.topN = t;
  const pe = Number(p.get('pe'));
  if (app.popest.years.includes(pe)) app.popestYear = pe;
  const pem = Object.keys(PE_MEASURES).find((key) => PE_MEASURES[key].short === p.get('pem'));
  app.peMeasure = pem || 'netmig';
  app.peUnits = p.get('peu') === 'rate' ? 'rate' : 'people';
}

function syncControls() {
  yearSel.value = String(app.year);
  stateSel.value = app.sel >= 0 ? app.states[app.sel].abbr : '';
  popestSel.value = String(app.popestYear);
  topN.value = String(app.topN);
  topNOut.textContent = String(app.topN);
  for (const b of modeBtns) b.setAttribute('aria-checked', String(b.dataset.mode === app.mode));
}

let renderToken = 0;
async function render({ history = true } = {}) {
  const token = ++renderToken;
  syncControls();
  writeHash();
  document.querySelector('.map-card').classList.add('loading');
  const m = await getAcs(app.year);
  if (token !== renderToken) return;
  document.querySelector('.map-card').classList.remove('loading');
  hideTip();
  renderMap(m);
  renderFlowsTable(m);
  renderPopest();
  renderPeMap();
  if (history) await renderHistory();
}

function setYear(y) {
  app.year = y;
  render();
}
function setState(i) {
  app.sel = i;
  render();
}
function toggleState(i) {
  setState(app.sel === i ? -1 : i);
}

function initControls() {
  const single = el('optgroup', { label: 'Single year' },
    [...app.index.acs].sort((x, y) => y.year - x.year).map((a) => el('option', { value: a.year }, `ACS 1-year, ${a.year}`)));
  const combos = app.index.combined?.length
    ? el('optgroup', { label: 'Combined' }, app.index.combined.map((c) => el('option', { value: c.key }, c.label)))
    : null;
  yearSel.append(single, ...(combos ? [combos] : []));
  for (const s of [...app.states].sort((a, b) => a.name.localeCompare(b.name))) {
    stateSel.append(el('option', { value: s.abbr }, s.name));
  }
  for (const y of [...app.popest.years].sort((a, b) => b - a)) {
    popestSel.append(el('option', { value: y }, y === app.popest.years[0] ? `${y} (Apr–Jun)` : `${y - 1}–${String(y).slice(2)}`));
  }
  yearSel.addEventListener('change', () => setYear(parseDsKey(yearSel.value)));
  stateSel.addEventListener('change', () => setState(stateSel.value ? app.byAbbr.get(stateSel.value).i : -1));
  popestSel.addEventListener('change', () => {
    app.popestYear = Number(popestSel.value);
    writeHash();
    renderPopest();
    renderPeMap();
  });
  for (const [id, prop] of [['pe-measure', 'peMeasure'], ['pe-units', 'peUnits']]) {
    for (const b of document.querySelectorAll(`#${id} button`)) {
      b.addEventListener('click', () => {
        app[prop] = b.dataset.value;
        writeHash();
        renderPeMap();
      });
    }
  }
  topN.addEventListener('input', () => {
    app.topN = Number(topN.value);
    topNOut.textContent = topN.value;
    render({ history: false });
  });
  for (const b of modeBtns) {
    b.addEventListener('click', () => {
      app.mode = b.dataset.mode;
      render({ history: false });
    });
  }
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && app.sel >= 0 && !(e.target instanceof HTMLSelectElement)) setState(-1);
  });
  window.addEventListener('hashchange', () => {
    // Only app-state hashes (key=value pairs) change the view.
    if (!location.hash.includes('=')) return;
    readHash();
    render();
  });
  // The URL hash holds the view, so in-page links scroll instead of replacing it.
  document.addEventListener('click', (e) => {
    const a = e.target.closest?.('a[href^="#"]');
    if (!a || a.getAttribute('href').includes('=')) return;
    const target = document.getElementById(a.getAttribute('href').slice(1));
    if (!target) return;
    e.preventDefault();
    hideTip();
    target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  });
  window.addEventListener('scroll', hideTip, { passive: true });
  // Re-render on theme change so token colors refresh.
  window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => render());
}

async function main() {
  const [index, popest] = await Promise.all([getJson('index.json'), getJson('popest.json')]);
  app.index = index;
  app.popest = popest;
  app.states = index.states.map((s, i) => ({ ...s, i }));
  for (const s of app.states) {
    app.byFips.set(s.fips, s);
    app.byAbbr.set(s.abbr, s);
  }
  const acsYears = index.acs.map((a) => a.year);
  document.getElementById('acs-range').textContent = `${d3.min(acsYears)}–${d3.max(acsYears)}`;
  for (const n of document.querySelectorAll('.pe-vintage')) n.textContent = String(popest.vintage);
  const peLink = document.getElementById('pe-link');
  peLink.textContent = index.popest.source.replace(/\.csv$/i, '');
  if (index.popest.url) peLink.href = index.popest.url;
  app.year = d3.max(index.acs, (a) => a.year);
  app.popestYear = d3.max(popest.years);
  readHash();
  initMap();
  initPeMap();
  initControls();
  await render();
}

main().catch((err) => {
  console.error(err);
  document.querySelector('main').prepend(el('p', { class: 'card' }, `Could not load data: ${err.message}`));
});
