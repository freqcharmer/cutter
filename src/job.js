// Turns document objects into cut jobs ("sheets"): color layers, registration marks, tiling,
// mirror, placement, weed border and weed lines, cut order, overcut, drag-blade offset
// compensation, passes, cutter axes, and HPGL.
import { bbox, unionBox, pointInPoly, signedArea, pathLength } from './geom.js';
import { worldPaths } from './doc.js';
import { buildJob } from './hpgl.js';
import { offset, outers, linesOutside, clipToRect } from './clip.js';

const MM = 1 / 25.4;
const CORNER_DEG = 12;   // turns sharper than this get a blade swivel arc
const ARC_STEP_DEG = 15;

/** Points along an open polyline for `dist` inches from its start. */
function lead(pts, dist) {
  const out = [];
  let left = dist;
  for (let i = 1; i < pts.length && left > 0; i++) {
    const [ax, ay] = pts[i - 1], [bx, by] = pts[i];
    const L = Math.hypot(bx - ax, by - ay);
    if (L >= left) { const t = left / L; out.push([ax + (bx - ax) * t, ay + (by - ay) * t]); break; }
    out.push(pts[i]); left -= L;
  }
  return out;
}

/**
 * Drag-knife compensation: the blade tip trails the holder center by `o` inches.
 * `prevDir` is the direction the blade was last cutting; when it differs from this path's
 * first direction, a swivel arc around the start point lines the blade up before the cut
 * (the lead-in fix). Returns { pts, dir } where dir is the direction at the end.
 */
export function compensate(pts, o, prevDir = null) {
  if (pts.length < 2) return { pts: pts.slice(), dir: prevDir };
  const dirs = [];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1], L = Math.hypot(dx, dy);
    dirs.push(L ? [dx / L, dy / L] : dirs.at(-1) || [1, 0]);
  }
  if (!o) return { pts: pts.slice(), dir: dirs.at(-1) };
  const off = (p, d) => [p[0] + d[0] * o, p[1] + d[1] * o];
  const swivel = (p, a, b, out) => {
    const turn = Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]);
    if (Math.abs(turn) * (180 / Math.PI) <= CORNER_DEG) return false;
    const a0 = Math.atan2(a[1], a[0]);
    const n = Math.max(2, Math.ceil(Math.abs(turn) / ((ARC_STEP_DEG * Math.PI) / 180)));
    for (let k = 1; k <= n; k++) {
      const ang = a0 + (turn * k) / n;
      out.push([p[0] + Math.cos(ang) * o, p[1] + Math.sin(ang) * o]);
    }
    return true;
  };
  const out = [];
  // Lead-in: lower the blade where its tip already sits on the start point, then turn it.
  if (prevDir) { out.push(off(pts[0], prevDir)); if (!swivel(pts[0], prevDir, dirs[0], out)) out.length = 0; }
  if (!out.length) out.push(off(pts[0], dirs[0]));
  for (let i = 1; i < pts.length - 1; i++) {
    out.push(off(pts[i], dirs[i - 1]));
    swivel(pts[i], dirs[i - 1], dirs[i], out);
  }
  out.push(off(pts.at(-1), dirs.at(-1)));
  return { pts: out, dir: dirs.at(-1) };
}

