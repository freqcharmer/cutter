// PNG/JPG import: threshold to black and white, then trace outlines with ImageTracer.js.
import ImageTracer from '../vendor/imagetracer.mjs';
import { dToPaths } from './import-svg.js';
import { scale } from './geom.js';

const MAX_SIDE = 1400; // pixels; bigger images are scaled down before tracing
const PAD = 2;

export const TRACE_DEFAULTS = { threshold: 128, invert: false, smooth: 1, despeckle: 8, ppi: 150 };

export function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('That image could not be opened.'));
    img.src = src;
  });
}

/** Reads an image file, downsizes it, and returns a PNG data URL (stored in the document). */
export async function fileToDataURL(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await loadImage(url);
    const k = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(img.naturalWidth * k));
    c.height = Math.max(1, Math.round(img.naturalHeight * k));
    const g = c.getContext('2d');
    g.fillStyle = '#fff'; g.fillRect(0, 0, c.width, c.height); // transparent → white
    g.drawImage(img, 0, 0, c.width, c.height);
    return { dataURL: c.toDataURL('image/png'), width: c.width, height: c.height };
  } finally { URL.revokeObjectURL(url); }
}

/** Traces a stored image. Returns paths in inches, top-left at (0,0). */
export async function traceImage(dataURL, opts = {}) {
  const o = { ...TRACE_DEFAULTS, ...opts };
  const img = await loadImage(dataURL);
  const w = img.naturalWidth + PAD * 2, h = img.naturalHeight + PAD * 2;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  g.drawImage(img, PAD, PAD);
  const id = g.getImageData(0, 0, w, h), d = id.data;
  for (let i = 0; i < d.length; i += 4) {
    const lum = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    const alpha = d[i + 3] / 255;
    const v = lum * alpha + 255 * (1 - alpha);
    let black = v < o.threshold;
    if (o.invert) black = !black;
    d[i] = d[i + 1] = d[i + 2] = black ? 0 : 255; d[i + 3] = 255;
  }
  const svg = ImageTracer.imagedataToSVG(id, {
    ltres: o.smooth, qtres: o.smooth, pathomit: o.despeckle, colorsampling: 0, numberofcolors: 2,
    pal: [{ r: 0, g: 0, b: 0, a: 255 }, { r: 255, g: 255, b: 255, a: 255 }],
    colorquantcycles: 1, blurradius: 0, linefilter: true, rightangleenhance: true, roundcoords: 2,
    viewbox: true, desc: false, strokewidth: 0,
  });
  const m = scale(1 / o.ppi);
  m[4] = -PAD / o.ppi; m[5] = -PAD / o.ppi;
  const paths = [];
  const re = /<path fill="rgb\(0,0,0\)"[^>]*?\sd="([^"]*)"/g;
  let r, el = 0;
  while ((r = re.exec(svg))) {
    for (const p of dToPaths(r[1], m, 0.5 / o.ppi)) paths.push({ ...p, el, color: '#000000' });
    el++;
  }
  return paths.filter((p) => p.closed);
}
