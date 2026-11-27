// DXF import: lines, polylines (with bulges), arcs, circles, ellipses, splines, and block inserts.
import DxfParser from '../vendor/dxf-parser.mjs';
import { I, mul, apply, translate, rotate, scale, arcPoints, clean, TOL } from './geom.js';

// $INSUNITS → inches per drawing unit (0 = unitless, assume inches)
const INSUNITS = { 0: 1, 1: 1, 2: 12, 4: 1 / 25.4, 5: 1 / 2.54, 6: 1000 / 25.4, 8: 1e-6, 9: 0.001, 10: 36 };
const ACI = { 1: '#ff0000', 2: '#ffff00', 3: '#00ff00', 4: '#00ffff', 5: '#0000ff', 6: '#ff00ff', 7: '#000000' };

function bulgePoints(a, b, bulge, tol) {
  const theta = 4 * Math.atan(bulge);
  const dx = b[0] - a[0], dy = b[1] - a[1], chord = Math.hypot(dx, dy);
  if (chord < 1e-9) return [b];
  const r = Math.abs(chord / (2 * Math.sin(theta / 2)));
  const mx = (a[0] + b[0]) / 2, my = (a[1] + b[1]) / 2;
  const s = chord / (2 * Math.tan(theta / 2)); // signed distance from chord midpoint to center (left = +)
  const cx = mx - (dy / chord) * s, cy = my + (dx / chord) * s;
  const a0 = Math.atan2(a[1] - cy, a[0] - cx);
  return arcPoints(cx, cy, r, r, a0, a0 + theta, 0, tol).slice(1);
}

function deBoor(k, x, t, c, p) {
  const d = [];
  for (let j = 0; j <= p; j++) d.push([...c[j + k - p]]);
  for (let r = 1; r <= p; r++) {
    for (let j = p; j >= r; j--) {
      const den = t[j + 1 + k - r] - t[j + k - p];
      const alpha = den ? (x - t[j + k - p]) / den : 0;
      d[j] = [(1 - alpha) * d[j - 1][0] + alpha * d[j][0], (1 - alpha) * d[j - 1][1] + alpha * d[j][1]];
    }
  }
  return d[p];
}

function splinePoints(e) {
  const c = (e.controlPoints || []).map((v) => [v.x, v.y]);
  const p = e.degreeOfSplineCurve || 3;
  const t = e.knotValues || [];
  if (c.length > p && t.length === c.length + p + 1) {
    const out = [], n = Math.max(32, c.length * 12);
    const t0 = t[p], t1 = t[c.length];
    for (let i = 0; i <= n; i++) {
      const x = t0 + ((t1 - t0) * i) / n;
      let k = p;
      while (k < c.length - 1 && x >= t[k + 1]) k++;
      out.push(deBoor(k, x, t, c, p));
    }
    return out;
  }
  if (e.fitPoints?.length > 1) return e.fitPoints.map((v) => [v.x, v.y]);
  return c;
}

export function parseDXF(text) {
  let dxf;
  try { dxf = new DxfParser().parseSync(text); } catch (err) { throw new Error('That DXF could not be read: ' + err.message); }
  const unit = INSUNITS[dxf.header?.$INSUNITS ?? 0] ?? 1;
  // DXF y points up; the document's y points down.
  const root = mul(scale(unit, -unit), I);
  const out = [];
  let el = 0, skipped = 0;

  const colorOf = (e) => (e.color != null && e.color !== 0 ? '#' + e.color.toString(16).padStart(6, '0') : ACI[e.colorIndex] || '#000000');

  const emit = (pts, closed, m, color) => {
    if (pts.length < 2) return;
    out.push({ ...clean({ pts: pts.map((p) => apply(m, p)), closed }), el, color });
  };

  const walk = (entities, m, depth = 0) => {
    for (const e of entities || []) {
      const color = colorOf(e);
      const tol = TOL / unit;
      switch (e.type) {
        case 'LINE':
          emit(e.vertices.map((v) => [v.x, v.y]), false, m, color); break;
        case 'LWPOLYLINE': case 'POLYLINE': {
          const v = e.vertices || [];
          if (!v.length) break;
          const closed = !!e.shape || !!e.closed;
          const pts = [[v[0].x, v[0].y]];
          const n = closed ? v.length : v.length - 1;
          for (let i = 0; i < n; i++) {
            const a = v[i], b = v[(i + 1) % v.length];
            if (a.bulge) pts.push(...bulgePoints([a.x, a.y], [b.x, b.y], a.bulge, tol));
            else pts.push([b.x, b.y]);
          }
          emit(pts, closed, m, color); break;
        }
        case 'CIRCLE':
          emit(arcPoints(e.center.x, e.center.y, e.radius, e.radius, 0, 2 * Math.PI, 0, tol), true, m, color); break;
        case 'ARC': {
          let a1 = e.endAngle;
          while (a1 <= e.startAngle) a1 += 2 * Math.PI;
          emit(arcPoints(e.center.x, e.center.y, e.radius, e.radius, e.startAngle, a1, 0, tol), false, m, color); break;
        }
        case 'ELLIPSE': {
          const mx = e.majorAxisEndPoint.x, my = e.majorAxisEndPoint.y;
          const rx = Math.hypot(mx, my), ry = rx * e.axisRatio;
          let a0 = e.startAngle ?? 0, a1 = e.endAngle ?? 2 * Math.PI;
          while (a1 <= a0) a1 += 2 * Math.PI;
          const full = Math.abs(a1 - a0 - 2 * Math.PI) < 1e-6;
          emit(arcPoints(e.center.x, e.center.y, rx, ry, a0, a1, Math.atan2(my, mx), tol), full, m, color); break;
        }
        case 'SPLINE':
          emit(splinePoints(e), !!e.closed, m, color); break;
        case 'INSERT': {
          const block = dxf.blocks?.[e.name];
          if (!block || depth > 8) { skipped++; break; }
          const base = block.position || { x: 0, y: 0 };
          const bm = mul(m, mul(translate(e.position.x, e.position.y),
            mul(rotate(e.rotation || 0), mul(scale(e.xScale ?? 1, e.yScale ?? 1), translate(-base.x, -base.y)))));
          walk(block.entities, bm, depth + 1);
          break;
        }
        default: skipped++; continue;
      }
      el++;
    }
  };
  walk(dxf.entities, root);
  const note = skipped ? `${skipped} unsupported item(s) skipped (text, dimensions, or hatches).` : '';
  return { paths: out, note };
}
