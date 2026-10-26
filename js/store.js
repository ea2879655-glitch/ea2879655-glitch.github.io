// حافظه‌ی محلی روی خود گوشی (IndexedDB)
// پیام‌ها، مخاطبان و فایل‌ها روی گوشی هم قفل‌شده ذخیره می‌شوند (AES-256-GCM با «کلید داده»).
// کلید داده با رمز قفل برنامه محافظت می‌شود (فایل lock.js)؛ تا برنامه باز نشود، خوانا نیستند.

const DB_NAME = 'khaneh-v3';
let dbPromise = null;
let dataKey = null;
const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const dec = new TextDecoder();

export function setDataKey(k) { dataKey = k; }
export function hasDataKey() { return !!dataKey; }

async function sealBytes(bytes) {
  if (!dataKey) throw new Error('locked');
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await subtle.encrypt({ name: 'AES-GCM', iv }, dataKey, bytes);
  return { iv, ct };
}
async function openBytes(e) {
  if (!dataKey) throw new Error('locked');
  return subtle.decrypt({ name: 'AES-GCM', iv: e.iv }, dataKey, e.ct);
}
const sealObj = async (o) => sealBytes(enc.encode(JSON.stringify(o)));
const openObj = async (e) => JSON.parse(dec.decode(await openBytes(e)));

const encMessage = async (m) => ({ id: m.id, chatId: m.chatId, ts: m.ts, e: await sealObj(m) });
const decMessage = async (r) => (r ? openObj(r.e) : r);
const encContact = async (c) => ({ id: c.id, e: await sealObj(c) });
const decContact = async (r) => (r ? openObj(r.e) : r);
const encMedia = async (m) => ({ id: m.id, mime: m.mime, e: await sealBytes(m.buf) });
const decMedia = async (r) => (r ? { id: r.id, mime: r.mime, buf: await openBytes(r.e) } : r);

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const r = indexedDB.open(DB_NAME, 1);
    r.onupgradeneeded = () => {
      const d = r.result;
      d.createObjectStore('kv');
      const m = d.createObjectStore('messages', { keyPath: 'id' });
      m.createIndex('chatTs', ['chatId', 'ts']);
      d.createObjectStore('contacts', { keyPath: 'id' });
      d.createObjectStore('sessions', { keyPath: 'contactId' });
      d.createObjectStore('media', { keyPath: 'id' });
    };
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
  return dbPromise;
}

async function run(store, mode, fn) {
  const d = await openDB();
  return new Promise((resolve, reject) => {
    const t = d.transaction(store, mode);
    const req = fn(t.objectStore(store));
    let out;
    if (req) req.onsuccess = () => { out = req.result; };
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

export const kv = {
  get: (k) => run('kv', 'readonly', (s) => s.get(k)),
  set: (k, v) => run('kv', 'readwrite', (s) => s.put(v, k)),
  del: (k) => run('kv', 'readwrite', (s) => s.delete(k)),
};

export const messages = {
  put: async (m) => { const r = await encMessage(m); return run('messages', 'readwrite', (s) => s.put(r)); },
  get: async (id) => decMessage(await run('messages', 'readonly', (s) => s.get(id))),
  del: (id) => run('messages', 'readwrite', (s) => s.delete(id)),
  byChat: async (chatId) => Promise.all((await run('messages', 'readonly', (s) =>
    s.index('chatTs').getAll(IDBKeyRange.bound([chatId, 0], [chatId, Number.MAX_SAFE_INTEGER])))).map(decMessage)),
  all: async () => Promise.all((await run('messages', 'readonly', (s) => s.getAll())).map(decMessage)),
  clear: () => run('messages', 'readwrite', (s) => s.clear()),
};

export const contacts = {
  put: async (c) => { const r = await encContact(c); return run('contacts', 'readwrite', (s) => s.put(r)); },
  get: async (id) => decContact(await run('contacts', 'readonly', (s) => s.get(id))),
  all: async () => Promise.all((await run('contacts', 'readonly', (s) => s.getAll())).map(decContact)),
};

export const sessions = {
  get: (contactId) => run('sessions', 'readonly', (s) => s.get(contactId)),
  del: (contactId) => run('sessions', 'readwrite', (s) => s.delete(contactId)),
};

export const media = {
  get: async (id) => decMedia(await run('media', 'readonly', (s) => s.get(id))),
  put: async (rec) => { const r = await encMedia(rec); return run('media', 'readwrite', (s) => s.put(r)); },
  del: (id) => run('media', 'readwrite', (s) => s.delete(id)),
  clear: () => run('media', 'readwrite', (s) => s.clear()),
};

// ذخیره‌ی چند تغییر در یک عملیات واحد: یا همه ذخیره می‌شوند یا هیچ‌کدام.
// ops: [{ store, put: value, key (فقط برای kv) }] یا [{ store, del: key }]
export async function commit(ops) {
  // رمزنگاری قبل از باز کردن تراکنش انجام می‌شود (تراکنش IndexedDB نباید منتظر کار دیگری بماند)
  ops = await Promise.all(ops.map(async (o) => {
    if ('del' in o) return o;
    if (o.store === 'messages') return { ...o, put: await encMessage(o.put) };
    if (o.store === 'contacts') return { ...o, put: await encContact(o.put) };
    if (o.store === 'media') return { ...o, put: await encMedia(o.put) };
    return o;
  }));
  const d = await openDB();
  const names = [...new Set(ops.map((o) => o.store))];
  return new Promise((resolve, reject) => {
    const t = d.transaction(names, 'readwrite');
    for (const o of ops) {
      const s = t.objectStore(o.store);
      if ('del' in o) s.delete(o.del);
      else if (o.store === 'kv') s.put(o.put, o.key);
      else s.put(o.put);
    }
    t.oncomplete = () => resolve();
    t.onerror = () => reject(t.error);
    t.onabort = () => reject(t.error);
  });
}

// درخواست از مرورگر که اطلاعات این برنامه را هنگام کمبود فضا پاک نکند
export async function persistentStorage() {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch { return null; }
}

// پاک کردن کامل همه‌ی اطلاعات این گوشی (کلیدها، پیام‌ها، مخاطبان، فایل‌ها)
export async function wipeDevice() {
  if (dbPromise) { try { (await dbPromise).close(); } catch { /* ignore */ } dbPromise = null; }
  await new Promise((resolve) => {
    const r = indexedDB.deleteDatabase(DB_NAME);
    r.onsuccess = r.onerror = r.onblocked = () => resolve();
  });
}
