// FantastiCut app: wires the document, canvas, panels, dialogs, and cutter together.
import { Doc, newId, worldPaths, worldBox, groupBox, localBox } from './doc.js';
import { View } from './view.js';
import { center, objMatrix, apply, bbox, pointInPoly, signedArea, round, mul, invert, translate, rotate, transformPaths } from './geom.js';
import { weld as weldPaths, offset as offsetPaths, union as clipUnion } from './clip.js';
import { fitNodes, refresh, insertNode, setType, setSegment, breakAt, joinEnds, classify } from './nodes.js';
import { lsGet, lsSet } from './store.js';
import { parseSVG } from './import-svg.js';
import { parseDXF } from './import-dxf.js';
import { fileToDataURL, Tracer, TRACE_DEFAULTS, loadImage } from './import-image.js';
import { listFonts, loadInstalledFonts, uploadFont, getFont, textToPaths, TEXT_DEFAULTS, localFontsSupported, BUNDLED } from './text.js';
import { loadPresets, savePresets, loadSettings, saveSettings, DEFAULT_PRESETS } from './presets.js';
import { prepareJob, planJob, testPattern, JOB_DEFAULTS } from './job.js';
import { rectPack } from './nest-core.js';
import { region, intersect as clipIntersect, area as clipArea } from './clip.js';
import { Cutter, supported as serialSupported } from './serial.js';

// Version: v0.1 until E's first real test cut, then 1.0. BUILD changes with every deploy (also in index.html).
export const VERSION = 'v0.1';
export const BUILD = '2026-11-27 Phase 3 fix';
const $ = (id) => document.getElementById(id);

// ---------- state ----------
let settings = loadSettings();
let presets = loadPresets();
const doc = new Doc();
const view = new View($('canvas'), doc, () => settings);
let clipboard = null;
let fileHandle = null;
let fontList = [];

// ---------- log + toasts ----------
const logEl = $('log');
function log(msg) {
  const t = new Date().toLocaleTimeString();
  logEl.textContent += `[${t}] ${msg}\n`;
  if (logEl.textContent.length > 400000) logEl.textContent = logEl.textContent.slice(-300000);
  logEl.scrollTop = logEl.scrollHeight;
}
function toast(msg, { error = false, ms = 4200 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast' + (error ? ' err' : '');
  el.textContent = msg;
  $('toasts').append(el);
  while ($('toasts').children.length > 3) $('toasts').firstChild.remove(); // keep the newest three
  setTimeout(() => el.remove(), ms);
  if (error) log('ERROR: ' + msg);
}
const run = (fn) => async (...a) => {
  try { await fn(...a); } catch (e) {
    if (e?.name === 'NotFoundError' || e?.name === 'AbortError') return; // user closed a picker
    console.error(e); toast(e.message || String(e), { error: true });
  }
};

// ---------- units ----------
const k = () => (settings.units === 'mm' ? 25.4 : 1);
const fmt = (inches) => (settings.units === 'mm' ? round(inches * 25.4, 1) : round(inches, 3));
const unitLabel = () => (settings.units === 'mm' ? 'mm' : '"');
const fmtU = (inches) => `${fmt(inches)}${unitLabel()}`;

// ---------- object helpers ----------
/** Sets an object's geometry from source-space paths, keeping it in place on the roll. */
function setSource(o, src) {
  const { paths, cx, cy } = center(src);
  if (o.cx != null) {
    const L = objMatrix({ ...o, x: 0, y: 0 });
    const [dx, dy] = apply(L, [cx - o.cx, cy - o.cy]);
    o.x += dx; o.y += dy;
  }
  o.cx = cx; o.cy = cy; o.paths = paths;
}

function makeObject(kind, name, src, extra = {}) {
  const o = { id: newId(), kind, name, x: 0, y: 0, sx: 1, sy: 1, rot: 0, color: '#000000', ...extra };
  setSource(o, src);
  const colors = [...new Set(src.map((p) => p.color).filter(Boolean))];
  if (colors.length === 1) o.color = colors[0];
  return o;
}

/** Splits imported paths into one object per color, keeping their layout. */
function makeObjects(name, paths) {
  const key = (p) => (p.color || '#000000').toLowerCase();
  const colors = [...new Set(paths.map(key))];
  if (colors.length < 2) return [makeObject('shape', name, paths)];
  return colors.map((c) => {
    const o = makeObject('shape', `${name} (${layerName(c)})`, paths.filter((p) => key(p) === c));
    o.x = o.cx; o.y = o.cy; o.color = c;
    return o;
  });
}

/** Places several new objects as one group to the right of existing work, sized to fit the roll. */
function placeGroup(objs) {
  if (objs.length === 1) { place(objs[0]); return; }
  let b = groupBox(objs);
  const fit = settings.cutWidth - 0.5;
  if (b.h > fit) {
    const f = fit / b.h;
    for (const o of objs) { o.x = b.x + (o.x - b.x) * f; o.y = b.y + (o.y - b.y) * f; o.sx *= f; o.sy *= f; }
    toast(`Scaled down to fit the ${settings.cutWidth}" cutting width.`);
    b = groupBox(objs);
  }
  const others = groupBox(doc.objects);
  const tx = (others ? others.x1 + 0.5 : 0.5) - b.x, ty = 0.5 - b.y;
  for (const o of objs) { o.x += tx; o.y += ty; }
}

/** Puts a new object to the right of existing work, sized to fit the roll. */
function place(o) {
  const lb = localBox(o);
  const fit = settings.cutWidth - 0.5;
  const b0 = worldBox(o);
  if (b0 && b0.h > fit) {
    const f = fit / b0.h;
    o.sx *= f; o.sy *= f;
    toast(`Scaled down to fit the ${settings.cutWidth}" cutting width.`);
  }
  const others = groupBox(doc.objects);
  const b = worldBox(o) || { w: lb.w, h: lb.h };
  o.x = (others ? others.x1 + 0.5 : 0.5) + b.w / 2;
  o.y = 0.5 + b.h / 2;
}

function ensureVisible(o) {
  const b = worldBox(o);
  if (!b) return;
  const [x0, y0] = view.toWorld(30, 30), [x1, y1] = view.toWorld(view.w - 20, view.h - 20);
  if (b.x < x0 || b.x1 > x1 || b.y < y0 || b.y1 > y1) view.fitDesign();
}

// ---------- importing ----------
const baseName = (n) => n.replace(/\.[^.]+$/, '');

async function importFile(file) {
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  if (ext === 'fcut') { await openText(await file.text(), file.name); return; }
  let o, objs;
  if (ext === 'svg' || file.type === 'image/svg+xml') {
    const { paths, note } = parseSVG(await file.text());
    if (!paths.length) throw new Error(`${file.name}: no cuttable shapes found.${note ? ' ' + note : ''}`);
    objs = makeObjects(baseName(file.name), paths);
    if (note) toast(note);
  } else if (ext === 'dxf') {
    const { paths, note } = parseDXF(await file.text());
    if (!paths.length) throw new Error(`${file.name}: no cuttable shapes found.${note ? ' ' + note : ''}`);
    objs = makeObjects(baseName(file.name), paths);
    if (note) toast(note);
  } else if (file.type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'].includes(ext)) {
    toast('Tracing image…', { ms: 1500 });
    const img = await fileToDataURL(file);
    const ppi = Math.max(100, Math.round(img.width / 8));
    const trace = { ...TRACE_DEFAULTS, ppi, dataURL: img.dataURL, showImage: false, baseName: baseName(file.name || 'Pasted image') };
    let layers = null;
    while (!layers) layers = await tracer.trace(img.dataURL, trace); // null only if another trace jumped in
    const paths = layers[0]?.paths || [];
    o = makeObject('trace', trace.baseName, paths.length ? paths : [{ pts: [[0, 0], [0.01, 0]], closed: false }], { trace });
    view.images.set(o.id, await loadImage(img.dataURL));
    if (!paths.length) toast('Nothing traced at this threshold. Try moving the Threshold slider or ticking Invert.');
  } else {
    throw new Error(`${file.name}: FantastiCut can import SVG, DXF, PNG, and JPG files.`);
  }
  objs ||= [o];
  placeGroup(objs);
  for (const x of objs) doc.add(x, { select: false });
  doc.select(objs.map((x) => x.id));
  doc.commit('Import ' + baseName(file.name));
  for (const x of objs) ensureVisible(x);
  if (objs.length > 1) toast(`${file.name} has ${objs.length} colors, so it came in as ${objs.length} color layers.`);
  const gb = groupBox(objs);
  log(`Imported ${file.name}: ${objs.reduce((n, x) => n + x.paths.length, 0)} path(s) in ${objs.length} object(s), ${fmtU(gb.w)} × ${fmtU(gb.h)}.`);
}
const importFiles = run(async (files) => {
  const wasEmpty = !doc.objects.length;
  for (const f of files) { try { await importFile(f); } catch (e) { toast(e.message, { error: true }); } }
  if (wasEmpty && doc.objects.length) view.fitDesign();
});

// ---------- text ----------
async function buildText(o) {
  const font = await getFont(o.text.font);
  const paths = textToPaths(font, o.text);
  setSource(o, paths.length ? paths : [{ pts: [[0, 0], [0.01, 0]], closed: false }]);
}

const addText = run(async () => {
  const o = { id: newId(), kind: 'text', name: 'Text', x: 0, y: 0, sx: 1, sy: 1, rot: 0, color: '#000000', text: { ...TEXT_DEFAULTS } };
  await buildText(o);
  const [cx, cy] = view.visibleCenter();
  o.x = cx; o.y = cy;
  const b = worldBox(o);
  if (b.x < 0.25) o.x += 0.25 - b.x;
  if (b.y < 0.25) o.y += 0.25 - b.y;
  doc.add(o);
  doc.commit('Add text');
  refreshPanels();
  $('t-text').focus(); $('t-text').select();
});

let textTimer = 0;
function updateText(change, label = 'Edit text') {
  const o = single('text');
  if (!o) return;
  Object.assign(o.text, change);
  clearTimeout(textTimer);
  textTimer = setTimeout(run(async () => {
    await buildText(o);
    o.name = (o.text.text.split('\n')[0] || 'Text').slice(0, 30);
    doc.commit(label);
    view.redraw(); refreshPanels(true);
  }), 120);
}

async function refreshFontSelect() {
  fontList = await listFonts();
  renderFontOptions();
}
function renderFontOptions() {
  const sel = $('t-font'), q = $('t-font-filter').value.trim().toLowerCase();
  const cur = single('text')?.text.font;
  sel.textContent = '';
  const groups = new Map();
  for (const f of fontList) {
    if (q && !f.name.toLowerCase().includes(q) && f.key !== cur) continue;
    if (!groups.has(f.group)) { const og = document.createElement('optgroup'); og.label = f.group; groups.set(f.group, og); sel.append(og); }
    const op = new Option(f.name, f.key, false, f.key === cur);
    groups.get(f.group).append(op);
  }
  if (cur && !fontList.some((f) => f.key === cur)) sel.prepend(new Option(cur.replace(/^\w+:/, '') + ' (not loaded)', cur, false, true));
}

// ---------- trace ----------
// Tracing runs in a worker (see import-image.js). While a slider moves, the new trace shows as a
// preview over the design; letting go records it as one undo step. "Colors" makes one object per
// color (a trace group that re-traces together).
const tracer = new Tracer();
let traceDraft = null; // { id, t: settings, gm: source→world matrix, layers, commit }
const TRACE_MODES = { bw: 'Black and white', color: 'Colors', center: 'Centerline' };

function traceGroup(o) {
  return o?.trace?.group ? doc.objects.filter((x) => x.kind === 'trace' && x.trace?.group === o.trace.group) : o ? [o] : [];
}
/** The trace the panel works on: one trace object, or every object of one trace group. */
function traceTarget() {
  const sel = doc.selected();
  if (!sel.length || !sel.every((o) => o.kind === 'trace' && o.trace)) return null;
  const g = sel[0].trace.group;
  if (sel.length > 1 && (!g || !sel.every((o) => o.trace.group === g))) return null;
  return traceGroup(sel[0])[0];
}
const traceSettings = (o) => ({ ...TRACE_DEFAULTS, ...o.trace });

function setTraceStatus(msg) { $('tr-status').textContent = msg || ''; }

async function updateTrace(change, commit = false) {
  const o = traceTarget();
  if (!o) return;
  const same = traceDraft?.id === o.id;
  const t = { ...(same ? traceDraft.t : traceSettings(o)), ...change };
  traceDraft = { id: o.id, t, gm: mul(objMatrix(o), translate(-o.cx, -o.cy)), layers: same ? traceDraft.layers : null, commit: commit || (same && traceDraft.commit) };
  view.hidden = new Set(traceGroup(o).map((x) => x.id));
  fillTraceControls(t);
  setTraceStatus('Tracing…');
  let layers;
  try { layers = await tracer.trace(o.trace.dataURL, t); } catch (e) { clearTraceDraft(); toast(e.message, { error: true }); return; }
  if (!layers || traceDraft?.id !== o.id || traceDraft.t !== t) return; // newer settings are on the way
  if (traceDraft.commit) { clearTraceDraft(); applyTrace(o, layers, t); return; }
  traceDraft.layers = layers;
  view.overlay = drawTracePreview;
  setTraceStatus(`Preview: ${describeLayers(layers)}. Let go to keep it.`);
  view.redraw();
}
function describeLayers(layers) {
  const L = layers.filter((l) => l.paths.length), n = L.reduce((a, l) => a + l.paths.length, 0);
  return L.length > 1 ? `${L.length} color layers, ${n} outlines` : `${n} outline${n === 1 ? '' : 's'}`;
}
function clearTraceDraft() {
  traceDraft = null; view.overlay = null; view.hidden = null; setTraceStatus(''); view.redraw();
}
function drawTracePreview(g, v, C) {
  const d = traceDraft;
  if (!d?.layers) return;
  for (const L of d.layers) {
    const p2 = new Path2D();
    for (const p of L.paths) {
      p.pts.forEach((pt, i) => { const [x, y] = v.toScreen(apply(d.gm, pt)); i ? p2.lineTo(x, y) : p2.moveTo(x, y); });
      if (p.closed) p2.closePath();
    }
    const col = /^#([0-9a-f]{6})$/i.test(L.color) && L.color.toLowerCase() !== '#000000' ? L.color : C.text;
    g.globalAlpha = 0.3; g.fillStyle = col; g.fill(p2, 'evenodd');
    g.globalAlpha = 1; g.strokeStyle = C.accent; g.lineWidth = 1; g.setLineDash([5, 3]); g.stroke(p2); g.setLineDash([]);
  }
}

/** Replaces a trace (or trace group) with new results: one object per layer, in the same place. */
function applyTrace(o, layers, t) {
  const group = traceGroup(o);
  const L = layers.filter((l) => l.paths.length);
  if (!L.length) { toast('Nothing traced with these settings. Try the Threshold slider, Invert, or fewer specks removed.'); refreshPanels(); return; }
  const gm = mul(objMatrix(o), translate(-o.cx, -o.cy));
  const base = t.baseName || o.name.replace(/ \([^)]*\)$/, '');
  const multi = L.length > 1;
  const gid = multi ? (o.trace.group || newId()) : undefined;
  const made = L.map((layer, i) => {
    const n = { id: group[i]?.id || newId(), kind: 'trace', name: multi ? `${base} (${layerName(layer.color)})` : base, x: 0, y: 0, sx: 1, sy: 1, rot: 0, cx: null,
      color: multi ? layer.color : group.length > 1 ? '#000000' : colorKey(o.color),
      trace: { ...t, baseName: base, group: gid, layer: multi ? layer.color : undefined, primary: i === 0 } };
    if (!multi) { delete n.trace.group; delete n.trace.layer; }
    setSource(n, layer.paths);
    setMatrix(n, mul(gm, translate(n.cx, n.cy)));
    return n;
  });
  const idx = Math.min(...group.map((x) => doc.objects.indexOf(x)));
  const img = view.images.get(o.id);
  doc.remove(group.map((x) => x.id));
  doc.objects.splice(idx, 0, ...made);
  if (img) for (const n of made) view.images.set(n.id, img);
  doc.select(made.map((n) => n.id));
  doc.commit(t.mode !== traceSettings(o).mode ? `Trace: ${TRACE_MODES[t.mode]}` : 'Trace settings');
  setTraceStatus(describeLayers(L) + '.');
  if (multi && group.length < 2) toast(`Traced into ${L.length} color layers, one object each. They are listed under Color layers.`);
}

