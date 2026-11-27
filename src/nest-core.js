// Nesting engine (no DOM; runs in the nest Web Worker, and in Node for tests).
//
// Fast: rectangle packing (MaxRects, bottom-left) on bounding boxes.
// Best fit: true-shape nesting in the style of SVGnest (Jack Qiao, MIT license): parts are placed one by
// one at the lowest-length spot their No-Fit Polygon allows, and a genetic algorithm searches part order
// and rotation. Written fresh for FantastiCut: SVGnest's own code is tied to its SVG page, and its
// "orbiting" NFP is fragile on complex shapes. Here each NFP is exact: both shapes are split into convex
// pieces, the convex pieces' Minkowski sums are joined with Clipper2. (Clipper2's own Minkowski sum was
// tested too: correct, but about 8 times slower on shapes this size.)
//
// Coordinates: integers in 1/10000 inch (Clipper's units). The roll runs along x; y is across it.
import { Clipper, Clipper64, ClipType, FillRule, ClipperOffset, JoinType, EndType } from '../vendor/clipper2.mjs';

export const SCALE = 10000;

// ---------- small geometry helpers ----------
const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
const areaOf = (p) => { let s = 0; for (let i = 0; i < p.length; i++) { const a = p[i], b = p[(i + 1) % p.length]; s += a.x * b.y - b.x * a.y; } return s / 2; };
const ccw = (p) => (areaOf(p) < 0 ? p.slice().reverse() : p);
const isConvex = (p) => { const n = p.length; for (let i = 0; i < n; i++) if (cross(p[i], p[(i + 1) % n], p[(i + 2) % n]) < 0) return false; return true; };
const key = (p) => p.x + ',' + p.y;
const bounds = (paths) => {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of paths) for (const q of p) { if (q.x < x0) x0 = q.x; if (q.y < y0) y0 = q.y; if (q.x > x1) x1 = q.x; if (q.y > y1) y1 = q.y; }
  return { x0, y0, x1, y1 };
};
function boolOp(type, subj, clip = []) {
  const c = new Clipper64();
  if (subj.length) c.addSubject(subj);
  if (clip.length) c.addClip(clip);
  const out = [];
  c.execute(type, FillRule.NonZero, out, []);
  return out;
}

/** Splits a region (outer outlines plus holes) into convex pieces: triangulate, then merge across shared edges. */
export function convexPieces(paths) {
  const tr = Clipper.triangulate(paths, false);
  let pieces = (tr.solution || []).map(ccw).filter((t) => Math.abs(areaOf(t)) > 0);
  for (let pass = 0; pass < 4; pass++) {
    let merged = false;
    const edges = new Map();
    pieces.forEach((p, i) => p.forEach((a, j) => edges.set(key(a) + '|' + key(p[(j + 1) % p.length]), [i, j])));
    const dead = new Set();
    for (let i = 0; i < pieces.length; i++) {
      if (dead.has(i)) continue;
      const p = pieces[i];
      for (let j = 0; j < p.length; j++) {
        const a = p[j], b = p[(j + 1) % p.length], o = edges.get(key(b) + '|' + key(a));
        if (!o || o[0] === i || dead.has(o[0])) continue;
        const q = pieces[o[0]], k = o[1];
        const P = [], Q = [];
        for (let t = 0; t < p.length; t++) P.push(p[(j + 1 + t) % p.length]);
        for (let t = 0; t < q.length; t++) Q.push(q[(k + 1 + t) % q.length]);
        const cand = [...P, ...Q.slice(1, -1)];
        if (isConvex(cand)) {
          pieces[i] = cand; dead.add(o[0]); merged = true;
          // edges of the merged piece now point at i
          cand.forEach((a2, jj) => edges.set(key(a2) + '|' + key(cand[(jj + 1) % cand.length]), [i, jj]));
          break;
        }
      }
    }
    pieces = pieces.filter((_, i) => !dead.has(i));
    if (!merged) break;
  }
  return pieces;
}

