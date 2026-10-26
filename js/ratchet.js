// رمزنگاری گفتگوها در «خانه» — به روش پروتکل Signal
//
// ۱. X3DH: شروع امن یک گفتگو حتی وقتی طرف مقابل آفلاین است.
//    هر کاربر روی سرور یک «پیش‌کلید امضاشده» (SPK) و تعدادی «پیش‌کلید یک‌بارمصرف» (OPK) می‌گذارد.
//    فرستنده با کلید هویت خودش، یک کلید موقت، و پیش‌کلیدهای گیرنده یک راز مشترک می‌سازد.
//
// ۲. Double Ratchet: برای هر پیام یک کلید تازه ساخته و بعد از استفاده نابود می‌شود.
//    - Forward Secrecy: با لو رفتن کلیدهای امروز، پیام‌های قبلی باز نمی‌شوند.
//    - Post-Compromise Security: بعد از هر رفت‌وبرگشت، کلیدهای جدیدی ساخته می‌شود
//      که مهاجم قبلی به آن‌ها دسترسی ندارد.
//
// منحنی: P-256 (پشتیبانی کامل در همه‌ی نسخه‌های Safari آیفون)
// قفل پیام: AES-256-GCM — مشتق‌سازی کلید: HKDF-SHA256 و HMAC-SHA256
//
// مرجع: https://signal.org/docs/specifications/x3dh/ و /doubleratchet/

import { b64, concat, enc, dec } from './crypto.js';

const subtle = globalThis.crypto.subtle;
const P256 = { name: 'ECDH', namedCurve: 'P-256' };
const SIG = { name: 'ECDSA', hash: 'SHA-256' };
const ZERO32 = new Uint8Array(32);

export const MAX_SKIP = 500;             // حداکثر پیام جاافتاده در یک زنجیره
const MAX_SKIPPED_TOTAL = 1000;          // حداکثر کلید نگه‌داشته‌شده برای پیام‌های دیرتر
const SKIPPED_TTL = 30 * 24 * 3600e3;    // کلید پیام نرسیده بعد از ۳۰ روز نابود می‌شود
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

// ---------- ابزارهای پایه ----------
export async function generateDH() {
  const kp = await subtle.generateKey(P256, false, ['deriveBits']);
  const pub = new Uint8Array(await subtle.exportKey('raw', kp.publicKey));
  return { priv: kp.privateKey, pub: b64.from(pub) };
}

function checkPub(p) {
  if (typeof p !== 'string' || p.length > 120 || !B64_RE.test(p)) throw new Error('bad-key');
  const raw = b64.to(p);
  if (raw.length !== 65 || raw[0] !== 4) throw new Error('bad-key');
  return raw;
}

async function dh(priv, pubB64) {
  const pub = await subtle.importKey('raw', checkPub(pubB64), P256, false, []);
  return new Uint8Array(await subtle.deriveBits({ name: 'ECDH', public: pub }, priv, 256));
}

async function hkdf(ikm, salt, info, len) {
  const k = await subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt, info: enc.encode(info) }, k, len * 8));
}

async function hmac(key, data) {
  const k = await subtle.importKey('raw', key, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await subtle.sign('HMAC', k, data));
}

// KDF_RK: ریشه + خروجی DH ← ریشه‌ی جدید + کلید زنجیره
async function kdfRK(rk, dhOut) {
  const o = await hkdf(dhOut, rk, 'khaneh-v2-root', 64);
  return [o.slice(0, 32), o.slice(32, 64)];
}

// KDF_CK: کلید زنجیره ← کلید زنجیره‌ی بعدی + کلید یک پیام
async function kdfCK(ck) {
  const mk = await hmac(ck, new Uint8Array([1]));
  const next = await hmac(ck, new Uint8Array([2]));
  return [next, mk];
}

async function messageCipher(mk) {
  const o = await hkdf(mk, ZERO32, 'khaneh-v2-message', 44);
  const key = await subtle.importKey('raw', o.slice(0, 32), 'AES-GCM', false, ['encrypt', 'decrypt']);
  return { key, iv: o.slice(32, 44) };
}

function wipe(u8) { if (u8 instanceof Uint8Array) u8.fill(0); }

// ---------- امضای پیش‌کلید ----------
const spkMessage = (id, pub) => concat(enc.encode(`khaneh-spk:${id}:`), checkPub(pub));

export async function makeSignedPreKey(signPriv, id) {
  const kp = await generateDH();
  const sig = new Uint8Array(await subtle.sign(SIG, signPriv, spkMessage(id, kp.pub)));
  return { id, priv: kp.priv, pub: kp.pub, sig: b64.from(sig), created: Date.now() };
}

