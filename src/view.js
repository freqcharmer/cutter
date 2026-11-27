// The editor canvas: roll view, rendering, selection, move / scale / rotate, pan and zoom.
import { objMatrix, apply, mul, rotate, invert, insidePaths, distToPaths, bbox } from './geom.js';
import { worldPaths, groupBox, localBox } from './doc.js';

const RULER = 24;
const HANDLE = 5;

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();

/** Colors near black would vanish on the dark canvas, so show them in the text color. */
function displayColor(c) {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(c || '');
  if (!m) return null;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16));
  const lum = 0.299 * r + 0.587 * g + 0.114 * b;
  if (lum < 70 || lum > 235) return null;
  return c;
}

export class View {
  constructor(canvas, doc, getSettings) {
    this.c = canvas; this.g = canvas.getContext('2d');
    this.doc = doc; this.settings = getSettings;
    this.zoom = 30; this.ox = RULER + 40; this.oy = RULER + 30; // screen px of world (0,0)
    this.drag = null; this.hover = null; this.pointers = new Map();
    this.images = new Map(); // trace object id → HTMLImageElement
    this.onCursor = () => {}; this.onCommit = () => {}; this.onSelect = () => {};
    this.spaceDown = false; this.tool = 'select';
    this.resize();
    new ResizeObserver(() => { this.resize(); }).observe(canvas.parentElement);
    canvas.addEventListener('pointerdown', (e) => this.down(e));
    canvas.addEventListener('pointermove', (e) => this.move(e));
    canvas.addEventListener('pointerup', (e) => this.up(e));
    canvas.addEventListener('pointercancel', (e) => this.up(e));
    canvas.addEventListener('wheel', (e) => this.wheel(e), { passive: false });
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  // ---------- coordinates ----------
  toScreen([x, y]) { return [this.ox + x * this.zoom, this.oy + y * this.zoom]; }
  toWorld(sx, sy) { return [(sx - this.ox) / this.zoom, (sy - this.oy) / this.zoom]; }
  eventPoint(e) { const r = this.c.getBoundingClientRect(); return [e.clientX - r.left, e.clientY - r.top]; }

  resize() {
    const r = this.c.parentElement.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    this.w = Math.max(100, r.width); this.h = Math.max(100, r.height);
    this.c.width = Math.round(this.w * dpr); this.c.height = Math.round(this.h * dpr);
    this.c.style.width = this.w + 'px'; this.c.style.height = this.h + 'px';
    this.dpr = dpr;
    this.redraw();
  }

  fitRoll() {
    const cw = this.settings().cutWidth;
    this.zoom = Math.max(2, (this.h - RULER - 60) / cw);
    this.ox = RULER + 40; this.oy = RULER + 30;
    this.redraw();
  }
  fitDesign() {
    const b = groupBox(this.doc.objects);
    if (!b) return this.fitRoll();
    // leave room for the rotate handle above and the zoom bar below
    const availW = this.w - RULER - 80, availH = this.h - RULER - 130;
    const z = Math.min(availW / Math.max(b.w, 0.5), availH / Math.max(b.h, 0.5));
    this.zoom = Math.max(2, Math.min(z, 400));
    this.ox = RULER + 40 + (availW - b.w * this.zoom) / 2 - b.x * this.zoom;
    this.oy = RULER + 50 + (availH - b.h * this.zoom) / 2 - b.y * this.zoom;
    this.redraw();
  }
  zoomBy(f, sx = this.w / 2, sy = this.h / 2) {
    const z = Math.max(1, Math.min(800, this.zoom * f));
    const [wx, wy] = this.toWorld(sx, sy);
    this.zoom = z; this.ox = sx - wx * z; this.oy = sy - wy * z;
    this.redraw();
  }
  /** Center of the visible roll area, for placing new things. */
  visibleCenter() {
    const [x0, y0] = this.toWorld(RULER, RULER), [x1, y1] = this.toWorld(this.w, this.h);
    const cw = this.settings().cutWidth;
    return [Math.max(1, (x0 + x1) / 2), Math.min(Math.max(1, (y0 + y1) / 2), cw - 1)];
  }
  visibleTopLeft() {
    const [x0, y0] = this.toWorld(RULER, RULER);
    return [Math.max(0.5, x0 + 0.5), Math.max(0.5, y0 + 0.5)];
  }

  redraw() { if (!this.raf) this.raf = requestAnimationFrame(() => { this.raf = 0; this.draw(); }); }

  // ---------- drawing ----------
  draw() {
    const g = this.g, z = this.zoom, s = this.settings();
    const C = { bg: css('--bg'), panel: css('--panel'), line: css('--line'), text: css('--text'), dim: css('--dim'), accent: css('--accent'), roll: css('--roll'), grid: css('--grid'), warn: css('--warn') };
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    g.fillStyle = C.bg; g.fillRect(0, 0, this.w, this.h);

    // roll
    const [rx0, ry0] = this.toScreen([0, 0]);
    const ry1 = this.toScreen([0, s.cutWidth])[1];
    g.fillStyle = C.roll; g.fillRect(rx0, ry0, this.w - rx0 + 10, ry1 - ry0);

    // grid: 1" lines, stronger every 12"
    const step = z < 6 ? 12 : z < 14 ? 6 : 1;
    const [wx0] = this.toWorld(RULER, 0), [wx1] = this.toWorld(this.w, 0);
    g.lineWidth = 1;
    for (let x = Math.max(0, Math.floor(wx0 / step) * step); x <= wx1; x += step) {
      const sx = Math.round(this.ox + x * z) + 0.5;
      g.strokeStyle = x % 12 === 0 ? C.line : C.grid;
      g.beginPath(); g.moveTo(sx, ry0); g.lineTo(sx, ry1); g.stroke();
    }
    for (let y = 0; y <= s.cutWidth + 1e-9; y += step) {
      const sy = Math.round(this.oy + y * z) + 0.5;
      g.strokeStyle = y % 12 === 0 ? C.line : C.grid;
      g.beginPath(); g.moveTo(Math.max(rx0, RULER), sy); g.lineTo(this.w, sy); g.stroke();
    }
    g.strokeStyle = C.accent; g.lineWidth = 2;
    g.beginPath(); g.moveTo(rx0, ry0); g.lineTo(this.w, ry0); g.moveTo(rx0, ry1); g.lineTo(this.w, ry1); g.stroke();
    // blade start marker
    g.fillStyle = C.accent; g.beginPath(); g.arc(rx0, ry0, 5, 0, Math.PI * 2); g.fill();

    // objects
    for (const o of this.doc.objects) {
      const sel = this.doc.selection.has(o.id);
      const wp = worldPaths(o);
      const b = bbox(wp);
      const outside = b && (b.y1 > s.cutWidth + 0.001 || b.y < -0.001 || b.x < -0.001);
      if (o.kind === 'trace' && o.trace?.showImage && this.images.get(o.id)) {
        const img = this.images.get(o.id), t = o.trace;
        g.save();
        const m = mul([z, 0, 0, z, this.ox, this.oy], objMatrix(o));
        g.setTransform(this.dpr * m[0], this.dpr * m[1], this.dpr * m[2], this.dpr * m[3], this.dpr * m[4], this.dpr * m[5]);
        g.globalAlpha = 0.45;
        g.drawImage(img, -(o.cx || 0), -(o.cy || 0), img.naturalWidth / t.ppi, img.naturalHeight / t.ppi);
        g.restore();
      }
      const p2 = new Path2D();
      for (const p of wp) {
        p.pts.forEach((pt, i) => { const [x, y] = this.toScreen(pt); i ? p2.lineTo(x, y) : p2.moveTo(x, y); });
        if (p.closed) p2.closePath();
      }
      const col = displayColor(o.color) || C.text;
      g.globalAlpha = 0.22; g.fillStyle = outside ? C.warn : col; g.fill(p2, 'evenodd');
      g.globalAlpha = 1; g.lineWidth = sel ? 1.6 : 1.2;
      g.strokeStyle = outside ? C.warn : sel ? C.accent : (this.hover === o.id ? C.dim : col);
      g.stroke(p2);
    }

    // selection
    const sel = this.doc.selected();
    if (sel.length) {
      const hs = this.handles();
      g.strokeStyle = C.accent; g.lineWidth = 1; g.setLineDash([4, 3]);
      g.beginPath();
      hs.box.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y)));
      g.closePath(); g.stroke(); g.setLineDash([]);
      const rot = hs.list.find((h) => h.id === 'rot');
      const top = hs.list.find((h) => h.id === 'n') || { x: (hs.box[0][0] + hs.box[1][0]) / 2, y: (hs.box[0][1] + hs.box[1][1]) / 2 };
      g.beginPath(); g.moveTo(top.x, top.y); g.lineTo(rot.x, rot.y); g.stroke();
      for (const h of hs.list) {
        g.fillStyle = h.id === 'rot' ? C.accent : C.bg; g.strokeStyle = C.accent; g.lineWidth = 1.5;
        g.beginPath();
        if (h.id === 'rot') g.arc(h.x, h.y, HANDLE + 1, 0, Math.PI * 2);
        else g.rect(h.x - HANDLE, h.y - HANDLE, HANDLE * 2, HANDLE * 2);
        g.fill(); g.stroke();
      }
    }

    // marquee
    if (this.drag?.type === 'marquee') {
      const { a, b } = this.drag;
      g.fillStyle = 'rgba(88,164,176,0.12)'; g.strokeStyle = C.accent; g.lineWidth = 1;
      g.fillRect(a[0], a[1], b[0] - a[0], b[1] - a[1]); g.strokeRect(a[0], a[1], b[0] - a[0], b[1] - a[1]);
    }

    this.drawRulers(C);
  }

  drawRulers(C) {
    const g = this.g, z = this.zoom, metric = this.settings().units === 'mm';
    g.fillStyle = C.panel; g.fillRect(0, 0, this.w, RULER); g.fillRect(0, 0, RULER, this.h);
    g.strokeStyle = C.line; g.lineWidth = 1;
    g.beginPath(); g.moveTo(0, RULER + 0.5); g.lineTo(this.w, RULER + 0.5); g.moveTo(RULER + 0.5, 0); g.lineTo(RULER + 0.5, this.h); g.stroke();
    g.fillStyle = C.dim; g.font = '10px system-ui, sans-serif'; g.textBaseline = 'top';
    const unit = metric ? 1 / 25.4 : 1;               // inches per ruler unit
    const pxPer = z * unit;
    const steps = metric ? [1, 5, 10, 50, 100, 500, 1000] : [1 / 8, 1 / 4, 1 / 2, 1, 2, 6, 12, 24, 48];
    const major = steps.find((s) => s * pxPer >= 60) || steps.at(-1);
    const minor = steps.slice().reverse().find((s) => s < major && s * pxPer >= 8) || major;
    const draw = (horizontal) => {
      const [a0, a1] = horizontal ? [this.toWorld(RULER, 0)[0], this.toWorld(this.w, 0)[0]] : [this.toWorld(0, RULER)[1], this.toWorld(0, this.h)[1]];
      const u0 = Math.floor(a0 / unit / minor) * minor, u1 = a1 / unit;
      g.beginPath();
      for (let u = u0; u <= u1; u += minor) {
        const isMajor = Math.abs(u / major - Math.round(u / major)) < 1e-6;
        const sp = horizontal ? this.ox + u * unit * z : this.oy + u * unit * z;
        if (sp < RULER) continue;
        const len = isMajor ? 10 : 5;
        if (horizontal) { g.moveTo(Math.round(sp) + 0.5, RULER - len); g.lineTo(Math.round(sp) + 0.5, RULER); }
        else { g.moveTo(RULER - len, Math.round(sp) + 0.5); g.lineTo(RULER, Math.round(sp) + 0.5); }
        if (isMajor) {
          const label = String(Math.round(u * 100) / 100);
          if (horizontal) g.fillText(label, sp + 3, 3);
          else { g.save(); g.translate(3, sp + 3); g.rotate(Math.PI / 2); g.fillText(label, 0, -10); g.restore(); }
        }
      }
      g.stroke();
    };
    draw(true); draw(false);
    g.fillStyle = C.panel; g.fillRect(0, 0, RULER, RULER);
    g.fillStyle = C.dim; g.fillText(metric ? 'mm' : 'in', 4, 7);
  }

  // ---------- selection handles ----------
  handles() {
    const sel = this.doc.selected();
    const off = 26;
    if (sel.length === 1) {
      const o = sel[0], lb = localBox(o);
      const ex = (lb.w / 2) * Math.abs(o.sx), ey = (lb.h / 2) * Math.abs(o.sy);
      const R = rotate(o.rot || 0);
      const at = (hx, hy, extraPx = 0) => {
        const [x, y] = apply(R, [hx * ex, hy * ey - (extraPx / this.zoom)]);
        return this.toScreen([o.x + x, o.y + y]);
      };
      const ids = { nw: [-1, -1], n: [0, -1], ne: [1, -1], e: [1, 0], se: [1, 1], s: [0, 1], sw: [-1, 1], w: [-1, 0] };
      const list = Object.entries(ids).map(([id, [hx, hy]]) => { const [x, y] = at(hx, hy); return { id, hx, hy, x, y }; });
      const [rx, ry] = at(0, -1, off);
      list.push({ id: 'rot', x: rx, y: ry });
      return { list, box: [at(-1, -1), at(1, -1), at(1, 1), at(-1, 1)], single: o, ex, ey };
    }
    const b = groupBox(sel);
    const [x0, y0] = this.toScreen([b.x, b.y]), [x1, y1] = this.toScreen([b.x1, b.y1]);
    const list = [
      { id: 'nw', hx: -1, hy: -1, x: x0, y: y0 }, { id: 'ne', hx: 1, hy: -1, x: x1, y: y0 },
      { id: 'se', hx: 1, hy: 1, x: x1, y: y1 }, { id: 'sw', hx: -1, hy: 1, x: x0, y: y1 },
      { id: 'rot', x: (x0 + x1) / 2, y: y0 - off },
    ];
    return { list, box: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]], group: b };
  }

  hitHandle(sp, touch) {
    if (!this.doc.selection.size) return null;
    const r = touch ? 16 : 9;
    return this.handles().list.find((h) => Math.hypot(h.x - sp[0], h.y - sp[1]) <= r) || null;
  }

  hitObject(sp) {
    const wp = this.toWorld(...sp), tol = 5 / this.zoom;
    const objs = this.doc.objects;
    let boxHit = null;
    for (let i = objs.length - 1; i >= 0; i--) {
      const o = objs[i], paths = worldPaths(o), b = bbox(paths);
      if (!b || wp[0] < b.x - tol || wp[0] > b.x1 + tol || wp[1] < b.y - tol || wp[1] > b.y1 + tol) continue;
      if (insidePaths(wp, paths) || distToPaths(wp, paths) <= tol) return o;
      boxHit ||= o;
    }
    return boxHit;
  }

  // ---------- pointer handling ----------
  down(e) {
    this.c.setPointerCapture(e.pointerId);
    const sp = this.eventPoint(e);
    this.pointers.set(e.pointerId, sp);
    if (this.pointers.size === 2) { // pinch / two-finger pan
      const [a, b] = [...this.pointers.values()];
      this.drag = { type: 'pinch', d0: Math.hypot(a[0] - b[0], a[1] - b[1]), z0: this.zoom, mid0: [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2], ox: this.ox, oy: this.oy };
      return;
    }
    if (e.button === 1 || e.button === 2 || this.spaceDown || this.tool === 'pan') {
      this.drag = { type: 'pan', s0: sp, ox: this.ox, oy: this.oy };
      this.c.style.cursor = 'grabbing';
      return;
    }
    const touch = e.pointerType === 'touch';
    const h = this.hitHandle(sp, touch);
    const start = { sp, wp: this.toWorld(...sp), objs: this.doc.selected().map((o) => structuredClone(o)) };
    if (h) {
      const hs = this.handles();
      this.drag = { ...start, type: h.id === 'rot' ? 'rotate' : 'scale', h, hs, moved: false };
      return;
    }
    const o = this.hitObject(sp);
    if (o) {
      if (e.shiftKey || e.ctrlKey || e.metaKey) { this.doc.toggle(o.id); this.onSelect(); this.redraw(); return; }
      if (!this.doc.selection.has(o.id)) { this.doc.select([o.id]); this.onSelect(); }
      this.drag = { type: 'move', sp, wp: start.wp, objs: this.doc.selected().map((x) => structuredClone(x)), moved: false };
    } else {
      if (!e.shiftKey) { this.doc.clearSelection(); this.onSelect(); }
      this.drag = { type: 'marquee', a: sp, b: sp, additive: e.shiftKey };
    }
    this.redraw();
  }

  move(e) {
    const sp = this.eventPoint(e);
    if (this.pointers.has(e.pointerId)) this.pointers.set(e.pointerId, sp);
    const wp = this.toWorld(...sp);
    this.onCursor(wp);
    const d = this.drag;
    if (!d) {
      const touch = e.pointerType === 'touch';
      const h = this.hitHandle(sp, touch);
      const o = h ? null : this.hitObject(sp);
      const id = o?.id || null;
      if (id !== this.hover) { this.hover = id; this.redraw(); }
      this.c.style.cursor = this.spaceDown || this.tool === 'pan' ? 'grab' : h ? (h.id === 'rot' ? 'crosshair' : 'nwse-resize') : o ? 'move' : 'default';
      return;
    }
    if (d.type === 'pinch') {
      if (this.pointers.size < 2) return;
      const [a, b] = [...this.pointers.values()];
      const dist = Math.hypot(a[0] - b[0], a[1] - b[1]), mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
      const z = Math.max(1, Math.min(800, d.z0 * (dist / d.d0)));
      const wx = (d.mid0[0] - d.ox) / d.z0, wy = (d.mid0[1] - d.oy) / d.z0;
      this.zoom = z; this.ox = mid[0] - wx * z; this.oy = mid[1] - wy * z;
      this.redraw(); return;
    }
    if (d.type === 'pan') { this.ox = d.ox + sp[0] - d.s0[0]; this.oy = d.oy + sp[1] - d.s0[1]; this.redraw(); return; }
    if (d.type === 'marquee') { d.b = sp; this.redraw(); return; }

    if (!d.moved && Math.hypot(sp[0] - d.sp[0], sp[1] - d.sp[1]) < 3) return;
    d.moved = true;
    const byId = new Map(d.objs.map((o) => [o.id, o]));
    const live = this.doc.selected();

    if (d.type === 'move') {
      let dx = wp[0] - d.wp[0], dy = wp[1] - d.wp[1];
      if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      for (const o of live) { const s0 = byId.get(o.id); o.x = s0.x + dx; o.y = s0.y + dy; }
    } else if (d.type === 'rotate') {
      const c = d.hs.single ? [d.objs[0].x, d.objs[0].y] : [d.hs.group.x + d.hs.group.w / 2, d.hs.group.y + d.hs.group.h / 2];
      let da = (Math.atan2(wp[1] - c[1], wp[0] - c[0]) - Math.atan2(d.wp[1] - c[1], d.wp[0] - c[0])) * 180 / Math.PI;
      if (d.hs.single) {
        let r = d.objs[0].rot + da;
        if (e.shiftKey) r = Math.round(r / 15) * 15;
        live[0].rot = ((r % 360) + 360) % 360;
      } else {
        if (e.shiftKey) da = Math.round(da / 15) * 15;
        const R = rotate(da);
        for (const o of live) {
          const s0 = byId.get(o.id);
          const [x, y] = apply(R, [s0.x - c[0], s0.y - c[1]]);
          o.x = c[0] + x; o.y = c[1] + y; o.rot = (((s0.rot + da) % 360) + 360) % 360;
        }
      }
    } else if (d.type === 'scale') {
      if (d.hs.single) this.scaleSingle(live[0], d.objs[0], d.h, d.hs, wp, e.shiftKey);
      else this.scaleGroup(live, byId, d.h, d.hs.group, wp);
    }
    this.onSelect(true);
    this.redraw();
  }

  scaleSingle(o, s0, h, hs, wp, free) {
    const R = rotate(s0.rot || 0), Ri = invert(R);
    const u = apply(Ri, [wp[0] - s0.x, wp[1] - s0.y]);
    const ex0 = hs.ex, ey0 = hs.ey, min = 0.01;
    const A = [-h.hx * ex0, -h.hy * ey0];
    let ex = ex0, ey = ey0;
    const corner = h.hx !== 0 && h.hy !== 0;
    if (corner && !free) {
      const H = [h.hx * ex0, h.hy * ey0];
      const v = [H[0] - A[0], H[1] - A[1]];
      const f = Math.max(min / Math.max(ex0, ey0, 1e-6), ((u[0] - A[0]) * v[0] + (u[1] - A[1]) * v[1]) / (v[0] ** 2 + v[1] ** 2));
      ex = ex0 * f; ey = ey0 * f;
    } else {
      if (h.hx) ex = Math.max(min, ((u[0] - A[0]) * h.hx) / 2);
      if (h.hy) ey = Math.max(min, ((u[1] - A[1]) * h.hy) / 2);
    }
    const c = [h.hx ? A[0] + h.hx * ex : 0, h.hy ? A[1] + h.hy * ey : 0];
    const [cx, cy] = apply(R, c);
    o.x = s0.x + cx; o.y = s0.y + cy;
    const lb = localBox(s0);
    if (lb.w > 0) o.sx = Math.sign(s0.sx || 1) * (ex * 2) / lb.w;
    if (lb.h > 0) o.sy = Math.sign(s0.sy || 1) * (ey * 2) / lb.h;
  }

  scaleGroup(live, byId, h, b, wp) {
    const A = [h.hx > 0 ? b.x : b.x1, h.hy > 0 ? b.y : b.y1];
    const H = [h.hx > 0 ? b.x1 : b.x, h.hy > 0 ? b.y1 : b.y];
    const v = [H[0] - A[0], H[1] - A[1]];
    const f = Math.max(0.02, ((wp[0] - A[0]) * v[0] + (wp[1] - A[1]) * v[1]) / (v[0] ** 2 + v[1] ** 2));
    for (const o of live) {
      const s0 = byId.get(o.id);
      o.x = A[0] + f * (s0.x - A[0]); o.y = A[1] + f * (s0.y - A[1]);
      o.sx = s0.sx * f; o.sy = s0.sy * f;
    }
  }

  up(e) {
    this.pointers.delete(e.pointerId);
    const d = this.drag;
    if (!d) return;
    if (d.type === 'pinch') { if (this.pointers.size === 0) this.drag = null; return; }
    this.drag = null;
    if (d.type === 'pan') { this.c.style.cursor = this.spaceDown || this.tool === 'pan' ? 'grab' : 'default'; return; }
    if (d.type === 'marquee') {
      const [ax, ay] = this.toWorld(...d.a), [bx, by] = this.toWorld(...d.b);
      const x0 = Math.min(ax, bx), x1 = Math.max(ax, bx), y0 = Math.min(ay, by), y1 = Math.max(ay, by);
      if (x1 - x0 > 2 / this.zoom || y1 - y0 > 2 / this.zoom) {
        const ids = this.doc.objects.filter((o) => {
          const b = bbox(worldPaths(o));
          return b && b.x1 >= x0 && b.x <= x1 && b.y1 >= y0 && b.y <= y1;
        }).map((o) => o.id);
        this.doc.select(ids, d.additive);
        this.onSelect();
      }
      this.redraw();
      return;
    }
    if (d.moved) this.onCommit({ move: 'Move', rotate: 'Rotate', scale: 'Resize' }[d.type] || 'Edit');
  }

  wheel(e) {
    e.preventDefault();
    const sp = this.eventPoint(e);
    if (e.shiftKey && !e.ctrlKey) { this.ox -= e.deltaY || e.deltaX; this.redraw(); return; }
    // Trackpad two-finger scroll (no ctrl, small deltas with deltaX) pans; mouse wheel and pinch zoom.
    if (!e.ctrlKey && Math.abs(e.deltaX) > 0 && e.deltaMode === 0 && Math.abs(e.deltaY) < 50) {
      this.ox -= e.deltaX; this.oy -= e.deltaY; this.redraw(); return;
    }
    const f = Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015));
    this.zoomBy(f, sp[0], sp[1]);
  }
}