function fillTraceControls(t) {
  $('tr-mode').value = t.mode;
  for (const el of document.querySelectorAll('#p-trace [data-modes]')) el.hidden = !el.dataset.modes.split(' ').includes(t.mode);
  $('tr-th').value = t.threshold; $('tr-sm').value = t.smooth; $('tr-sp').value = t.despeckle;
  $('tr-inv').checked = !!t.invert; $('tr-colors').value = t.colors; $('tr-bg').checked = !!t.dropBg;
  $('tr-stack').value = t.stack;
  if (document.activeElement !== $('tr-overlap')) $('tr-overlap').value = fmt(t.overlap);
  if (document.activeElement !== $('tr-stroke')) $('tr-stroke').value = t.stroke > 0 ? fmt(t.stroke) : '';
  $('tr-overlap').disabled = t.stack !== 'overlap';
  $('tr-th-v').textContent = t.threshold; $('tr-sm-v').textContent = t.smooth; $('tr-sp-v').textContent = t.despeckle; $('tr-colors-v').textContent = t.colors;
}
async function loadTraceImages() {
  const byURL = new Map();
  for (const o of doc.objects) {
    if (o.kind === 'trace' && o.trace?.dataURL && !view.images.has(o.id)) {
      try {
        if (!byURL.has(o.trace.dataURL)) byURL.set(o.trace.dataURL, await loadImage(o.trace.dataURL));
        view.images.set(o.id, byURL.get(o.trace.dataURL));
      } catch {}
    }
  }
  view.redraw();
}

// ---------- selection editing ----------
const single = (kind) => {
  const s = doc.selected();
  return s.length === 1 && (!kind || s[0].kind === kind) ? s[0] : null;
};

function setNum(id, v) { const el = $(id); if (document.activeElement !== el) el.value = v; }

function refreshPanels(liveOnly = false) {
  const sel = doc.selected();
  $('empty').hidden = doc.objects.length > 0;
  $('p-none').hidden = sel.length > 0;
  $('p-sel').hidden = sel.length === 0;
  const one = sel.length === 1 ? sel[0] : null;
  const ne = view.nodeEdit;
  $('sheet-label').textContent = ne ? 'Edit nodes' : one ? one.name : sel.length ? `${sel.length} objects` : 'Design and layers';
  $('p-nodes').hidden = !ne;
  if (ne) {
    $('p-sel').hidden = true;
    const lists = view.nodePaths();
    const total = lists.reduce((a, l) => a + l.length, 0);
    $('n-info').textContent = `${total} node${total === 1 ? '' : 's'} in ${lists.length} path${lists.length === 1 ? '' : 's'} · ${ne.sel.size} picked`;
  }
  $('p-text').hidden = !!ne || !(one && one.kind === 'text');
  const tt = traceTarget();
  $('p-trace').hidden = !!ne || !tt;
  if (traceDraft && traceDraft.id !== tt?.id) clearTraceDraft();
  $('p-offset').hidden = !!ne || !(one && one.kind === 'offset' && one.offset?.linked);
  $('f-width').textContent = fmtU(settings.cutWidth);
  $('f-count').textContent = doc.objects.length;
  const all = groupBox(doc.objects);
  $('f-size').textContent = all ? `${fmtU(all.w)} × ${fmtU(all.h)}` : '–';

  if (sel.length) {
    const b = groupBox(sel);
    $('sel-title').textContent = one ? ({ text: 'Text', trace: 'Traced image', shape: one.weld ? 'Weld' : 'Shape', offset: 'Offset' }[one.kind] || 'Shape') + ': ' + one.name : `${sel.length} objects`;
    if (document.activeElement !== $('in-color')) $('in-color').value = colorKey(sel[0].color);
    $('b-weld').disabled = !canWeld(sel);
    $('b-unweld').disabled = !canUnweld(sel);
    setNum('in-x', fmt(b.x)); setNum('in-y', fmt(b.y));
    if (one) {
      const lb = localBox(one);
      setNum('in-w', fmt(lb.w * Math.abs(one.sx))); setNum('in-h', fmt(lb.h * Math.abs(one.sy)));
      setNum('in-rot', round(one.rot || 0, 1));
    } else { setNum('in-w', fmt(b.w)); setNum('in-h', fmt(b.h)); setNum('in-rot', ''); }
    $('in-rot').disabled = !one;
    $('align-row').hidden = sel.length < 2;
    $('b-ungroup').disabled = !(one && one.paths.length > 1);
    $('b-combine').disabled = sel.length < 2;
    $('b-nodes').disabled = !one;
    $('st-sel').textContent = `${sel.length} selected · ${fmtU(b.w)} × ${fmtU(b.h)}`;
  } else $('st-sel').textContent = '';

  if (!liveOnly && one?.kind === 'text') {
    if (document.activeElement !== $('t-text')) $('t-text').value = one.text.text;
    setNum('t-height', fmt(one.text.height * Math.abs(one.sy)));
    setNum('t-spacing', one.text.spacing);
    setNum('t-line', one.text.lineHeight);
    $('t-align').value = one.text.align;
    renderFontOptions();
    const fname = fontList.find((f) => f.key === one.text.font)?.name || one.text.font;
    $('t-weld').checked = one.text.weld !== false;
    $('t-script-hint').hidden = !(/pacifico|script|brush|hand/i.test(fname) && one.text.weld === false);
  }
  if (!liveOnly && one?.kind === 'offset' && one.offset?.linked) {
    setNum('of-dist', fmt(one.offset.dist));
    $('of-dir').value = one.offset.dir; $('of-join').value = one.offset.join;
    const names = one.offset.src.map((id) => doc.get(id)?.name).filter(Boolean);
    $('of-status').textContent = `Linked to ${names.length === 1 ? `"${names[0]}"` : `${names.length} objects`}: it updates when you move, resize, or edit the original.${one.empty ? ' Nothing is left at this distance; make it smaller.' : ''}`;
  }
  if (!liveOnly && tt && !traceDraft) {
    fillTraceControls(traceSettings(tt));
    $('tr-show').checked = !!tt.trace.showImage;
  }
  if (!liveOnly) { renderLayers(); renderColorLayers(); }
  $('btn-undo').disabled = !doc.undoStack.length;
  $('btn-redo').disabled = !doc.redoStack.length;
  $('btn-undo').title = doc.undoStack.length ? `Undo ${doc.undoStack.at(-1).label} (Ctrl+Z)` : 'Undo (Ctrl+Z)';
  $('btn-redo').title = doc.redoStack.length ? `Redo ${doc.redoStack.at(-1).label} (Ctrl+Shift+Z)` : 'Redo (Ctrl+Shift+Z)';
  $('zoom-label').textContent = Math.round((view.zoom / 96) * 100) + '%';
}

function renderLayers() {
  const ul = $('layers');
  ul.textContent = '';
  if (!doc.objects.length) { const li = document.createElement('li'); li.className = 'empty-li'; li.textContent = 'Nothing here yet.'; ul.append(li); return; }
  for (const o of [...doc.objects].reverse()) {
    const li = document.createElement('li');
    if (doc.selection.has(o.id)) li.classList.add('sel');
    const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = o.color || '#000';
    const nm = document.createElement('span'); nm.className = 'nm'; nm.textContent = o.name;
    const kd = document.createElement('span'); kd.className = 'kd'; kd.textContent = o.weld ? 'weld' : o.kind === 'offset' ? 'offset' : o.kind;
    li.append(sw, nm, kd);
    li.onclick = (e) => { if (e.shiftKey || e.ctrlKey) doc.toggle(o.id); else doc.select([o.id]); };
    ul.append(li);
  }
}

function applyBoxEdit(field, value) {
  const sel = doc.selected();
  if (!sel.length || !Number.isFinite(value)) return;
  const v = value / k();
  const b = groupBox(sel);
  if (field === 'x' || field === 'y') {
    const d = field === 'x' ? v - b.x : v - b.y;
    for (const o of sel) o[field] += d;
  } else if (field === 'rot') {
    if (sel.length === 1) sel[0].rot = ((value % 360) + 360) % 360;
  } else {
    if (v <= 0) return;
    const lock = $('in-lock').checked;
    if (sel.length === 1) {
      const o = sel[0], lb = localBox(o);
      const cur = field === 'w' ? lb.w * Math.abs(o.sx) : lb.h * Math.abs(o.sy);
      if (!cur) return;
      const f = v / cur;
      if (lock) { o.sx *= f; o.sy *= f; } else if (field === 'w') o.sx *= f; else o.sy *= f;
      const nb = worldBox(o); o.x += b.x - nb.x; o.y += b.y - nb.y; // keep top-left corner
    } else {
      const f = v / (field === 'w' ? b.w : b.h);
      for (const o of sel) { o.x = b.x + (o.x - b.x) * f; o.y = b.y + (o.y - b.y) * f; o.sx *= f; o.sy *= f; }
    }
  }
  doc.commit({ x: 'Move', y: 'Move', w: 'Resize', h: 'Resize', rot: 'Rotate' }[field]);
}

function flip(axis) {
  const sel = doc.selected();
  if (!sel.length) return;
  const b = groupBox(sel), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
  for (const o of sel) {
    if (axis === 'h') { o.sx = -o.sx; o.x = 2 * cx - o.x; o.rot = (360 - o.rot) % 360; }
    else { o.sy = -o.sy; o.y = 2 * cy - o.y; o.rot = (360 - o.rot) % 360; }
  }
  doc.commit(axis === 'h' ? 'Mirror' : 'Flip');
}

/**
 * Copies objects with new ids. A linked offset whose original is copied too follows the copy;
 * one whose original is not copied becomes a plain shape.
 */
function cloneObjects(objs, dx = 0, dy = 0) {
  const map = new Map();
  const groups = new Map(); // a copied trace group becomes its own group
  const copies = objs.map((o) => {
    const c = structuredClone(o); c.id = newId(); map.set(o.id, c.id); c.x += dx; c.y += dy;
    if (c.trace?.group) { if (!groups.has(c.trace.group)) groups.set(c.trace.group, newId()); c.trace.group = groups.get(c.trace.group); }
    return c;
  });
  for (const c of copies) {
    if (c.kind !== 'offset' || !c.offset) continue;
    if (c.offset.linked && c.offset.src.every((id) => map.has(id))) { c.offset.src = c.offset.src.map((id) => map.get(id)); c.offset.hash = ''; }
    else { c.kind = 'shape'; delete c.offset; }
  }
  return copies;
}

function duplicate(offset = 0.25) {
  const sel = doc.selected();
  if (!sel.length) return;
  const copies = cloneObjects(sel, offset, offset);
  for (const c of copies) doc.add(c, { select: false });
  doc.select(copies.map((c) => c.id));
  doc.commit('Duplicate');
  loadTraceImages();
}

function deleteSel() {
  const ids = [...doc.selection];
  if (!ids.length) return;
  doc.remove(ids);
  doc.commit(ids.length > 1 ? `Delete ${ids.length} objects` : 'Delete');
}

/** Splits an object into pieces: each outer outline with the holes inside it. */
function ungroup() {
  const o = single();
  if (!o || o.paths.length < 2) return;
  const byColor = new Map();
  for (const p of o.paths) { const c = p.color || o.color; if (!byColor.has(c)) byColor.set(c, []); byColor.get(c).push(p); }
  const pieces = [];
  for (const [color, paths] of byColor) {
    const closed = paths.filter((p) => p.closed).map((p) => ({ p, area: Math.abs(signedArea(p.pts)), box: bbox([p]) }));
    const depth = (a) => closed.filter((b) => b !== a && b.area > a.area && pointInPoly(a.p.pts[0], b.p.pts)).length;
    const outers = closed.filter((c) => depth(c) % 2 === 0).map((c) => ({ ...c, holes: [] }));
    for (const c of closed) {
      if (depth(c) % 2 === 0) continue;
      const host = outers.filter((u) => u.area > c.area && pointInPoly(c.p.pts[0], u.p.pts)).sort((a, b) => a.area - b.area)[0];
      if (host) host.holes.push(c.p); else outers.push({ ...c, holes: [] });
    }
    for (const u of outers) pieces.push({ color, paths: [u.p, ...u.holes] });
    for (const p of paths.filter((p) => !p.closed)) pieces.push({ color, paths: [p] });
  }
  if (pieces.length < 2) { toast('This is already a single piece.'); return; }
  const idx = doc.objects.indexOf(o);
  const made = pieces.map((pc, i) => {
    const n = { id: newId(), kind: 'shape', name: `${o.name} ${i + 1}`, x: o.x, y: o.y, sx: o.sx, sy: o.sy, rot: o.rot, color: pc.color || o.color, cx: 0, cy: 0, paths: [] };
    setSource(n, pc.paths);
    return n;
  });
  doc.objects.splice(idx, 1, ...made);
  doc.select(made.map((m) => m.id));
  doc.commit('Ungroup');
}

