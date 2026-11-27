// Turns document objects into a cut job: mirror, placement, cut order, overcut,
// drag-blade offset compensation, passes, cutter axes, and HPGL.
import { bbox, pointInPoly, signedArea, pathLength } from './geom.js';
import { worldPaths } from './doc.js';
import { buildJob } from './hpgl.js';

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

/** Drag-knife compensation: the blade tip trails the holder center by `o` inches. */
export function compensate(pts, o) {
  if (!o || pts.length < 2) return pts.slice();
  const dirs = [];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i][0] - pts[i - 1][0], dy = pts[i][1] - pts[i - 1][1], L = Math.hypot(dx, dy);
    dirs.push(L ? [dx / L, dy / L] : dirs.at(-1) || [1, 0]);
  }
  const off = (p, d) => [p[0] + d[0] * o, p[1] + d[1] * o];
  const out = [off(pts[0], dirs[0])];
  for (let i = 1; i < pts.length - 1; i++) {
    const a = dirs[i - 1], b = dirs[i], p = pts[i];
    out.push(off(p, a));
    const turn = Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1]);
    if (Math.abs(turn) * (180 / Math.PI) > CORNER_DEG) {
      const a0 = Math.atan2(a[1], a[0]);
      const n = Math.max(2, Math.ceil(Math.abs(turn) / ((ARC_STEP_DEG * Math.PI) / 180)));
      for (let k = 1; k <= n; k++) {
        const ang = a0 + (turn * k) / n;
        out.push([p[0] + Math.cos(ang) * o, p[1] + Math.sin(ang) * o]);
      }
    }
  }
  out.push(off(pts.at(-1), dirs.at(-1)));
  return out;
}

/** Orders paths: inner shapes before the shapes around them, then nearest-next with a forward bias. */
export function orderPaths(paths) {
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
  let pos = [0, 0];
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
    out.push({ pts, closed: best.closed, color: best.color });
    pos = best.closed ? pts[0] : pts.at(-1);
  }
  return out;
}

/**
 * @param objects  document objects to cut
 * @param preset   { speed, force, passes, bladeOffset (mm), overcut (mm) }
 * @param s        settings (see presets.js) plus { mirror }
 */
export function prepareJob(objects, preset, s) {
  let paths = objects.flatMap((o) => worldPaths(o)).filter((p) => p.pts.length > 1);
  const warnings = [];
  if (!paths.length) return { empty: true, warnings: ['Nothing to cut.'] };
  const box = bbox(paths);

  // Mirror across the job's own width (left-right as you read the design).
  if (s.mirror) paths = paths.map((p) => ({ ...p, pts: p.pts.map(([x, y]) => [box.x + box.x1 - x, y]) }));

  // Placement relative to the blade start point.
  let dx = 0, dy = 0;
  if (s.startAtBlade) { dx = s.margin - box.x; dy = s.margin - box.y; }
  paths = paths.map((p) => ({ ...p, pts: p.pts.map(([x, y]) => [x + dx, y + dy]) }));
  const placed = bbox(paths);
  if (placed.y < -0.001 || placed.x < -0.001) warnings.push('Part of the design sits above or left of the blade start and will be clipped by the cutter.');
  if (placed.y1 > s.cutWidth + 0.001) warnings.push(`The design is ${placed.y1.toFixed(2)}" across, wider than the ${s.cutWidth}" cutting width.`);

  const ordered = orderPaths(paths);
  const o = (preset.bladeOffset || 0) * MM, oc = (preset.overcut || 0) * MM;
  const passes = Math.max(1, Math.round(preset.passes || 1));
  const cut = [];
  let cutLen = 0, travel = 0, pos = [0, 0];
  for (const p of ordered) {
    let line = p.closed ? [...p.pts, p.pts[0]] : p.pts.slice();
    if (p.closed && oc > 0) line = line.concat(lead(line, oc));
    const comp = compensate(line, o);
    travel += Math.hypot(comp[0][0] - pos[0], comp[0][1] - pos[1]);
    cutLen += pathLength(comp) * passes;
    for (let k = 0; k < passes; k++) cut.push(comp);
    pos = comp.at(-1);
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
  return {
    hpgl, ordered, placed, warnings,
    stats: { pieces: ordered.length, cutLen, travel, seconds, w: placed.x1 - Math.min(0, placed.x), h: placed.y1, passes },
  };
}

/** Test pattern: a 1" square with a triangle inside, plus a small tab at the top-left corner to show orientation. */
export function testPattern() {
  const sq = [[0, 0], [1, 0], [1, 1], [0, 1]];
  const tri = [[0.25, 0.25], [0.8, 0.5], [0.25, 0.75]];
  const tab = [[-0.25, -0.25], [-0.1, -0.25], [-0.1, -0.1], [-0.25, -0.1]];
  return [sq, tri, tab].map((pts) => ({ pts, closed: true, color: '#000000' }));
}
