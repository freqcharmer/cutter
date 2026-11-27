// Editable curves. A path can carry `nodes`: its Bézier description. `pts` (the flattened outline
// that every other feature uses) is rebuilt from the nodes after each node edit.
//
// A node: { p: [x, y], i: [x, y] | null, o: [x, y] | null, t: 'c' | 's' | 'y' }
//   p = the node, i = handle coming in, o = handle going out (null = straight on that side),
//   t = corner, smooth (handles in line), or symmetric (in line and the same length).
// A segment from node a to node b is straight when a.o and b.i are both null, else a cubic Bézier.
import fitCurve from '../vendor/fit-curve.mjs';
import { flattenCubic, TOL } from './geom.js';

const cp = (p) => (p ? [p[0], p[1]] : null);
const lerp = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const dist = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1]);
export const copyNode = (n) => ({ p: cp(n.p), i: cp(n.i), o: cp(n.o), t: n.t || 'c' });

export const segCount = (nodes, closed) => (closed ? nodes.length : nodes.length - 1);

/** The two ends and control points of segment k. */
export function segment(nodes, closed, k) {
  const a = nodes[k], b = nodes[(k + 1) % nodes.length];
  const line = !a.o && !b.i;
  return { a, b, line, c1: a.o || a.p, c2: b.i || b.p };
}

/** Point on segment k at t (0..1). */
export function segPoint(nodes, closed, k, t) {
  const { a, b, line, c1, c2 } = segment(nodes, closed, k);
  if (line) return lerp(a.p, b.p, t);
  const u = 1 - t;
  return [
    u * u * u * a.p[0] + 3 * u * u * t * c1[0] + 3 * u * t * t * c2[0] + t * t * t * b.p[0],
    u * u * u * a.p[1] + 3 * u * u * t * c1[1] + 3 * u * t * t * c2[1] + t * t * t * b.p[1],
  ];
}

/** Flattens nodes to points (tolerance in the same units as the nodes). */
export function nodesToPts(nodes, closed, tol = TOL) {
  if (!nodes.length) return [];
  const pts = [cp(nodes[0].p)];
  const n = segCount(nodes, closed);
  for (let k = 0; k < n; k++) {
    const { a, b, line, c1, c2 } = segment(nodes, closed, k);
    if (line) pts.push(cp(b.p));
    else flattenCubic(a.p, c1, c2, b.p, pts, tol);
  }
  if (closed && pts.length > 1 && dist(pts[0], pts.at(-1)) < 1e-9) pts.pop();
  return pts;
}

/** Rebuilds a path's points from its nodes (in place) and returns it. */
export function refresh(path) {
  path.pts = nodesToPts(path.nodes, path.closed);
  if (path.closed && path.nodes.length < 3 && !path.nodes.some((n) => n.i || n.o)) path.closed = false;
  return path;
}

export const transformNodes = (nodes, m) => nodes.map((n) => ({
  p: [m[0] * n.p[0] + m[2] * n.p[1] + m[4], m[1] * n.p[0] + m[3] * n.p[1] + m[5]],
  i: n.i ? [m[0] * n.i[0] + m[2] * n.i[1] + m[4], m[1] * n.i[0] + m[3] * n.i[1] + m[5]] : null,
  o: n.o ? [m[0] * n.o[0] + m[2] * n.o[1] + m[4], m[1] * n.o[0] + m[3] * n.o[1] + m[5]] : null,
  t: n.t || 'c',
}));

/** Corner, smooth, or symmetric, judged from where the handles point. */
export function classify(n) {
  if (!n.i || !n.o) return 'c';
  const a = [n.p[0] - n.i[0], n.p[1] - n.i[1]], b = [n.o[0] - n.p[0], n.o[1] - n.p[1]];
  const la = Math.hypot(...a), lb = Math.hypot(...b);
  if (la < 1e-9 || lb < 1e-9) return 'c';
  const cross = (a[0] * b[1] - a[1] * b[0]) / (la * lb), dot = (a[0] * b[0] + a[1] * b[1]) / (la * lb);
  if (Math.abs(cross) > 0.02 || dot < 0) return 'c';
  return Math.abs(la - lb) < 1e-4 ? 'y' : 's';
}

