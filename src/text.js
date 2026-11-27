// Text: font registry (bundled, installed via Local Font Access, uploaded) and text → paths.
import { parse as parseFont } from '../vendor/opentype.mjs';
import { flattenCubic, flattenQuad, clean } from './geom.js';
import { idbGet, idbSet, idbKeys } from './store.js';

export const BUNDLED = [
  { key: 'bundled:bebas-neue', name: 'Bebas Neue', url: 'fonts/bebas-neue.woff' },
  { key: 'bundled:oswald-bold', name: 'Oswald Bold', url: 'fonts/oswald-bold.woff' },
  { key: 'bundled:space-grotesk-bold', name: 'Space Grotesk Bold', url: 'fonts/space-grotesk-bold.woff' },
  { key: 'bundled:pacifico', name: 'Pacifico (script)', url: 'fonts/pacifico.woff' },
];
export const DEFAULT_FONT = BUNDLED[0].key;

const cache = new Map();     // key → opentype Font
let localFonts = null;       // key → FontData (Local Font Access API)
const uploads = new Map();   // key → display name

export const localFontsSupported = () => 'queryLocalFonts' in window;

export async function listFonts() {
  for (const k of await idbKeys('font:')) uploads.set('upload:' + k.slice(5), k.slice(5));
  const list = BUNDLED.map((f) => ({ key: f.key, name: f.name, group: 'Included' }));
  for (const [key, name] of uploads) list.push({ key, name, group: 'Uploaded' });
  if (localFonts) for (const [key, fd] of localFonts) list.push({ key, name: fd.fullName, group: 'Installed on this computer' });
  return list;
}

/** Asks the browser for installed fonts. Needs a click (user gesture) the first time. */
export async function loadInstalledFonts() {
  if (!localFontsSupported()) throw new Error('This browser cannot read installed fonts. Use Chrome or Edge, or upload a font file.');
  const fonts = await window.queryLocalFonts();
  localFonts = new Map();
  for (const fd of fonts) localFonts.set('local:' + fd.postscriptName, fd);
  return localFonts.size;
}

export async function uploadFont(file) {
  const buf = await file.arrayBuffer();
  const font = parseFont(buf); // throws if unreadable
  const name = font.names.fullName?.en || file.name.replace(/\.[^.]+$/, '');
  await idbSet('font:' + name, buf);
  const key = 'upload:' + name;
  uploads.set(key, name);
  cache.set(key, font);
  return key;
}

export async function getFont(key) {
  if (cache.has(key)) return cache.get(key);
  let buf;
  if (key.startsWith('bundled:')) {
    const f = BUNDLED.find((b) => b.key === key);
    if (!f) throw new Error('Unknown font.');
    buf = await (await fetch(f.url)).arrayBuffer();
  } else if (key.startsWith('upload:')) {
    buf = await idbGet('font:' + key.slice(7));
  } else if (key.startsWith('local:')) {
    if (!localFonts) { try { await loadInstalledFonts(); } catch {} }
    const fd = localFonts?.get(key);
    if (fd) buf = await (await fd.blob()).arrayBuffer();
  }
  if (!buf) throw new Error('That font is not available. Click "Load installed fonts" or pick another font.');
  let font;
  try { font = parseFont(buf); } catch { throw new Error('That font file type is not supported. Try a .ttf or .otf font.'); }
  cache.set(key, font);
  return font;
}

export const TEXT_DEFAULTS = { text: 'FantastiCut', font: DEFAULT_FONT, height: 1, spacing: 0, lineHeight: 1.2, align: 'left' };

/** Builds paths for text. `height` is the capital-letter height in inches. Each glyph gets its own `el`. */
export function textToPaths(font, t) {
  const capRatio = (font.tables.os2?.sCapHeight || font.unitsPerEm * 0.7) / font.unitsPerEm;
  const size = t.height / capRatio;
  const opts = { kerning: true, tracking: (t.spacing || 0) * 1000 };
  const lines = String(t.text ?? '').split('\n');
  const widths = lines.map((l) => font.getAdvanceWidth(l, size, opts));
  const maxW = Math.max(0, ...widths);
  const out = [];
  let el = 0;
  lines.forEach((line, i) => {
    const x = t.align === 'center' ? (maxW - widths[i]) / 2 : t.align === 'right' ? maxW - widths[i] : 0;
    const y = i * size * (t.lineHeight || 1.2);
    for (const gp of font.getPaths(line, x, y, size, opts)) {
      const before = out.length;
      commandsToPaths(gp.commands, out);
      for (let j = before; j < out.length; j++) out[j].el = el;
      if (out.length > before) el++;
    }
  });
  return out;
}

function commandsToPaths(cmds, out) {
  let cur = null, pos = [0, 0], start = [0, 0];
  const end = (closed) => { if (cur && cur.length > 2) out.push({ ...clean({ pts: cur, closed }), color: '#000000' }); cur = null; };
  for (const c of cmds) {
    if (c.type === 'M') { end(true); pos = [c.x, c.y]; start = pos; cur = [pos]; }
    else if (c.type === 'L') { pos = [c.x, c.y]; cur?.push(pos); }
    else if (c.type === 'C') { const p = [c.x, c.y]; flattenCubic(pos, [c.x1, c.y1], [c.x2, c.y2], p, cur); pos = p; }
    else if (c.type === 'Q') { const p = [c.x, c.y]; flattenQuad(pos, [c.x1, c.y1], p, cur); pos = p; }
    else if (c.type === 'Z') { cur?.push(start); end(true); pos = start; }
  }
  end(true);
}