export async function verifySignedPreKey(iskPub, spk) {
  if (!spk || !Number.isSafeInteger(spk.id) || typeof spk.sig !== 'string') return false;
  try {
    const key = await subtle.importKey('raw', checkPub(iskPub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    return await subtle.verify(SIG, key, b64.to(spk.sig), spkMessage(spk.id, spk.pub));
  } catch { return false; }
}

export async function makeOneTimePreKeys(startId, count) {
  const out = [];
  for (let i = 0; i < count; i++) {
    const kp = await generateDH();
    out.push({ id: startId + i, priv: kp.priv, pub: kp.pub });
  }
  return out;
}

// «داده‌ی همراه» جلسه: کلیدهای هویت هر دو طرف، به ترتیب شروع‌کننده و پاسخ‌دهنده
function associatedData(initiator, responder) {
  return b64.from(concat(
    checkPub(initiator.ik), checkPub(initiator.isk),
    checkPub(responder.ik), checkPub(responder.isk),
  ));
}

// ---------- X3DH ----------
// me: { ikPriv, ikPub, iskPub } — bundle: { ik, isk, spk:{id,pub,sig}, opk:{id,pub}|null }
export async function initiateSession(me, bundle) {
  if (!(await verifySignedPreKey(bundle.isk, bundle.spk))) throw new Error('bad-spk-signature');
  const ek = await generateDH();
  const parts = [
    new Uint8Array(32).fill(0xff),
    await dh(me.ikPriv, bundle.spk.pub),
    await dh(ek.priv, bundle.ik),
    await dh(ek.priv, bundle.spk.pub),
  ];
  if (bundle.opk) parts.push(await dh(ek.priv, bundle.opk.pub));
  const ikm = concat(...parts);
  const sk = await hkdf(ikm, ZERO32, 'khaneh-v2-x3dh', 32);
  parts.forEach(wipe); wipe(ikm);

  // شروع Double Ratchet (نقش فرستنده‌ی اول)
  const dhs = await generateDH();
  const [rk, cks] = await kdfRK(sk, await dh(dhs.priv, bundle.spk.pub));
  wipe(sk);
  return {
    v: 2,
    sid: ek.pub, // شناسه‌ی جلسه = کلید عمومی موقت شروع‌کننده
    ad: associatedData({ ik: me.ikPub, isk: me.iskPub }, { ik: bundle.ik, isk: bundle.isk }),
    rk, cks, ckr: null,
    dhs, dhr: bundle.spk.pub,
    ns: 0, nr: 0, pn: 0,
    skipped: {},
    pending: { ik: me.ikPub, isk: me.iskPub, ek: ek.pub, spk: bundle.spk.id, opk: bundle.opk ? bundle.opk.id : null },
    created: Date.now(),
    used: Date.now(),
  };
  // کلید خصوصی موقت (ek.priv) همین‌جا رها و نابود می‌شود
}

// x: سرآیند X3DH پیام اول — spk: { id, priv, pub } — opkPriv: کلید خصوصی پیش‌کلید یک‌بارمصرف یا null
// them: کلیدهای هویت فرستنده که قبلاً ثبت شده‌اند { ik, isk }
export async function acceptSession(me, x, spk, opkPriv, them) {
  if (x.ik !== them.ik || x.isk !== them.isk) throw new Error('identity-mismatch');
  if (x.spk !== spk.id) throw new Error('spk-mismatch');
  if (x.opk != null && !opkPriv) throw new Error('opk-missing');
  const parts = [
    new Uint8Array(32).fill(0xff),
    await dh(spk.priv, x.ik),
    await dh(me.ikPriv, x.ek),
    await dh(spk.priv, x.ek),
  ];
  if (x.opk != null) parts.push(await dh(opkPriv, x.ek));
  const ikm = concat(...parts);
  const sk = await hkdf(ikm, ZERO32, 'khaneh-v2-x3dh', 32);
  parts.forEach(wipe); wipe(ikm);
  return {
    v: 2,
    sid: x.ek,
    ad: associatedData({ ik: x.ik, isk: x.isk }, { ik: me.ikPub, isk: me.iskPub }),
    rk: sk, cks: null, ckr: null,
    dhs: { priv: spk.priv, pub: spk.pub },
    dhr: null,
    ns: 0, nr: 0, pn: 0,
    skipped: {},
    pending: null,
    created: Date.now(),
    used: Date.now(),
  };
}

// ---------- کپی امن وضعیت (تا اگر باز کردن پیام شکست خورد، وضعیت اصلی دست نخورد) ----------
function cloneState(s) {
  const skipped = {};
  for (const [k, v] of Object.entries(s.skipped || {})) skipped[k] = { mk: v.mk.slice(), t: v.t };
  return {
    ...s,
    rk: s.rk.slice(),
    cks: s.cks ? s.cks.slice() : null,
    ckr: s.ckr ? s.ckr.slice() : null,
    dhs: { ...s.dhs },
    skipped,
    pending: s.pending ? { ...s.pending } : null,
  };
}

const aadFor = (st, headerBytes, extra) => concat(b64.to(st.ad), headerBytes, enc.encode(`|${extra}`));

// ---------- قفل کردن ----------
// خروجی: { state, envelope } — وضعیت جدید باید قبل از ارسال ذخیره شود.
export async function encrypt(state, plaintext, extraAad) {
  const st = cloneState(state);
  if (!st.cks) throw new Error('no-sending-chain');
  const [ck, mk] = await kdfCK(st.cks);
  wipe(st.cks);
  st.cks = ck;
  const header = { sid: st.sid, dh: st.dhs.pub, pn: st.pn, n: st.ns };
  if (st.pending) header.x = st.pending;
  st.ns += 1;
  st.used = Date.now();
  const hb = enc.encode(JSON.stringify(header));
  const { key, iv } = await messageCipher(mk);
  wipe(mk);
  const ct = new Uint8Array(await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: aadFor(st, hb, extraAad) }, key, enc.encode(plaintext)));
  return { state: st, envelope: JSON.stringify({ v: 2, h: b64.from(hb), c: b64.from(ct) }) };
}