/** Removes nodes that sit on top of the previous one with a straight segment between them. */
export function cleanNodes(nodes, closed, eps = 1e-5) {
  const out = [];
  for (const n of nodes) {
    const l = out.at(-1);
    if (l && dist(l.p, n.p) < eps && !l.o && !n.i) { l.o = cp(n.o); continue; }
    out.push(copyNode(n));
  }
  if (closed && out.length > 1) {
    const f = out[0], l = out.at(-1);
    if (dist(f.p, l.p) < eps) { f.i = cp(l.i); out.pop(); }
  }
  for (const n of out) n.t = classify(n);
  return out;
}

// ---------- fitting curves to flattened outlines ----------
const CORNER_DEG = 38;      // a turn sharper than this is a corner
const LONG_SEG = 0.2;       // inches: a segment this long stays a straight line

function dedupe(pts, eps = 1e-5) {
  const out = [];
  for (const p of pts) { const l = out.at(-1); if (!l || dist(l, p) > eps) out.push(p); }
  return out;
}
function turnDeg(a, b, c) {
  const u = [b[0] - a[0], b[1] - a[1]], v = [c[0] - b[0], c[1] - b[1]];
  const lu = Math.hypot(...u), lv = Math.hypot(...v);
  if (lu < 1e-12 || lv < 1e-12) return 0;
  const cos = Math.max(-1, Math.min(1, (u[0] * v[0] + u[1] * v[1]) / (lu * lv)));
  return (Math.acos(cos) * 180) / Math.PI;
}
const nearlyStraight = (b, err) => {
  const [p0, c1, c2, p3] = b;
  const L = dist(p0, p3);
  if (L < 1e-9) return false;
  const off = (q) => Math.abs((p3[0] - p0[0]) * (p0[1] - q[1]) - (p0[0] - q[0]) * (p3[1] - p0[1])) / L;
  return off(c1) < err * 0.5 && off(c2) < err * 0.5;
};

/**
 * Fits Bézier nodes to a flattened outline: splits at corners and long straight segments,
 * then fits curves through the rest. `err` is the allowed distance from the original (inches).
 */
export function fitNodes(ptsIn, closed, err = 0.005) {
  let pts = dedupe(ptsIn);
  if (closed && pts.length > 2 && dist(pts[0], pts.at(-1)) < 1e-5) pts.pop();
  const n = pts.length;
  if (n < 2) return pts.map((p) => ({ p: cp(p), i: null, o: null, t: 'c' }));
  if (closed && n < 3) closed = false;
  const at = (i) => pts[((i % n) + n) % n];
  const corner = new Array(n).fill(false);
  for (let i = 0; i < n; i++) {
    if (!closed && (i === 0 || i === n - 1)) { corner[i] = true; continue; }
    if (turnDeg(at(i - 1), at(i), at(i + 1)) > CORNER_DEG) corner[i] = true;
  }
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) if (dist(at(i), at(i + 1)) > LONG_SEG) { corner[i] = true; corner[(i + 1) % n] = true; }

  // Start at a corner (closed paths with none start at 0 and get a smooth joint there).
  let start = closed ? corner.indexOf(true) : 0;
  const smoothLoop = closed && start < 0;
  if (start < 0) start = 0;
  const order = [];
  for (let k = 0; k <= (closed ? n : n - 1); k++) order.push(closed ? (start + k) % n : k);
  // order ends where it starts for closed paths
  const nodes = [{ p: cp(at(order[0])), i: null, o: null }];
  let runStart = 0;
  const flush = (runEnd) => {
    const run = [];
    for (let k = runStart; k <= runEnd; k++) run.push(at(order[k]));
    if (run.length === 2) { nodes.push({ p: cp(run[1]), i: null, o: null }); return; }
    let curves;
    try { curves = fitCurve(run, err * err); } catch { curves = null; }
    if (!curves || !curves.length) { for (let k = 1; k < run.length; k++) nodes.push({ p: cp(run[k]), i: null, o: null }); return; }
    for (const b of curves) {
      if (nearlyStraight(b, Math.min(err, 0.004))) nodes.push({ p: cp(b[3]), i: null, o: null });
      else { nodes.at(-1).o = cp(b[1]); nodes.push({ p: cp(b[3]), i: cp(b[2]), o: null }); }
    }
  };
  for (let k = 1; k < order.length; k++) {
    const idx = order[k];
    if (corner[idx] || k === order.length - 1) { flush(k); runStart = k; }
  }
  if (closed) {
    const last = nodes.pop(); // same point as the first node
    nodes[0].i = cp(last.i);
  }
  for (const nd of nodes) nd.t = classify(nd);
  if (smoothLoop && nodes[0].i && nodes[0].o) setType(nodes, 0, 's');
  return nodes;
}