function align(how) {
  const sel = doc.selected();
  if (sel.length < 2) return;
  const g = groupBox(sel);
  for (const o of sel) {
    const b = worldBox(o);
    if (how === 'left') o.x += g.x - b.x;
    if (how === 'top') o.y += g.y - b.y;
    if (how === 'hcenter') o.x += g.x + g.w / 2 - (b.x + b.w / 2);
    if (how === 'vcenter') o.y += g.y + g.h / 2 - (b.y + b.h / 2);
  }
  doc.commit('Align');
}

function nudge(dx, dy) {
  const sel = doc.selected();
  if (!sel.length) return;
  for (const o of sel) { o.x += dx; o.y += dy; }
  doc.commit('Nudge');
}

// ---------- color layers ----------
const COLOR_NAMES = {
  '#000000': 'Black', '#ffffff': 'White', '#ff0000': 'Red', '#00ff00': 'Green', '#008000': 'Green', '#0000ff': 'Blue',
  '#ffff00': 'Yellow', '#ffa500': 'Orange', '#800080': 'Purple', '#ff00ff': 'Magenta', '#00ffff': 'Cyan',
  '#808080': 'Gray', '#c0c0c0': 'Silver', '#ffd700': 'Gold', '#a52a2a': 'Brown', '#ffc0cb': 'Pink',
};
const colorKey = (c) => (c || '#000000').toLowerCase();
function layerName(c) { const k = colorKey(c); return doc.layers[k]?.name || COLOR_NAMES[k] || k; }
function layerColors(objs = doc.objects) { return [...new Set(objs.map((o) => colorKey(o.color)))]; }

function renderColorLayers() {
  const ul = $('clayers');
  ul.textContent = '';
  const colors = layerColors();
  $('p-colors').hidden = !colors.length;
  for (const c of colors) {
    const objs = doc.objects.filter((o) => colorKey(o.color) === c);
    const li = document.createElement('li');
    if (objs.every((o) => doc.selection.has(o.id))) li.classList.add('sel');
    const sw = document.createElement('input'); sw.type = 'color'; sw.value = c; sw.title = 'Change this layer’s color';
    sw.onchange = () => recolorLayer(c, sw.value);
    const nm = document.createElement('input'); nm.type = 'text'; nm.value = doc.layers[c]?.name || ''; nm.placeholder = COLOR_NAMES[c] || c;
    nm.title = 'Layer name (shown in the Cut window)';
    nm.onchange = () => {
      const v = nm.value.trim();
      if (v) doc.layers[c] = { ...(doc.layers[c] || {}), name: v }; else delete doc.layers[c];
      doc.commit('Rename layer');
    };
    const ct = document.createElement('span'); ct.className = 'ct'; ct.textContent = objs.length;
    li.append(sw, nm, ct);
    li.onclick = (e) => { if (e.target === li || e.target === ct) doc.select(objs.map((o) => o.id), e.shiftKey || e.ctrlKey); };
    ul.append(li);
  }
}

function recolorLayer(from, to) {
  from = colorKey(from); to = colorKey(to);
  if (from === to) return;
  for (const o of doc.objects) if (colorKey(o.color) === from) o.color = to;
  if (doc.layers[from]) { doc.layers[to] ||= doc.layers[from]; delete doc.layers[from]; }
  doc.commit('Recolor layer');
}

function setSelectionColor(c) {
  const sel = doc.selected();
  if (!sel.length) return;
  for (const o of sel) o.color = colorKey(c);
  doc.commit('Color');
}

// ---------- weld / unweld ----------
const canWeld = (sel = doc.selected()) => sel.some((o) => o.paths.some((p) => p.closed));
const canUnweld = (sel = doc.selected()) => sel.some((o) => o.weld?.sources?.length || (o.kind === 'text' && o.text.weld !== false));

/** Sets an object's placement from a matrix. Skewed results are baked into plain shapes. */
function setMatrix(o, m) {
  const sx = Math.hypot(m[0], m[1]), sy2 = Math.hypot(m[2], m[3]);
  const det = m[0] * m[3] - m[1] * m[2];
  const skew = Math.abs(m[0] * m[2] + m[1] * m[3]) / ((sx * sy2) || 1);
  if (skew > 1e-6 || !sx) {
    const wp = transformPaths(o.paths, m);
    Object.assign(o, { kind: 'shape', sx: 1, sy: 1, rot: 0, cx: null });
    delete o.text; delete o.trace;
    setSource(o, wp); o.x = o.cx; o.y = o.cy;
    return;
  }
  o.x = m[4]; o.y = m[5];
  o.rot = round((((Math.atan2(m[1], m[0]) * 180) / Math.PI) % 360 + 360) % 360, 6);
  o.sx = sx; o.sy = det / sx;
}

/** Joins the selected objects' closed shapes into one outline. Open lines come along unchanged. */
function weldSelection() {
  const sel = doc.selected();
  if (!sel.length) return;
  if (!canWeld(sel)) { toast('Weld needs closed shapes. Open lines can’t be welded.'); return; }
  const groups = sel.map((o) => worldPaths(o).filter((p) => p.closed)).filter((g) => g.length);
  const joined = weldPaths(groups);
  const open = sel.flatMap((o) => worldPaths(o).filter((p) => !p.closed));
  const before = sel.reduce((n, o) => n + o.paths.filter((p) => p.closed).length, 0);
  const w = { id: newId(), kind: 'shape', name: sel.length === 1 ? `${sel[0].name} (welded)` : 'Weld', x: 0, y: 0, sx: 1, sy: 1, rot: 0, color: colorKey(sel[0].color) };
  setSource(w, [...joined, ...open].map((p) => ({ pts: p.pts, closed: p.closed })));
  w.x = w.cx; w.y = w.cy;
  w.weld = { x0: w.x, y0: w.y, sources: sel.map((o) => structuredClone(o)) };
  const ids = new Set(sel.map((o) => o.id));
  for (const o of doc.objects) if (o.kind === 'offset' && o.offset?.linked) {
    // Borders around the pieces now follow the weld.
    if (o.offset.src.some((id) => ids.has(id))) o.offset.src = [...new Set(o.offset.src.map((id) => (ids.has(id) ? w.id : id)))];
  }
  const idx = Math.min(...sel.map((o) => doc.objects.indexOf(o)));
  doc.remove([...ids]);
  doc.objects.splice(idx, 0, w);
  doc.select([w.id]);
  doc.commit('Weld');
  const colors = layerColors(sel);
  toast(joined.length < before || sel.length > 1
    ? `Welded into one piece${colors.length > 1 ? ` (all ${layerName(w.color)}; the other colors joined it)` : ''}. Right-click → Unweld splits it again.`
    : 'Nothing overlapped, so the outline is unchanged. It is now one object.');
}

/** Splits welds back into their pieces, and turns letter welding off for text. */
const unweldSelection = run(async () => {
  const sel = doc.selected();
  if (!canUnweld(sel)) { toast('Nothing to unweld here.'); return; }
  const made = [], keep = [];
  for (const o of sel) {
    if (o.weld?.sources?.length) {
      const delta = mul(objMatrix(o), invert(translate(o.weld.x0, o.weld.y0)));
      const parts = o.weld.sources.map((src) => {
        const p = structuredClone(src);
        if (doc.get(p.id) || made.some((m) => m.id === p.id)) p.id = newId();
        setMatrix(p, mul(delta, objMatrix(src)));
        return p;
      });
      for (const b of doc.objects) if (b.kind === 'offset' && b.offset?.linked && b.offset.src.includes(o.id)) {
        b.offset.src = [...new Set(b.offset.src.flatMap((id) => (id === o.id ? parts.map((p) => p.id) : [id])))];
      }
      doc.objects.splice(doc.objects.indexOf(o), 1, ...parts);
      doc.selection.delete(o.id);
      made.push(...parts);
    } else if (o.kind === 'text' && o.text.weld !== false) {
      o.text.weld = false;
      await buildText(o);
      keep.push(o);
    }
  }
  doc.select([...made, ...keep].map((x) => x.id));
  doc.commit('Unweld');
  if (keep.length && !made.length) toast('Letters unwelded: each letter cuts on its own. Tick Weld letters to join them again.');
});

// ---------- offset (contour) ----------
let offsetDefaults = { dist: 0.125, dir: 'out', join: 'round', ...lsGet('fc.offset', {}) };
const OFFSET_COLORS = ['#ffffff', '#ffd700', '#58a4b0', '#e07a5f', '#8ab4f8', '#6bcb77'];

function hashObjs(objs) {
  let h = 2166136261;
  const mix = (v) => { h = Math.imul(h ^ Math.round(v * 1e4), 16777619); };
  for (const o of objs) {
    for (const v of [o.x, o.y, o.sx, o.sy, o.rot || 0]) mix(v);
    for (const p of o.paths) { mix(p.pts.length); mix(p.closed ? 1 : 0); for (const [x, y] of p.pts) { mix(x); mix(y); } }
  }
  return (h >>> 0).toString(36);
}
const offsetKey = (o, srcs) => `${hashObjs(srcs)}|${o.offset.dist}|${o.offset.dir}|${o.offset.join}`;
const placeKey = (o) => [o.x, o.y, o.sx, o.sy, o.rot || 0].map((v) => round(v, 4)).join(',');

/** Rebuilds an offset object's outline from its originals, in world space. */
function applyOffset(o, srcs) {
  const of = o.offset;
  const res = offsetPaths(srcs.flatMap((s) => worldPaths(s)), of.dir === 'in' ? -of.dist : of.dist, of.join);
  Object.assign(o, { sx: 1, sy: 1, rot: 0, cx: null });
  setSource(o, res.length ? res : [{ pts: [[0, 0], [0.001, 0]], closed: false }]);
  o.x = o.cx; o.y = o.cy;
  o.empty = !res.length;
  of.hash = offsetKey(o, srcs);
  of.place = placeKey(o);
}

function unlinkOffset(o, why) {
  o.kind = 'shape';
  delete o.offset; delete o.empty;
  if (why) toast(why);
}

/** Keeps linked offsets matched to their originals. Runs before every undo step. */
function syncOffsets() {
  for (const o of [...doc.objects]) {
    if (o.kind !== 'offset' || !o.offset?.linked) continue;
    const srcs = o.offset.src.map((id) => doc.get(id)).filter(Boolean);
    if (!srcs.length) { unlinkOffset(o, `"${o.name}" lost its original, so it is a plain shape now.`); continue; }
    o.offset.src = srcs.map((x) => x.id);
    if (offsetKey(o, srcs) !== o.offset.hash) applyOffset(o, srcs);
    else if (placeKey(o) !== o.offset.place) unlinkOffset(o, 'The border was moved on its own, so it is unlinked from the original. Undo (Ctrl+Z) links it again.');
  }
}
doc.beforeCommit = syncOffsets;

/** Linked offsets that should move along with these objects while dragging. */
function followersOf(objs) {
  const ids = new Set(objs.map((o) => o.id));
  return doc.objects.filter((o) => o.kind === 'offset' && o.offset?.linked && !ids.has(o.id) && o.offset.src.some((id) => ids.has(id)));
}

function addOffset() {
  const sel = doc.selected().filter((o) => o.paths.length);
  if (!sel.length) return;
  const used = new Set(layerColors(sel));
  const color = OFFSET_COLORS.find((c) => !used.has(c)) || '#ffffff';
  const of = { dist: offsetDefaults.dist, dir: offsetDefaults.dir, join: offsetDefaults.join, src: sel.map((o) => o.id), linked: true };
  const o = { id: newId(), kind: 'offset', name: `Offset of ${sel.length === 1 ? sel[0].name : sel.length + ' objects'}`, x: 0, y: 0, sx: 1, sy: 1, rot: 0, color, offset: of };
  applyOffset(o, sel);
  if (o.empty) { toast('That inside offset is bigger than the shape. Try a smaller distance.'); return; }
  const idx = Math.min(...sel.map((x) => doc.objects.indexOf(x)));
  doc.objects.splice(of.dir === 'in' ? idx + sel.length : idx, 0, o);
  doc.select([o.id]);
  doc.commit('Offset');
  toast(`Offset added in ${layerName(color)}, behind the original. Change the distance and corners in the side panel.`);
}

function updateOffset(change) {
  const o = single('offset');
  if (!o?.offset) return;
  Object.assign(o.offset, change);
  offsetDefaults = { dist: o.offset.dist, dir: o.offset.dir, join: o.offset.join };
  lsSet('fc.offset', offsetDefaults);
  doc.commit('Offset settings');
  if (o.empty) toast('That inside offset is bigger than the shape, so nothing is left. Try a smaller distance.');
}

// ---------- step and repeat ----------
function repeatPlan() {
  const sel = doc.selected();
  if (!sel.length) return null;
  const b = groupBox(sel);
  const gap = Math.max(0, (+$('r-gap').value || 0) / k());
  let rows = Math.max(1, Math.round(+$('r-rows').value || 1));
  const cols = Math.max(1, Math.round(+$('r-cols').value || 1));
  const top = $('r-fill').checked ? settings.margin : b.y;
  if ($('r-fill').checked) rows = Math.max(1, Math.floor((settings.cutWidth - settings.margin - top + gap + 1e-9) / (b.h + gap)));
  return { sel, b, gap, rows, cols, top, w: cols * b.w + (cols - 1) * gap, h: rows * b.h + (rows - 1) * gap };
}
function refreshRepeat() {
  const p = repeatPlan();
  if (!p) return;
  $('r-rows').disabled = $('r-fill').checked;
  if ($('r-fill').checked) $('r-rows').value = p.rows;
  const f = $('r-facts'); f.textContent = '';
  const rows = [['Copies', `${p.rows * p.cols} (${p.rows} × ${p.cols})`], ['Grid size', `${fmtU(p.w)} × ${fmtU(p.h)}`], ['Vinyl length', fmtU(p.b.x + p.w + settings.margin)]];
  if (p.top + p.h > settings.cutWidth + 0.001) rows.push(['Warning', 'Wider than the cutting width']);
  for (const [a, v] of rows) { const dt = document.createElement('dt'); dt.textContent = a; const dd = document.createElement('dd'); dd.textContent = v; f.append(dt, dd); }
  $('r-ok').disabled = p.rows * p.cols < 2;
}
function openRepeat() {
  if (!doc.selection.size) { toast('Select what to repeat first.'); return; }
  if (!$('r-gap').value) $('r-gap').value = fmt(0.25);
  refreshRepeat();
  $('dlg-repeat').showModal();
}
function doRepeat() {
  const p = repeatPlan();
  if (!p) return;
  const { sel, b, gap, rows, cols, top } = p;
  const dy0 = top - b.y;
  for (const o of sel) o.y += dy0;
  const made = [...sel];
  for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
    if (!r && !c) continue;
    const copies = cloneObjects(sel, c * (b.w + gap), r * (b.h + gap));
    for (const x of copies) doc.add(x, { select: false });
    made.push(...copies);
  }
  if ($('r-weed').checked && gap >= 0.05) {
    const x0 = b.x - gap / 2, x1 = b.x + p.w + gap / 2, y0 = top - gap / 2, y1 = top + p.h + gap / 2, lines = [];
    for (let c = 1; c < cols; c++) { const x = b.x + c * (b.w + gap) - gap / 2; lines.push({ pts: [[x, y0], [x, y1]], closed: false }); }
    for (let r = 1; r < rows; r++) { const y = top + r * (b.h + gap) - gap / 2; lines.push({ pts: [[x0, y], [x1, y]], closed: false }); }
    if (lines.length) {
      const wl = { id: newId(), kind: 'shape', name: 'Weed lines', x: 0, y: 0, sx: 1, sy: 1, rot: 0, color: colorKey(sel[0].color) };
      setSource(wl, lines); wl.x = wl.cx; wl.y = wl.cy;
      doc.add(wl, { select: false }); made.push(wl);
    }
  } else if ($('r-weed').checked) toast('The gap is too small for weed lines between copies (needs at least 0.05").');
  doc.select(made.map((o) => o.id));
  doc.commit('Step and repeat');
  loadTraceImages();
  toast(`${rows * cols} copies, ${fmtU(p.w)} × ${fmtU(p.h)}, using about ${fmtU(b.x + p.w + settings.margin)} of vinyl.`);
}


