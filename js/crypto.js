// ابزارهای پایه‌ی رمزنگاری «خانه»
// فقط از Web Crypto خود مرورگر استفاده می‌شود (بدون کتابخانه‌ی خارجی).
// پیام‌های گفتگو از فاز ۲ با Double Ratchet (فایل ratchet.js) قفل می‌شوند؛
// تابع‌های seal/open این فایل فقط برای قفل کردن شماره‌ی تلفن هنگام ثبت‌نام (برای مدیر) استفاده می‌شوند.
//
// روش seal:
// - هر گوشی دو کلید دائمی می‌سازد: ECDH (برای قفل کردن) و ECDSA (برای امضا).
//   کلیدهای خصوصی «غیرقابل‌خروج» ساخته می‌شوند و هیچ‌وقت از گوشی خارج نمی‌شوند.
// - برای هر پیام یک کلید یک‌بارمصرف ساخته می‌شود، با کلید عمومی گیرنده ترکیب می‌شود
//   (ECDH)، از آن با HKDF یک کلید AES-256-GCM ساخته می‌شود و پیام قفل می‌شود.
// - فرستنده پیام قفل‌شده را امضا می‌کند تا سرور نتواند خود را جای کسی جا بزند.
// - شناسه‌ی فرستنده، گیرنده و پیام به‌عنوان «داده‌ی همراه» در قفل گنجانده می‌شود
//   تا سرور نتواند پیام را به گفتگوی دیگری منتقل کند.

const subtle = globalThis.crypto.subtle;
export const enc = new TextEncoder();
export const dec = new TextDecoder();

const ECDH = { name: 'ECDH', namedCurve: 'P-256' };
const ECDSA = { name: 'ECDSA', namedCurve: 'P-256' };
const SIG = { name: 'ECDSA', hash: 'SHA-256' };
const INFO = enc.encode('khaneh-e2e-v1');

export const b64 = {
  from(u8) {
    let s = '';
    for (let i = 0; i < u8.length; i += 0x8000) s += String.fromCharCode(...u8.subarray(i, i + 0x8000));
    return btoa(s);
  },
  to(str) {
    const s = atob(str);
    const u = new Uint8Array(s.length);
    for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
    return u;
  },
};

export function concat(...parts) {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

export const rand = (n) => globalThis.crypto.getRandomValues(new Uint8Array(n));

export async function generateIdentity() {
  const ecdh = await subtle.generateKey(ECDH, false, ['deriveBits']);
  const sign = await subtle.generateKey(ECDSA, false, ['sign', 'verify']);
  return {
    ecdh,
    sign,
    ecdhPub: b64.from(new Uint8Array(await subtle.exportKey('raw', ecdh.publicKey))),
    signPub: b64.from(new Uint8Array(await subtle.exportKey('raw', sign.publicKey))),
  };
}

const pubCache = new Map();
async function importPub(b64key, algo, usages) {
  const k = algo.name + b64key;
  if (!pubCache.has(k)) pubCache.set(k, await subtle.importKey('raw', b64.to(b64key), algo, true, usages));
  return pubCache.get(k);
}

async function deriveKey(privateKey, publicKey, salt) {
  const bits = await subtle.deriveBits({ name: 'ECDH', public: publicKey }, privateKey, 256);
  const hk = await subtle.importKey('raw', bits, 'HKDF', false, ['deriveKey']);
  return subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt, info: INFO },
    hk,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

// قفل کردن یک شیء برای گیرنده
export async function seal(obj, recipientEcdhPub, aad, signingKey) {
  const eph = await subtle.generateKey(ECDH, false, ['deriveBits']);
  const epk = new Uint8Array(await subtle.exportKey('raw', eph.publicKey));
  const salt = rand(16);
  const iv = rand(12);
  const key = await deriveKey(eph.privateKey, await importPub(recipientEcdhPub, ECDH, []), salt);
  const ad = enc.encode(aad);
  const ct = new Uint8Array(await subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: ad }, key, enc.encode(JSON.stringify(obj)),
  ));
  const out = { v: 1, e: b64.from(epk), s: b64.from(salt), i: b64.from(iv), c: b64.from(ct) };
  if (signingKey) {
    const sig = await subtle.sign(SIG, signingKey, concat(epk, salt, iv, ct, ad));
    out.g = b64.from(new Uint8Array(sig));
  }
  return JSON.stringify(out);
}

// باز کردن پیام قفل‌شده با کلید خصوصی خودمان
export async function open(sealed, myEcdhPrivate, aad, senderSignPub) {
  const o = JSON.parse(sealed);
  if (o.v !== 1) throw new Error('unsupported');
  const epk = b64.to(o.e);
  const salt = b64.to(o.s);
  const iv = b64.to(o.i);
  const ct = b64.to(o.c);
  const ad = enc.encode(aad);
  if (senderSignPub) {
    if (!o.g) throw new Error('unsigned');
    const ok = await subtle.verify(SIG, await importPub(senderSignPub, ECDSA, ['verify']), b64.to(o.g), concat(epk, salt, iv, ct, ad));
    if (!ok) throw new Error('bad-signature');
  }
  const key = await deriveKey(myEcdhPrivate, await importPub(o.e, ECDH, []), salt);
  const pt = await subtle.decrypt({ name: 'AES-GCM', iv, additionalData: ad }, key, ct);
  return JSON.parse(dec.decode(pt));
}

function digits(hash, groups) {
  const out = [];
  for (let i = 0; i < groups; i++) {
    const n = ((hash[i * 2] << 8) | hash[i * 2 + 1]) % 10000;
    out.push(String(n).padStart(4, '0'));
  }
  return out.join(' ');
}

// اثر انگشت کلیدهای یک نفر
export async function fingerprint(ecdhPub, signPub) {
  const h = new Uint8Array(await subtle.digest('SHA-256', concat(b64.to(ecdhPub), b64.to(signPub))));
  return digits(h, 6);
}

// کد امنیتی مشترک یک گفتگو — برای هر دو طرف یکسان است
export async function safetyCode(a, b) {
  const pa = concat(b64.to(a.ecdhPub), b64.to(a.signPub));
  const pb = concat(b64.to(b.ecdhPub), b64.to(b.signPub));
  const [x, y] = b64.from(pa) < b64.from(pb) ? [pa, pb] : [pb, pa];
  const h = new Uint8Array(await subtle.digest('SHA-256', concat(x, y)));
  return digits(h, 12);
}

export const REG_AAD = 'khaneh-registration';

// ---------- قفل کردن فایل (ویس، ویدیو) ----------
// هر فایل یک کلید تصادفی یک‌بارمصرف می‌گیرد. فقط فایل قفل‌شده روی سرور می‌رود
// و کلید داخل یک پیام Double Ratchet به گیرنده می‌رسد.
const FILE_AAD = enc.encode('khaneh-file-v1');

export async function encryptFile(buf) {
  const keyBytes = rand(32);
  const iv = rand(12);
  const key = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['encrypt']);
  const ct = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: FILE_AAD }, key, buf));
  const out = { ct, key: b64.from(keyBytes), iv: b64.from(iv) };
  keyBytes.fill(0);
  return out;
}

export async function decryptFile(ct, keyB64, ivB64) {
  const keyBytes = b64.to(keyB64);
  const iv = b64.to(ivB64);
  if (keyBytes.length !== 32 || iv.length !== 12) throw new Error('bad-file-key');
  const key = await subtle.importKey('raw', keyBytes, 'AES-GCM', false, ['decrypt']);
  keyBytes.fill(0);
  return subtle.decrypt({ name: 'AES-GCM', iv, additionalData: FILE_AAD }, key, ct);
}
