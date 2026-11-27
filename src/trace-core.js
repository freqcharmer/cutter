// Image tracing that runs inside the trace Web Worker (no DOM): black and white, colors (one layer per
// color), and centerline. Input is an ImageData-like { width, height, data }; output is paths in inches
// with the image's top-left at (0, 0).
import ImageTracer from '../vendor/imagetracer.mjs';
import { dToPaths } from './import-svg.js';
import { scale } from './geom.js';
import { centerlines } from './centerline.js';
import { fitNodes, nodesToPts } from './nodes.js';
import { region, union, intersect, offset, area } from './clip.js';

export const PAD = 2; // white pixels added around the image so edge shapes close
export const TRACE_DEFAULTS = {
  mode: 'bw', threshold: 128, invert: false, smooth: 1, despeckle: 8, ppi: 150,
  colors: 4, dropBg: true, stack: 'overlap', overlap: 0.03, stroke: 0.08,
};

const pxMatrix = (ppi) => { const m = scale(1 / ppi); m[4] = -PAD / ppi; m[5] = -PAD / ppi; return m; };
const hex = ([r, g, b]) => '#' + [r, g, b].map((v) => Math.round(v).toString(16).padStart(2, '0')).join('');
const lum = (d, i) => { const a = d[i + 3] / 255; return (0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) * a + 255 * (1 - a); };

/** Pixels darker than the threshold (or lighter, when inverted) as a 0/1 array. */
function binary(img, o) {
  const { width: w, height: h, data: d } = img, bin = new Uint8Array(w * h);
  for (let i = 0, j = 0; j < w * h; i += 4, j++) { let ink = lum(d, i) < o.threshold; if (o.invert) ink = !ink; bin[j] = ink ? 1 : 0; }
  return bin;
}

/** Runs ImageTracer with a fixed palette and returns { paletteIndex: paths }. */
function traceWithPalette(img, pal, o) {
  const svg = ImageTracer.imagedataToSVG(img, {
    ltres: o.smooth, qtres: o.smooth, pathomit: o.despeckle, colorsampling: 0, numberofcolors: pal.length,
    pal: pal.map(([r, g, b]) => ({ r, g, b, a: 255 })), colorquantcycles: 1, blurradius: 0, linefilter: true,
    rightangleenhance: true, roundcoords: 2, viewbox: true, desc: false, strokewidth: 0,
  });
  const m = pxMatrix(o.ppi), out = new Map();
  const re = /<path fill="rgb\((\d+),(\d+),(\d+)\)"[^>]*?\sd="([^"]*)"/g;
  let r, el = 0;
  while ((r = re.exec(svg))) {
    const key = [+r[1], +r[2], +r[3]].join(',');
    if (!out.has(key)) out.set(key, []);
    for (const p of dToPaths(r[4], m, 0.5 / o.ppi)) if (p.closed) out.get(key).push({ ...p, el });
    el++;
  }
  return out;
}

/** Black and white: one layer of the dark (or, inverted, light) areas. */
export function traceBW(img, o) {
  const bin = binary(img, o), d = new Uint8ClampedArray(img.data.length);
  for (let j = 0; j < bin.length; j++) { const v = bin[j] ? 0 : 255; d[j * 4] = d[j * 4 + 1] = d[j * 4 + 2] = v; d[j * 4 + 3] = 255; }
  const res = traceWithPalette({ width: img.width, height: img.height, data: d }, [[0, 0, 0], [255, 255, 255]], o);
  return [{ color: '#000000', paths: (res.get('0,0,0') || []).map((p) => ({ ...p, color: '#000000' })) }];
}