// ---------- خواندن سرآیند (بدون باز کردن پیام) ----------
export function parseEnvelope(envelope) {
  const o = JSON.parse(envelope);
  if (o.v !== 2 || typeof o.h !== 'string' || typeof o.c !== 'string') throw new Error('bad-envelope');
  if (o.h.length > 4000 || !B64_RE.test(o.h) || !B64_RE.test(o.c)) throw new Error('bad-envelope');
  const hb = b64.to(o.h);
  const header = JSON.parse(dec.decode(hb));
  const intOk = (n) => Number.isSafeInteger(n) && n >= 0 && n < 1e7;
  if (!header || typeof header.sid !== 'string' || !intOk(header.n) || !intOk(header.pn)) throw new Error('bad-header');
  checkPub(header.sid);
  checkPub(header.dh);
  if (header.x) {
    const x = header.x;
    checkPub(x.ik); checkPub(x.isk); checkPub(x.ek);
    if (x.ek !== header.sid || !Number.isSafeInteger(x.spk) || !(x.opk === null || Number.isSafeInteger(x.opk))) throw new Error('bad-header');
  }
  return { header, hb, ct: b64.to(o.c) };
}

// ---------- باز کردن ----------
// خروجی: { state, plaintext } — اگر شکست بخورد خطا می‌دهد و وضعیت قبلی دست‌نخورده می‌ماند.
export async function decrypt(state, parsed, extraAad) {
  const { header, hb, ct } = parsed;
  if (header.sid !== state.sid) throw new Error('wrong-session');
  const st = cloneState(state);
  pruneSkipped(st);

  const skKey = `${header.dh}:${header.n}`;
  let mk;
  if (st.skipped[skKey]) {
    mk = st.skipped[skKey].mk;
    delete st.skipped[skKey];
  } else {
    if (header.dh !== st.dhr) {
      await skipKeys(st, header.pn);
      await dhRatchet(st, header.dh);
    }
    await skipKeys(st, header.n);
    const [ck, k] = await kdfCK(st.ckr);
    wipe(st.ckr);
    st.ckr = ck;
    st.nr += 1;
    mk = k;
  }

  const { key, iv } = await messageCipher(mk);
  wipe(mk);
  let pt;
  try {
    pt = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: aadFor(st, hb, extraAad) }, key, ct);
  } catch {
    throw new Error('decrypt-failed');
  }
  st.pending = null; // پاسخ طرف مقابل رسید؛ جلسه تأیید شد
  st.used = Date.now();
  return { state: st, plaintext: dec.decode(pt) };
}

async function skipKeys(st, until) {
  if (!st.ckr) return;
  if (until - st.nr > MAX_SKIP) throw new Error('too-many-skipped');
  while (st.nr < until) {
    const [ck, mk] = await kdfCK(st.ckr);
    wipe(st.ckr);
    st.ckr = ck;
    st.skipped[`${st.dhr}:${st.nr}`] = { mk, t: Date.now() };
    st.nr += 1;
  }
  const keys = Object.keys(st.skipped);
  if (keys.length > MAX_SKIPPED_TOTAL) {
    keys.sort((a, b) => st.skipped[a].t - st.skipped[b].t);
    for (const k of keys.slice(0, keys.length - MAX_SKIPPED_TOTAL)) { wipe(st.skipped[k].mk); delete st.skipped[k]; }
  }
}

function pruneSkipped(st) {
  const limit = Date.now() - SKIPPED_TTL;
  for (const [k, v] of Object.entries(st.skipped)) if (v.t < limit) { wipe(v.mk); delete st.skipped[k]; }
}

async function dhRatchet(st, theirPub) {
  st.pn = st.ns;
  st.ns = 0;
  st.nr = 0;
  st.dhr = theirPub;
  const out1 = await dh(st.dhs.priv, st.dhr);
  const [rk1, ckr] = await kdfRK(st.rk, out1);
  wipe(out1); wipe(st.rk);
  st.ckr = ckr;
  st.dhs = await generateDH(); // کلید خصوصی قبلی رها و نابود می‌شود
  const out2 = await dh(st.dhs.priv, st.dhr);
  const [rk2, cks] = await kdfRK(rk1, out2);
  wipe(out2); wipe(rk1);
  st.rk = rk2;
  st.cks = cks;
}
