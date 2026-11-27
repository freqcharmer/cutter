// Polygon operations on document paths, using Clipper2 (vendor/clipper2.mjs: clipper2-ts 2.0.1, Boost license).
// Paths are { pts: [[x, y], ...], closed } in inches. Clipper works in integers, so
// coordinates are scaled by SCALE (0.0001" resolution).
import { Clipper64, ClipperOffset, ClipType, FillRule, JoinType, EndType } from '../vendor/clipper2.mjs';
import { signedArea } from './geom.js';

const SCALE = 10000;
const ARC_TOL = 0.002 * SCALE; // round corners stay within 0.002" of a true arc

const toPath = (pts) => pts.map(([x, y]) => ({ x: Math.round(x * SCALE), y: Math.round(y * SCALE) }));
const toPaths = (paths) => paths.filter((p) => p.pts.length > 1).map((p) => toPath(p.pts));
const fromPaths = (ps, closed) => {
  const out = [];
  for (const p of ps) {
    // Drop repeated points so later operations stay clean.
    const pts = [];
    for (const pt of p) {
      const l = pts.at(-1);
      if (!l || l[0] !== pt.x || l[1] !== pt.y) pts.push([pt.x, pt.y]);
    }
    if (closed && pts.length > 1 && pts[0][0] === pts.at(-1)[0] && pts[0][1] === pts.at(-1)[1]) pts.pop();
    if (pts.length < (closed ? 3 : 2)) continue;
    out.push({ pts: pts.map(([x, y]) => [x / SCALE, y / SCALE]), closed });
  }
  return out;
};

function run(type, fill, subjects, clips = [], openSubjects = []) {
  const c = new Clipper64();
  if (subjects.length) c.addSubject(toPaths(subjects));
  if (openSubjects.length) c.addOpenSubject(toPaths(openSubjects));
  if (clips.length) c.addClip(toPaths(clips));
  const closed = [], open = [];
  c.execute(type, fill, closed, open);
  return { closed: fromPaths(closed, true), open: fromPaths(open, false) };
}

/** One object's outlines as a filled region (holes stay holes), with consistent winding. */
export const region = (paths, fill = 'evenodd') =>
  run(ClipType.Union, fill === 'nonzero' ? FillRule.NonZero : FillRule.EvenOdd, paths.filter((p) => p.closed)).closed;

/**
 * Welds several groups of paths into one shape. Each group is read as its own region
 * first (so letter counters stay open), then the regions are joined.
 */
export function weld(groups, fill = 'evenodd') {
  const all = groups.flatMap((g) => region(g, fill));
  return run(ClipType.Union, FillRule.NonZero, all).closed;
}

/** Only the outer outlines of a region (holes filled in). */
export function outers(paths) {
  const r = region(paths);
  if (!r.length) return [];
  const big = r.reduce((a, b) => (Math.abs(signedArea(b.pts)) > Math.abs(signedArea(a.pts)) ? b : a));
  const sign = Math.sign(signedArea(big.pts));
  return run(ClipType.Union, FillRule.NonZero, r.filter((p) => Math.sign(signedArea(p.pts)) === sign)).closed;
}

const JOINS = { round: JoinType.Round, sharp: JoinType.Miter, bevel: JoinType.Bevel };

/**
 * Offsets (contours) paths by `dist` inches. Positive = outside, negative = inside.
 * Closed paths are offset as regions; open paths (outside only) become a band around the line.
 */
export function offset(paths, dist, join = 'round', { miterLimit = 4, fill = 'evenodd' } = {}) {
  const co = new ClipperOffset(miterLimit, ARC_TOL);
  const r = region(paths, fill);
  if (r.length) co.addPaths(toPaths(r), JOINS[join] ?? JoinType.Round, EndType.Polygon);
  const open = paths.filter((p) => !p.closed && p.pts.length > 1);
  if (open.length && dist > 0) co.addPaths(toPaths(open), JOINS[join] ?? JoinType.Round, EndType.Round);
  const out = [];
  co.execute(dist * SCALE, out);
  return run(ClipType.Union, FillRule.NonZero, fromPaths(out, true)).closed;
}

/** Open lines with everything inside `region` (closed paths) removed. */
export const linesOutside = (lines, regionPaths) =>
  run(ClipType.Difference, FillRule.NonZero, [], regionPaths, lines).open;

/** Paths cut down to the inside of a rectangle {x, y, x1, y1}. Closed stays closed, open stays open. */
export function clipToRect(paths, r) {
  const rect = [{ pts: [[r.x, r.y], [r.x1, r.y], [r.x1, r.y1], [r.x, r.y1]], closed: true }];
  const res = run(ClipType.Intersection, FillRule.EvenOdd, paths.filter((p) => p.closed), rect, paths.filter((p) => !p.closed));
  return [...res.closed, ...res.open];
}

/** Region operations on closed paths (each side read with the even-odd rule). */
export const union = (a, b = []) => run(ClipType.Union, FillRule.NonZero, [...region(a), ...region(b)]).closed;
export const intersect = (a, b) => run(ClipType.Intersection, FillRule.NonZero, region(a), region(b)).closed;
export const difference = (a, b) => run(ClipType.Difference, FillRule.NonZero, region(a), region(b)).closed;
/** Total filled area of a region, in square inches. */
export const area = (paths) => Math.abs(region(paths).reduce((s, p) => s + signedArea(p.pts), 0));