/** Minkowski sum of two convex, counter-clockwise polygons. */
function convexSum(P, Q) {
  const low = (p) => { let i = 0; for (let k = 1; k < p.length; k++) if (p[k].y < p[i].y || (p[k].y === p[i].y && p[k].x < p[i].x)) i = k; return i; };
  const a = low(P), b = low(Q), n = P.length, m = Q.length, out = [];
  let i = 0, j = 0;
  while (i < n || j < m) {
    const p0 = P[(a + i) % n], p1 = P[(a + i + 1) % n], q0 = Q[(b + j) % m], q1 = Q[(b + j + 1) % m];
    out.push({ x: p0.x + q0.x, y: p0.y + q0.y });
    const c = (p1.x - p0.x) * (q1.y - q0.y) - (p1.y - p0.y) * (q1.x - q0.x);
    if (j >= m || (i < n && c > 0)) i++; else if (i >= n || c < 0) j++; else { i++; j++; }
  }
  return out;
}

/** No-Fit Polygon: where B's origin may NOT go so B stays outside A (both in their own coordinates). */
export function nfp(aPieces, bNegPieces) {
  const sums = [];
  for (const x of aPieces) for (const y of bNegPieces) sums.push(convexSum(x, y));
  return boolOp(ClipType.Union, sums);
}

// ---------- preparing parts ----------
/**
 * Prepares one part: grows it by half the spacing, simplifies it, and makes each rotation.
 * `paths` are closed outlines in inches (holes included). Returns null if it has no area.
 */
export function preparePart(id, paths, { spacing = 0.125, rotations = [0], holes = false, simplify = 0.015 } = {}) {
  const toP = (ps) => ps.filter((p) => p.length > 2).map((p) => p.map(([x, y]) => ({ x: Math.round(x * SCALE), y: Math.round(y * SCALE) })));
  let reg = boolOp(ClipType.Union, toP(paths));
  if (!reg.length) return null;
  const grow = spacing / 2 * SCALE;
  if (grow > 0) {
    const co = new ClipperOffset(2, 0.004 * SCALE);
    co.addPaths(reg, JoinType.Round, EndType.Polygon);
    const g = []; co.execute(grow, g); reg = boolOp(ClipType.Union, g);
  }
  reg = reg.map((p) => Clipper.ramerDouglasPeucker(p, simplify * SCALE)).filter((p) => p.length > 2 && Math.abs(areaOf(p)) > 4);
  reg = boolOp(ClipType.Union, reg);
  if (!reg.length) return null;
  const outerOnly = reg.filter((p) => areaOf(p) > 0);
  const area = Math.abs(reg.reduce((s, p) => s + areaOf(p), 0));
  const rots = rotations.map((deg) => {
    const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
    const rot = (ps) => ps.map((p) => p.map((q) => ({ x: Math.round(q.x * c - q.y * s), y: Math.round(q.x * s + q.y * c) })));
    const R = rot(reg), O = rot(outerOnly.length ? outerOnly : reg);
    const b = bounds(R);
    const norm = (ps) => ps.map((p) => p.map((q) => ({ x: q.x - b.x0, y: q.y - b.y0 })));
    const region = norm(R), outer = norm(O);
    return {
      deg, w: b.x1 - b.x0, h: b.y1 - b.y0, minx: b.x0, miny: b.y0,
      region, outer,
      aPieces: convexPieces(holes ? region : outer),
      bNeg: convexPieces(outer).map((p) => ccw(p.map((q) => ({ x: -q.x, y: -q.y })))),
    };
  });
  return { id, area, rots };
}

// ---------- placement ----------
/**
 * Places parts in order (with the chosen rotation index for each) along the strip
 * { x0, y0, y1 } (integer units). `fixed` are obstacles already on the roll (regions with pieces).
 * Returns { placements: [{ id, rot, x, y }], length, unplaced: [ids] }.
 */
