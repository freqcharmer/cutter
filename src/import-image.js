// PNG/JPG import and tracing. The tracing itself (trace-core.js) runs in a Web Worker, so the
// sliders stay smooth and only the newest settings are traced.
import { TRACE_DEFAULTS, PAD } from './trace-core.js';

const MAX_SIDE = 1400; // pixels; bigger images are scaled down before tracing

export { TRACE_DEFAULTS };

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

/** The stored image's pixels with a white border of PAD pixels (cached per image). */
const pixelCache = new Map();
async function pixels(dataURL) {
  if (pixelCache.has(dataURL)) return pixelCache.get(dataURL);
  const img = await loadImage(dataURL);
  const w = img.naturalWidth + PAD * 2, h = img.naturalHeight + PAD * 2;
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.fillStyle = '#fff'; g.fillRect(0, 0, w, h);
  g.drawImage(img, PAD, PAD);
  const id = g.getImageData(0, 0, w, h);
  const px = { width: w, height: h, data: id.data };
  if (pixelCache.size > 6) pixelCache.delete(pixelCache.keys().next().value);
  pixelCache.set(dataURL, px);
  return px;
}

const optsKey = (o) => JSON.stringify(['mode', 'threshold', 'invert', 'smooth', 'despeckle', 'ppi', 'colors', 'dropBg', 'stack', 'overlap', 'stroke'].map((k) => o[k]));

/**
 * Runs traces in a worker. trace() resolves with layers [{ color, paths }], or with null when newer
 * settings arrived before this one finished (only the newest trace matters).
 */
export class Tracer {
  constructor() {
    this.gen = 0; this.inflight = null; this.next = null; this.waiting = new Map(); this.cache = new Map(); this.worker = null; this.busy = false;
    try {
      this.worker = new Worker(new URL('./trace-worker.js', import.meta.url), { type: 'module' });
      this.worker.onmessage = (e) => this.done(e.data);
      this.worker.onerror = (e) => { console.warn('Trace worker failed; tracing on the main thread.', e.message); this.worker = null; this.failAll(); };
    } catch { this.worker = null; }
    this.onbusy = () => {};
  }
  failAll() { for (const [, w] of this.waiting) w.reject(new Error('Tracing stopped. Try again.')); this.waiting.clear(); }
  post(job) { this.inflight = job.gen; this.worker.postMessage(job); }
  done({ gen, layers, error }) {
    this.inflight = null;
    if (this.next) { const j = this.next; this.next = null; this.post(j); }
    const w = this.waiting.get(gen);
    this.waiting.delete(gen);
    if (gen === this.gen) { this.busy = false; this.onbusy(false); }
    if (!w) return;
    if (error) { w.reject(new Error('Trace failed: ' + error)); return; }
    this.remember(w.key, layers);
    w.resolve(gen === this.gen ? layers : null);
  }
  remember(key, layers) { this.cache.set(key, layers); if (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value); }
  async trace(dataURL, opts) {
    const o = { ...TRACE_DEFAULTS, ...opts };
    const key = dataURL.length + ':' + dataURL.slice(-64) + optsKey(o);
    const gen = ++this.gen;
    if (this.cache.has(key)) { this.busy = false; this.onbusy(false); return this.cache.get(key); }
    const image = await pixels(dataURL);
    if (gen !== this.gen) return null;
    this.busy = true; this.onbusy(true);
    if (!this.worker) {
      const { traceAll } = await import('./trace-core.js');
      const layers = traceAll(image, o);
      this.remember(key, layers);
      this.busy = false; this.onbusy(false);
      return gen === this.gen ? layers : null;
    }
    return new Promise((resolve, reject) => {
      // Only one trace runs at a time; a newer request replaces any that is still waiting.
      if (this.next) { this.waiting.get(this.next.gen)?.resolve(null); this.waiting.delete(this.next.gen); this.next = null; }
      this.waiting.set(gen, { resolve, reject, key });
      const job = { gen, image: { width: image.width, height: image.height, data: image.data }, opts: o };
      if (this.inflight) this.next = job; else this.post(job);
    });
  }
}
