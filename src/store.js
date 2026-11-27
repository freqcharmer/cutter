// Tiny IndexedDB key-value store (autosave, uploaded fonts) plus safe localStorage helpers.
const DB = 'fantasticut', STORE = 'kv';
let dbp = null;

function db() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

export async function idbGet(key) {
  try {
    const d = await db();
    return await new Promise((res, rej) => {
      const r = d.transaction(STORE).objectStore(STORE).get(key);
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
  } catch { return undefined; }
}

export async function idbSet(key, value) {
  try {
    const d = await db();
    await new Promise((res, rej) => {
      const t = d.transaction(STORE, 'readwrite');
      t.objectStore(STORE).put(value, key);
      t.oncomplete = res; t.onerror = () => rej(t.error);
    });
    return true;
  } catch { return false; }
}

export async function idbKeys(prefix = '') {
  try {
    const d = await db();
    const keys = await new Promise((res, rej) => {
      const r = d.transaction(STORE).objectStore(STORE).getAllKeys();
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    });
    return keys.filter((k) => String(k).startsWith(prefix));
  } catch { return []; }
}

export function lsGet(key, fallback) {
  try {
    const v = localStorage.getItem(key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
export function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
}