export function placeAll(parts, order, rotIdx, strip, cache, fixed = []) {
  const placed = []; // { part, r, x, y }
  const placements = [], unplaced = [];
  let maxX = strip.x0;
  const totalW = parts.reduce((s, p) => s + Math.max(...p.rots.map((r) => Math.max(r.w, r.h))), 0);
  const X = strip.x0 + totalW + SCALE * 10;
  for (let gi = 0; gi < order.length; gi++) {
    const part = parts[order[gi]], r = part.rots[rotIdx[gi] % part.rots.length];
    const ty1 = strip.y1 - r.h;
    if (ty1 < strip.y0) { unplaced.push(part.id); continue; }
    const forb = [];
    for (const f of fixed) {
      const k = 'F' + f.id + '|' + part.id + ':' + r.deg;
      let n = cache.get(k);
      if (!n) { n = nfp(f.aPieces, r.bNeg); cache.set(k, n); }
      forb.push(...n);
    }
    for (const q of placed) {
      const k = q.part.id + ':' + q.r.deg + '|' + part.id + ':' + r.deg;
      let n = cache.get(k);
      if (!n) { n = nfp(q.r.aPieces, r.bNeg); cache.set(k, n); }
      for (const p of n) forb.push(p.map((v) => ({ x: v.x + q.x, y: v.y + q.y })));
    }
    const ifp = [{ x: strip.x0, y: strip.y0 }, { x: X, y: strip.y0 }, { x: X, y: ty1 }, { x: strip.x0, y: ty1 }];
    let valid;
    if (!forb.length) valid = [ifp];
    else {
      const c = new Clipper64();
      c.addSubject([ifp]); c.addClip(forb);
      valid = []; c.execute(ClipType.Difference, FillRule.NonZero, valid, []);
    }
    let best = null;
    for (const p of valid) for (const v of p) {
      if (v.x < strip.x0 - 1 || v.y < strip.y0 - 1 || v.y > ty1 + 1) continue;
      const len = Math.max(maxX, v.x + r.w);
      if (!best || len < best.len - 1 || (Math.abs(len - best.len) <= 1 && (v.x < best.x - 1 || (Math.abs(v.x - best.x) <= 1 && v.y < best.y)))) best = { len, x: v.x, y: v.y };
    }
    // a strip with no gaps left (rare): put it after everything
    if (!best) best = { x: maxX, y: strip.y0, len: maxX + r.w };
    placed.push({ part, r, x: best.x, y: best.y });
    placements.push({ id: part.id, deg: r.deg, x: best.x, y: best.y, minx: r.minx, miny: r.miny });
    maxX = Math.max(maxX, best.x + r.w);
  }
  return { placements, length: maxX - strip.x0, unplaced };
}

// ---------- genetic search over order and rotation ----------
function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

export class Nester {
  /**
   * parts: from preparePart. strip: { x0, y0, y1 } integer units. fixed: prepared obstacles placed at
   * their spots ({ id, aPieces } already in strip coordinates).
   */
  constructor(parts, strip, { fixed = [], population = 10, mutation = 0.1, seed = 7 } = {}) {
    this.parts = parts; this.strip = strip; this.fixed = fixed;
    this.cache = new Map(); this.rand = rng(seed); this.mutation = mutation; this.size = population;
    this.best = null; this.evals = 0;
    const order = parts.map((_, i) => i).sort((a, b) => parts[b].area - parts[a].area);
    const base = { order, rot: order.map(() => 0) };
    this.pop = [base];
    while (this.pop.length < population) this.pop.push(this.mutate(base, 0.3));
    this.queue = [...this.pop];
  }
  mutate(ind, rate = this.mutation) {
    const order = ind.order.slice(), rot = ind.rot.slice();
    for (let i = 0; i < order.length; i++) {
      if (this.rand() < rate && i + 1 < order.length) { [order[i], order[i + 1]] = [order[i + 1], order[i]]; [rot[i], rot[i + 1]] = [rot[i + 1], rot[i]]; }
      if (this.rand() < rate) rot[i] = Math.floor(this.rand() * this.parts[order[i]].rots.length);
    }
    return { order, rot };
  }
  crossover(a, b) {
    const cut = Math.max(1, Math.floor(this.rand() * (a.order.length - 1)));
    const order = a.order.slice(0, cut), rot = a.rot.slice(0, cut), seen = new Set(order);
    b.order.forEach((g, i) => { if (!seen.has(g)) { order.push(g); rot.push(b.rot[i]); } });
    return { order, rot };
  }
  evaluate(ind) {
    const res = placeAll(this.parts, ind.order, ind.rot, this.strip, this.cache, this.fixed);
    ind.fitness = res.length + res.unplaced.length * 1e9;
    ind.result = res;
    this.evals++;
    if (!this.best || ind.fitness < this.best.fitness) { this.best = ind; return true; }
    return false;
  }
  /** Evaluates one more arrangement. Returns true when it beat the best so far. */
  step() {
    if (!this.queue.length) this.breed();
    return this.evaluate(this.queue.shift());
  }
  breed() {
    const scored = this.pop.filter((p) => p.fitness != null).sort((a, b) => a.fitness - b.fitness);
    const pick = () => { const a = scored[Math.floor(this.rand() * scored.length)], b = scored[Math.floor(this.rand() * scored.length)]; return a.fitness < b.fitness ? a : b; };
    const next = [scored[0]];
    while (next.length < this.size) next.push(this.mutate(this.crossover(pick(), pick())));
    this.pop = next;
    this.queue = next.slice(1);
  }
}