/** Orders paths: inner shapes before the shapes around them, then nearest-next with a forward bias. */
export function orderPaths(paths, start = [0, 0]) {
  const items = paths.map((p, i) => ({ ...p, i, box: bbox([p]), area: p.closed ? Math.abs(signedArea(p.pts)) : 0, inside: [] }));
  for (const a of items) {
    if (!a.closed) continue;
    for (const b of items) {
      if (a === b || b.area >= a.area && b.closed) continue;
      const bb = b.box, ab = a.box;
      if (bb.x >= ab.x && bb.y >= ab.y && bb.x1 <= ab.x1 && bb.y1 <= ab.y1 && pointInPoly(b.pts[0], a.pts)) a.inside.push(b);
    }
  }
  const done = new Set(), out = [];
  let pos = start;
  while (out.length < items.length) {
    let best = null, bestD = Infinity, bestK = 0;
    for (const it of items) {
      if (done.has(it) || it.inside.some((c) => !done.has(c))) continue;
      const cand = it.closed ? it.pts.map((p, k) => [p, k]) : [[it.pts[0], 0], [it.pts.at(-1), -1]];
      for (const [p, k] of cand) {
        const dx = p[0] - pos[0], dy = p[1] - pos[1];
        const d = Math.hypot(dx < 0 ? dx * 3 : dx, dy); // moving back along the roll costs more
        if (d < bestD) { bestD = d; best = it; bestK = k; }
      }
    }
    if (!best) break;
    done.add(best);
    let pts = best.pts;
    if (best.closed) pts = [...pts.slice(bestK), ...pts.slice(0, bestK)];
    else if (bestK === -1) pts = [...pts].reverse();
    out.push({ pts, closed: best.closed, color: best.color, kind: best.kind });
    pos = best.closed ? pts[0] : pts.at(-1);
  }
  return out;
}

// ---------- marks ----------
/** A small cross (two open lines) centered on (x, y). */
export const cross = (x, y, arm = 0.25) => [
  { pts: [[x - arm, y], [x + arm, y]], closed: false, kind: 'mark' },
  { pts: [[x, y - arm], [x, y + arm]], closed: false, kind: 'mark' },
];

// Seven-segment digits, cut as short open lines, for numbering panels.
const SEG = { a: [[0, 0], [1, 0]], b: [[1, 0], [1, 0.5]], c: [[1, 0.5], [1, 1]], d: [[0, 1], [1, 1]], e: [[0, 0.5], [0, 1]], f: [[0, 0], [0, 0.5]], g: [[0, 0.5], [1, 0.5]] };
const DIGITS = ['abcdef', 'bc', 'abged', 'abgcd', 'fgbc', 'afgcd', 'afgedc', 'abc', 'abcdefg', 'abcdfg'];
export function numberPaths(n, x, y, h = 0.4) {
  const w = h * 0.55, out = [];
  String(n).split('').forEach((ch, i) => {
    const ox = x + i * w * 1.6;
    for (const s of DIGITS[+ch] || '') out.push({ pts: SEG[s].map(([u, v]) => [ox + u * w, y + v * h]), closed: false, kind: 'mark' });
  });
  return out;
}

const shift = (paths, dx, dy) => paths.map((p) => ({ ...p, pts: p.pts.map(([x, y]) => [x + dx, y + dy]) }));
const grow = (b, m) => ({ x: b.x - m, y: b.y - m, x1: b.x1 + m, y1: b.y1 + m, w: b.w + 2 * m, h: b.h + 2 * m });
const rectPath = (b, kind) => ({ pts: [[b.x, b.y], [b.x1, b.y], [b.x1, b.y1], [b.x, b.y1]], closed: true, kind });

export const JOB_DEFAULTS = {
  weedBorder: false, weedMargin: 0.25,          // inches
  weedLines: 'none', weedSpacing: 3, weedGap: 0.1, // 'none' | 'h' | 'v' | 'both'
  byColor: false, regMarks: true, layers: null, // layers: colors to cut (null = all)
  layerNames: {},                               // color → name, for step labels
  tile: false, panelW: 0, panelL: 0, overlap: 0.5, // panelW 0 = fit the cutting width; panelL 0 = no limit
};

/** Weed lines across a box, kept `gap` away from the design. */
function weedLines(design, box, how, spacing, gap) {
  const lines = [];
  const sp = Math.max(0.25, spacing);
  if (how === 'h' || how === 'both') for (let y = box.y + sp; y < box.y1 - 0.05; y += sp) lines.push({ pts: [[box.x, y], [box.x1, y]], closed: false });
  if (how === 'v' || how === 'both') for (let x = box.x + sp; x < box.x1 - 0.05; x += sp) lines.push({ pts: [[x, box.y], [x, box.y1]], closed: false });
  if (!lines.length) return [];
  const keepOut = offset([...outers(design.filter((p) => p.closed)), ...design.filter((p) => !p.closed)], Math.max(0.02, gap));
  return linesOutside(lines, keepOut).filter((p) => pathLength(p.pts) > 0.15).map((p) => ({ ...p, kind: 'weed' }));
}

