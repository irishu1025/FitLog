// Tiny IndexedDB wrapper: one key-value store for app state, one for meal photos.
const DB_NAME = 'fitlog';
let dbp;

function open() {
  if (!dbp) {
    dbp = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore('kv');
        req.result.createObjectStore('photos');
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbp;
}

async function run(store, mode, fn) {
  const db = await open();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(store, mode);
    const req = fn(tx.objectStore(store));
    tx.oncomplete = () => resolve(req?.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export const kvGet = (k) => run('kv', 'readonly', (s) => s.get(k));
export const kvSet = (k, v) => run('kv', 'readwrite', (s) => s.put(v, k));
export const photoGet = (id) => run('photos', 'readonly', (s) => s.get(id));
export const photoSet = (id, v) => run('photos', 'readwrite', (s) => s.put(v, id));
export const photoDel = (id) => run('photos', 'readwrite', (s) => s.delete(id));
export const photoKeys = () => run('photos', 'readonly', (s) => s.getAllKeys());
export const clearAll = () => Promise.all([run('kv', 'readwrite', (s) => s.clear()), run('photos', 'readwrite', (s) => s.clear())]);
