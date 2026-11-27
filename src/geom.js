// Geometry helpers. All document geometry is in inches, y pointing down.
// A "path" is { pts: [[x, y], ...], closed: boolean }.

export const TOL = 0.004; // curve flattening tolerance, inches (~0.1 mm)

// ---------- 2D affine matrices [a, b, c, d, e, f] (same layout as SVG) ----------
export const I = [1, 0, 0, 1, 0, 0];
export const mul = (m, n) => [
  m[0] * n[0] + m[2] * n[1], m[1] * n[0] + m[3] * n[1],
  m[0] * n[2] + m[2] * n[3], m[1] * n[2] + m[3] * n[3],
  m[0] * n[4] + m[2] * n[5] + m[4], m[1] * n[4] + m[3] * n[5] + m[5],
];
export const apply = (m, [x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]];
export const translate = (x, y) => [1, 0, 0, 1, x, y];
export const scale = (sx, sy = sx) => [sx, 0, 0, sy, 0, 0];
export const rotate = (deg) => {
  const r = (deg * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
  return [c, s, -s, c, 0, 0];
};
export function invert(m) {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!det) return I.slice();
  return [m[3] / det, -m[1] / det, -m[2] / det, m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det, (m[1] * m[4] - m[0] * m[5]) / det];
}

/** Object transform: world = translate(x,y) · rotate(rot) · scale(sx,sy) · local */
export const objMatrix = (o) => mul(translate(o.x, o.y), mul(rotate(o.rot || 0), scale(o.sx, o.sy)));

export const transformPaths = (paths, m) =>
  paths.map((p) => ({ ...p, pts: p.pts.map((pt) => apply(m, pt)) }));

// ---------- curve flattening ----------
export function flattenCubic(p0, p1, p2, p3, out, tol = TOL, depth = 0) {
  // flatness test: distance of control points from chord
  const dx = p3[0] - p0[0], dy = p3[1] - p0[1];
  const d1 = Math.abs((p1[0] - p3[0]) * dy - (p1[1] - p3[1]) * dx);
  const d2 = Math.abs((p2[0] - p3[0]) * dy - (p2[1] - p3[1]) * dx);
  const len2 = dx * dx + dy * dy;
  // A near-zero chord can still hide a loop, so always subdivide a few times first.
  const flat = len2 > 1e-12 ? (d1 + d2) * (d1 + d2) <= tol * tol * len2 * 4 : depth >= 3;
  if (depth > 16 || (flat && depth >= 1)) { out.push(p3); return; }
  const m = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const p01 = m(p0, p1), p12 = m(p1, p2), p23 = m(p2, p3);
  const p012 = m(p01, p12), p123 = m(p12, p23), mid = m(p012, p123);
  flattenCubic(p0, p01, p012, mid, out, tol, depth + 1);
  flattenCubic(mid, p123, p23, p3, out, tol, depth + 1);
}
export function flattenQuad(p0, p1, p2, out, tol = TOL) {
  const c1 = [p0[0] + (2 / 3) * (p1[0] - p0[0]), p0[1] + (2 / 3) * (p1[1] - p0[1])];
  const c2 = [p2[0] + (2 / 3) * (p1[0] - p2[0]), p2[1] + (2 / 3) * (p1[1] - p2[1])];
  flattenCubic(p0, c1, c2, p2, out, tol);
}
/** Points along an elliptical/circular arc (angles in radians). */
export function arcPoints(cx, cy, rx, ry, a0, a1, rotRad = 0, tol = TOL) {
  const r = Math.max(rx, ry);
  const sweep = a1 - a0;
  const step = r > tol ? 2 * Math.acos(Math.max(-1, 1 - tol / r)) : Math.PI / 4;
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / Math.max(step, 0.01)));
  const c = Math.cos(rotRad), s = Math.sin(rotRad), pts = [];
  for (let i = 0; i <= n; i++) {
    const a = a0 + (sweep * i) / n;
    const x = rx * Math.cos(a), y = ry * Math.sin(a);
    pts.push([cx + x * c - y * s, cy + x * s + y * c]);
  }
  return pts;
}

// ---------- measurements ----------
export function bbox(paths) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of paths) for (const [x, y] of p.pts) {
    if (x < x0) x0 = x; if (y < y0) y0 = y; if (x > x1) x1 = x; if (y > y1) y1 = y;
  }
  if (x0 === Infinity) return null;
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0, x1, y1 };
}
export const unionBox = (a, b) => {
  if (!a) return b; if (!b) return a;
  const x = Math.min(a.x, b.x), y = Math.min(a.y, b.y);
  const x1 = Math.max(a.x1, b.x1), y1 = Math.max(a.y1, b.y1);
  return { x, y, x1, y1, w: x1 - x, h: y1 - y };
};
export function pathLength(pts, closed = false) {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (closed && pts.length > 1) L += Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]);
  return L;
}
export function signedArea(pts) {
  let a = 0;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) a += (pts[j][0] - pts[i][0]) * (pts[j][1] + pts[i][1]);
  return a / 2;
}
export function pointInPoly([x, y], pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i], [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
/** Even-odd fill test across several paths. */
export const insidePaths = (pt, paths) =>
  paths.reduce((n, p) => n + (p.closed && pointInPoly(pt, p.pts) ? 1 : 0), 0) % 2 === 1;

export function distToSeg([px, py], [ax, ay], [bx, by]) {
  const dx = bx - ax, dy = by - ay, L = dx * dx + dy * dy;
  let t = L ? ((px - ax) * dx + (py - ay) * dy) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
export function distToPaths(pt, paths) {
  let d = Infinity;
  for (const p of paths) {
    const n = p.pts.length;
    for (let i = 1; i < n; i++) d = Math.min(d, distToSeg(pt, p.pts[i - 1], p.pts[i]));
    if (p.closed && n > 1) d = Math.min(d, distToSeg(pt, p.pts[n - 1], p.pts[0]));
  }
  return d;
}

/** Removes duplicate / near-duplicate points and a closing point equal to the first. */
export function clean(path, eps = 1e-4) {
  const out = [];
  for (const pt of path.pts) {
    const l = out.at(-1);
    if (!l || Math.abs(l[0] - pt[0]) > eps || Math.abs(l[1] - pt[1]) > eps) out.push(pt);
  }
  let closed = path.closed;
  if (out.length > 2) {
    const a = out[0], b = out.at(-1);
    if (Math.abs(a[0] - b[0]) <= eps && Math.abs(a[1] - b[1]) <= eps) { out.pop(); closed = true; }
  }
  return { ...path, pts: out, closed: closed && out.length > 2 };
}

/** Centers paths on (0,0); returns { paths, cx, cy } where (cx, cy) was the old center. */
export function center(paths) {
  const b = bbox(paths);
  if (!b) return { paths, cx: 0, cy: 0 };
  const cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  return { paths: transformPaths(paths, translate(-cx, -cy)), cx, cy };
}

export const round = (v, d = 3) => Math.round(v * 10 ** d) / 10 ** d;