/**
 * Builds one sheet (one send to the cutter) from paths in document space.
 * `originBox` is the area whose top-left corner goes to the blade start, shared by every
 * sheet of the same panel so color layers line up.
 */
function buildSheet(paths, originBox, preset, s, o) {
  const warnings = [];
  let dx = 0, dy = 0;
  if (s.startAtBlade) { dx = s.margin - originBox.x; dy = s.margin - originBox.y; }
  const design = shift(paths, dx, dy);
  const dbox = bbox(design);
  const extra = [];
  const wbox = grow(dbox, o.weedMargin);
  if (o.weedLines && o.weedLines !== 'none') extra.push(...weedLines(design, wbox, o.weedLines, o.weedSpacing, o.weedGap));
  const border = o.weedBorder ? [rectPath(wbox, 'weed')] : [];
  const placed = bbox([...design, ...border, ...extra]);
  if (placed.y < -0.001 || placed.x < -0.001) warnings.push('Part of the job sits above or left of the blade start and will be clipped by the cutter.');
  if (placed.y1 > s.cutWidth + 0.001) warnings.push(`The job is ${placed.y1.toFixed(2)}" across, wider than the ${s.cutWidth}" cutting width. Turn on Tiling, or make it smaller.`);

  // Design first (inner shapes first), then weed lines, then the border last so the sheet stays put.
  const ordered = orderPaths(design);
  const lastPos = ordered.length ? (ordered.at(-1).closed ? ordered.at(-1).pts[0] : ordered.at(-1).pts.at(-1)) : [0, 0];
  ordered.push(...orderPaths(extra, lastPos), ...orderPaths(border, lastPos));

  const off = (preset.bladeOffset || 0) * MM, oc = (preset.overcut || 0) * MM;
  const passes = Math.max(1, Math.round(preset.passes || 1));
  const cut = [];
  let cutLen = 0, travel = 0, pos = [0, 0], dir = [1, 0]; // assume the blade starts pointing along the feed
  for (const p of ordered) {
    let line = p.closed ? [...p.pts, p.pts[0]] : p.pts.slice();
    if (p.closed && oc > 0) line = line.concat(lead(line, oc));
    for (let k = 0; k < passes; k++) {
      const comp = compensate(line, off, dir);
      dir = comp.dir;
      travel += Math.hypot(comp.pts[0][0] - pos[0], comp.pts[0][1] - pos[1]);
      cutLen += pathLength(comp.pts);
      cut.push(comp.pts);
      pos = comp.pts.at(-1);
    }
  }

  // Map document axes to cutter axes.
  const all = bbox(cut.map((pts) => ({ pts })));
  const map = ([x, y]) => {
    let X = s.swapXY ? y : x, Y = s.swapXY ? x : y;
    const mx = s.swapXY ? all.y1 : all.x1, my = s.swapXY ? all.x1 : all.y1;
    if (s.flipX) X = mx - X;
    if (s.flipY) Y = my - Y;
    return [X, Y];
  };
  const end = s.afterCut === 'origin' ? [0, 0] : [placed.x1 + 1, 0];
  const hpgl = buildJob(cut.map((pts) => pts.map(map)), {
    speed: preset.speed, force: preset.force, stepsPerInch: s.stepsPerInch,
    sendSpeedForce: s.sendSpeedForce, end: map(end),
  });

  const ips = (preset.speed || 20) / 2.54;
  // Real cutters slow down for corners and curves, so pad the straight-line estimate.
  const seconds = (cutLen / ips) * 1.6 + travel / (ips * 1.5) + cut.length * 0.4;
  const pieces = ordered.filter((p) => p.kind !== 'weed' && p.kind !== 'mark').length;
  return {
    hpgl, ordered, placed, warnings,
    stats: { pieces, weeds: extra.length + border.length, cutLen, travel, seconds, w: placed.x1 - Math.min(0, placed.x), h: placed.y1, passes, length: placed.x1 + s.margin },
  };
}