// ---------- node editing ----------
const plainShape = (o) => o.kind === 'shape' && !o.weld;
let simplifyBase = null; // paths before the Simplify slider moved

/** Starts node editing on an object (double-click, menu, or the Edit nodes button). */
function enterNodes(o) {
  if (!o || !o.paths.length) return;
  closeMenu();
  doc.select([o.id]);
  view.nodeEdit = { id: o.id, sel: new Set(), fit: [], ready: false, hover: null };
  syncNodeEdit();
  simplifyBase = null; $('n-simp').value = 0;
  const what = o.kind === 'text' ? 'text (it becomes shapes)' : o.kind === 'trace' ? 'traced image (its trace settings go away)' : o.weld ? 'weld (Unweld stops working)' : o.kind === 'offset' && o.offset?.linked ? 'border (it unlinks from the original)' : '';
  toast(what ? `Editing nodes. Your first change converts this ${what}; Undo brings it back.` : 'Editing nodes. Drag nodes and handles; double-click a line to add a node. Esc or Done when finished.', { ms: 5000 });
  refreshPanels(); view.redraw();
}
function exitNodes() {
  if (!view.nodeEdit) return;
  view.nodeEdit = null; simplifyBase = null;
  refreshPanels(); view.redraw();
}
/** Keeps node mode matched to the document (after undo, redo, or other changes). */
function syncNodeEdit() {
  const ne = view.nodeEdit;
  if (!ne) return;
  const o = doc.get(ne.id);
  if (!o || !o.paths.length) { exitNodes(); return; }
  ne.ready = plainShape(o) && o.paths.every((p) => p.nodes);
  if (!ne.ready) ne.fit = o.paths.map((p, i) => (p.nodes ? null : (ne.fit?.[i]?.src === p.pts ? ne.fit[i] : Object.assign(fitNodes(p.pts, p.closed), { src: p.pts }))));
  const lists = view.nodePaths(o);
  for (const key of [...ne.sel]) { const [pi, ni] = key.split(':').map(Number); if (!lists[pi]?.[ni]) ne.sel.delete(key); }
  if (!doc.selection.has(o.id) || doc.selection.size !== 1) doc.selection = new Set([o.id]);
}
/** Makes the object editable before its first node change: converts text, traces, welds, and borders. */
function nodeBegin() {
  const ne = view.nodeEdit, o = ne && doc.get(ne.id);
  if (!o) return false;
  if (ne.ready) return true;
  const said = [];
  if (o.kind === 'text') { o.kind = 'shape'; delete o.text; said.push('The text is shapes now.'); }
  if (o.kind === 'trace') { o.kind = 'shape'; delete o.trace; view.images.delete(o.id); said.push('The trace settings are gone.'); }
  if (o.weld) { delete o.weld; said.push('The weld is baked in (Unweld no longer applies).'); }
  if (o.kind === 'offset') { o.kind = 'shape'; delete o.offset; delete o.empty; said.push('The border is unlinked from its original.'); }
  o.paths.forEach((p, i) => { if (!p.nodes) { p.nodes = (ne.fit[i] || fitNodes(p.pts, p.closed)).map((n) => ({ p: n.p, i: n.i, o: n.o, t: n.t })); } });
  ne.fit = []; ne.ready = true;
  if (said.length) toast(`${said.join(' ')} Undo (Ctrl+Z) brings it back.`, { ms: 6000 });
  return true;
}
/** Keeps the object's local geometry centered after node edits, then records the undo step. */
function nodeCommit(label) {
  const o = view.nodeEdit && doc.get(view.nodeEdit.id);
  if (o) { o.cx = 0; o.cy = 0; setSource(o, o.paths); }
  doc.commit(label);
}
const nodeSel = () => [...(view.nodeEdit?.sel || [])].map((k) => k.split(':').map(Number));
const endOf = (o, pi, ni) => { const p = o.paths[pi]; if (!p || p.closed) return null; return ni === 0 ? 'start' : ni === p.nodes.length - 1 ? 'end' : null; };

/** Node commands. `hit` is what was under the pointer (for insert, toggle, and segment changes). */
function nodeOp(op, hit) {
  const ne = view.nodeEdit, o = ne && doc.get(ne.id);
  if (!o) return;
  if (op === 'selectall') { ne.sel = new Set(view.nodePaths(o).flatMap((ns, pi) => ns.map((_, ni) => pi + ':' + ni))); refreshPanels(); view.redraw(); return; }
  if (op === 'exit') { exitNodes(); return; }
  if (!nodeBegin()) return;
  const sel = nodeSel();
  const touched = new Set();
  let label = 'Edit nodes';
  if (op === 'insert' && hit) {
    const p = o.paths[hit.pi], ni = insertNode(p.nodes, p.closed, hit.k, hit.t);
    touched.add(hit.pi); ne.sel = new Set([hit.pi + ':' + ni]); label = 'Add node';
  } else if (op === 'toggle' && hit) {
    const p = o.paths[hit.pi], n = p.nodes[hit.ni];
    setType(p.nodes, hit.ni, n.t === 'c' ? 's' : 'c', p.closed); touched.add(hit.pi); label = n.t === 'c' ? 'Corner node' : 'Smooth node';
  } else if (op === 'corner' || op === 'smooth' || op === 'symmetric') {
    if (!sel.length) { toast('Pick a node first.'); return; }
    for (const [pi, ni] of sel) { const p = o.paths[pi]; setType(p.nodes, ni, { corner: 'c', smooth: 's', symmetric: 'y' }[op], p.closed); touched.add(pi); }
    label = { corner: 'Corner node', smooth: 'Smooth node', symmetric: 'Symmetric node' }[op];
  } else if (op === 'delete') {
    if (!sel.length) { toast('Pick the nodes to delete first.'); return; }
    const byPath = new Map();
    for (const [pi, ni] of sel) { if (!byPath.has(pi)) byPath.set(pi, []); byPath.get(pi).push(ni); }
    const drop = [];
    for (const [pi, list] of byPath) {
      const p = o.paths[pi];
      for (const ni of list.sort((a, b) => b - a)) p.nodes.splice(ni, 1);
      if (p.nodes.length < (p.closed ? 3 : 2) && !(p.closed && p.nodes.length === 2 && p.nodes.some((n) => n.i || n.o))) drop.push(pi);
      else touched.add(pi);
    }
    o.paths = o.paths.filter((_, i) => !drop.includes(i));
    ne.sel = new Set();
    label = sel.length > 1 ? `Delete ${sel.length} nodes` : 'Delete node';
    if (!o.paths.length) { doc.remove([o.id]); exitNodes(); doc.commit('Delete shape'); return; }
    for (const pi of [...touched]) { touched.delete(pi); const ni = pi - drop.filter((d) => d < pi).length; touched.add(ni); }
  } else if (op === 'break') {
    if (sel.length !== 1) { toast('Pick one node to break the path at.'); return; }
    const [pi, ni] = sel[0], p = o.paths[pi];
    if (!p.closed && (ni === 0 || ni === p.nodes.length - 1)) { toast('That is already an end of the path.'); return; }
    const parts = breakAt(p, ni).map((q) => refresh({ ...p, nodes: q.nodes, closed: q.closed }));
    o.paths.splice(pi, 1, ...parts);
    ne.sel = new Set([pi + ':0']); label = 'Break path';
  } else if (op === 'join') {
    const ends = sel.map(([pi, ni]) => ({ pi, ni, end: endOf(o, pi, ni) })).filter((x) => x.end);
    if (sel.length !== 2 || ends.length !== 2) { toast('Pick two open ends to join (the nodes with a ring around them).'); return; }
    const [a, b] = ends;
    const joined = joinEnds({ path: o.paths[a.pi], end: a.end }, { path: o.paths[b.pi], end: b.end });
    const base = o.paths[a.pi];
    const np = refresh({ ...base, nodes: joined.nodes, closed: joined.closed });
    if (a.pi === b.pi) o.paths.splice(a.pi, 1, np);
    else { o.paths = o.paths.filter((_, i) => i !== a.pi && i !== b.pi); o.paths.push(np); }
    ne.sel = new Set(); label = a.pi === b.pi ? 'Close path' : 'Join paths';
  } else if (op === 'close') {
    const pis = [...new Set(sel.map(([pi]) => pi))].filter((pi) => !o.paths[pi].closed);
    if (!pis.length) { toast('Pick a node on an open path first.'); return; }
    for (const pi of pis) { const p = o.paths[pi]; const j = joinEnds({ path: p, end: 'start' }, { path: p, end: 'end' }); p.nodes = j.nodes; p.closed = true; touched.add(pi); }
    ne.sel = new Set(); label = 'Close path';
  } else if (op === 'line' || op === 'curve') {
    const segs = [];
    if (hit?.kind === 'seg') segs.push([hit.pi, hit.k]);
    else {
      const set = new Set(sel.map(([pi, ni]) => pi + ':' + ni));
      for (const [pi, ni] of sel) {
        const p = o.paths[pi], L = p.nodes.length, nx = (ni + 1) % L;
        if ((ni < L - 1 || p.closed) && set.has(pi + ':' + nx)) segs.push([pi, ni]);
      }
    }
    if (!segs.length) { toast('Right-click a line between nodes, or pick two nodes next to each other.'); return; }
    for (const [pi, k] of segs) { const p = o.paths[pi]; setSegment(p.nodes, p.closed, k, op === 'curve'); touched.add(pi); }
    label = op === 'curve' ? 'Make curve' : 'Make line';
  } else return;
  for (const pi of touched) if (o.paths[pi]) refresh(o.paths[pi]);
  for (const p of o.paths) for (const n of p.nodes || []) if (n.t !== 'y' && n.t !== 's') n.t = classify(n) === 'c' ? 'c' : n.t;
  simplifyBase = null; $('n-simp').value = 0;
  nodeCommit(label);
}

/** Simplify slider: re-fits every path with a looser tolerance (always from the shape before the slider moved). */
function simplifyNodes(level, final) {
  const ne = view.nodeEdit, o = ne && doc.get(ne.id);
  if (!o || !nodeBegin()) return;
  if (!simplifyBase) simplifyBase = o.paths.map((p) => ({ pts: p.pts, closed: p.closed, nodes: p.nodes }));
  const err = 0.003 + (level / 100) ** 2 * 0.03;
  o.paths.forEach((p, i) => {
    const b = simplifyBase[i];
    if (!b) return;
    if (level <= 0) { p.nodes = b.nodes; p.pts = b.pts; return; }
    p.nodes = fitNodes(b.pts, b.closed, err);
    refresh(p);
  });
  ne.sel = new Set();
  refreshPanels(true); view.redraw();
  if (final) { nodeCommit('Simplify'); simplifyBase = null; $('n-simp').value = 0; }
}

function nudgeNodes(dx, dy) {
  const ne = view.nodeEdit, o = ne && doc.get(ne.id);
  if (!o || !ne.sel.size || !nodeBegin()) return;
  const Mi = invert(objMatrix(o)), lx = Mi[0] * dx + Mi[2] * dy, ly = Mi[1] * dx + Mi[3] * dy;
  const mv = (p) => (p ? [p[0] + lx, p[1] + ly] : null);
  const touched = new Set();
  for (const [pi, ni] of nodeSel()) { const n = o.paths[pi]?.nodes?.[ni]; if (!n) continue; n.p = mv(n.p); n.i = mv(n.i); n.o = mv(n.o); touched.add(pi); }
  for (const pi of touched) refresh(o.paths[pi]);
  nodeCommit('Nudge nodes');
}

function nodeMenuItems(sp) {
  const ne = view.nodeEdit, o = doc.get(ne.id);
  const h = view.hitNodes(sp, false);
  if (h?.kind === 'node' && !ne.sel.has(h.pi + ':' + h.ni)) ne.sel = new Set([h.pi + ':' + h.ni]);
  const sel = nodeSel(), n = sel.length;
  const ends = o ? sel.filter(([pi, ni]) => endOf(o, pi, ni)).length : 0;
  const openSel = o ? sel.some(([pi]) => !o.paths[pi]?.closed) : false;
  return [
    ...(h?.kind === 'seg' ? [{ label: 'Add node here', kb: 'Double-click', on: () => nodeOp('insert', h) }] : []),
    { label: n > 1 ? `Delete ${n} nodes` : 'Delete node', kb: 'Del', on: () => nodeOp('delete'), off: !n, cls: 'danger' },
    '-',
    { label: 'Corner', on: () => nodeOp('corner'), off: !n },
    { label: 'Smooth', on: () => nodeOp('smooth'), off: !n },
    { label: 'Symmetric', on: () => nodeOp('symmetric'), off: !n },
    '-',
    { label: 'Break path here', on: () => nodeOp('break'), off: n !== 1 },
    { label: 'Join ends', on: () => nodeOp('join'), off: !(n === 2 && ends === 2) },
    { label: 'Close path', on: () => nodeOp('close'), off: !openSel },
    { label: 'Make line', on: () => nodeOp('line', h), off: !(h?.kind === 'seg' || n >= 2) },
    { label: 'Make curve', on: () => nodeOp('curve', h), off: !(h?.kind === 'seg' || n >= 2) },
    '-',
    { label: 'Select all nodes', kb: 'Ctrl+A', on: () => nodeOp('selectall') },
    { label: 'Done editing nodes', kb: 'Esc', on: exitNodes },
  ];
}

