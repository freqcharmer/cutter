// FantastiCut app: wires the document, canvas, panels, dialogs, and cutter together.
import { Doc, newId, worldPaths, worldBox, groupBox, localBox } from './doc.js';
import { View } from './view.js';
import { center, objMatrix, apply, bbox, pointInPoly, signedArea, round } from './geom.js';
import { parseSVG } from './import-svg.js';
import { parseDXF } from './import-dxf.js';
import { fileToDataURL, traceImage, TRACE_DEFAULTS, loadImage } from './import-image.js';
import { listFonts, loadInstalledFonts, uploadFont, getFont, textToPaths, TEXT_DEFAULTS, localFontsSupported, BUNDLED } from './text.js';
import { loadPresets, savePresets, loadSettings, saveSettings, DEFAULT_PRESETS } from './presets.js';
import { prepareJob, testPattern } from './job.js';
import { Cutter, supported as serialSupported } from './serial.js';

export const VERSION = '1.0 (Phase 1)';
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
  let o;
  if (ext === 'svg' || file.type === 'image/svg+xml') {
    const { paths, note } = parseSVG(await file.text());
    if (!paths.length) throw new Error(`${file.name}: no cuttable shapes found.${note ? ' ' + note : ''}`);
    o = makeObject('shape', baseName(file.name), paths);
    if (note) toast(note);
  } else if (ext === 'dxf') {
    const { paths, note } = parseDXF(await file.text());
    if (!paths.length) throw new Error(`${file.name}: no cuttable shapes found.${note ? ' ' + note : ''}`);
    o = makeObject('shape', baseName(file.name), paths);
    if (note) toast(note);
  } else if (file.type.startsWith('image/') || ['png', 'jpg', 'jpeg', 'webp', 'bmp', 'gif'].includes(ext)) {
    toast('Tracing image…', { ms: 1500 });
    const img = await fileToDataURL(file);
    const ppi = Math.max(100, Math.round(img.width / 8));
    const trace = { ...TRACE_DEFAULTS, ppi, dataURL: img.dataURL, showImage: false };
    const paths = await traceImage(img.dataURL, trace);
    o = makeObject('trace', baseName(file.name || 'Pasted image'), paths.length ? paths : [{ pts: [[0, 0], [0.01, 0]], closed: false }], { trace });
    view.images.set(o.id, await loadImage(img.dataURL));
    if (!paths.length) toast('Nothing traced at this threshold. Try moving the Threshold slider or ticking Invert.');
  } else {
    throw new Error(`${file.name}: FantastiCut can import SVG, DXF, PNG, and JPG files.`);
  }
  place(o);
  doc.add(o);
  doc.commit('Import ' + o.name);
  ensureVisible(o);
  log(`Imported ${file.name}: ${o.paths.length} path(s), ${fmtU(worldBox(o).w)} × ${fmtU(worldBox(o).h)}.`);
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
let traceTimer = 0;
function updateTrace(change) {
  const o = single('trace');
  if (!o) return;
  Object.assign(o.trace, change);
  refreshTraceOutputs(o);
  clearTimeout(traceTimer);
  traceTimer = setTimeout(run(async () => {
    const paths = await traceImage(o.trace.dataURL, o.trace);
    if (paths.length) setSource(o, paths);
    else toast('Nothing traced at this threshold.');
    doc.commit('Trace settings');
    view.redraw();
  }), 250);
}
function refreshTraceOutputs(o) {
  $('tr-th-v').textContent = o.trace.threshold;
  $('tr-sm-v').textContent = o.trace.smooth;
  $('tr-sp-v').textContent = o.trace.despeckle;
}
async function loadTraceImages() {
  for (const o of doc.objects) {
    if (o.kind === 'trace' && o.trace?.dataURL && !view.images.has(o.id)) {
      try { view.images.set(o.id, await loadImage(o.trace.dataURL)); } catch {}
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
  $('p-text').hidden = !(one && one.kind === 'text');
  $('p-trace').hidden = !(one && one.kind === 'trace');
  $('f-width').textContent = fmtU(settings.cutWidth);
  $('f-count').textContent = doc.objects.length;
  const all = groupBox(doc.objects);
  $('f-size').textContent = all ? `${fmtU(all.w)} × ${fmtU(all.h)}` : '–';

  if (sel.length) {
    const b = groupBox(sel);
    $('sel-title').textContent = one ? { text: 'Text', trace: 'Traced image', shape: 'Shape' }[one.kind] + ': ' + one.name : `${sel.length} objects`;
    setNum('in-x', fmt(b.x)); setNum('in-y', fmt(b.y));
    if (one) {
      const lb = localBox(one);
      setNum('in-w', fmt(lb.w * Math.abs(one.sx))); setNum('in-h', fmt(lb.h * Math.abs(one.sy)));
      setNum('in-rot', round(one.rot || 0, 1));
    } else { setNum('in-w', fmt(b.w)); setNum('in-h', fmt(b.h)); setNum('in-rot', ''); }
    $('in-rot').disabled = !one;
    $('align-row').hidden = sel.length < 2;
    $('b-ungroup').disabled = !(one && one.paths.length > 1);
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
    $('t-script-hint').hidden = !/pacifico|script|brush|hand/i.test(fname);
  }
  if (!liveOnly && one?.kind === 'trace') {
    $('tr-th').value = one.trace.threshold; $('tr-sm').value = one.trace.smooth; $('tr-sp').value = one.trace.despeckle;
    $('tr-inv').checked = !!one.trace.invert; $('tr-show').checked = !!one.trace.showImage;
    refreshTraceOutputs(one);
  }
  if (!liveOnly) renderLayers();
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
    const kd = document.createElement('span'); kd.className = 'kd'; kd.textContent = o.kind;
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

function duplicate(offset = 0.25) {
  const sel = doc.selected();
  if (!sel.length) return;
  const copies = sel.map((o) => ({ ...structuredClone(o), id: newId(), x: o.x + offset, y: o.y + offset, name: o.name }));
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
  doc.objects = []; doc.selection.clear(); fileHandle = null;
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
  $('c-send').textContent = cutter.connected ? 'Send to cutter' : 'Connect and cut';
}
cutter.onchange = refreshConn;

async function connect({ forcePicker = false } = {}) {
  if (!serialSupported()) throw new Error('This browser cannot talk to cutters. Open FantastiCut in Chrome or Edge on a computer. Until then, "Save .plt" saves the job as a file.');
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
let currentJob = null;

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

function recomputeJob() {
  const s = { ...settings, mirror: $('c-mirror').checked, startAtBlade: $('c-atblade').checked };
  currentJob = prepareJob(cutObjects(), cutFields(), s);
  drawPreview(currentJob);
  const st = $('c-stats'), w = $('c-warn');
  st.textContent = ''; w.textContent = '';
  for (const msg of currentJob.warnings) { const li = document.createElement('li'); li.textContent = msg; w.append(li); }
  if (currentJob.empty) { $('c-send').disabled = $('c-plt').disabled = true; return; }
  $('c-send').disabled = $('c-plt').disabled = false;
  const t = currentJob.stats;
  const mins = Math.floor(t.seconds / 60), secs = Math.round(t.seconds % 60);
  const rows = [
    ['Design size', `${fmtU(currentJob.placed.x1 - currentJob.placed.x)} × ${fmtU(currentJob.placed.y1 - currentJob.placed.y)}`],
    ['Vinyl used (length)', fmtU(currentJob.placed.x1 + settings.margin)],
    ['Pieces', `${t.pieces}${t.passes > 1 ? ` × ${t.passes} passes` : ''}`],
    ['Cut length', fmtU(t.cutLen)],
    ['Estimated time', mins ? `${mins} min ${secs} s` : `${secs} s`],
  ];
  for (const [a, b] of rows) { const dt = document.createElement('dt'); dt.textContent = a; const dd = document.createElement('dd'); dd.textContent = b; st.append(dt, dd); }
}

function drawPreview(job) {
  const c = $('c-preview'), g = c.getContext('2d');
  const W = c.width, H = c.height;
  g.fillStyle = getComputedStyle(document.documentElement).getPropertyValue('--roll'); g.fillRect(0, 0, W, H);
  if (job.empty) return;
  const b = { x: Math.min(0, job.placed.x), y: Math.min(0, job.placed.y), x1: job.placed.x1, y1: job.placed.y1 };
  const pad = 18, z = Math.min((W - pad * 2) / Math.max(b.x1 - b.x, 0.1), (H - pad * 2) / Math.max(b.y1 - b.y, 0.1));
  const S = ([x, y]) => [pad + (x - b.x) * z, pad + (y - b.y) * z];
  // roll edge (cutting width) if visible
  const edge = S([0, settings.cutWidth])[1];
  if (edge < H) { g.strokeStyle = '#E07A5F'; g.setLineDash([6, 4]); g.beginPath(); g.moveTo(0, edge); g.lineTo(W, edge); g.stroke(); g.setLineDash([]); }
  let pos = S([0, 0]);
  g.lineWidth = 1;
  job.ordered.forEach((p, i) => {
    const s0 = S(p.pts[0]);
    g.strokeStyle = 'rgba(169,188,208,0.45)'; g.setLineDash([3, 3]);
    g.beginPath(); g.moveTo(...pos); g.lineTo(...s0); g.stroke(); g.setLineDash([]);
    g.strokeStyle = '#58A4B0'; g.lineWidth = 1.4;
    g.beginPath(); p.pts.forEach((pt, j) => { const [x, y] = S(pt); j ? g.lineTo(x, y) : g.moveTo(x, y); });
    if (p.closed) g.closePath();
    g.stroke(); g.lineWidth = 1;
    if (job.ordered.length <= 30) { g.fillStyle = '#D8DBE2'; g.font = '10px system-ui'; g.fillText(String(i + 1), s0[0] + 3, s0[1] - 3); }
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
  refreshConn();
  recomputeJob();
  cutDlg.showModal();
}

async function sendJob(hpgl, what) {
  if (!cutter.connected) await connect();
  const btn = $('c-send'), label = btn.textContent;
  btn.disabled = true;
  const stop = $('c-test');
  log(`Sending ${what}: preset "${$('c-preset').selectedOptions[0]?.text}", ${JSON.stringify(cutFields())}, mirror ${$('c-mirror').checked}, ${hpgl.length} bytes.`);
  log('TX ' + (hpgl.length > 4000 ? hpgl.slice(0, 4000) + ` … (${hpgl.length - 4000} more bytes; use Save .plt for the full job)` : hpgl));
  const oldTest = stop.textContent, oldOnclick = stop.onclick;
  stop.textContent = 'Stop'; stop.onclick = () => cutter.stop();
  try {
    const ok = await cutter.send(hpgl, { chunk: settings.chunk, delayMs: settings.chunkDelay, onProgress: (f) => { btn.textContent = `Sending ${Math.round(f * 100)}%`; } });
    if (ok) { log(`Send complete (${what}).`); toast(what === 'test cut' ? 'Test cut sent. Weed the triangle: it should lift out cleanly without the square moving.' : 'Job sent to the cutter.'); }
  } finally {
    btn.textContent = label; btn.disabled = false; stop.textContent = oldTest; stop.onclick = oldOnclick;
  }
}

$('btn-cut').onclick = openCut;
for (const id of ['c-speed', 'c-force', 'c-passes', 'c-offset', 'c-overcut', 'c-mirror', 'c-selonly', 'c-atblade']) $(id).addEventListener('input', recomputeJob);
$('c-preset').onchange = () => { settings.presetId = $('c-preset').value; saveSettings(settings); loadPresetIntoFields(); recomputeJob(); };
$('c-send').onclick = run(async () => { recomputeJob(); if (!currentJob.empty) await sendJob(currentJob.hpgl, 'job'); });
$('c-plt').onclick = () => { recomputeJob(); if (!currentJob.empty) { download('fantasticut-job.plt', currentJob.hpgl); log(`Saved .plt (${currentJob.hpgl.length} bytes).`); } };
const testCut = run(async () => {
  const obj = { paths: testPattern(), x: 0, y: 0, sx: 1, sy: 1, rot: 0 };
  const job = prepareJob([obj], cutFields(), { ...settings, mirror: false, startAtBlade: true });
  await sendJob(job.hpgl, 'test cut');
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
    inp('mirror', 'checkbox'); inp('knob', 'text');
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
$('btn-about').onclick = () => { $('ver').textContent = VERSION; $('dlg-about').showModal(); };

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

$('tr-th').addEventListener('input', () => updateTrace({ threshold: +$('tr-th').value }));
$('tr-sm').addEventListener('input', () => updateTrace({ smooth: +$('tr-sm').value }));
$('tr-sp').addEventListener('input', () => updateTrace({ despeckle: +$('tr-sp').value }));
$('tr-inv').addEventListener('change', () => updateTrace({ invert: $('tr-inv').checked }));
$('tr-show').addEventListener('change', () => { const o = single('trace'); if (o) { o.trace.showImage = $('tr-show').checked; doc.commit('Show photo'); } });

// log drawer
$('st-log').onclick = () => { $('logdrawer').hidden = !$('logdrawer').hidden; };
$('log-close').onclick = () => { $('logdrawer').hidden = true; };
$('log-clear').onclick = () => { logEl.textContent = ''; };
$('log-copy').onclick = run(async () => { await navigator.clipboard.writeText(logEl.textContent); toast('Log copied.'); });

// ---------- view events ----------
view.onCommit = (label) => doc.commit(label);
view.onSelect = (live) => refreshPanels(!!live);
view.onCursor = ([x, y]) => { $('st-cursor').textContent = `${fmt(x)}, ${fmt(y)} ${settings.units}`; };
doc.on((why) => {
  if (why === 'saved') { $('st-saved').textContent = 'Autosaved ' + doc.lastSaved.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); return; }
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
  if (clipboard) {
    e.preventDefault();
    const copies = clipboard.map((o) => ({ ...structuredClone(o), id: newId(), x: o.x + 0.25, y: o.y + 0.25 }));
    clipboard = copies.map((c) => structuredClone(c));
    for (const c of copies) doc.add(c, { select: false });
    doc.select(copies.map((c) => c.id));
    doc.commit('Paste');
    loadTraceImages();
  }
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
  if (mod && key === 'y') { e.preventDefault(); $('btn-redo').click(); return; }
  if (mod && key === 'd') { e.preventDefault(); duplicate(); return; }
  if (mod && key === 'a') { e.preventDefault(); doc.select(doc.objects.map((o) => o.id)); return; }
  if (mod && key === 'c') { if (doc.selection.size) { clipboard = doc.selected().map((o) => structuredClone(o)); toast('Copied.', { ms: 1000 }); } return; }
  if (mod && key === 'x') { if (doc.selection.size) { clipboard = doc.selected().map((o) => structuredClone(o)); deleteSel(); } return; }
  if (mod && key === 'n') { e.preventDefault(); newDesign(); return; }
  if (key === 'delete' || key === 'backspace') { e.preventDefault(); deleteSel(); return; }
  if (key === 'escape') { doc.clearSelection(); return; }
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
  log(`FantastiCut ${VERSION} ready. Web Serial ${serialSupported() ? 'available' : 'NOT available (use Chrome or Edge)'}.`);
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
window.fc = { doc, view, settings: () => settings, prepareJob, BUNDLED };

// Opening a .fcut file from Windows when FantastiCut is installed as an app.
if ('launchQueue' in window) {
  window.launchQueue.setConsumer(run(async (params) => {
    for (const h of params.files || []) { const f = await h.getFile(); await openText(await f.text(), f.name); fileHandle = h; }
  }));
}