// ---------- editing helpers (all work in place on a nodes array) ----------

/** Makes node j a corner, smooth, or symmetric node, adjusting its handles to match. */
export function setType(nodes, j, t, closed = true) {
  const n = nodes[j];
  n.t = t;
  if (t === 'c') return;
  const len = nodes.length;
  const prev = j > 0 || closed ? nodes[(j - 1 + len) % len] : null;
  const next = j < len - 1 || closed ? nodes[(j + 1) % len] : null;
  if (!n.i && !n.o) {
    if (!prev || !next) return;
    const d = [next.p[0] - prev.p[0], next.p[1] - prev.p[1]], L = Math.hypot(...d) || 1;
    const u = [d[0] / L, d[1] / L], a = dist(prev.p, n.p) / 3, b = dist(n.p, next.p) / 3;
    n.i = [n.p[0] - u[0] * a, n.p[1] - u[1] * a];
    n.o = [n.p[0] + u[0] * b, n.p[1] + u[1] * b];
  } else if (!n.i || !n.o) {
    const h = n.i || n.o, other = n.i ? next : prev;
    const L = other ? dist(n.p, other.p) / 3 : dist(n.p, h);
    const d = [n.p[0] - h[0], n.p[1] - h[1]], dl = Math.hypot(...d) || 1;
    const m = [n.p[0] + (d[0] / dl) * L, n.p[1] + (d[1] / dl) * L];
    if (n.i) n.o = m; else n.i = m;
  }
  const a = [n.o[0] - n.i[0], n.o[1] - n.i[1]], L = Math.hypot(...a) || 1, u = [a[0] / L, a[1] / L];
  let li = dist(n.p, n.i), lo = dist(n.p, n.o);
  if (t === 'y') li = lo = (li + lo) / 2;
  n.i = [n.p[0] - u[0] * li, n.p[1] - u[1] * li];
  n.o = [n.p[0] + u[0] * lo, n.p[1] + u[1] * lo];
}

/** Moves handle `which` ('i' or 'o') of node j to q, keeping a smooth or symmetric node in line. */
export function moveHandle(n, which, q, breakLink = false) {
  n[which] = cp(q);
  if (breakLink) { n.t = 'c'; return; }
  const other = which === 'i' ? 'o' : 'i';
  if ((n.t === 's' || n.t === 'y') && n[other]) {
    const d = [n.p[0] - q[0], n.p[1] - q[1]], L = Math.hypot(...d);
    if (L < 1e-9) return;
    const keep = n.t === 'y' ? L : dist(n.p, n[other]);
    n[other] = [n.p[0] + (d[0] / L) * keep, n.p[1] + (d[1] / L) * keep];
  }
}

/** Splits a cubic at t (de Casteljau). */
function splitCubic(p0, p1, p2, p3, t) {
  const a = lerp(p0, p1, t), b = lerp(p1, p2, t), c = lerp(p2, p3, t);
  const d = lerp(a, b, t), e = lerp(b, c, t), m = lerp(d, e, t);
  return [a, d, m, e, c];
}

/** Adds a node on segment k at t. Returns the new node's index. */
export function insertNode(nodes, closed, k, t) {
  const { a, b, line, c1, c2 } = segment(nodes, closed, k);
  let nn;
  if (line) nn = { p: lerp(a.p, b.p, t), i: null, o: null, t: 'c' };
  else {
    const [l1, l2, m, r1, r2] = splitCubic(a.p, c1, c2, b.p, t);
    a.o = l1; b.i = r2;
    nn = { p: m, i: l2, o: r1, t: 's' };
  }
  nodes.splice(k + 1, 0, nn);
  return k + 1;
}

/** Nearest point on the path: { k (segment), t, d (distance), pt }. */
export function nearestOnNodes(nodes, closed, q) {
  let best = { k: -1, t: 0, d: Infinity, pt: null };
  const n = segCount(nodes, closed);
  for (let k = 0; k < n; k++) {
    const S = 24;
    let bt = 0, bd = Infinity;
    for (let s = 0; s <= S; s++) { const t = s / S, p = segPoint(nodes, closed, k, t), d = dist(p, q); if (d < bd) { bd = d; bt = t; } }
    let lo = Math.max(0, bt - 1 / S), hi = Math.min(1, bt + 1 / S);
    for (let it = 0; it < 24; it++) {
      const m1 = lo + (hi - lo) / 3, m2 = hi - (hi - lo) / 3;
      if (dist(segPoint(nodes, closed, k, m1), q) < dist(segPoint(nodes, closed, k, m2), q)) hi = m2; else lo = m1;
    }
    const t = (lo + hi) / 2, pt = segPoint(nodes, closed, k, t), d = dist(pt, q);
    if (d < best.d) best = { k, t, d, pt };
  }
  return best;
}