// ---------- combine ----------
/** Joins the selected objects into one object without welding (paths and curves stay as they are). */
function combineSelection() {
  const sel = doc.selected();
  if (sel.length < 2) { toast('Select two or more objects to combine.'); return; }
  const c = { id: newId(), kind: 'shape', name: 'Combined', x: 0, y: 0, sx: 1, sy: 1, rot: 0, color: colorKey(sel[0].color) };
  setSource(c, sel.flatMap((o) => worldPaths(o, true).map((p) => ({ ...p, color: undefined }))));
  c.x = c.cx; c.y = c.cy;
  const ids = new Set(sel.map((o) => o.id));
  for (const o of doc.objects) if (o.kind === 'offset' && o.offset?.linked && o.offset.src.some((id) => ids.has(id))) o.offset.src = [...new Set(o.offset.src.map((id) => (ids.has(id) ? c.id : id)))];
  const idx = Math.min(...sel.map((o) => doc.objects.indexOf(o)));
  doc.remove([...ids]);
  doc.objects.splice(idx, 0, c);
  doc.select([c.id]);
  doc.commit('Combine');
  toast(`Combined ${sel.length} objects into one${layerColors(sel).length > 1 ? `, all ${layerName(c.color)}` : ''}. Ungroup splits it again.`);
}


// ---------- nesting ----------
// Units: objects that move together (overlapping pieces, and borders with their originals).
let nest = null; // { units, fixed, skipped, x0, before, result: { place: [{ unit, deg, tx, ty }], unplaced }, worker }
let nestOpts = { method: 'fast', spacing: 0.125, rot: '90', holes: false, ...lsGet('fc.nest', {}) };

function nestUnits(objs) {
  const ids = new Set(objs.map((o) => o.id));
  for (const f of followersOf(objs)) { if (!ids.has(f.id)) { objs.push(f); ids.add(f.id); } }
  const movable = objs.filter((o) => o.paths.some((p) => p.closed));
  const skipped = objs.filter((o) => !o.paths.some((p) => p.closed));
  const parent = movable.map((_, i) => i);
  const find = (i) => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const join = (a, b) => { parent[find(a)] = find(b); };
  const idx = new Map(movable.map((o, i) => [o.id, i]));
  const geo = movable.map((o) => { const wp = worldPaths(o).filter((p) => p.closed); return { wp, box: bbox(wp) }; });
  movable.forEach((o, i) => { if (o.kind === 'offset' && o.offset?.linked) for (const s of o.offset.src) if (idx.has(s)) join(i, idx.get(s)); });
  for (let i = 0; i < movable.length; i++) for (let j = i + 1; j < movable.length; j++) {
    const a = geo[i].box, b = geo[j].box;
    if (!a || !b || a.x > b.x1 || b.x > a.x1 || a.y > b.y1 || b.y > a.y1 || find(i) === find(j)) continue;
    if (clipArea(clipIntersect(geo[i].wp, geo[j].wp)) > 1e-5) join(i, j);
  }
  const groups = new Map();
  movable.forEach((o, i) => { const r = find(i); if (!groups.has(r)) groups.set(r, []); groups.get(r).push(i); });
  const units = [...groups.values()].map((list, k) => {
    const wp = list.flatMap((i) => geo[i].wp);
    const reg = region(clipUnion(wp));
    return { id: k, objs: list.map((i) => movable[i]), paths: reg.map((p) => p.pts), outline: reg, box: bbox(reg) };
  });
  return { units, skipped };
}

function nestRotations() {
  const p = presets.find((x) => x.id === settings.presetId);
  if (p?.noRotate) return { list: [0], locked: p.name };
  const step = +nestOpts.rot;
  if (!step) return { list: [0] };
  const list = [];
  for (let a = 0; a < 360; a += step) list.push(a);
  return { list };
}

function openNest() {
  if (!doc.objects.length) { toast('Import a design or add text first.'); return; }
  const objs = doc.selection.size ? doc.selected() : doc.objects.slice();
  const { units, skipped } = nestUnits(objs);
  if (units.length < 2) { toast(units.length ? 'Nesting needs two or more separate pieces. (Pieces that overlap count as one.)' : 'Nothing to nest: it needs closed shapes.'); return; }
  const moving = new Set(units.flatMap((u) => u.objs.map((o) => o.id)));
  const fixed = doc.objects.filter((o) => !moving.has(o.id) && o.paths.some((p) => p.closed)).map((o, i) => ({ id: i, paths: region(worldPaths(o).filter((p) => p.closed)).map((p) => p.pts), box: worldBox(o) }));
  const all = units.reduce((b, u) => unionBoxSafe(b, u.box), null);
  nest = { units, fixed, skipped, x0: Math.max(0, all.x), before: all.x1 - Math.max(0, all.x), result: null, worker: null };
  $('ns-method').value = nestOpts.method; $('ns-space').value = fmt(nestOpts.spacing); $('ns-rot').value = nestOpts.rot; $('ns-holes').checked = !!nestOpts.holes;
  const rots = nestRotations();
  $('ns-rot').disabled = !!rots.locked;
  $('ns-what').textContent = `${units.length} pieces to nest${doc.selection.size ? ' (the selection)' : ' (everything)'}${fixed.length ? `, around ${fixed.length} object${fixed.length > 1 ? 's' : ''} that stay put` : ''}.`;
  const notes = [];
  if (rots.locked) notes.push(`Rotation is off: "${rots.locked}" is marked No rotation in Materials.`);
  if (skipped.length) notes.push(`${skipped.length} object${skipped.length > 1 ? 's' : ''} of open lines (such as weed lines) stay where they are; delete or redo them after nesting.`);
  $('ns-note').textContent = notes.join(' ');
  $('dlg-nest').showModal();
  runNest();
}
const unionBoxSafe = (a, b) => (!a ? b : !b ? a : { x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), w: Math.max(a.x1, b.x1) - Math.min(a.x, b.x), h: Math.max(a.y1, b.y1) - Math.min(a.y, b.y) });

function readNestOpts() {
  const sp = parseFloat($('ns-space').value) / k();
  nestOpts = { method: $('ns-method').value, spacing: Number.isFinite(sp) && sp >= 0 ? round(sp, 4) : 0.125, rot: $('ns-rot').value, holes: $('ns-holes').checked };
  lsSet('fc.nest', nestOpts);
}
const nestStrip = () => {
  const m = settings.margin, s = nestOpts.spacing;
  return { x0: nest.x0 - s / 2, y0: m - s / 2, y1: settings.cutWidth - m + s / 2 };
};

function stopNestWorker() { if (nest?.worker) { nest.worker.terminate(); nest.worker = null; } }

/** Fast mode packs right away; Best fit starts the worker. */
function runNest() {
  readNestOpts();
  stopNestWorker();
  nest.result = null;
  const fast = nestOpts.method === 'fast';
  $('ns-holes').disabled = fast;
  $('ns-start').hidden = fast;
  if (fast) {
    const s = nestOpts.spacing, rot = nestRotations().list.some((a) => a % 180 === 90);
    const items = nest.units.map((u) => ({ id: u.id, w: u.box.w + s, h: u.box.h + s }));
    const fixedR = nest.fixed.map((f) => ({ x: f.box.x - s / 2, y: f.box.y - s / 2, w: f.box.w + s, h: f.box.h + s }));
    const r = rectPack(items, nestStrip(), { rotate: rot, fixed: fixedR });
    nest.result = {
      place: r.placements.map((p) => {
        const u = nest.units[p.id], deg = p.rot90 ? 90 : 0;
        const rb = rotatedBox(u, deg);
        return { unit: p.id, deg, tx: p.x + s / 2 - rb.x, ty: p.y + s / 2 - rb.y };
      }),
      unplaced: r.unplaced,
    };
    setNestStatus('Packed by bounding boxes. Best fit usually saves more on odd shapes.');
    showNest();
  } else {
    setNestStatus('Press Start to search for the tightest fit.');
    $('ns-start').textContent = 'Start';
    showNest();
  }
}
function rotatedBox(u, deg) {
  const R = rotate(deg);
  return bbox(u.outline.map((p) => ({ pts: p.pts.map((q) => apply(R, q)) })));
}
function startBestFit() {
  if (nest.worker) { // Stop: keep the best so far
    stopNestWorker();
    $('ns-start').textContent = 'Start';
    setNestStatus(nest.result ? `Stopped. Kept the best result (${nest.evals} arrangements tried).` : 'Stopped before a result was found.');
    return;
  }
  readNestOpts();
  const w = new Worker(new URL('./nest-worker.js', import.meta.url), { type: 'module' });
  nest.worker = w; nest.evals = 0;
  $('ns-start').textContent = 'Stop';
  setNestStatus('Searching…');
  w.onmessage = (e) => {
    const m = e.data;
    if (m.type === 'best') {
      nest.result = { place: m.placements.map((p) => ({ unit: p.id, deg: p.deg, tx: (p.x - p.minx) / 10000, ty: (p.y - p.miny) / 10000 })), unplaced: m.unplaced };
      nest.evals = m.evals;
      showNest();
    }
    if (m.type === 'progress') { nest.evals = m.evals; setNestStatus(`Searching… ${m.evals} arrangements tried. Stop keeps the best one.`); }
    if (m.type === 'done') { stopNestWorker(); $('ns-start').textContent = 'Start'; setNestStatus(`Done: ${m.evals} arrangements tried; this is the best.`); }
    if (m.type === 'error') { stopNestWorker(); $('ns-start').textContent = 'Start'; setNestStatus('Nesting failed: ' + m.message); }
  };
  w.onerror = (e) => { stopNestWorker(); $('ns-start').textContent = 'Start'; setNestStatus('Nesting failed: ' + (e.message || 'worker error')); };
  w.postMessage({
    type: 'start', spacing: nestOpts.spacing, rotations: nestRotations().list, holes: nestOpts.holes,
    units: nest.units.map((u) => ({ id: u.id, paths: u.paths })), fixed: nest.fixed.map((f) => ({ id: f.id, paths: f.paths })), strip: nestStrip(),
  });
}
function setNestStatus(t) { $('ns-status').textContent = t; }
const placeMatrix = (p) => { const R = rotate(p.deg); R[4] = p.tx; R[5] = p.ty; return R; };

/** Draws the preview and the vinyl length before and after. */
function showNest() {
  const c = $('ns-preview'), g = c.getContext('2d'), W = c.width, H = c.height;
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--roll'); g.fillRect(0, 0, W, H);
  const res = nest.result;
  const after = res ? res.place.map((p) => ({ p, outline: nest.units[p.unit].outline.map((q) => q.pts.map((pt) => apply(placeMatrix(p), pt))) })) : [];
  let x1 = nest.x0 + 1;
  for (const a of after) for (const q of a.outline) for (const [x] of q) x1 = Math.max(x1, x);
  const len = res ? x1 - nest.x0 : null;
  const span = Math.max(len || 0, nest.before, 1) + nest.x0 + 0.5;
  const z = Math.min((W - 16) / span, (H - 16) / settings.cutWidth), S = ([x, y]) => [8 + x * z, 8 + y * z];
  g.strokeStyle = '#58A4B0'; g.lineWidth = 1.5; g.beginPath(); g.moveTo(8, 8); g.lineTo(W, 8); g.moveTo(8, 8 + settings.cutWidth * z); g.lineTo(W, 8 + settings.cutWidth * z); g.stroke();
  const poly = (pts) => { g.beginPath(); pts.forEach((pt, i) => { const [x, y] = S(pt); i ? g.lineTo(x, y) : g.moveTo(x, y); }); g.closePath(); };
  g.fillStyle = 'rgba(169,188,208,0.25)';
  for (const f of nest.fixed) for (const p of f.paths) { poly(p); g.fill('evenodd'); }
  for (const a of after) {
    const col = nest.units[a.p.unit].objs[0].color;
    g.fillStyle = col && col !== '#000000' ? col + '88' : 'rgba(216,219,226,0.55)';
    g.strokeStyle = '#D8DBE2'; g.lineWidth = 1;
    const p2 = new Path2D();
    for (const q of a.outline) { q.forEach((pt, i) => { const [x, y] = S(pt); i ? p2.lineTo(x, y) : p2.moveTo(x, y); }); p2.closePath(); }
    g.fill(p2, 'evenodd'); g.stroke(p2);
  }
  if (res) { g.strokeStyle = '#E07A5F'; g.setLineDash([4, 3]); g.beginPath(); g.moveTo(...S([x1, 0])); g.lineTo(...S([x1, settings.cutWidth])); g.stroke(); g.setLineDash([]); }
  const f = $('ns-facts'); f.textContent = '';
  const rows = [['Vinyl length now', fmtU(nest.before)]];
  if (res) {
    const saved = nest.before - len;
    rows.push(['After nesting', fmtU(len)], [saved >= 0 ? 'Saves' : 'Uses more', `${fmtU(Math.abs(saved))} (${Math.round((Math.abs(saved) / nest.before) * 100)}%)`]);
    if (res.unplaced.length) rows.push(['Too big for the roll', `${res.unplaced.length} piece${res.unplaced.length > 1 ? 's' : ''} (left where they are)`]);
  }
  for (const [a, b] of rows) { const dt = document.createElement('dt'); dt.textContent = a; const dd = document.createElement('dd'); dd.textContent = b; f.append(dt, dd); }
  nest.after = len;
  $('ns-apply').disabled = !res || !res.place.length;
}

function applyNest() {
  if (!nest?.result) return;
  stopNestWorker();
  for (const p of nest.result.place) {
    const M = placeMatrix(p);
    for (const o of nest.units[p.unit].objs) setMatrix(o, mul(M, objMatrix(o)));
  }
  const saved = nest.before - (nest.after ?? nest.before);
  doc.select(nest.units.flatMap((u) => u.objs.map((o) => o.id)));
  doc.commit('Nest');
  $('dlg-nest').close();
  toast(saved > 0.005 ? `Nested. Saves about ${fmtU(saved)} of vinyl.` : 'Nested. It was already tight, so this saves almost nothing.');
  nest = null;
}

