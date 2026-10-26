// قفل برنامه و رمز اضطراری
//
// - «کلید داده» (۳۲ بایت تصادفی) همه‌ی پیام‌ها، مخاطبان و فایل‌های روی گوشی را قفل می‌کند.
// - بدون رمز قفل: کلید داده بدون محافظت در حافظه‌ی برنامه است (مثل اکثر پیام‌رسان‌ها).
// - با رمز قفل: کلید داده با کلیدی که از رمز ساخته می‌شود (PBKDF2-SHA256، ۳۱۰٬۰۰۰ دور) قفل می‌شود
//   و تا رمز درست وارد نشود، هیچ پیامی روی گوشی خوانا نیست.
// - رمز اضطراری: اگر به‌جای رمز اصلی وارد شود، برنامه خالی نشان داده می‌شود یا همه‌چیز پاک می‌شود،
//   و یک هشدار مخفی و رمزنگاری‌شده برای مدیر فرستاده می‌شود.
import { kv } from './store.js';

const subtle = globalThis.crypto.subtle;
const enc = new TextEncoder();
const ITER = 310_000;
const rand = (n) => crypto.getRandomValues(new Uint8Array(n));

async function pinKey(pin, salt) {
  const base = await subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits', 'deriveKey']);
  return subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, base,
    { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

async function pinCheck(pin, salt) {
  const base = await subtle.importKey('raw', enc.encode(pin), 'PBKDF2', false, ['deriveBits']);
  return new Uint8Array(await subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITER }, base, 256));
}

function equal(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}

const importData = (raw) => subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt']);

export async function state() {
  const dk = await kv.get('dk');
  if (!dk) return { exists: false, pin: false, emergency: null };
  return { exists: true, pin: dk.mode === 'pin', emergency: dk.em ? dk.em.action : null };
}

// برنامه بدون رمز قفل: کلید داده ساخته یا خوانده می‌شود
export async function openWithoutPin() {
  let dk = await kv.get('dk');
  if (!dk) { dk = { mode: 'open', raw: rand(32) }; await kv.set('dk', dk); }
  if (dk.mode !== 'open') throw new Error('pin-required');
  return importData(dk.raw);
}

async function throttle() {
  const f = (await kv.get('dkfails')) || { n: 0, until: 0 };
  if (f.until > Date.now()) return Math.ceil((f.until - Date.now()) / 1000);
  return 0;
}

async function failed() {
  const f = (await kv.get('dkfails')) || { n: 0, until: 0 };
  f.n += 1;
  if (f.n >= 10) f.until = Date.now() + 5 * 60_000;
  else if (f.n >= 5) f.until = Date.now() + 30_000;
  await kv.set('dkfails', f);
}

// نتیجه: { key } یا { emergency: 'decoy' | 'wipe' } یا { wait: ثانیه } یا { wrong: true }
export async function unlock(pin) {
  const wait = await throttle();
  if (wait) return { wait };
  const dk = await kv.get('dk');
  if (!dk || dk.mode !== 'pin') return { key: await openWithoutPin() };
  if (dk.em && equal(await pinCheck(pin, dk.em.salt), dk.em.check)) {
    await kv.del('dkfails');
    return { emergency: dk.em.action };
  }
  try {
    const raw = new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: dk.iv }, await pinKey(pin, dk.salt), dk.wrapped));
    const key = await importData(raw);
    raw.fill(0);
    await kv.del('dkfails');
    return { key };
  } catch {
    await failed();
    return { wrong: true };
  }
}

async function currentRaw(oldPin) {
  const dk = await kv.get('dk');
  if (!dk) throw new Error('no-key');
  if (dk.mode === 'open') return dk.raw;
  return new Uint8Array(await subtle.decrypt({ name: 'AES-GCM', iv: dk.iv }, await pinKey(oldPin, dk.salt), dk.wrapped));
}

// گذاشتن یا عوض کردن رمز قفل
export async function setPin(newPin, oldPin = null) {
  const dk = await kv.get('dk');
  let raw;
  try { raw = await currentRaw(oldPin); } catch { throw new Error('رمز فعلی اشتباه است'); }
  if (dk.em && equal(await pinCheck(newPin, dk.em.salt), dk.em.check)) throw new Error('رمز قفل نباید با رمز اضطراری یکی باشد');
  const salt = rand(16);
  const iv = rand(12);
  const wrapped = new Uint8Array(await subtle.encrypt({ name: 'AES-GCM', iv }, await pinKey(newPin, salt), raw));
  await kv.set('dk', { mode: 'pin', salt, iv, wrapped, em: dk.em || null });
  raw.fill(0);
}

export async function removePin(oldPin) {
  let raw;
  try { raw = await currentRaw(oldPin); } catch { throw new Error('رمز فعلی اشتباه است'); }
  await kv.set('dk', { mode: 'open', raw, em: null }); // بدون رمز قفل، رمز اضطراری هم معنا ندارد
}

export async function setEmergency(pin, action, mainPin) {
  const dk = await kv.get('dk');
  if (!dk || dk.mode !== 'pin') throw new Error('اول رمز قفل برنامه را بگذارید');
  if (pin === mainPin) throw new Error('رمز اضطراری باید با رمز قفل فرق داشته باشد');
  try { await currentRaw(mainPin); } catch { throw new Error('رمز قفل اشتباه است'); }
  const salt = rand(16);
  dk.em = { salt, check: await pinCheck(pin, salt), action: action === 'wipe' ? 'wipe' : 'decoy' };
  await kv.set('dk', dk);
}

export async function removeEmergency() {
  const dk = await kv.get('dk');
  if (dk) { dk.em = null; await kv.set('dk', dk); }
}