/**
 * Plans a cut as one or more sheets.
 * @param objects  document objects to cut
 * @param preset   { speed, force, passes, bladeOffset (mm), overcut (mm) }
 * @param s        settings (see presets.js) plus { mirror, startAtBlade }
 * @param opt      see JOB_DEFAULTS
 * @returns { empty?, sheets: [{ label, color, panel, hpgl, ordered, placed, warnings, stats }], warnings, totals }
 */
export function planJob(objects, preset, s, opt = {}) {
  const o = { ...JOB_DEFAULTS, ...opt };
  const warnings = [];
  const groups = new Map();
  for (const ob of objects) {
    const color = (ob.color || '#000000').toLowerCase();
    if (o.layers && !o.layers.includes(color)) continue;
    const ps = worldPaths(ob).filter((p) => p.pts.length > 1).map((p) => ({ pts: p.pts, closed: p.closed, color, kind: 'design' }));
    if (!ps.length) continue;
    const key = o.byColor ? color : 'all';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(...ps);
  }
  if (!groups.size) return { empty: true, sheets: [], warnings: ['Nothing to cut.'] };
  const allPaths = [...groups.values()].flat();
  const dbox = bbox(allPaths);

  // Registration marks: the same crosses at the design's corners on every color layer.
  let reg = [];
  if (o.byColor && o.regMarks && groups.size > 1) {
    const m = 0.4;
    reg = [[dbox.x - m, dbox.y - m], [dbox.x1 + m, dbox.y - m], [dbox.x - m, dbox.y1 + m], [dbox.x1 + m, dbox.y1 + m]].flatMap(([x, y]) => cross(x, y, 0.2));
  }
  let frame = unionBox(dbox, reg.length ? bbox(reg) : null);

  // Mirror everything across the shared frame, so layers still line up.
  const mirror = (ps) => (s.mirror ? ps.map((p) => ({ ...p, pts: p.pts.map(([x, y]) => [frame.x + frame.x1 - x, y]) })) : ps);
  for (const [k, ps] of groups) groups.set(k, mirror(ps));
  reg = mirror(reg);

  // Panels (tiling). Without tiling there is one panel: the whole frame.
  const panels = [];
  if (o.tile) {
    const P = Math.max(1, o.panelW || s.cutWidth - 2 * s.margin - (o.weedBorder ? 2 * o.weedMargin : 0));
    const ov = Math.max(0, Math.min(o.overlap, P / 2));
    const L = o.panelL > 0 ? Math.max(1, o.panelL) : Infinity;
    const ovL = Number.isFinite(L) ? Math.max(0, Math.min(o.overlap, L / 2)) : 0;
    const ny = Math.max(1, Math.ceil((frame.h - ov) / (P - ov) - 1e-9));
    const nx = Number.isFinite(L) ? Math.max(1, Math.ceil((frame.w - ovL) / (L - ovL) - 1e-9)) : 1;
    for (let iy = 0; iy < ny; iy++) {
      for (let ix = 0; ix < nx; ix++) {
        const y0 = frame.y + iy * (P - ov), y1 = Math.min(frame.y1, y0 + P);
        const x0 = Number.isFinite(L) ? frame.x + ix * (L - ovL) : frame.x;
        const x1 = Number.isFinite(L) ? Math.min(frame.x1, x0 + L) : frame.x1;
        const e = 0.01; // let shapes lying on the outer edge survive the clip
        const clip = { x: ix ? x0 : x0 - 1, y: iy ? y0 : y0 - e, x1: ix < nx - 1 ? x1 : x1 + 1, y1: iy < ny - 1 ? y1 : y1 + e };
        // Alignment crosses in the overlap with each neighbor, outside the design on the left and right.
        const marks = [];
        const band = (a, b) => (a + b) / 2;
        if (iy > 0) { const yb = band(y0, frame.y + (iy - 1) * (P - ov) + P); marks.push(...cross(frame.x - 0.6, yb, Math.min(0.25, ov / 2 || 0.25)), ...cross(frame.x1 + 0.6, yb, Math.min(0.25, ov / 2 || 0.25))); }
        if (iy < ny - 1) { const yb = band(frame.y + (iy + 1) * (P - ov), y1); marks.push(...cross(frame.x - 0.6, yb, Math.min(0.25, ov / 2 || 0.25)), ...cross(frame.x1 + 0.6, yb, Math.min(0.25, ov / 2 || 0.25))); }
        if (Number.isFinite(L)) {
          if (ix > 0) { const xb = band(x0, frame.x + (ix - 1) * (L - ovL) + L); marks.push(...cross(xb, y0 - 0.6, 0.2), ...cross(xb, y1 + 0.6, 0.2)); }
          if (ix < nx - 1) { const xb = band(frame.x + (ix + 1) * (L - ovL), x1); marks.push(...cross(xb, y0 - 0.6, 0.2), ...cross(xb, y1 + 0.6, 0.2)); }
        }
        const n = iy * nx + ix + 1;
        if (nx * ny > 1) marks.push(...numberPaths(n, Math.min(x0, frame.x) - 1.3, y0 + 0.15));
        const area = { x: Math.max(x0, frame.x), y: Math.max(y0, frame.y), x1: Math.min(x1, frame.x1), y1: Math.min(y1, frame.y1) };
        panels.push({ n, count: nx * ny, clip, marks, originBox: unionBox({ ...area, w: area.x1 - area.x, h: area.y1 - area.y }, marks.length ? bbox(marks) : null) });
      }
    }
  } else {
    panels.push({ n: 1, count: 1, clip: null, marks: [], originBox: frame });
  }

  const sheets = [];
  for (const [key, ps] of groups) {
    for (const pn of panels) {
      let design = ps, marks = [...reg];
      if (pn.clip) {
        design = clipToRect(ps, pn.clip).map((p) => ({ ...p, kind: 'design', color: key }));
        marks = clipToRect(reg, pn.clip).map((p) => ({ ...p, kind: 'mark' }));
        if (!design.length) continue;
        marks.push(...pn.marks);
      }
      const origin = o.weedBorder || o.weedLines !== 'none' ? grow(pn.originBox, o.weedMargin) : pn.originBox;
      const sh = buildSheet([...design, ...marks], origin, preset, s, o);
      const name = key === 'all' ? '' : o.layerNames[key] || key;
      sh.color = key === 'all' ? null : key;
      sh.panel = pn.count > 1 ? pn.n : null;
      sh.label = [name, pn.count > 1 ? `Panel ${pn.n} of ${pn.count}` : ''].filter(Boolean).join(' · ') || 'Whole design';
      sheets.push(sh);
    }
  }
  for (const sh of sheets) for (const w of sh.warnings) if (!warnings.includes(w)) warnings.push(w);
  const totals = sheets.reduce((t, sh) => ({ seconds: t.seconds + sh.stats.seconds, cutLen: t.cutLen + sh.stats.cutLen, length: t.length + sh.stats.length }), { seconds: 0, cutLen: 0, length: 0 });
  return { sheets, warnings, totals, frame };
}

/** One-sheet job (all objects together, no extras). Kept for the test cut and console use. */
export function prepareJob(objects, preset, s, opt = {}) {
  const plan = planJob(objects, preset, s, opt);
  if (plan.empty) return plan;
  const sh = plan.sheets[0];
  return { ...sh, warnings: plan.warnings };
}

/** Test pattern: a 1" square with a triangle inside, plus a small tab at the top-left corner to show orientation. */
export function testPattern() {
  const sq = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const tri = [[0.25, 0.25], [0.8, 0.5], [0.25, 0.75]];
  const tab = [[-0.25, -0.25], [-0.1, -0.25], [-0.1, -0.1], [-0.25, -0.1]];
  return [sq, tri, tab].map((pts) => ({ pts, closed: true, color: '#000000' }));
}