// ---------- right-click / long-press menu ----------
const ctx = $('ctx');
function closeMenu() { ctx.hidden = true; ctx.textContent = ''; }
function openMenu({ sp, client }) {
  if (view.nodeEdit) { showMenu(nodeMenuItems(sp), client); view.redraw(); refreshPanels(); return; }
  const hit = view.hitObject(sp);
  if (hit && !doc.selection.has(hit.id)) doc.select([hit.id]);
  if (!hit && doc.selection.size && !doc.selected().some((o) => { const b = worldBox(o); const [x, y] = view.toWorld(...sp); return b && x >= b.x && x <= b.x1 && y >= b.y && y <= b.y1; })) doc.clearSelection();
  const sel = doc.selected(), one = sel.length === 1 ? sel[0] : null;
  const items = sel.length ? [
    { label: sel.length > 1 ? `Weld ${sel.length} objects` : 'Weld', kb: 'Ctrl+G', on: weldSelection, off: !canWeld(sel) },
    { label: 'Unweld', kb: 'Ctrl+Shift+G', on: unweldSelection, off: !canUnweld(sel) },
    { label: 'Edit nodes', kb: 'Double-click', on: () => enterNodes(one), off: !one },
    { label: sel.length > 1 ? `Combine ${sel.length} objects` : 'Combine', on: combineSelection, off: sel.length < 2 },
    { label: 'Offset (border)', on: addOffset },
    ...(one?.kind === 'offset' && one.offset?.linked ? [{ label: 'Unlink border', on: () => { unlinkOffset(one); doc.commit('Unlink'); } }] : []),
    { label: 'Step and repeat…', on: openRepeat },
    { label: 'Nest…', on: openNest, off: sel.length < 2 },
    '-',
    { label: 'Duplicate', kb: 'Ctrl+D', on: () => duplicate() },
    { label: 'Copy', kb: 'Ctrl+C', on: () => { clipboard = doc.selected().map((o) => structuredClone(o)); toast('Copied.', { ms: 1000 }); } },
    { label: 'Mirror ↔', on: () => flip('h') },
    { label: 'Flip ↕', on: () => flip('v') },
    { label: 'Ungroup', on: ungroup, off: !(one && one.paths.length > 1) },
    { label: 'To front', on: () => $('b-front').click() },
    { label: 'To back', on: () => $('b-back').click() },
    { label: `Select all ${layerName(sel[0].color)}`, on: () => doc.select(doc.objects.filter((o) => colorKey(o.color) === colorKey(sel[0].color)).map((o) => o.id)) },
    '-',
    { label: 'Delete', kb: 'Del', on: deleteSel, cls: 'danger' },
  ] : [
    { label: doc.undoStack.length ? `Undo ${doc.undoStack.at(-1).label}` : 'Undo', kb: 'Ctrl+Z', on: () => $('btn-undo').click(), off: !doc.undoStack.length },
    { label: doc.redoStack.length ? `Redo ${doc.redoStack.at(-1).label}` : 'Redo', kb: 'Ctrl+Shift+Z', on: () => $('btn-redo').click(), off: !doc.redoStack.length },
    '-',
    { label: 'Paste', kb: 'Ctrl+V', on: pasteClipboard, off: !clipboard },
    { label: 'Add text', kb: 'T', on: addText },
    { label: 'Import…', kb: 'Ctrl+I', on: () => $('file-import').click() },
    { label: 'Select all', kb: 'Ctrl+A', on: () => doc.select(doc.objects.map((o) => o.id)), off: !doc.objects.length },
    { label: 'Nest everything…', on: openNest, off: doc.objects.length < 2 },
    '-',
    { label: 'Fit design', kb: 'Shift+1', on: () => view.fitDesign() },
    { label: 'Show the roll', kb: 'Shift+0', on: () => view.fitRoll() },
  ];
  showMenu(items, client);
}
function showMenu(items, client) {
  ctx.textContent = '';
  for (const it of items) {
    if (it === '-') { ctx.append(document.createElement('hr')); continue; }
    const b = document.createElement('button');
    b.setAttribute('role', 'menuitem');
    if (it.cls) b.className = it.cls;
    b.disabled = !!it.off;
    const l = document.createElement('span'); l.textContent = it.label; b.append(l);
    if (it.kb) { const kb = document.createElement('span'); kb.className = 'kb'; kb.textContent = it.kb; b.append(kb); }
    b.onclick = () => { closeMenu(); it.on(); };
    ctx.append(b);
  }
  ctx.hidden = false;
  const r = ctx.getBoundingClientRect();
  ctx.style.left = Math.max(4, Math.min(client[0], innerWidth - r.width - 4)) + 'px';
  ctx.style.top = Math.max(4, Math.min(client[1], innerHeight - r.height - 4)) + 'px';
  ctx.querySelector('button:not(:disabled)')?.focus();
  refreshPanels(); view.redraw();
}
document.addEventListener('pointerdown', (e) => { if (!ctx.hidden && !ctx.contains(e.target)) closeMenu(); }, true);
window.addEventListener('blur', closeMenu);
window.addEventListener('resize', closeMenu);
ctx.addEventListener('keydown', (e) => {
  const bs = [...ctx.querySelectorAll('button:not(:disabled)')], i = bs.indexOf(document.activeElement);
  if (e.key === 'ArrowDown') { e.preventDefault(); bs[(i + 1) % bs.length]?.focus(); }
  if (e.key === 'ArrowUp') { e.preventDefault(); bs[(i - 1 + bs.length) % bs.length]?.focus(); }
  if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); }
});

function pasteClipboard() {
  if (!clipboard) return;
  const copies = cloneObjects(clipboard, 0.25, 0.25);
  clipboard = copies.map((c) => structuredClone(c));
  for (const c of copies) doc.add(c, { select: false });
  doc.select(copies.map((c) => c.id));
  doc.commit('Paste');
  loadTraceImages();
}

// ---------- files ----------
async function openText(text, name = 'design') {
  doc.load(text);
  fileHandle = null;
  view.images.clear();
  await loadTraceImages();
  doc.commit('Open');
  view.fitDesign();
  toast(`Opened ${name}.`);
}

const openFile = run(async () => {
  if ('showOpenFilePicker' in window) {
    const [h] = await window.showOpenFilePicker({ types: [{ description: 'FantastiCut design', accept: { 'application/json': ['.fcut'] } }] });
    const f = await h.getFile();
    await openText(await f.text(), f.name);
    fileHandle = h;
  } else $('file-open').click();
});

const saveFile = run(async (saveAs = false) => {
  const data = doc.serialize();
  if ('showSaveFilePicker' in window) {
    if (!fileHandle || saveAs) {
      fileHandle = await window.showSaveFilePicker({ suggestedName: 'design.fcut', types: [{ description: 'FantastiCut design', accept: { 'application/json': ['.fcut'] } }] });
    }
    const w = await fileHandle.createWritable();
    await w.write(data); await w.close();
    toast(`Saved ${fileHandle.name}.`);
  } else {
    download('design.fcut', data, 'application/json');
  }
});

function download(name, text, type = 'text/plain') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

function newDesign() {
  if (!doc.objects.length) return;
  doc.objects = []; doc.layers = {}; doc.selection.clear(); fileHandle = null;
  doc.commit('New design');
  toast('New design. Undo (Ctrl+Z) brings the old one back.');
}

// ---------- cutter connection ----------
const cutter = new Cutter(log);
function refreshConn() {
  const b = $('btn-conn');
  b.classList.toggle('on', cutter.connected);
  $('conn-label').textContent = cutter.connected ? 'Cutter connected' : 'Connect cutter';
  b.title = cutter.connected ? 'Click to disconnect' : 'Connect the cutter';
  if ($('dlg-cut').open) updateSendLabel();
}
cutter.onchange = refreshConn;

async function connect({ forcePicker = false } = {}) {
  if (!serialSupported()) throw new Error(/Android|iPhone|iPad/i.test(navigator.userAgent)
    ? 'This phone\'s browser can\'t reach the cutter yet: phones don\'t show USB serial adapters to web apps. Design here, then cut from Flip (your design autosaves only in this browser, so use Save to move it), or use Save .plt in the Cut window.'
    : 'This browser cannot talk to cutters. Open FantastiCut in Chrome or Edge on a computer. Until then, "Save .plt" saves the job as a file.');
  if (/Android/i.test(navigator.userAgent) && !lsGet('fc.androidSerialNote', false)) {
    lsSet('fc.androidSerialNote', true);
    toast('Heads-up: most Android phones don\'t list USB serial adapters to web apps yet, so the list may be empty. If it is, cut from Flip or use Save .plt.', { ms: 9000 });
  }
  $('btn-conn').classList.add('busy');
  try {
    await cutter.choose({ forcePicker });
    await cutter.open({ baudRate: Number(settings.baud), flowControl: settings.flow });
    toast('Cutter connected.');
  } finally { $('btn-conn').classList.remove('busy'); }
}
$('btn-conn').onclick = run(async (e) => {
  if (cutter.connected) { await cutter.close(); return; }
  await connect({ forcePicker: e.shiftKey });
});

// ---------- cut dialog ----------
const cutDlg = $('dlg-cut');
let currentPlan = null, stepIdx = 0, stepsDone = new Set(), sending = false;
let jobOpts = { ...JOB_DEFAULTS, ...lsGet('fc.jobopts', {}) };
delete jobOpts.layers; delete jobOpts.layerNames;

function cutFields() {
  return {
    speed: +$('c-speed').value, force: +$('c-force').value, passes: +$('c-passes').value,
    bladeOffset: +$('c-offset').value, overcut: +$('c-overcut').value,
  };
}
function fillPresetSelect() {
  const sel = $('c-preset');
  sel.textContent = '';
  for (const p of presets) sel.append(new Option(p.name, p.id, false, p.id === settings.presetId));
}
function loadPresetIntoFields() {
  const p = presets.find((x) => x.id === $('c-preset').value) || presets[0];
  $('c-speed').value = p.speed; $('c-force').value = p.force; $('c-passes').value = p.passes;
  $('c-offset').value = p.bladeOffset; $('c-overcut').value = p.overcut;
  $('c-mirror').checked = !!p.mirror;
  $('c-knob').textContent = p.knob ? 'Blade depth: ' + p.knob + '.' : '';
}
function cutObjects() { return $('c-selonly').checked && doc.selection.size ? doc.selected() : doc.objects; }

// Option fields: id → [key, kind] (len = a length shown in the display units)
const JOB_FIELDS = {
  'c-bycolor': ['byColor', 'bool'], 'c-reg': ['regMarks', 'bool'], 'c-border': ['weedBorder', 'bool'],
  'c-wmargin': ['weedMargin', 'len'], 'c-wlines': ['weedLines', 'str'], 'c-wspace': ['weedSpacing', 'len'],
  'c-wgap': ['weedGap', 'len'], 'c-tile': ['tile', 'bool'], 'c-panelw': ['panelW', 'len0'], 'c-overlap': ['overlap', 'len'], 'c-panell': ['panelL', 'len0'],
};
function fillJobFields() {
  for (const [id, [key, kind]] of Object.entries(JOB_FIELDS)) {
    const el = $(id), v = jobOpts[key];
    if (kind === 'bool') el.checked = !!v;
    else if (kind === 'str') el.value = v;
    else if (kind === 'len0') el.value = v > 0 ? fmt(v) : '';
    else el.value = fmt(v);
  }
}
function readJobFields() {
  for (const [id, [key, kind]] of Object.entries(JOB_FIELDS)) {
    const el = $(id);
    if (kind === 'bool') jobOpts[key] = el.checked;
    else if (kind === 'str') jobOpts[key] = el.value;
    else { const v = parseFloat(el.value) / k(); jobOpts[key] = kind === 'len0' ? (v > 0 ? v : 0) : Number.isFinite(v) && v >= 0 ? v : JOB_DEFAULTS[key]; }
  }
  lsSet('fc.jobopts', jobOpts);
}

function fillLayerChecks() {
  const ul = $('c-layers'), colors = layerColors(cutObjects());
  const prev = new Map([...ul.querySelectorAll('input')].map((i) => [i.value, i.checked]));
  ul.textContent = '';
  for (const c of colors) {
    const li = document.createElement('li'), lab = document.createElement('label'), cb = document.createElement('input'), sw = document.createElement('span');
    lab.className = 'check'; cb.type = 'checkbox'; cb.value = c; cb.checked = prev.get(c) ?? true;
    sw.className = 'sw'; sw.style.background = c;
    cb.addEventListener('input', () => recomputeJob(true));
    lab.append(cb, sw, document.createTextNode(` ${layerName(c)} (${doc.objects.filter((o) => colorKey(o.color) === c).length})`));
    li.append(lab); ul.append(li);
  }
  $('c-layers-box').querySelector('summary').textContent = `Color layers (${colors.length})`;
  $('c-bycolor').disabled = colors.length < 2;
  $('c-reg').disabled = colors.length < 2 || !$('c-bycolor').checked;
  if (colors.length > 1) $('c-layers-box').open = true;
}

function recomputeJob(reset = false) {
  readJobFields();
  const s = { ...settings, mirror: $('c-mirror').checked, startAtBlade: $('c-atblade').checked };
  const layers = [...$('c-layers').querySelectorAll('input:checked')].map((i) => i.value);
  const names = Object.fromEntries(layerColors().map((c) => [c, layerName(c)]));
  const opt = { ...jobOpts, layers, layerNames: names, byColor: jobOpts.byColor && layerColors(cutObjects()).length > 1 };
  $('c-reg').disabled = $('c-bycolor').disabled || !$('c-bycolor').checked;
  const prevLabels = currentPlan?.sheets?.map((x) => x.label).join('|');
  currentPlan = planJob(cutObjects(), cutFields(), s, opt);
  const labels = currentPlan.sheets.map((x) => x.label).join('|');
  if (reset || labels !== prevLabels) { stepsDone = new Set(); stepIdx = 0; }
  stepIdx = Math.min(stepIdx, Math.max(0, currentPlan.sheets.length - 1));
  renderCutView();
}

function currentSheet() { return currentPlan?.sheets?.[stepIdx] || null; }

function renderCutView() {
  const plan = currentPlan, sh = currentSheet();
  const n = plan.sheets.length;
  const st = $('c-stats'), w = $('c-warn'), ol = $('c-steps');
  st.textContent = ''; w.textContent = ''; ol.textContent = '';
  for (const msg of plan.warnings) { const li = document.createElement('li'); li.textContent = msg; w.append(li); }
  ol.hidden = n < 2;
  plan.sheets.forEach((x, i) => {
    const li = document.createElement('li');
    if (i === stepIdx) li.classList.add('cur');
    if (stepsDone.has(i)) li.classList.add('done');
    const nn = document.createElement('span'); nn.className = 'n'; nn.textContent = `Step ${i + 1}`;
    const sw = document.createElement('span'); sw.className = 'sw'; sw.style.background = x.color || 'transparent';
    const lb = document.createElement('span'); lb.className = 'lbl'; lb.textContent = x.label;
    const ln = document.createElement('span'); ln.className = 'dim'; ln.textContent = fmtU(x.stats.length);
    li.append(nn, sw, lb, ln);
    li.onclick = () => { if (!sending) { stepIdx = i; renderCutView(); } };
    ol.append(li);
  });
  drawPreview(sh);
  const none = !sh;
  $('c-send').disabled = $('c-plt').disabled = none || sending;
  updateSendLabel();
  if (none) return;
  const t = sh.stats;
  const time = (sec) => { const m = Math.floor(sec / 60), s2 = Math.round(sec % 60); return m ? `${m} min ${s2} s` : `${s2} s`; };
  const rows = [
    [n > 1 ? `Step ${stepIdx + 1} size` : 'Design size', `${fmtU(sh.placed.x1 - sh.placed.x)} × ${fmtU(sh.placed.y1 - sh.placed.y)}`],
    ['Vinyl used (length)', fmtU(t.length)],
    ['Pieces', `${t.pieces}${t.passes > 1 ? ` × ${t.passes} passes` : ''}${t.weeds ? ` + ${t.weeds} weeding cut${t.weeds > 1 ? 's' : ''}` : ''}`],
    ['Cut length', fmtU(t.cutLen)],
    ['Estimated time', time(t.seconds)],
  ];
  if (n > 1) rows.push(['All steps: vinyl', fmtU(plan.totals.length)], ['All steps: time', time(plan.totals.seconds)]);
  for (const [a, b] of rows) { const dt = document.createElement('dt'); dt.textContent = a; const dd = document.createElement('dd'); dd.textContent = b; st.append(dt, dd); }
}

