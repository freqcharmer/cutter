// Document model, undo/redo history, and autosave.
//
// An object:
//   { id, kind: 'shape' | 'text' | 'trace', name, color,
//     x, y,          world position of the object's center (inches)
//     sx, sy, rot,   scale (negative = mirrored) and rotation in degrees
//     paths,         local geometry centered on (0,0): [{ pts, closed, el? }]
//     text?, trace?  source settings for regenerating the geometry }
import { bbox, objMatrix, transformPaths, unionBox } from './geom.js';
import { idbGet, idbSet } from './store.js';

const HISTORY_LIMIT = 150;
let nextId = 1;
export const newId = () => `o${Date.now().toString(36)}${(nextId++).toString(36)}`;

export const worldPaths = (o) => transformPaths(o.paths, objMatrix(o));
export const worldBox = (o) => bbox(worldPaths(o));
export const groupBox = (objs) => objs.reduce((b, o) => unionBox(b, worldBox(o)), null);
export const localBox = (o) => bbox(o.paths) || { x: 0, y: 0, w: 0, h: 0, x1: 0, y1: 0 };

export class Doc {
  constructor() {
    this.objects = [];
    this.selection = new Set();
    this.undoStack = [];
    this.redoStack = [];
    this.listeners = new Set();
    this.saveTimer = null;
    this.lastSaved = null;
    this.snapshot = this.serialize();
  }

  on(fn) { this.listeners.add(fn); }
  emit(reason) { for (const fn of this.listeners) fn(reason); }

  serialize() { return JSON.stringify({ app: 'FantastiCut', version: 1, objects: this.objects }); }

  load(json, { resetHistory = true } = {}) {
    const data = typeof json === 'string' ? JSON.parse(json) : json;
    if (!data || !Array.isArray(data.objects)) throw new Error('Not a FantastiCut file.');
    this.objects = data.objects;
    this.selection.clear();
    if (resetHistory) { this.undoStack = []; this.redoStack = []; }
    this.snapshot = this.serialize();
    this.emit('load');
  }

  /** Records the current state as one undo step. Call after every finished change. */
  commit(label = 'Edit') {
    const now = this.serialize();
    if (now === this.snapshot) { this.emit('change'); return; }
    this.undoStack.push({ label, state: this.snapshot });
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.snapshot = now;
    this.scheduleSave();
    this.emit('change');
  }

  undo() {
    const step = this.undoStack.pop();
    if (!step) return null;
    this.redoStack.push({ label: step.label, state: this.snapshot });
    this.restore(step.state);
    return step.label;
  }
  redo() {
    const step = this.redoStack.pop();
    if (!step) return null;
    this.undoStack.push({ label: step.label, state: this.snapshot });
    this.restore(step.state);
    return step.label;
  }
  restore(state) {
    this.objects = JSON.parse(state).objects;
    this.snapshot = state;
    for (const id of [...this.selection]) if (!this.get(id)) this.selection.delete(id);
    this.scheduleSave();
    this.emit('change');
  }

  get(id) { return this.objects.find((o) => o.id === id); }
  selected() { return this.objects.filter((o) => this.selection.has(o.id)); }
  select(ids, additive = false) {
    if (!additive) this.selection.clear();
    for (const id of ids) this.selection.add(id);
    this.emit('select');
  }
  toggle(id) {
    if (this.selection.has(id)) this.selection.delete(id); else this.selection.add(id);
    this.emit('select');
  }
  clearSelection() { if (this.selection.size) { this.selection.clear(); this.emit('select'); } }

  add(obj, { select = true } = {}) {
    obj.id ||= newId();
    this.objects.push(obj);
    if (select) { this.selection.clear(); this.selection.add(obj.id); }
    return obj;
  }
  remove(ids) {
    const set = new Set(ids);
    this.objects = this.objects.filter((o) => !set.has(o.id));
    for (const id of set) this.selection.delete(id);
  }

  // ---------- autosave ----------
  scheduleSave() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.saveNow(), 700);
  }
  async saveNow() {
    clearTimeout(this.saveTimer);
    const ok = await idbSet('autosave', this.snapshot);
    if (ok) { this.lastSaved = new Date(); this.emit('saved'); }
    return ok;
  }
  async restoreAutosave() {
    const s = await idbGet('autosave');
    if (!s) return false;
    try { this.load(s); return this.objects.length > 0; } catch { return false; }
  }
}