/** k-means++ palette (fixed seed, so the same image always gives the same colors). */
export function palette(img, k) {
  let seed = 12345;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const d = img.data, px = [], step = Math.max(1, Math.floor(d.length / 4 / 30000));
  for (let i = 0; i < d.length; i += 4 * step) px.push([d[i], d[i + 1], d[i + 2]]);
  const d2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
  const C = [px[Math.floor(rnd() * px.length)]];
  while (C.length < k) {
    const D = px.map((p) => Math.min(...C.map((c) => d2(p, c))));
    const sum = D.reduce((a, b) => a + b, 0);
    if (!sum) break;
    let r = rnd() * sum, j = 0;
    while ((r -= D[j]) > 0 && j < D.length - 1) j++;
    C.push(px[j]);
  }
  for (let it = 0; it < 12; it++) {
    const acc = C.map(() => [0, 0, 0, 0]);
    for (const p of px) {
      let b = 0, bd = Infinity;
      for (let j = 0; j < C.length; j++) { const v = d2(p, C[j]); if (v < bd) { bd = v; b = j; } }
      acc[b][0] += p[0]; acc[b][1] += p[1]; acc[b][2] += p[2]; acc[b][3]++;
    }
    acc.forEach((a, j) => { if (a[3]) C[j] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
  }
  return C.map((c) => c.map(Math.round));
}

/**
 * Colors: one layer per palette color, bottom (largest) first. With stack 'overlap', each lower layer
 * extends under the layers above it by `overlap` inches, so small misalignment never shows a gap.
 */
export function traceColors(img0, o) {
  // The added white border would trace as a frame in some color, so copy the image's own edge into it.
  const { width: w, height: h } = img0, d = new Uint8ClampedArray(img0.data);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    if (x >= PAD && y >= PAD && x < w - PAD && y < h - PAD) continue;
    const sx = Math.min(w - 1 - PAD, Math.max(PAD, x)), sy = Math.min(h - 1 - PAD, Math.max(PAD, y));
    d.copyWithin((y * w + x) * 4, (sy * w + sx) * 4, (sy * w + sx) * 4 + 4);
  }
  const img = { width: w, height: h, data: d };
  const pal = palette(img, Math.max(2, Math.min(8, Math.round(o.colors))));
  const byColor = traceWithPalette(img, pal, o);
  // background = the palette color most common around the image edge
  const edge = new Array(pal.length).fill(0);
  const nearest = (i) => { let b = 0, bd = Infinity; pal.forEach((c, j) => { const v = (d[i] - c[0]) ** 2 + (d[i + 1] - c[1]) ** 2 + (d[i + 2] - c[2]) ** 2; if (v < bd) { bd = v; b = j; } }); return b; };
  for (let x = 0; x < w; x++) { edge[nearest(x * 4)]++; edge[nearest(((h - 1) * w + x) * 4)]++; }
  for (let y = 0; y < h; y++) { edge[nearest(y * w * 4)]++; edge[nearest((y * w + w - 1) * 4)]++; }
  const bg = edge.indexOf(Math.max(...edge));
  let layers = pal.map((c, j) => ({ j, color: hex(c), paths: byColor.get(c.join(',')) || [] }))
    .filter((L) => L.paths.length && !(o.dropBg && L.j === bg))
    .map((L) => ({ ...L, area: area(L.paths) }))
    .filter((L) => L.area > 1e-4)
    .sort((a, b) => b.area - a.area);
  if (o.stack === 'overlap' && o.overlap > 0 && layers.length > 1) {
    const regions = layers.map((L) => region(L.paths));
    layers = layers.map((L, i) => {
      if (i === layers.length - 1) return L;
      const above = union(regions.slice(i + 1).flat());
      const grown = offset(regions[i], o.overlap, 'round');
      const under = intersect(grown, above);
      return { ...L, paths: union(regions[i], under) };
    });
  }
  return layers.map((L) => ({ color: L.color, paths: L.paths.map((p) => ({ ...p, color: L.color })) }));
}

/** Centerline: single-stroke paths through the middle of line art; with a stroke width, outlines around them. */
export function traceCenter(img, o) {
  const bin = binary(img, o);
  const lines = centerlines(bin, img.width, img.height, { minLen: Math.max(4, o.despeckle / 2), smooth: o.smooth });
  const m = pxMatrix(o.ppi);
  const err = Math.max(0.6, o.smooth) / o.ppi;
  let paths = lines.filter((l) => l.pts.length > 1).map((l) => {
    const pts = l.pts.map(([x, y]) => [x * m[0] + m[4], y * m[3] + m[5]]);
    const nodes = fitNodes(pts, l.closed, err);
    return { pts: nodesToPts(nodes, l.closed), closed: l.closed && pts.length > 2, nodes, color: '#000000' };
  });
  if (o.stroke > 0 && paths.length) {
    const asLines = paths.map((p) => ({ pts: p.closed ? [...p.pts, p.pts[0]] : p.pts, closed: false }));
    paths = offset(asLines, o.stroke / 2, 'round').map((p) => ({ ...p, color: '#000000' }));
  }
  return [{ color: '#000000', paths }];
}

/** Traces with the given settings. Returns layers [{ color, paths }] (one layer unless mode is 'color'). */
export function traceAll(img, opts) {
  const o = { ...TRACE_DEFAULTS, ...opts };
  if (o.mode === 'color') return traceColors(img, o);
  if (o.mode === 'center') return traceCenter(img, o);
  return traceBW(img, o);
}
