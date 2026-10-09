// Persistence: small state in localStorage, the last imported model files in IndexedDB.
// Every access is guarded - private windows or blocked storage just mean nothing is remembered.
const KEY = 'handposer.v1';

export function loadState() {
  try { return JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { return null; }
}
export function saveState(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { }
}

function db() {
  return new Promise((res, rej) => {
    try {
      const r = indexedDB.open('handposer', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    } catch (e) { rej(e); }
  });
}
export async function putModel(files) {
  try {
    const d = await db();
    await new Promise((res, rej) => { const t = d.transaction('kv', 'readwrite'); t.objectStore('kv').put(files, 'model'); t.oncomplete = res; t.onerror = () => rej(t.error); });
  } catch (e) { }
}
export async function getModel() {
  try {
    const d = await db();
    return await new Promise((res, rej) => { const r = d.transaction('kv').objectStore('kv').get('model'); r.onsuccess = () => res(r.result || null); r.onerror = () => rej(r.error); });
  } catch (e) { return null; }
}
export async function clearModel() {
  try { const d = await db(); d.transaction('kv', 'readwrite').objectStore('kv').delete('model'); } catch (e) { }
}

// per-model files in the model library (key = model id)
async function kv(mode, fn) {
  const d = await db();
  return new Promise((res, rej) => { const t = d.transaction('kv', mode); const r = fn(t.objectStore('kv')); t.oncomplete = () => res(r && r.result); t.onerror = () => rej(t.error); });
}
export async function putFiles(id, files) { try { await kv('readwrite', s => s.put(files, 'files:' + id)); return true; } catch (e) { return false; } }
export async function getFiles(id) { try { return (await kv('readonly', s => s.get('files:' + id))) || null; } catch (e) { return null; } }
export async function deleteFiles(id) { try { await kv('readwrite', s => s.delete('files:' + id)); } catch (e) { } }

// images the user added to a model's materials (key = model id + image id)
export async function putImage(modelId, imgId, rec) { try { await kv('readwrite', s => s.put(rec, `img:${modelId}:${imgId}`)); return true; } catch (e) { return false; } }
export async function getImage(modelId, imgId) { try { return (await kv('readonly', s => s.get(`img:${modelId}:${imgId}`))) || null; } catch (e) { return null; } }
export async function deleteImages(modelId) {
  try { await kv('readwrite', s => s.delete(IDBKeyRange.bound(`img:${modelId}:`, `img:${modelId}:￿`))); } catch (e) { }
}