function updateSendLabel() {
  if (sending) return;
  const n = currentPlan?.sheets?.length || 0;
  const verb = cutter.connected ? 'Send' : 'Connect and send';
  $('c-send').textContent = n > 1 ? `${verb} step ${stepIdx + 1} of ${n}` : cutter.connected ? 'Send to cutter' : 'Connect and cut';
}

function drawPreview(sh) {
  const c = $('c-preview'), g = c.getContext('2d');
  const W = c.width, H = c.height;
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--roll'); g.fillRect(0, 0, W, H);
  if (!sh) return;
  const b = { x: Math.min(0, sh.placed.x), y: Math.min(0, sh.placed.y), x1: sh.placed.x1, y1: Math.max(sh.placed.y1, Math.min(settings.cutWidth, sh.placed.y1 + 1)) };
  const pad = 18, z = Math.min((W - pad * 2) / Math.max(b.x1 - b.x, 0.1), (H - pad * 2) / Math.max(b.y1 - b.y, 0.1));
  const S = ([x, y]) => [pad + (x - b.x) * z, pad + (y - b.y) * z];
  // roll edge (cutting width) if visible
  const edge = S([0, settings.cutWidth])[1];
  if (edge < H) { g.strokeStyle = '#E07A5F'; g.setLineDash([6, 4]); g.beginPath(); g.moveTo(0, edge); g.lineTo(W, edge); g.stroke(); g.setLineDash([]); }
  const COL = { design: '#58A4B0', weed: '#F2C14E', mark: '#E07A5F' };
  let pos = S([0, 0]);
  g.lineWidth = 1;
  let num = 0;
  sh.ordered.forEach((p) => {
    const s0 = S(p.pts[0]);
    g.strokeStyle = 'rgba(169,188,208,0.45)'; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(...pos); g.lineTo(...s0); g.stroke(); g.setLineDash([]);
    g.strokeStyle = COL[p.kind] || COL.design; g.lineWidth = 1.4;
    g.beginPath(); p.pts.forEach((pt, j) => { const [x, y] = S(pt); j ? g.lineTo(x, y) : g.moveTo(x, y); });
    if (p.closed) g.closePath();
    g.stroke(); g.lineWidth = 1;
    if (p.kind === 'design') { num++; if (sh.stats.pieces <= 30) { g.fillStyle = '#D8DBE2'; g.font = '11px Outfit, system-ui'; g.fillText(String(num), s0[0] + 3, s0[1] - 3); } }
    pos = p.closed ? s0 : S(p.pts.at(-1));
  });
  const o = S([0, 0]);
  g.fillStyle = '#58A4B0'; g.beginPath(); g.arc(o[0], o[1], 4, 0, Math.PI * 2); g.fill();
  g.fillStyle = '#A9BCD0'; g.font = '11px system-ui'; g.fillText('blade start', o[0] + 6, o[1] - 6 < 10 ? o[1] + 14 : o[1] - 6);
}
function openCut() {
  if (!doc.objects.length) { toast('Import a design or add text first.'); return; }
  fillPresetSelect(); loadPresetIntoFields();
  $('c-selonly').checked = doc.selection.size > 0 && doc.selection.size < doc.objects.length;
  $('c-selonly').disabled = !doc.selection.size;
  $('c-atblade').checked = settings.startAtBlade;
  fillJobFields();
  $('c-layers').textContent = '';
  fillLayerChecks();
  refreshConn();
  currentPlan = null;
  recomputeJob(true);
  cutDlg.showModal();
}

async function sendJob(hpgl, what) {
  if (!cutter.connected) await connect();
  const btn = $('c-send'), label = btn.textContent;
  btn.disabled = true; sending = true;
  const stop = $('c-test');
  log(`Sending ${what}: preset "${$('c-preset').selectedOptions[0]?.text}", ${JSON.stringify(cutFields())}, mirror ${$('c-mirror').checked}, ${hpgl.length} bytes.`);
  log('TX ' + (hpgl.length > 4000 ? hpgl.slice(0, 4000) + ` … (${hpgl.length - 4000} more bytes; use Save .plt for the full job)` : hpgl));
  const oldTest = stop.textContent, oldOnclick = stop.onclick;
  stop.textContent = 'Stop'; stop.onclick = () => cutter.stop();
  try {
    const ok = await cutter.send(hpgl, { chunk: settings.chunk, delayMs: settings.chunkDelay, onProgress: (f) => { btn.textContent = `Sending ${Math.round(f * 100)}%`; } });
    if (ok) log(`Send complete (${what}).`);
    return ok;
  } finally {
    sending = false;
    btn.textContent = label; btn.disabled = false; stop.textContent = oldTest; stop.onclick = oldOnclick;
  }
}

const sendStep = run(async () => {
  if (!currentPlan || currentPlan.empty) recomputeJob();
  const sh = currentSheet();
  if (!sh) return;
  const n = currentPlan.sheets.length, i = stepIdx;
  const ok = await sendJob(sh.hpgl, n > 1 ? `step ${i + 1} of ${n} (${sh.label})` : 'job');
  if (!ok) return;
  stepsDone.add(i);
  const next = currentPlan.sheets.findIndex((x, j) => j > i && !stepsDone.has(j));
  if (next >= 0) {
    stepIdx = next;
    const nx = currentPlan.sheets[next];
    const prev = currentPlan.sheets[i];
    const load = nx.color && nx.color !== prev.color ? `Load ${layerName(nx.color)} vinyl, then` : nx.panel ? `Feed fresh vinyl for panel ${nx.panel}, then` : 'When ready,';
    toast(`Step ${i + 1} sent. ${load} click "Send step ${next + 1}".`, { ms: 9000 });
  } else toast(n > 1 ? `All ${n} steps sent.` : 'Job sent to the cutter.');
  renderCutView();
});

$('btn-cut').onclick = openCut;
for (const id of ['c-speed', 'c-force', 'c-passes', 'c-offset', 'c-overcut', 'c-mirror', 'c-atblade']) $(id).addEventListener('input', () => recomputeJob());
for (const id of Object.keys(JOB_FIELDS)) $(id).addEventListener(['c-wmargin', 'c-wspace', 'c-wgap', 'c-panelw', 'c-overlap', 'c-panell'].includes(id) ? 'change' : 'input', () => recomputeJob(true));
$('c-selonly').addEventListener('input', () => { fillLayerChecks(); recomputeJob(true); });
$('c-preset').onchange = () => { settings.presetId = $('c-preset').value; saveSettings(settings); loadPresetIntoFields(); recomputeJob(); };
$('c-send').onclick = sendStep;
$('c-plt').onclick = run(async () => {
  recomputeJob();
  const sheets = currentPlan.sheets;
  if (!sheets.length) return;
  if (sheets.length === 1) { download('fantasticut-job.plt', sheets[0].hpgl); log(`Saved .plt (${sheets[0].hpgl.length} bytes).`); return; }
  const slug = (t) => t.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  for (let i = 0; i < sheets.length; i++) {
    download(`fantasticut-step${i + 1}-${slug(sheets[i].label)}.plt`, sheets[i].hpgl);
    await new Promise((r) => setTimeout(r, 350));
  }
  log(`Saved ${sheets.length} .plt files, one per step.`);
  toast(`Saved ${sheets.length} .plt files, one per step. If Chrome asks, allow multiple downloads.`);
});
const testCut = run(async () => {
  const obj = { paths: testPattern(), x: 0, y: 0, sx: 1, sy: 1, rot: 0 };
  const job = prepareJob([obj], cutFields(), { ...settings, mirror: false, startAtBlade: true });
  if (await sendJob(job.hpgl, 'test cut')) toast('Test cut sent. Weed the triangle: it should lift out cleanly without the square moving.');
});
$('c-test').onclick = testCut;
$('c-save-preset').onclick = () => {
  const p = presets.find((x) => x.id === $('c-preset').value);
  if (!p) return;
  Object.assign(p, cutFields(), { mirror: $('c-mirror').checked });
  savePresets(presets);
  toast(`Saved to "${p.name}".`);
};
$('c-edit-presets').onclick = () => { renderPresetRows(); $('dlg-presets').showModal(); };

// ---------- materials dialog ----------
function renderPresetRows() {
  const tb = $('p-rows');
  tb.textContent = '';
  for (const p of presets) {
    const tr = document.createElement('tr');
    if (p.id === settings.presetId) tr.className = 'active';
    const cell = (el) => { const td = document.createElement('td'); td.append(el); tr.append(td); return el; };
    const inp = (key, type = 'number', attrs = {}) => {
      const el = document.createElement('input'); el.type = type;
      Object.assign(el, attrs);
      if (type === 'checkbox') el.checked = !!p[key]; else el.value = p[key] ?? '';
      el.oninput = () => { p[key] = type === 'checkbox' ? el.checked : type === 'number' ? +el.value : el.value; savePresets(presets); };
      return cell(el);
    };
    inp('name', 'text'); inp('speed', 'number', { min: 1, max: 100 }); inp('force', 'number', { min: 10, max: 350 });
    inp('passes', 'number', { min: 1, max: 5 }); inp('bladeOffset', 'number', { step: 0.05, min: 0 }); inp('overcut', 'number', { step: 0.1, min: 0 });
    inp('mirror', 'checkbox'); inp('noRotate', 'checkbox'); inp('knob', 'text');
    const del = document.createElement('button'); del.className = 'tb danger'; del.textContent = 'Delete';
    del.onclick = () => { if (presets.length < 2) return; presets = presets.filter((x) => x !== p); savePresets(presets); renderPresetRows(); };
    cell(del);
    tb.append(tr);
  }
}
$('p-add').onclick = () => { presets.push({ ...presets[0], id: 'p' + Date.now().toString(36), name: 'New material' }); savePresets(presets); renderPresetRows(); };
$('p-reset').onclick = () => { presets = structuredClone(DEFAULT_PRESETS); savePresets(presets); renderPresetRows(); };
$('p-done').onclick = () => { $('dlg-presets').close(); if (cutDlg.open) { fillPresetSelect(); loadPresetIntoFields(); recomputeJob(); } };

// ---------- settings dialog ----------
const S_FIELDS = { 's-width': 'cutWidth', 's-units': 'units', 's-after': 'afterCut', 's-margin': 'margin', 's-baud': 'baud', 's-flow': 'flow', 's-chunk': 'chunk', 's-delay': 'chunkDelay', 's-steps': 'stepsPerInch', 's-speedforce': 'sendSpeedForce', 's-swap': 'swapXY', 's-flipx': 'flipX', 's-flipy': 'flipY' };
function openSettings() {
  for (const [id, key] of Object.entries(S_FIELDS)) {
    const el = $(id);
    if (el.type === 'checkbox') el.checked = !!settings[key]; else el.value = settings[key];
  }
  $('dlg-settings').showModal();
}
for (const [id, key] of Object.entries(S_FIELDS)) {
  $(id).addEventListener('change', () => {
    const el = $(id);
    settings[key] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? +el.value : el.value;
    if (key === 'baud') settings.baud = +el.value;
    saveSettings(settings); refreshPanels(); view.redraw();
  });
}
$('s-calc').onclick = () => {
  const m = +$('s-measured').value;
  if (!(m > 0.5 && m < 2)) { toast('Enter the measured size of the 1-inch test square, such as 1.012.'); return; }
  settings.stepsPerInch = round(settings.stepsPerInch / m, 2);
  $('s-steps').value = settings.stepsPerInch; $('s-measured').value = '';
  saveSettings(settings);
  toast(`Steps per inch set to ${settings.stepsPerInch}. Run another test cut to confirm.`);
};
$('s-done').onclick = () => $('dlg-settings').close();
$('btn-settings').onclick = openSettings;
$('btn-about').onclick = () => { $('ver').textContent = `${VERSION} (build ${BUILD})`; $('dlg-about').showModal(); };

// ---------- toolbar + panels ----------
$('btn-new').onclick = newDesign;
$('btn-open').onclick = openFile;
$('btn-save').onclick = (e) => saveFile(e.shiftKey);
$('btn-import').onclick = () => $('file-import').click();
$('empty-import').onclick = () => $('file-import').click();
$('file-import').onchange = (e) => { importFiles([...e.target.files]); e.target.value = ''; };
$('file-open').onchange = run(async (e) => { const f = e.target.files[0]; if (f) await openText(await f.text(), f.name); e.target.value = ''; });
$('btn-undo').onclick = () => { const l = doc.undo(); if (l) toast('Undid ' + l, { ms: 1500 }); };
$('btn-redo').onclick = () => { const l = doc.redo(); if (l) toast('Redid ' + l, { ms: 1500 }); };
$('btn-text').onclick = addText;
$('empty-text').onclick = addText;
$('zoom-in').onclick = () => { view.zoomBy(1.25); refreshPanels(true); };
$('zoom-out').onclick = () => { view.zoomBy(0.8); refreshPanels(true); };
$('zoom-fit').onclick = () => { view.fitDesign(); refreshPanels(true); };
$('zoom-roll').onclick = () => { view.fitRoll(); refreshPanels(true); };
$('tool-pan').onclick = () => { view.tool = view.tool === 'pan' ? 'select' : 'pan'; $('tool-pan').setAttribute('aria-pressed', view.tool === 'pan'); };