// ---------- fast: rectangle packing ----------
/**
 * MaxRects bottom-left packing in a strip. items: [{ id, w, h }] in inches (spacing already added).
 * strip: { x0, y0, y1 } inches. rotate: allow 90°. fixed: [{ x, y, w, h }] obstacles.
 * Returns { placements: [{ id, x, y, rot90 }], length, unplaced }.
 */
export function rectPack(items, strip, { rotate = false, fixed = [] } = {}) {
  const BIG = 1e5;
  let free = [{ x: strip.x0, y: strip.y0, w: BIG, h: strip.y1 - strip.y0 }];
  const cut = (r) => {
    const out = [];
    for (const f of free) {
      if (r.x >= f.x + f.w || r.x + r.w <= f.x || r.y >= f.y + f.h || r.y + r.h <= f.y) { out.push(f); continue; }
      if (r.x > f.x) out.push({ x: f.x, y: f.y, w: r.x - f.x, h: f.h });
      if (r.x + r.w < f.x + f.w) out.push({ x: r.x + r.w, y: f.y, w: f.x + f.w - r.x - r.w, h: f.h });
      if (r.y > f.y) out.push({ x: f.x, y: f.y, w: f.w, h: r.y - f.y });
      if (r.y + r.h < f.y + f.h) out.push({ x: f.x, y: r.y + r.h, w: f.w, h: f.y + f.h - r.y - r.h });
    }
    free = out.filter((a, i) => a.w > 1e-6 && a.h > 1e-6 && !out.some((b, j) => j !== i && b.x <= a.x + 1e-9 && b.y <= a.y + 1e-9 && b.x + b.w >= a.x + a.w - 1e-9 && b.y + b.h >= a.y + a.h - 1e-9 && (j < i || !(a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h))));
  };
  for (const f of fixed) cut(f);
  const order = items.map((_, i) => i).sort((a, b) => Math.max(items[b].w, items[b].h) - Math.max(items[a].w, items[a].h) || items[b].w * items[b].h - items[a].w * items[a].h);
  const placements = [], unplaced = [];
  let maxX = strip.x0;
  for (const i of order) {
    const it = items[i];
    let best = null;
    for (const rot90 of rotate ? [false, true] : [false]) {
      const w = rot90 ? it.h : it.w, h = rot90 ? it.w : it.h;
      for (const f of free) {
        if (w > f.w + 1e-9 || h > f.h + 1e-9) continue;
        const len = Math.max(maxX, f.x + w);
        if (!best || len < best.len - 1e-9 || (Math.abs(len - best.len) <= 1e-9 && (f.x < best.x - 1e-9 || (Math.abs(f.x - best.x) <= 1e-9 && f.y < best.y)))) best = { len, x: f.x, y: f.y, w, h, rot90 };
      }
    }
    if (!best) { unplaced.push(it.id); continue; }
    cut({ x: best.x, y: best.y, w: best.w, h: best.h });
    placements.push({ id: it.id, x: best.x, y: best.y, rot90: best.rot90 });
    maxX = Math.max(maxX, best.x + best.w);
  }
  return { placements, length: maxX - strip.x0, unplaced };
}