/** Reverses a node list (handles swap sides). */
export const reverseNodes = (nodes) => nodes.slice().reverse().map((n) => ({ p: cp(n.p), i: cp(n.o), o: cp(n.i), t: n.t }));

/** Makes segment k straight or curved. */
export function setSegment(nodes, closed, k, curve) {
  const a = nodes[k], b = nodes[(k + 1) % nodes.length];
  if (curve) {
    if (!a.o) a.o = lerp(a.p, b.p, 1 / 3);
    if (!b.i) b.i = lerp(a.p, b.p, 2 / 3);
  } else { a.o = null; b.i = null; }
  a.t = classify(a); b.t = classify(b);
}

/**
 * Breaks a path at node j. A closed path opens there; an open path splits in two.
 * Returns the resulting paths ({ nodes, closed }).
 */
export function breakAt(path, j) {
  const N = path.nodes;
  if (path.closed) {
    const rot = [...N.slice(j), ...N.slice(0, j)].map(copyNode);
    const end = copyNode(N[j]); end.o = null; end.t = 'c';
    rot[0].i = null; rot[0].t = 'c';
    return [{ nodes: [...rot, end], closed: false }];
  }
  if (j <= 0 || j >= N.length - 1) return [{ nodes: N.map(copyNode), closed: false }];
  const A = N.slice(0, j + 1).map(copyNode), B = N.slice(j).map(copyNode);
  A.at(-1).o = null; A.at(-1).t = 'c'; B[0].i = null; B[0].t = 'c';
  return [{ nodes: A, closed: false }, { nodes: B, closed: false }];
}

/**
 * Joins two open-path ends. `a` and `b` are { path, end: 'start' | 'end' }.
 * Same path: closes it. Different paths: returns one combined path.
 */
export function joinEnds(a, b, snap = 0.01) {
  if (a.path === b.path) {
    const N = a.path.nodes.map(copyNode);
    const f = N[0], l = N.at(-1);
    if (N.length > 2 && dist(f.p, l.p) < snap) { f.i = l.i; f.t = classify(f); N.pop(); }
    return { nodes: N, closed: true };
  }
  let P = a.path.nodes.map(copyNode), Q = b.path.nodes.map(copyNode);
  if (a.end === 'start') P = reverseNodes(P);
  if (b.end === 'end') Q = reverseNodes(Q);
  const pl = P.at(-1), qf = Q[0];
  if (dist(pl.p, qf.p) < snap) { pl.o = qf.o; pl.t = classify(pl); Q = Q.slice(1); }
  return { nodes: [...P, ...Q], closed: false };
}

/** Nodes for an elliptical arc (angles in radians, rotation in radians), split into pieces of 90° or less. */
export function arcNodes(cx, cy, rx, ry, a0, a1, rot = 0) {
  const sweep = a1 - a0, pieces = Math.max(1, Math.ceil(Math.abs(sweep) / (Math.PI / 2) - 1e-9));
  const d = sweep / pieces, k = (4 / 3) * Math.tan(d / 4);
  const c = Math.cos(rot), s = Math.sin(rot);
  const P = (x, y) => [cx + x * c - y * s, cy + x * s + y * c];
  const pt = (a) => P(rx * Math.cos(a), ry * Math.sin(a));
  const tan = (a) => [-rx * Math.sin(a), ry * Math.cos(a)];
  const nodes = [{ p: pt(a0), i: null, o: null, t: 'c' }];
  for (let j = 0; j < pieces; j++) {
    const s0 = a0 + j * d, s1 = s0 + d, t0 = tan(s0), t1 = tan(s1);
    const p0l = [rx * Math.cos(s0) + k * t0[0], ry * Math.sin(s0) + k * t0[1]];
    const p1l = [rx * Math.cos(s1) - k * t1[0], ry * Math.sin(s1) - k * t1[1]];
    nodes.at(-1).o = P(...p0l);
    nodes.push({ p: pt(s1), i: P(...p1l), o: null, t: 'c' });
  }
  return nodes;
}
