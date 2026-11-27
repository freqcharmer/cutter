// SVG import: shapes and paths → flattened paths in inches, keeping each element's color.
import svgpath from '../vendor/svgpath.mjs';
import { I, mul, apply, flattenCubic, flattenQuad, clean, TOL } from './geom.js';
import { cleanNodes } from './nodes.js';

const UNIT_IN = { in: 1, mm: 1 / 25.4, cm: 1 / 2.54, pt: 1 / 72, pc: 1 / 6, px: 1 / 96, '': 1 / 96 };
const SKIP = new Set(['defs', 'clipPath', 'mask', 'symbol', 'marker', 'pattern', 'metadata', 'title', 'desc', 'style', 'script', 'linearGradient', 'radialGradient', 'filter', 'text']);

function parseLength(v) {
  const m = /^\s*([-+]?[\d.]+(?:e[-+]?\d+)?)\s*(in|mm|cm|pt|pc|px|%)?\s*$/i.exec(v || '');
  if (!m || m[2] === '%') return null;
  return { value: parseFloat(m[1]), unit: (m[2] || '').toLowerCase() };
}

function parseTransform(str) {
  let m = I.slice();
  if (!str) return m;
  const re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g;
  let t;
  while ((t = re.exec(str))) {
    const a = t[2].split(/[\s,]+/).filter(Boolean).map(Number);
    let n;
    switch (t[1]) {
      case 'matrix': n = a.slice(0, 6); break;
      case 'translate': n = [1, 0, 0, 1, a[0] || 0, a[1] || 0]; break;
      case 'scale': n = [a[0], 0, 0, a[1] ?? a[0], 0, 0]; break;
      case 'rotate': {
        const r = ((a[0] || 0) * Math.PI) / 180, c = Math.cos(r), s = Math.sin(r);
        n = [c, s, -s, c, 0, 0];
        if (a.length >= 3) n = mul(mul([1, 0, 0, 1, a[1], a[2]], n), [1, 0, 0, 1, -a[1], -a[2]]);
        break;
      }
      case 'skewX': n = [1, 0, Math.tan((a[0] * Math.PI) / 180), 1, 0, 0]; break;
      case 'skewY': n = [1, Math.tan((a[0] * Math.PI) / 180), 0, 1, 0, 0]; break;
    }
    m = mul(m, n);
  }
  return m;
}

function styleOf(el, inherited) {
  const s = { ...inherited };
  const css = Object.fromEntries((el.getAttribute('style') || '').split(';')
    .map((d) => d.split(':').map((x) => x && x.trim())).filter((d) => d[0] && d[1]));
  for (const k of ['fill', 'stroke', 'display', 'visibility']) {
    const v = css[k] ?? el.getAttribute(k);
    if (v != null && v !== 'inherit') s[k] = v;
  }
  return s;
}

const num = (el, a, d = 0) => { const v = parseFloat(el.getAttribute(a)); return Number.isFinite(v) ? v : d; };

function shapeToD(el) {
  switch (el.localName) {
    case 'path': return el.getAttribute('d') || '';
    case 'rect': {
      const x = num(el, 'x'), y = num(el, 'y'), w = num(el, 'width'), h = num(el, 'height');
      if (w <= 0 || h <= 0) return '';
      let rx = el.hasAttribute('rx') ? num(el, 'rx') : null, ry = el.hasAttribute('ry') ? num(el, 'ry') : null;
      rx ??= ry ?? 0; ry ??= rx;
      rx = Math.min(rx, w / 2); ry = Math.min(ry, h / 2);
      if (!rx || !ry) return `M${x},${y}H${x + w}V${y + h}H${x}Z`;
      return `M${x + rx},${y}H${x + w - rx}A${rx},${ry} 0 0 1 ${x + w},${y + ry}V${y + h - ry}` +
        `A${rx},${ry} 0 0 1 ${x + w - rx},${y + h}H${x + rx}A${rx},${ry} 0 0 1 ${x},${y + h - ry}` +
        `V${y + ry}A${rx},${ry} 0 0 1 ${x + rx},${y}Z`;
    }
    case 'circle': case 'ellipse': {
      const cx = num(el, 'cx'), cy = num(el, 'cy');
      const rx = el.localName === 'circle' ? num(el, 'r') : num(el, 'rx');
      const ry = el.localName === 'circle' ? rx : num(el, 'ry');
      if (rx <= 0 || ry <= 0) return '';
      return `M${cx - rx},${cy}A${rx},${ry} 0 1 0 ${cx + rx},${cy}A${rx},${ry} 0 1 0 ${cx - rx},${cy}Z`;
    }
    case 'line': return `M${num(el, 'x1')},${num(el, 'y1')}L${num(el, 'x2')},${num(el, 'y2')}`;
    case 'polyline': case 'polygon': {
      const p = (el.getAttribute('points') || '').trim().split(/[\s,]+/).map(Number);
      if (p.length < 4) return '';
      let d = `M${p[0]},${p[1]}`;
      for (let i = 2; i + 1 < p.length; i += 2) d += `L${p[i]},${p[i + 1]}`;
      return el.localName === 'polygon' ? d + 'Z' : d;
    }
  }
  return '';
}

/**
 * Converts a path "d" string to flattened subpaths using matrix m. `tol` is in output units.
 * Each subpath also keeps its Bézier nodes (for node editing).
 */
