// مدیریت جلسه‌های رمزنگاری: پیش‌کلیدها، شروع گفتگو، و ذخیره‌ی امن وضعیت Double Ratchet
import * as R from './ratchet.js';
import { kv, sessions, commit } from './store.js';

const OPK_LOW = 20;          // اگر پیش‌کلیدهای یک‌بارمصرف روی سرور کمتر از این شد، شارژ می‌شود
const OPK_BATCH = 50;
const SPK_ROTATE = 7 * 24 * 3600e3;   // پیش‌کلید امضاشده هر ۷ روز عوض می‌شود
const SPK_KEEP = 3;                    // سه پیش‌کلید آخر برای پیام‌های دیررس نگه داشته می‌شود
const SESSIONS_KEEP = 5;

let ctx = null; // { api, identity }
let chain = Promise.resolve();

// همه‌ی عملیات رمزنگاری پشت سر هم اجرا می‌شوند تا وضعیت هرگز هم‌زمان تغییر نکند
function withLock(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
}

export class KeyChangedError extends Error {
  constructor() { super('key-changed'); this.code = 'key-changed'; }
}

export function init(api, identity) { ctx = { api, identity }; }

const me = () => ({ ikPriv: ctx.identity.ecdhPriv, ikPub: ctx.identity.ecdhPub, iskPub: ctx.identity.signPub });
const aad = (from, to, id) => `${from}>${to}:${id}`;

function trim(rec) {
  const sids = Object.keys(rec.list);
  if (sids.length <= SESSIONS_KEEP) return;
  sids.sort((a, b) => (rec.list[b].used || 0) - (rec.list[a].used || 0));
  for (const sid of sids.slice(SESSIONS_KEEP)) if (sid !== rec.active) delete rec.list[sid];
}

// ---------- پیش‌کلیدها ----------
// پیش‌کلیدهای محلی با هویت جدید پاک می‌شوند (saveIdentity)، پس اینجا همیشه از حافظه خوانده می‌شوند.
// اگر سرور پیش‌کلیدها را پاک کرده باشد (ورود دوباره)، از روی وضعیت سرور تشخیص داده و دوباره ساخته می‌شوند.
export function ensurePrekeys() {
  return withLock(async () => {
    let pk = await kv.get('prekeys');
    if (!pk) pk = { spks: [], opks: {}, nextOpkId: 1, nextSpkId: 1 };
    const status = await ctx.api('/api/prekeys/status');

    const current = pk.spks[pk.spks.length - 1];
    const serverHasCurrent = current && status.spkId === current.id;
    if (!current || !serverHasCurrent || Date.now() - current.created > SPK_ROTATE) {
      const spk = await R.makeSignedPreKey(ctx.identity.signPriv, pk.nextSpkId);
      pk.nextSpkId += 1;
      pk.spks.push(spk);
      pk.spks = pk.spks.slice(-SPK_KEEP);
      await kv.set('prekeys', pk); // اول کلید خصوصی ذخیره می‌شود، بعد کلید عمومی فرستاده می‌شود
      await ctx.api('/api/prekeys', { spk: { id: spk.id, pub: spk.pub, sig: spk.sig } });
    }

    if (status.opks < OPK_LOW) {
      if (status.maxOpkId != null && status.maxOpkId >= pk.nextOpkId) pk.nextOpkId = status.maxOpkId + 1;
      const batch = await R.makeOneTimePreKeys(pk.nextOpkId, OPK_BATCH);
      pk.nextOpkId += OPK_BATCH;
      for (const o of batch) pk.opks[o.id] = { priv: o.priv, pub: o.pub };
      await kv.set('prekeys', pk);
      await ctx.api('/api/prekeys', { opks: batch.map((o) => ({ id: o.id, pub: o.pub })) });
    }
    return { opksOnServer: Math.max(status.opks, OPK_LOW), spkId: pk.spks[pk.spks.length - 1].id };
  });
}

// ---------- قفل کردن برای یک مخاطب ----------
// extraOps(envelope): تغییرهایی که باید هم‌زمان با وضعیت جدید ذخیره شوند (پیام، صف ارسال)
export function encryptFor(myId, contact, content, msgId, extraOps = () => []) {
  return withLock(async () => {
    const rec = (await sessions.get(contact.id)) || { contactId: contact.id, active: null, list: {} };
    let st = rec.active ? rec.list[rec.active] : null;
    if (!st) {
      const bundle = await ctx.api(`/api/bundle?id=${encodeURIComponent(contact.id)}`);
      // کلیدی که سرور داده باید همان کلید ثبت‌شده‌ی این مخاطب باشد
      if (bundle.ik !== contact.ecdhPub || bundle.isk !== contact.signPub) throw new KeyChangedError();
      st = await R.initiateSession(me(), bundle);
    }
    const { state, envelope } = await R.encrypt(st, JSON.stringify(content), aad(myId, contact.id, msgId));
    rec.list[state.sid] = state;
    rec.active = state.sid;
    trim(rec);
    await commit([{ store: 'sessions', put: rec }, ...extraOps(envelope)]);
    return envelope;
  });
}

// ---------- باز کردن پیام یک مخاطب ----------
// extraOps(content): تغییرهایی که باید هم‌زمان ذخیره شوند (مثلاً خود پیام)
export function decryptFrom(myId, contact, envelope, msgId, extraOps = () => []) {
  return withLock(async () => {
    const parsed = R.parseEnvelope(envelope);
    const rec = (await sessions.get(contact.id)) || { contactId: contact.id, active: null, list: {} };
    let st = rec.list[parsed.header.sid];
    let pk = null;
    let usedOpk = null;
    if (!st) {
      const x = parsed.header.x;
      if (!x) throw Object.assign(new Error('no-session'), { code: 'no-session' });
      pk = await kv.get('prekeys');
      const spk = pk?.spks.find((s) => s.id === x.spk);
      if (!spk) throw Object.assign(new Error('spk-gone'), { code: 'no-session' });
      const opk = x.opk != null ? pk.opks[x.opk] : null;
      if (x.opk != null && !opk) throw Object.assign(new Error('opk-used'), { code: 'no-session' });
      st = await R.acceptSession(me(), x, spk, opk ? opk.priv : null, { ik: contact.ecdhPub, isk: contact.signPub });
      usedOpk = x.opk;
    }
    const { state, plaintext } = await R.decrypt(st, parsed, aad(contact.id, myId, msgId));
    const content = JSON.parse(plaintext);
    rec.list[state.sid] = state;
    rec.active = state.sid; // جلسه‌ای که آخرین پیام را آورده، جلسه‌ی فعال می‌شود
    trim(rec);
    const ops = [{ store: 'sessions', put: rec }];
    if (usedOpk != null) {
      delete pk.opks[usedOpk]; // پیش‌کلید یک‌بارمصرف برای همیشه نابود می‌شود
      ops.push({ store: 'kv', key: 'prekeys', put: pk });
    }
    ops.push(...extraOps(content));
    await commit(ops);
    return content;
  });
}

export function dropSessions(contactId) {
  return withLock(() => sessions.del(contactId));
}

export async function prekeyHealth() {
  const pk = await kv.get('prekeys');
  return { local: pk ? Object.keys(pk.opks).length : 0, spks: pk ? pk.spks.length : 0 };
}
