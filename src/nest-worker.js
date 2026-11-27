// Web Worker: true-shape nesting. Keeps trying arrangements and reports each better one until stopped.
import { preparePart, Nester, SCALE } from './nest-core.js';

let running = false;

self.onmessage = async (e) => {
  const m = e.data;
  if (m.type === 'stop') { running = false; return; }
  if (m.type !== 'start') return;
  running = true;
  try {
    const opt = { spacing: m.spacing, rotations: m.rotations, holes: m.holes };
    const parts = m.units.map((u) => preparePart(u.id, u.paths, opt)).filter(Boolean);
    // Obstacles stay where they are: prepare them unrotated, then move their pieces back into place.
    const fixed = m.fixed.map((f) => preparePart('F' + f.id, f.paths, { ...opt, rotations: [0] })).filter(Boolean).map((f) => {
      const r = f.rots[0];
      return { id: f.id, aPieces: r.aPieces.map((p) => p.map((q) => ({ x: q.x + r.minx, y: q.y + r.miny }))) };
    });
    const strip = { x0: Math.round(m.strip.x0 * SCALE), y0: Math.round(m.strip.y0 * SCALE), y1: Math.round(m.strip.y1 * SCALE) };
    const N = new Nester(parts, strip, { fixed, seed: m.seed || 7 });
    let since = 0;
    const t0 = performance.now();
    while (running) {
      const better = N.step();
      since = better ? 0 : since + 1;
      if (better) self.postMessage({ type: 'best', placements: N.best.result.placements, length: N.best.result.length / SCALE, unplaced: N.best.result.unplaced, evals: N.evals });
      else self.postMessage({ type: 'progress', evals: N.evals });
      if (since > 400 || N.evals >= (m.maxEvals || 3000)) { self.postMessage({ type: 'done', evals: N.evals, ms: Math.round(performance.now() - t0) }); break; }
      await new Promise((r) => setTimeout(r, 0)); // lets a Stop message in
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err?.message || String(err) });
  }
  running = false;
};