export function dToPaths(d, m, tol = TOL) {
  const out = [];
  let cur = null, nodes = null, pos = [0, 0], start = [0, 0];
  const end = (closed) => {
    if (cur && cur.length > 1) {
      const p = clean({ pts: cur, closed });
      if (p.pts.length > 1) p.nodes = cleanNodes(nodes, p.closed);
      out.push(p);
    }
    cur = null; nodes = null;
  };
  const begin = () => { const q = apply(m, pos); cur = [q]; nodes = [{ p: q, i: null, o: null }]; };
  svgpath(d).abs().unarc().unshort().iterate((seg) => {
    const c = seg[0];
    if (c === 'M') { end(false); pos = [seg[1], seg[2]]; start = pos; begin(); return; }
    if (!cur) begin();
    const line = (p) => { pos = p; const q = apply(m, p); cur.push(q); nodes.push({ p: q, i: null, o: null }); };
    switch (c) {
      case 'L': line([seg[1], seg[2]]); break;
      case 'H': line([seg[1], pos[1]]); break;
      case 'V': line([pos[0], seg[1]]); break;
      case 'C': {
        const p = [seg[5], seg[6]], c1 = apply(m, [seg[1], seg[2]]), c2 = apply(m, [seg[3], seg[4]]), q = apply(m, p);
        flattenCubic(apply(m, pos), c1, c2, q, cur, tol);
        nodes.at(-1).o = c1; nodes.push({ p: q, i: c2, o: null });
        pos = p; break;
      }
      case 'Q': {
        const p = [seg[3], seg[4]], p0 = apply(m, pos), k = apply(m, [seg[1], seg[2]]), q = apply(m, p);
        flattenQuad(p0, k, q, cur, tol);
        nodes.at(-1).o = [p0[0] + (2 / 3) * (k[0] - p0[0]), p0[1] + (2 / 3) * (k[1] - p0[1])];
        nodes.push({ p: q, i: [q[0] + (2 / 3) * (k[0] - q[0]), q[1] + (2 / 3) * (k[1] - q[1])], o: null });
        pos = p; break;
      }
      case 'Z': case 'z': line(start); end(true); pos = start; break;
    }
  });
  end(false);
  return out.filter((p) => p.pts.length > 1);
}

const colorKey = (s) => {
  const pick = s.fill && s.fill !== 'none' ? s.fill : s.stroke && s.stroke !== 'none' ? s.stroke : '#000000';
  return normalizeColor(pick);
};

export function normalizeColor(c) {
  c = String(c).trim().toLowerCase();
  if (c.startsWith('url(')) return '#000000';
  let m;
  if ((m = /^#([0-9a-f]{3})$/.exec(c))) return '#' + m[1].split('').map((h) => h + h).join('');
  if (/^#[0-9a-f]{6}$/.test(c)) return c;
  if ((m = /^rgba?\(\s*([\d.]+)[\s,]+([\d.]+)[\s,]+([\d.]+)/.exec(c))) {
    return '#' + [m[1], m[2], m[3]].map((v) => Math.round(+v).toString(16).padStart(2, '0')).join('');
  }
  const named = { black: '#000000', white: '#ffffff', red: '#ff0000', green: '#008000', blue: '#0000ff', yellow: '#ffff00', none: '#000000' };
  return named[c] || '#000000';
}

/**
 * Parses SVG text. Returns { paths: [{pts, closed, el, color}], scaleNote }.
 * Coordinates are in inches, in the SVG's own position.
 */
export function parseSVG(text) {
  const doc = new DOMParser().parseFromString(text, 'image/svg+xml');
  const svg = doc.documentElement;
  if (!svg || svg.localName !== 'svg' || doc.querySelector('parsererror')) throw new Error('That file is not a readable SVG.');

  // User units → inches. Adobe Illustrator writes 72 user units per inch.
  const illustrator = /Adobe Illustrator/i.test(text.slice(0, 2000));
  const vb = (svg.getAttribute('viewBox') || '').split(/[\s,]+/).map(Number);
  const W = parseLength(svg.getAttribute('width')), H = parseLength(svg.getAttribute('height'));
  let sx = illustrator ? 1 / 72 : 1 / 96, sy = sx, ox = 0, oy = 0, note = illustrator ? 'Illustrator file: 72 units per inch.' : '';
  if (vb.length === 4 && vb[2] > 0 && vb[3] > 0) {
    ox = vb[0]; oy = vb[1];
    const unitIn = (L) => UNIT_IN[L.unit] * (L.unit === '' || L.unit === 'px' ? (illustrator ? 96 / 72 : 1) : 1);
    if (W && H) { sx = (W.value * unitIn(W)) / vb[2]; sy = (H.value * unitIn(H)) / vb[3]; sy = sx = Math.min(sx, sy); }
    else if (W) { sx = sy = (W.value * unitIn(W)) / vb[2]; }
  }
  const root = mul([sx, 0, 0, sy, 0, 0], [1, 0, 0, 1, -ox, -oy]);
  const tol = TOL; // flatten directly in inches

  const out = [];
  let elIndex = 0;
  const walk = (node, m, style) => {
    for (const el of node.children) {
      if (SKIP.has(el.localName)) continue;
      const st = styleOf(el, style);
      if (st.display === 'none' || st.visibility === 'hidden') continue;
      const mm = mul(m, parseTransform(el.getAttribute('transform')));
      if (el.localName === 'g' || el.localName === 'svg' || el.localName === 'a' || el.localName === 'switch') { walk(el, mm, st); continue; }
      const d = shapeToD(el);
      if (!d) continue;
      if ((st.fill === 'none' || st.fill === 'transparent') && (!st.stroke || st.stroke === 'none')) continue;
      const color = colorKey(st);
      const idx = elIndex++;
      try {
        for (const p of dToPaths(d, mm, tol)) out.push({ ...p, el: idx, color });
      } catch { /* skip malformed element */ }
    }
  };
  walk(svg, root, { fill: '#000000' });
  const texts = svg.getElementsByTagName('text').length;
  if (texts) note = `${note} ${texts} text element(s) skipped: convert text to outlines/paths in your design app first.`.trim();
  return { paths: out, note };
}
