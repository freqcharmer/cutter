// Centerline tracing for line art: thin the ink to a 1-pixel skeleton (Zhang–Suen), then follow
// the skeleton into polylines. Pure functions on pixel arrays, so they run in a Web Worker or Node.

/** Zhang–Suen thinning. `bin` is a Uint8Array (1 = ink), width w, height h. Thins in place and returns it. */
export function skeletonize(bin, w, h) {
  const at = (x, y) => (x < 0 || y < 0 || x >= w || y >= h ? 0 : bin[y * w + x]);
  let changed = true;
  const del = [];
  while (changed) {
    changed = false;
    for (let pass = 0; pass < 2; pass++) {
      del.length = 0;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        if (!bin[y * w + x]) continue;
        const p2 = at(x, y - 1), p3 = at(x + 1, y - 1), p4 = at(x + 1, y), p5 = at(x + 1, y + 1);
        const p6 = at(x, y + 1), p7 = at(x - 1, y + 1), p8 = at(x - 1, y), p9 = at(x - 1, y - 1);
        const B = p2 + p3 + p4 + p5 + p6 + p7 + p8 + p9;
        if (B < 2 || B > 6) continue;
        const seq = [p2, p3, p4, p5, p6, p7, p8, p9, p2];
        let A = 0;
        for (let i = 0; i < 8; i++) if (!seq[i] && seq[i + 1]) A++;
        if (A !== 1) continue;
        if (pass === 0 ? p2 * p4 * p6 || p4 * p6 * p8 : p2 * p4 * p8 || p2 * p6 * p8) continue;
        del.push(y * w + x);
      }
      if (del.length) { changed = true; for (const i of del) bin[i] = 0; }
    }
  }
  return bin;
}

const DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [-1, -1], [1, -1]];

/**
 * Follows a skeleton into polylines (pixel coordinates). Diagonal steps are only used when no
 * straight neighbor covers them, so corners don't make tiny triangles.
 * Returns [{ pts: [[x, y], ...], closed }].
 */
export function skeletonToPolylines(sk, w, h) {
  const on = (x, y) => x >= 0 && y >= 0 && x < w && y < h && sk[y * w + x] === 1;
  const nbrs = (x, y) => {
    const out = [];
    for (const [dx, dy] of DIRS) {
      if (!on(x + dx, y + dy)) continue;
      if (dx && dy && (on(x + dx, y) || on(x, y + dy))) continue; // reachable through a straight neighbor
      out.push([x + dx, y + dy]);
    }
    return out;
  };
  const deg = new Int8Array(w * h);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (sk[y * w + x]) deg[y * w + x] = nbrs(x, y).length;
  const seen = new Set();
  const ek = (a, b) => (a < b ? a * w * h + b : b * w * h + a);
  const lines = [];
  const walk = (x0, y0, x1, y1) => {
    const pts = [[x0, y0], [x1, y1]];
    seen.add(ek(y0 * w + x0, y1 * w + x1));
    let px = x0, py = y0, cx = x1, cy = y1;
    while (deg[cy * w + cx] === 2) {
      const nx = nbrs(cx, cy).find(([x, y]) => !(x === px && y === py) && !seen.has(ek(cy * w + cx, y * w + x)));
      if (!nx) break;
      seen.add(ek(cy * w + cx, nx[1] * w + nx[0]));
      px = cx; py = cy; [cx, cy] = nx;
      pts.push([cx, cy]);
      if (cx === x0 && cy === y0) return { pts: pts.slice(0, -1), closed: true };
    }
    return { pts, closed: false };
  };
  // Paths from ends and junctions
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = deg[y * w + x];
    if (!d || d === 2) continue;
    for (const [nx, ny] of nbrs(x, y)) if (!seen.has(ek(y * w + x, ny * w + nx))) lines.push(walk(x, y, nx, ny));
  }
  // Leftover loops (every pixel has two neighbors)
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (deg[y * w + x] !== 2) continue;
    const n = nbrs(x, y).find(([nx, ny]) => !seen.has(ek(y * w + x, ny * w + nx)));
    if (n) lines.push(walk(x, y, n[0], n[1]));
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (sk[y * w + x] && deg[y * w + x] === 0) lines.push({ pts: [[x, y]], closed: false, dot: true });
  return lines.map((l) => ({ ...l, ends: l.closed ? [] : [deg[l.pts[0][1] * w + l.pts[0][0]], deg[l.pts.at(-1)[1] * w + l.pts.at(-1)[0]]] }));
}

/** Ramer–Douglas–Peucker simplification. */
export function rdp(pts, eps) {
  if (pts.length < 3) return pts.slice();
  const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
  const stack = [[0, pts.length - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    const [ax, ay] = pts[a], [bx, by] = pts[b], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1;
    let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const d = Math.abs(dx * (ay - pts[i][1]) - (ax - pts[i][0]) * dy) / L;
      if (d > md) { md = d; mi = i; }
    }
    if (md > eps) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
  }
  return pts.filter((_, i) => keep[i]);
}

const plen = (pts, closed) => {
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  if (closed && pts.length > 1) L += Math.hypot(pts[0][0] - pts.at(-1)[0], pts[0][1] - pts.at(-1)[1]);
  return L;
};

/** Evens out pixel stair-steps with a few [1 2 1] averaging passes (open line ends stay put). */
export function smoothLine(pts, closed, passes) {
  let p = pts;
  const n = p.length;
  if (n < 3) return p;
  for (let k = 0; k < passes; k++) {
    p = p.map((q, i) => {
      if (!closed && (i === 0 || i === n - 1)) return q;
      const a = p[(i - 1 + n) % n], b = p[(i + 1) % n];
      return [(a[0] + 2 * q[0] + b[0]) / 4, (a[1] + 2 * q[1] + b[1]) / 4];
    });
  }
  return p;
}

/**
 * Centerlines of the ink in a binary image. `minLen` drops specks and short spurs (pixels);
 * `smooth` (the Smoothing slider) sets how much the pixel steps are evened out.
 * Returns polylines in pixel coordinates.
 */
export function centerlines(bin, w, h, { minLen = 6, smooth = 1 } = {}) {
  const sk = skeletonize(bin, w, h);
  const lines = skeletonToPolylines(sk, w, h).filter((l) => !l.dot);
  const out = [];
  for (const l of lines) {
    const L = plen(l.pts, l.closed);
    const spur = !l.closed && (l.ends[0] === 1) !== (l.ends[1] === 1); // one free end, one junction
    if (L < minLen || (spur && L < minLen * 1.5)) continue;
    out.push({ pts: rdp(smoothLine(l.pts, l.closed, Math.max(1, Math.round(smooth * 3))), 0.5), closed: l.closed });
  }
  return out;
}