for (const [id, f] of [['in-x', 'x'], ['in-y', 'y'], ['in-w', 'w'], ['in-h', 'h'], ['in-rot', 'rot']]) {
  $(id).addEventListener('change', () => applyBoxEdit(f, parseFloat($(id).value)));
}
$('b-fliph').onclick = () => flip('h');
$('b-flipv').onclick = () => flip('v');
$('b-dup').onclick = () => duplicate();
$('b-del').onclick = deleteSel;
$('b-ungroup').onclick = ungroup;
$('b-weld').onclick = weldSelection;
$('b-unweld').onclick = unweldSelection;
$('b-offset').onclick = addOffset;
// Side panel as a pull-up sheet on phones (CSS shows the handle only on narrow screens)
function setSheet(open) { $('side').classList.toggle('collapsed', !open); $('sheet-handle').setAttribute('aria-expanded', String(open)); lsSet('fc.sheet', open); }
setSheet(lsGet('fc.sheet', !matchMedia('(max-width: 600px)').matches));
$('sheet-handle').onclick = () => setSheet($('side').classList.contains('collapsed'));
$('b-combine').onclick = combineSelection;
$('b-nest').onclick = openNest;
$('ns-start').onclick = startBestFit;
$('ns-apply').onclick = applyNest;
$('ns-cancel').onclick = () => $('dlg-nest').close();
$('dlg-nest').addEventListener('close', () => { stopNestWorker(); nest = null; });
for (const id of ['ns-method', 'ns-rot', 'ns-holes', 'ns-space']) $(id).addEventListener('change', () => { if (nest) runNest(); });
$('b-nodes').onclick = () => enterNodes(single());
document.querySelectorAll('[data-node]').forEach((b) => { b.onclick = () => nodeOp(b.dataset.node); });
$('n-done').onclick = exitNodes;
$('n-simp').addEventListener('input', () => { $('n-simp-v').textContent = $('n-simp').value + '%'; simplifyNodes(+$('n-simp').value, false); });
$('n-simp').addEventListener('change', () => { simplifyNodes(+$('n-simp').value, true); $('n-simp-v').textContent = ''; });
$('b-repeat').onclick = openRepeat;
$('b-back').onclick = () => {
  const sel = doc.selected(); if (!sel.length) return;
  doc.objects = sel.concat(doc.objects.filter((o) => !doc.selection.has(o.id)));
  doc.commit('Send to back');
};
$('in-color').addEventListener('change', () => setSelectionColor($('in-color').value));
$('of-dist').addEventListener('change', () => { const v = parseFloat($('of-dist').value) / k(); if (v > 0) updateOffset({ dist: round(v, 4) }); });
$('of-dir').addEventListener('change', () => updateOffset({ dir: $('of-dir').value }));
$('of-join').addEventListener('change', () => updateOffset({ join: $('of-join').value }));
$('of-unlink').onclick = () => { const o = single('offset'); if (o) { unlinkOffset(o); doc.commit('Unlink'); toast('Unlinked. It is a plain shape now.'); } };
for (const id of ['r-rows', 'r-cols', 'r-gap', 'r-fill']) $(id).addEventListener('input', refreshRepeat);
$('r-cancel').onclick = () => $('dlg-repeat').close();
$('r-ok').onclick = () => { $('dlg-repeat').close(); doRepeat(); };
$('b-front').onclick = () => {
  const sel = doc.selected(); if (!sel.length) return;
  doc.objects = doc.objects.filter((o) => !doc.selection.has(o.id)).concat(sel);
  doc.commit('Bring to front');
};
document.querySelectorAll('[data-align]').forEach((b) => { b.onclick = () => align(b.dataset.align); });

$('t-text').addEventListener('input', () => updateText({ text: $('t-text').value }, 'Edit text'));
$('t-font').addEventListener('change', () => updateText({ font: $('t-font').value }, 'Change font'));
$('t-font-filter').addEventListener('input', renderFontOptions);
$('t-spacing').addEventListener('change', () => updateText({ spacing: +$('t-spacing').value }, 'Letter spacing'));
$('t-line').addEventListener('change', () => updateText({ lineHeight: +$('t-line').value }, 'Line spacing'));
$('t-align').addEventListener('change', () => updateText({ align: $('t-align').value }, 'Align text'));
$('t-weld').addEventListener('change', () => updateText({ weld: $('t-weld').checked }, $('t-weld').checked ? 'Weld letters' : 'Unweld letters'));
$('t-height').addEventListener('change', () => {
  const o = single('text'), v = parseFloat($('t-height').value) / k();
  if (!o || !(v > 0)) return;
  const cur = o.text.height * Math.abs(o.sy), f = v / cur;
  o.sx *= f; o.sy *= f;
  doc.commit('Letter height');
});
$('t-local').onclick = run(async () => {
  const n = await loadInstalledFonts();
  await refreshFontSelect();
  toast(`${n} installed fonts loaded.`);
});
$('t-upload').onclick = () => $('file-font').click();
$('file-font').onchange = run(async (e) => {
  const f = e.target.files[0]; e.target.value = '';
  if (!f) return;
  const key = await uploadFont(f);
  await refreshFontSelect();
  if (single('text')) updateText({ font: key }, 'Change font');
  toast('Font added. It stays available in this browser.');
});
if (!localFontsSupported()) $('t-local').disabled = true;

// Sliders: preview while dragging, keep on release. Other controls keep right away.
for (const [id, key] of [['tr-th', 'threshold'], ['tr-sm', 'smooth'], ['tr-sp', 'despeckle'], ['tr-colors', 'colors']]) {
  $(id).addEventListener('input', () => updateTrace({ [key]: +$(id).value }));
  $(id).addEventListener('change', () => updateTrace({ [key]: +$(id).value }, true));
}
$('tr-mode').addEventListener('change', () => updateTrace({ mode: $('tr-mode').value }, true));
$('tr-inv').addEventListener('change', () => updateTrace({ invert: $('tr-inv').checked }, true));
$('tr-bg').addEventListener('change', () => updateTrace({ dropBg: $('tr-bg').checked }, true));
$('tr-stack').addEventListener('change', () => updateTrace({ stack: $('tr-stack').value }, true));
$('tr-overlap').addEventListener('change', () => { const v = parseFloat($('tr-overlap').value) / k(); if (v >= 0) updateTrace({ overlap: round(v, 4) }, true); });
$('tr-stroke').addEventListener('change', () => { const v = parseFloat($('tr-stroke').value) / k(); updateTrace({ stroke: v > 0 ? round(v, 4) : 0 }, true); });
$('tr-show').addEventListener('change', () => { const o = traceTarget(); if (o) { for (const x of traceGroup(o)) x.trace.showImage = $('tr-show').checked; doc.commit('Show photo'); } });

// log drawer
$('st-log').onclick = () => { $('logdrawer').hidden = !$('logdrawer').hidden; };
$('log-close').onclick = () => { $('logdrawer').hidden = true; };
$('log-clear').onclick = () => { logEl.textContent = ''; };
$('log-copy').onclick = run(async () => { await navigator.clipboard.writeText(logEl.textContent); toast('Log copied.'); });

// ---------- view events ----------
view.onCommit = (label) => (view.nodeEdit ? nodeCommit(label) : doc.commit(label));
view.onNodeEnter = (o) => enterNodes(o);
view.onNodeExit = () => exitNodes();
view.onNodeBegin = () => nodeBegin();
view.onNodeOp = (op, hit) => nodeOp(op, hit);
view.onContext = (e) => openMenu(e);
view.followers = followersOf;
view.onSelect = (live) => refreshPanels(!!live);
view.onCursor = ([x, y]) => { $('st-cursor').textContent = `${fmt(x)}, ${fmt(y)} ${settings.units}`; };
doc.on((why) => {
  if (why === 'saved') { $('st-saved').textContent = 'Autosaved ' + doc.lastSaved.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); return; }
  if (why === 'load') exitNodes();
  syncNodeEdit();
  refreshPanels(); view.redraw();
});
$('canvas').addEventListener('wheel', () => refreshPanels(true), { passive: true });

// ---------- drag and drop, paste ----------
const stage = $('stage');
stage.addEventListener('dragover', (e) => { e.preventDefault(); stage.classList.add('dragging'); });
stage.addEventListener('dragleave', (e) => { if (e.target === stage || !stage.contains(e.relatedTarget)) stage.classList.remove('dragging'); });
stage.addEventListener('drop', (e) => { e.preventDefault(); stage.classList.remove('dragging'); importFiles([...e.dataTransfer.files]); });
document.addEventListener('paste', (e) => {
  if (isTyping(e.target)) return;
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); importFiles(files.map((f) => (f.name ? f : new File([f], 'Pasted image.png', { type: f.type })))); return; }
  if (clipboard) { e.preventDefault(); pasteClipboard(); }
});

// ---------- keyboard ----------
const isTyping = (el) => el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
document.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey, key = e.key.toLowerCase();
  if (document.querySelector('dialog[open]')) {
    if (mod && key === 'enter' && cutDlg.open) { e.preventDefault(); $('c-send').click(); }
    return;
  }
  if (mod && key === 's') { e.preventDefault(); saveFile(e.shiftKey); return; }
  if (mod && key === 'o') { e.preventDefault(); openFile(); return; }
  if (mod && key === 'i') { e.preventDefault(); $('file-import').click(); return; }
  if (mod && key === 'enter') { e.preventDefault(); openCut(); return; }
  if (isTyping(e.target)) return;
  if (mod && key === 'z') { e.preventDefault(); (e.shiftKey ? $('btn-redo') : $('btn-undo')).click(); return; }
  if (view.nodeEdit && !mod) {
    if (key === 'escape' || key === 'enter') { e.preventDefault(); if (!ctx.hidden) closeMenu(); else exitNodes(); return; }
    if (key === 'delete' || key === 'backspace') { e.preventDefault(); nodeOp('delete'); return; }
    const st = e.shiftKey ? 0.1 : 0.01;
    const ar = { arrowleft: [-st, 0], arrowright: [st, 0], arrowup: [0, -st], arrowdown: [0, st] };
    if (ar[key]) { e.preventDefault(); nudgeNodes(...ar[key]); return; }
  }
  if (view.nodeEdit && mod && key === 'a') { e.preventDefault(); nodeOp('selectall'); return; }
  if (mod && key === 'y') { e.preventDefault(); $('btn-redo').click(); return; }
  if (mod && key === 'd') { e.preventDefault(); duplicate(); return; }
  if (mod && key === 'g') { e.preventDefault(); if (e.shiftKey) unweldSelection(); else weldSelection(); return; }
  if (mod && key === 'a') { e.preventDefault(); doc.select(doc.objects.map((o) => o.id)); return; }
  if (mod && key === 'c') { if (doc.selection.size) { clipboard = doc.selected().map((o) => structuredClone(o)); toast('Copied.', { ms: 1000 }); } return; }
  if (mod && key === 'x') { if (doc.selection.size) { clipboard = doc.selected().map((o) => structuredClone(o)); deleteSel(); } return; }
  if (mod && key === 'n') { e.preventDefault(); newDesign(); return; }
  if (key === 'delete' || key === 'backspace') { e.preventDefault(); deleteSel(); return; }
  if (key === 'escape') { if (!ctx.hidden) closeMenu(); else doc.clearSelection(); return; }
  if (key === 't' && !mod) { e.preventDefault(); addText(); return; }
  if (e.key === ' ' && !view.spaceDown) { view.spaceDown = true; $('canvas').style.cursor = 'grab'; e.preventDefault(); return; }
  if (e.shiftKey && (e.code === 'Digit1')) { view.fitDesign(); return; }
  if (e.shiftKey && (e.code === 'Digit0')) { view.fitRoll(); return; }
  if (key === '=' || key === '+') { view.zoomBy(1.25); refreshPanels(true); return; }
  if (key === '-') { view.zoomBy(0.8); refreshPanels(true); return; }
  const step = e.shiftKey ? 0.5 : 0.05;
  const arrows = { arrowleft: [-step, 0], arrowright: [step, 0], arrowup: [0, -step], arrowdown: [0, step] };
  if (arrows[key]) { e.preventDefault(); nudge(...arrows[key]); }
});
document.addEventListener('keyup', (e) => { if (e.key === ' ') { view.spaceDown = false; $('canvas').style.cursor = 'default'; } });
window.addEventListener('beforeunload', () => { doc.saveNow(); });

// ---------- start up ----------
(async () => {
  $('st-ver').title = `FantastiCut ${VERSION}, build ${BUILD}`;
  log(`FantastiCut ${VERSION} (build ${BUILD}) ready. Web Serial ${serialSupported() ? 'available' : 'NOT available (use Chrome or Edge)'}.`);
  refreshConn();
  await refreshFontSelect().catch(() => {});
  view.fitRoll();
  if (await doc.restoreAutosave()) {
    await loadTraceImages();
    view.fitDesign();
    toast('Picked up where you left off.');
  }
  refreshPanels();
  if ('serviceWorker' in navigator && isSecureContext) {
    navigator.serviceWorker.register('sw.js').catch((e) => log('Offline mode unavailable: ' + e.message));
  }
})();

// For testing in the browser console.
// ---------- "Install as an app" hint on phones ----------
let installEvt = null;
addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); installEvt = e; $('install-go').hidden = false; });
function maybeInstallHint() {
  const phone = matchMedia('(max-width: 860px) and (pointer: coarse)').matches;
  const installed = matchMedia('(display-mode: standalone)').matches || navigator.standalone;
  if (!phone || installed || lsGet('fc.installHint', false)) return;
  $('install-hint').hidden = false;
  if (!installEvt) $('install-text').textContent = 'Tip: install FantastiCut as an app (your browser menu, then Add to phone or Install app). More room to design, and it works offline.';
}
$('install-go').onclick = async () => { if (!installEvt) return; installEvt.prompt(); const r = await installEvt.userChoice; installEvt = null; if (r.outcome === 'accepted') { lsSet('fc.installHint', true); $('install-hint').hidden = true; } };
$('install-x').onclick = () => { lsSet('fc.installHint', true); $('install-hint').hidden = true; };
addEventListener('appinstalled', () => { lsSet('fc.installHint', true); $('install-hint').hidden = true; });
setTimeout(maybeInstallHint, 4000);
// After an update, say which build is running (handy when comparing screenshots).
{ const last = lsGet('fc.build', null); if (last && last !== BUILD) setTimeout(() => toast(`Updated to FantastiCut ${VERSION}, build ${BUILD}.`), 1200); lsSet('fc.build', BUILD); }

window.fc = { doc, view, settings: () => settings, prepareJob, planJob, BUNDLED, plan: () => currentPlan, nest: () => nest, nestUnits: (objs) => nestUnits(objs).units.length, enterNodes, exitNodes, nodeOp, tracer, traceDraft: () => traceDraft };

// Opening a .fcut file from Windows when FantastiCut is installed as an app.
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(run(async (params) => {
    for (const h of params.files || []) { const f = await h.getFile(); await openText(await f.text(), f.name); fileHandle = h; }
  }));
}
