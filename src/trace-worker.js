// Web Worker: traces images off the main thread so the sliders stay smooth.
import { traceAll } from './trace-core.js';

self.onmessage = (e) => {
  const { gen, image, opts } = e.data;
  try {
    const t0 = performance.now();
    const layers = traceAll(image, opts);
    self.postMessage({ gen, layers, ms: Math.round(performance.now() - t0) });
  } catch (err) {
    self.postMessage({ gen, error: err?.message || String(err) });
  }
};
