// «خانه» — برنامه‌ی سمت گوشی (نسخه‌ی کامل)
import * as C from './crypto.js';
import * as secure from './secure.js';
import * as lock from './lock.js';
import { createCalls } from './calls.js';
import { Recorder, LIMITS, mediaSupported, unlockAudio, fmtDuration, cleanMime, openCamera, diagnoseCamera, requestMedia, camBroken } from './media.js';
import { kv, messages, contacts, media, commit, wipeDevice, persistentStorage, setDataKey, hasDataKey } from './store.js';
import { RELAY } from './config.js';
import { VERSION, FILES } from './version.js';

const $app = document.getElementById('app');

const S = {
  token: null,
  me: null,
  identity: null,
  status: null,
  view: null,
  chatId: null,
  contacts: new Map(),
  online: new Set(),
  lastSeen: new Map(),
  typing: new Map(),
  replyTo: null,
  outbox: new Map(),
  pendingRequests: 0,
  ws: null,
  connected: false,
  urls: [],
  speed: 1,
  composeMode: 'voice',
  directory: new Map(),
  seen: [],
  locked: false,
  decoy: false,
  hiddenAt: 0,
  serverAlerts: 0,
};
const isGroupId = (id) => typeof id === 'string';
const SECRET_TTL = 15 * 60; // فایل رمزدار: ۱۵ دقیقه (ثانیه)

// ---------- ابزارها ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const raw = (s) => ({ __raw: s });
function html(strings, ...vals) {
  let out = strings[0];
  vals.forEach((v, i) => {
    out += v && v.__raw !== undefined ? v.__raw : esc(v);
    out += strings[i + 1];
  });
  return out;
}
const join = (arr) => raw(arr.join(''));
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : C.b64.from(crypto.getRandomValues(new Uint8Array(16))).replace(/[^A-Za-z0-9]/g, 'x'));
const toLatinDigits = (s) => String(s).replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));
const isTouch = matchMedia('(pointer: coarse)').matches;

const fmtTime = new Intl.DateTimeFormat('fa-IR', { hour: '2-digit', minute: '2-digit' });
const fmtDay = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { day: 'numeric', month: 'long' });
const fmtDayYear = new Intl.DateTimeFormat('fa-IR-u-ca-persian', { day: 'numeric', month: 'long', year: 'numeric' });
const dayKey = (ts) => new Date(ts).toDateString();
function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const yest = new Date(Date.now() - 864e5);
  if (d.toDateString() === today.toDateString()) return 'امروز';
  if (d.toDateString() === yest.toDateString()) return 'دیروز';
  return d.getFullYear() === today.getFullYear() ? fmtDay.format(d) : fmtDayYear.format(d);
}
function shortTime(ts) {
  if (!ts) return '';
  return dayKey(ts) === dayKey(Date.now()) ? fmtTime.format(ts) : fmtDay.format(ts);
}
function lastSeenText(ts) {
  if (!ts) return 'آخرین بازدید: خیلی وقت پیش';
  if (Date.now() - ts < 60_000) return 'همین الان آنلاین بود';
  return `آخرین بازدید ${dayLabel(ts)} ساعت ${fmtTime.format(ts)}`;
}

const PHOTO_RE = /^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/;
function avatar(c, size = '') {
  const photo = c?.photo || (c && S.me && c.id === S.me.id ? S.myPhoto : null);
  if (photo && PHOTO_RE.test(photo)) return html`<img class="avatar ${size}" src="${photo}" alt="">`;
  const letter = (c?.name || '?').trim().charAt(0);
  const tone = (Number(c?.id) || 0) % 8;
  return html`<span class="avatar tone-${tone} ${size}" aria-hidden="true">${letter}</span>`;
}

// آیکون‌ها
const I = {
  star: '<svg viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor"><rect x="5" y="5" width="14" height="14"/><rect x="5" y="5" width="14" height="14" transform="rotate(45 12 12)"/></g><circle class="hole" cx="12" cy="12" r="2.6"/></svg>',
  back: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M9 5l7 7-7 7" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  menu: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="5" r="1.8" fill="currentColor"/><circle cx="12" cy="12" r="1.8" fill="currentColor"/><circle cx="12" cy="19" r="1.8" fill="currentColor"/></svg>',
  send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12L4 4l2.5 8L4 20z" fill="currentColor" transform="rotate(180 12 12)"/></svg>',
  mic: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  cam: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="none" stroke="currentColor" stroke-width="2"/><circle cx="12" cy="12" r="3.5" fill="currentColor"/></svg>',
  trash: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 13h8l1-13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  play: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13l11-6.5z" fill="currentColor"/></svg>',
  pause: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="5" width="3.6" height="14" rx="1" fill="currentColor"/><rect x="13.4" y="5" width="3.6" height="14" rx="1" fill="currentColor"/></svg>',
  close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  lock: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="10" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8.5 10.5V8a3.5 3.5 0 017 0v2.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>',
  shield: '<svg class="shield" viewBox="0 0 24 24" aria-label="کد امنیتی تأیید شده"><path d="M12 3l7 3v5c0 4.5-3 8.3-7 10-4-1.7-7-5.5-7-10V6z" fill="currentColor"/><path d="M8.5 12l2.4 2.4 4.6-4.8" class="shield-check" fill="none" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  up: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 14l5-5 5 5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  mute: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M16 9.5l5 5M21 9.5l-5 5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  clock: '<svg class="tick" viewBox="0 0 16 16" aria-label="در حال ارسال"><circle cx="8" cy="8" r="5.5" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 5v3.2l2 1.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
  one: '<svg class="tick" viewBox="0 0 16 16" aria-label="ارسال شد"><path d="M3 8.5l3 3 7-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  two: '<svg class="tick" viewBox="0 0 20 16" aria-label="رسید"><path d="M1.5 8.5l3 3 7-7M8 11.5l7-7" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  fail: '<svg class="tick" viewBox="0 0 16 16" aria-label="ارسال نشد"><circle cx="8" cy="8" r="6" fill="currentColor"/><path d="M8 4.5v4.2M8 11v.2" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>',
  phone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.6 3.5l2.6 3.1-1.4 2.3c1.2 2.5 3 4.3 5.4 5.4l2.3-1.4 3.1 2.6-1.5 3c-7.3-.4-12.9-6-13.3-13.3z" fill="currentColor"/></svg>',
  video: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="2.5" y="6.5" width="13" height="11" rx="2.5" fill="currentColor"/><path d="M16 11l5.5-3.5v9L16 13z" fill="currentColor"/></svg>',
  clip: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M16.5 7.5l-7.8 7.8a2.2 2.2 0 003.1 3.1l8-8a4 4 0 00-5.7-5.7l-8.2 8.2a5.8 5.8 0 008.2 8.2l6.6-6.6" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"/></svg>',
  group: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="8" r="3.4" fill="currentColor"/><circle cx="17" cy="9.5" r="2.6" fill="currentColor"/><path d="M2.5 19.5c.6-3.6 3.2-5.5 6.5-5.5s5.9 1.9 6.5 5.5zM15.5 19.5c-.2-1.6-.8-3-1.8-4 1-.5 2-.7 3.3-.7 2.6 0 4.3 1.6 4.8 4.7z" fill="currentColor"/></svg>',
  megaphone: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 10v4h3l7 4.5V5.5L6 10z" fill="currentColor"/><path d="M16.5 8.5a5 5 0 010 7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  bookmark: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6.5 3.5h11v17l-5.5-4-5.5 4z" fill="currentColor"/></svg>',
  photo: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="4.5" width="18" height="15" rx="2.5" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="9" cy="10" r="1.8" fill="currentColor"/><path d="M4 18l5-5 3.5 3.5L16 13l4 4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
  search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="10.5" cy="10.5" r="6.5" fill="none" stroke="currentColor" stroke-width="2"/><path d="M15.5 15.5L20 20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
  file: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 2.5h8l4.5 4.5v14.5H6z" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><rect x="9" y="12" width="6" height="5" rx="1" fill="currentColor"/><path d="M10.2 12v-1.3a1.8 1.8 0 013.6 0V12" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  ok: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M7.5 12.5l3 3 6-6.5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  warn: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="10" fill="currentColor"/><path d="M12 7v6M12 16.5v.3" stroke="#fff" stroke-width="2.2" stroke-linecap="round"/></svg>',
};

// ---------- ارتباط با سرور ----------
const relayUrl = (path) => (RELAY || '') + path;
function authHeaders() { return S.token ? { Authorization: `Bearer ${S.token}` } : {}; }

async function api(path, body) {
  const opts = { method: body === undefined ? 'GET' : 'POST', headers: authHeaders(), credentials: 'omit', cache: 'no-store' };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  let res;
  try { res = await fetch(relayUrl(path), opts); } catch { throw Object.assign(new Error('اتصال به سرور برقرار نشد'), { offline: true }); }
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && S.token && path !== '/api/password') {
    await logout(false);
    toast('لطفاً دوباره وارد شوید');
    throw new Error(data.error || 'نشست منقضی شد');
  }
  if (!res.ok) throw Object.assign(new Error(data.error || 'خطایی رخ داد'), { status: res.status });
  return data;
}

// گیرنده‌ها و مدت نگهداری در سرآیند فرستاده می‌شوند، نه در آدرس (تا در لاگ سرور ثبت نشوند)
async function uploadBlob(toList, bytes, ttl = 0) {
  let res;
  const headers = { ...authHeaders(), 'Content-Type': 'application/octet-stream', 'X-Khaneh-To': toList.join(',') };
  if (ttl) headers['X-Khaneh-TTL'] = String(ttl);
  try {
    res = await fetch(relayUrl('/api/blob'), {
      method: 'POST', headers,
      body: bytes, credentials: 'omit', cache: 'no-store',
    });
  } catch { throw Object.assign(new Error('اتصال به سرور برقرار نشد'), { offline: true }); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || 'ارسال فایل انجام نشد'), { status: res.status });
  return data.id;
}

async function downloadBlob(id) {
  let res;
  try {
    res = await fetch(relayUrl('/api/blob/get'), {
      method: 'POST', headers: { ...authHeaders(), 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }), credentials: 'omit', cache: 'no-store',
    });
  }
  catch { throw Object.assign(new Error('offline'), { offline: true }); }
  if (res.status === 404) throw Object.assign(new Error('gone'), { gone: true });
  if (!res.ok) throw new Error('download-failed');
  return new Uint8Array(await res.arrayBuffer());
}

// ---------- پیام‌های کوتاه و پنجره‌ها ----------
function toast(text) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.setAttribute('role', 'status');
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.classList.add('out'), 2600);
  setTimeout(() => el.remove(), 3000);
}

function sheet(contentHtml, { onMount } = {}) {
  const wrap = document.createElement('div');
  wrap.className = 'sheet-wrap';
  wrap.innerHTML = `<div class="sheet" role="dialog" aria-modal="true">${contentHtml}</div>`;
  const close = () => { wrap.classList.add('closing'); setTimeout(() => wrap.remove(), 180); };
  wrap.addEventListener('click', (e) => { if (e.target === wrap) close(); });
  document.body.appendChild(wrap);
  onMount?.(wrap.querySelector('.sheet'), close);
  return close;
}

function confirmBox(title, text, okLabel, danger = false) {
  return new Promise((resolve) => {
    let done = false;
    sheet(html`
      <h2 class="sheet-title">${title}</h2>
      ${text ? raw(html`<p class="sheet-text">${text}</p>`) : raw('')}
      <div class="sheet-actions">
        <button class="btn ${danger ? 'danger' : 'primary'}" data-ok>${okLabel}</button>
        <button class="btn ghost" data-cancel>انصراف</button>
      </div>`, {
      onMount(el, close) {
        el.querySelector('[data-ok]').onclick = () => { done = true; close(); resolve(true); };
        el.querySelector('[data-cancel]').onclick = () => { close(); };
        const obs = new MutationObserver(() => { if (!el.isConnected) { obs.disconnect(); if (!done) resolve(false); } });
        obs.observe(document.body, { childList: true });
      },
    });
  });
}

function setView(name, markup) {
  if (S.view === 'chat' && name !== 'chat') stopAudio();
  S.urls.forEach((u) => URL.revokeObjectURL(u));
  S.urls = [];
  S.view = name;
  $app.innerHTML = markup;
  $app.dataset.view = name;
}

function formError(form, msg) {
  const el = form.querySelector('.form-error');
  el.textContent = msg || '';
  el.hidden = !msg;
}

async function busy(btn, fn) {
  btn.disabled = true;
  btn.classList.add('loading');
  try { return await fn(); } finally { btn.disabled = false; btn.classList.remove('loading'); }
}

// ---------- کلیدها و نشست ----------
async function saveIdentity(identity, userId) {
  const rec = {
    userId,
    ecdhPriv: identity.ecdh.privateKey,
    signPriv: identity.sign.privateKey,
    ecdhPub: identity.ecdhPub,
    signPub: identity.signPub,
  };
  await kv.set('identity', rec);
  await kv.del('prekeys');
  S.identity = rec;
}

async function ensureIdentity(user) {
  let local = await kv.get('identity');
  if (local && local.userId !== user.id) {
    // این گوشی قبلاً برای حساب دیگری استفاده شده؛ اطلاعات آن حساب پاک می‌شود
    await wipeDevice();
    local = null;
  }
  if (!local) {
    const id = await C.generateIdentity();
    await api('/api/keys', { ecdhPub: id.ecdhPub, signPub: id.signPub });
    await saveIdentity(id, user.id);
    return;
  }
  if (local.ecdhPub !== user.ecdhPub || local.signPub !== user.signPub) {
    // حساب روی گوشی دیگری هم وارد شده بود؛ این گوشی دوباره گوشی اصلی می‌شود
    await api('/api/keys', { ecdhPub: local.ecdhPub, signPub: local.signPub });
    // سرور پیش‌کلیدها را پاک کرده؛ syncPrekeys از روی وضعیت سرور دوباره می‌فرستد
  }
  S.identity = local;
}

async function startSession(token, user) {
  S.token = token;
  await ensureIdentity(user);
  S.me = { ...user, ecdhPub: S.identity.ecdhPub, signPub: S.identity.signPub };
  await kv.set('session', { token, user: S.me });
  if (!(await openData())) return;
  await enterApp();
}

async function logout(callServer = true) {
  if (callServer && S.token) { try { await api('/api/logout', {}); } catch { /* ignore */ } }
  await kv.del('session').catch(() => {});
  S.token = null;
  S.me = null;
  S.connected = false;
  const ws = S.ws;
  S.ws = null;
  ws?.close();
  showWelcome();
}

async function syncPrekeys() {
  try { await secure.ensurePrekeys(); } catch (e) { console.warn('prekeys', e); }
}

// ---------- مخاطبان، گروه‌ها و کانال‌ها ----------
// شناسه‌ی گفتگو: عدد = گفتگوی دونفره، 'g:…' = گروه، 'c:…' = کانال، 'official' = کانال رسمی اپ
async function fetchContact(id) {
  const u = await api(`/api/user?id=${encodeURIComponent(id)}`);
  return applyUser(u);
}

async function applyUser(u) {
  const old = S.contacts.get(u.id) || (await contacts.get(u.id));
  const fp = u.ecdhPub && u.signPub ? await C.fingerprint(u.ecdhPub, u.signPub) : null;
  const c = {
    lastText: '', lastTs: 0, unread: 0, keyChanged: false, verified: false,
    ...old,
    id: u.id, username: u.username, name: u.name,
    ecdhPub: u.ecdhPub, signPub: u.signPub, fp, blocked: u.blocked,
  };
  if (old && old.fp && fp && old.fp !== fp) {
    // کلید هویت عوض شده: جلسه‌های قبلی کنار گذاشته می‌شوند و هشدار داده می‌شود
    c.keyChanged = true;
    c.verified = false;
    await secure.dropSessions(c.id);
    await messages.put({
      id: `sys-${uid()}`, chatId: c.id, mine: false, kind: 'system', ts: Date.now(),
      text: `کد امنیتی ${c.name} تغییر کرد. ممکن است گوشی‌اش را عوض کرده باشد. برای اطمینان، کد امنیتی را حضوری با او مقایسه کنید.`,
    });
  }
  if (u.online !== undefined) { if (u.online) S.online.add(u.id); else S.online.delete(u.id); }
  if (u.lastSeen) S.lastSeen.set(u.id, u.lastSeen);
  S.contacts.set(c.id, c);
  await contacts.put(c);
  return c;
}

async function getContact(id) {
  if (isGroupId(id)) return S.contacts.get(id) || null;
  return S.contacts.get(id) || (await contacts.get(id)) || fetchContact(id);
}

async function saveContact(c) {
  S.contacts.set(c.id, c);
  await contacts.put(c);
}

const nameOf = (id) => (id === S.me?.id ? 'شما' : (S.contacts.get(id)?.name || S.directory.get(id)?.name || 'کاربر'));

async function loadDirectory() {
  try {
    const list = await api('/api/directory');
    S.directory = new Map(list.map((u) => [u.id, u]));
    const admin = list.find((u) => u.isAdmin);
    if (admin) await kv.set('adminContact', { id: admin.id, name: admin.name, ecdhPub: admin.ecdhPub, signPub: admin.signPub });
    for (const u of list) if (u.online) S.online.add(u.id);
  } catch { /* بدون اتصال؛ از اطلاعات قبلی استفاده می‌شود */ }
}

// پیام‌های ذخیره‌شده: فقط روی همین گوشی، قفل‌شده؛ هیچ‌وقت به سرور فرستاده نمی‌شود
async function ensureSaved() {
  if (!S.contacts.get('saved')) {
    await saveContact({ id: 'saved', type: 'saved', name: 'پیام‌های ذخیره‌شده', lastText: 'یادداشت، عکس و فایل برای خودتان', lastTs: 2, unread: 0 });
  }
}
const isSaved = (chat) => chat?.type === 'saved';

async function ensureOfficial() {
  if (!S.contacts.get('official')) {
    await saveContact({ id: 'official', type: 'official', name: 'کانال رسمی خانه', lastText: 'اطلاعیه‌های مدیر اینجا می‌آید', lastTs: 1, unread: 0, muted: false });
  }
}

const isAdminUser = (id) => !!S.directory.get(id)?.isAdmin;
function canPost(chat) {
  if (!chat || !chat.type) return true;
  if (chat.type === 'official') return !!S.me?.isAdmin;
  if (chat.type === 'channel') return (chat.admins || []).includes(S.me.id);
  if (chat.type === 'group') return (chat.members || []).includes(S.me.id) && !chat.left;
  return true;
}
function recipientsOf(chat) {
  if (isSaved(chat)) return [];
  if (!isGroupId(chat.id)) return [chat.id];
  if (chat.type === 'official') return [...S.directory.keys()].filter((id) => id !== S.me.id);
  return (chat.members || []).filter((id) => id !== S.me.id);
}

// ---------- اتصال زنده ----------
let wsRetry = 0;
let wsTimer = null;
function wsUrl() {
  if (RELAY) return RELAY.replace(/^http/, 'ws') + '/ws';
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}
function connectWS() {
  if (!S.token) return;
  clearTimeout(wsTimer);
  let ws;
  try { ws = new WebSocket(wsUrl()); } catch { wsTimer = setTimeout(connectWS, 5000); return; }
  S.ws = ws;
  ws.onopen = () => ws.send(JSON.stringify({ t: 'auth', token: S.token }));
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    onWs(m).catch((err) => console.error(err));
  };
  ws.onclose = () => {
    if (S.ws !== ws) return;
    S.connected = false;
    updateConnState();
    if (!S.token || S.locked) return;
    wsTimer = setTimeout(connectWS, Math.min(15000, 800 * 2 ** wsRetry++));
  };
}
function closeWS() {
  clearTimeout(wsTimer);
  const ws = S.ws;
  S.ws = null;
  S.connected = false;
  ws?.close();
}

function wsSend(obj) {
  if (S.ws && S.ws.readyState === 1 && S.connected) {
    S.ws.send(JSON.stringify(obj));
    return true;
  }
  return false;
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') { S.hiddenAt = Date.now(); return; }
  if (!S.token || S.locked || S.decoy) return;
  if (S.pinSet && S.hiddenAt && Date.now() - S.hiddenAt > 60_000) { lockNow(); return; }
  if (!S.ws || S.ws.readyState > 1) { wsRetry = 0; connectWS(); }
  if (S.view === 'chat') markRead(S.chatId);
});
window.addEventListener('online', () => { if (S.token && !S.locked && (!S.ws || S.ws.readyState > 1)) { wsRetry = 0; connectWS(); } });

let incoming = Promise.resolve();
async function onWs(m) {
  if (!hasDataKey()) {
    // برنامه قفل است (یا حالت اضطراری): فقط تأیید ارسال پیام‌های خروجی پردازش می‌شود
    if (m.t === 'ready') { S.connected = true; flushOutbox(); }
    if (m.t === 'sent') { S.outbox.delete(m.id); persistOutbox(); S.onSent?.(m.id); }
    return;
  }
  switch (m.t) {
    case 'ready':
      S.connected = true;
      wsRetry = 0;
      updateConnState();
      flushOutbox();
      syncPrekeys();
      loadDirectory();
      retryPending();
      if (S.me?.isAdmin) refreshPendingCount();
      if (S.view === 'chat') { if (!isGroupId(S.chatId)) refreshPeer(S.chatId); markRead(S.chatId); }
      break;
    case 'msg':
      incoming = incoming.then(() => handleIncoming(m)).catch((e) => console.error(e));
      break;
    case 'sent':
      S.outbox.delete(m.id);
      persistOutbox();
      await setStatus(m.id, 'sent');
      break;
    case 'delivered':
      await setStatus(m.id, 'delivered');
      break;
    case 'read':
      for (const id of m.ids || []) await setStatus(id, 'read');
      break;
    case 'error':
      if (m.id) { S.outbox.delete(m.id); persistOutbox(); await setStatus(m.id, 'failed'); }
      toast(m.error || 'پیام ارسال نشد');
      break;
    case 'typing':
      S.typing.set(m.from, Date.now() + 4000);
      if (S.view === 'chat' && S.chatId === m.from) {
        renderPeerStatus();
        setTimeout(renderPeerStatus, 4100);
      }
      break;
    case 'presence':
      if (m.online) S.online.add(m.id);
      else { S.online.delete(m.id); if (m.lastSeen) S.lastSeen.set(m.id, m.lastSeen); }
      S.typing.delete(m.id);
      if (S.view === 'chat' && S.chatId === m.id) renderPeerStatus();
      break;
    case 'keys':
      loadDirectory();
      if (S.contacts.has(m.id)) {
        await fetchContact(m.id);
        if (S.view === 'chat' && S.chatId === m.id) openChat(m.id, false);
      }
      break;
    case 'user_joined':
      await loadDirectory();
      if (S.myPhoto) sendProfile([m.id]);
      break;
    case 'reg_request':
      toast('درخواست عضویت جدید رسید');
      refreshPendingCount();
      break;
    case 'server_alert':
      S.serverAlerts += 1;
      toast(m.text);
      if (navigator.vibrate) navigator.vibrate([200, 100, 200]);
      if (S.view === 'admin') renderAdmin();
      break;
    case 'cmd':
      incoming = incoming.then(() => handleCommand(m)).catch((e) => console.error(e));
      break;
    case 'auth_fail':
      await logout(false);
      toast('از حساب خارج شدید');
      break;
    default:
  }
}

const ackQueue = [];
let ackTimer = null;
function ack(id) {
  ackQueue.push(id);
  clearTimeout(ackTimer);
  ackTimer = setTimeout(() => {
    const ids = ackQueue.splice(0);
    if (ids.length && !wsSend({ t: 'ack', ids })) ackQueue.unshift(...ids);
  }, 60);
}

// ---------- بررسی محتوای پیام رسیده ----------
const BLOB_RE = /^[A-Za-z0-9_-]{22,64}$/;
const B64_RE = /^[A-Za-z0-9+/]+={0,2}$/;
const MID_RE = /^[A-Za-z0-9-]{8,48}$/;
function b64Len(s) { try { return typeof s === 'string' && B64_RE.test(s) ? C.b64.to(s).length : -1; } catch { return -1; } }
function blobOk(b) { return b && BLOB_RE.test(String(b.id)) && b64Len(b.key) === 32 && b64Len(b.iv) === 12; }

function recordFromContent(content, id, chatId, from, ts) {
  const base = { id, chatId, from, mine: false, ts, status: 'recv', readSent: false };
  const replyTo = typeof content.replyTo === 'string' && content.replyTo.length <= 64 ? content.replyTo : null;
  if (content.type === 'text' && typeof content.text === 'string') {
    return { ...base, kind: 'text', text: content.text.slice(0, 10000), replyTo };
  }
  if (content.type === 'voice' || content.type === 'vnote') {
    const mime = cleanMime(content.mime);
    const dur = Number(content.dur);
    const size = Number(content.size);
    const ok = blobOk(content.blob) && mime && Number.isFinite(dur) && dur >= 0 && dur <= 600
      && Number.isSafeInteger(size) && size > 0 && size <= LIMITS.maxBytes;
    if (!ok) return null;
    const wave = Array.isArray(content.wave) ? content.wave.slice(0, 64).map((v) => Math.max(0, Math.min(31, Number(v) | 0))) : [];
    const b = content.blob;
    return { ...base, kind: content.type, dur, size, mime, wave, replyTo, media: 'pending', blob: { id: b.id, key: b.key, iv: b.iv } };
  }
  if (content.type === 'photo') {
    const size = Number(content.size);
    const w = Number(content.w) | 0;
    const h = Number(content.h) | 0;
    if (!blobOk(content.blob) || content.mime !== 'image/jpeg' || !Number.isSafeInteger(size) || size <= 0 || size > FILE_MAX
      || w < 1 || h < 1 || w > 10000 || h > 10000) return null;
    const b = content.blob;
    return { ...base, kind: 'photo', mime: 'image/jpeg', size, w, h, replyTo, media: 'pending', blob: { id: b.id, key: b.key, iv: b.iv } };
  }
  if (content.type === 'file') {
    const size = Number(content.size);
    const mime = typeof content.mime === 'string' && /^[a-z0-9.+-]{1,40}\/[a-z0-9.+-]{1,80}$/i.test(content.mime) ? content.mime : 'application/octet-stream';
    const name = cleanFileName(content.name);
    if (!blobOk(content.blob) || !Number.isSafeInteger(size) || size <= 0 || size > FILE_MAX) return null;
    const b = content.blob;
    return { ...base, kind: 'file', mime, size, name, replyTo, media: 'pending', blob: { id: b.id, key: b.key, iv: b.iv } };
  }
  if (content.type === 'sfile' && !isGroupId(chatId)) {
    const size = Number(content.size);
    const mime = typeof content.mime === 'string' && /^(image|video)\/[a-z0-9.+-]{1,40}$/i.test(content.mime) ? content.mime : null;
    if (!blobOk(content.blob) || !mime || !Number.isSafeInteger(size) || size <= 0 || size > SECRET_MAX) return null;
    const b = content.blob;
    return { ...base, kind: 'sfile', mime, size, exp: ts + SECRET_TTL * 1000, state: 'available', blob: { id: b.id, key: b.key, iv: b.iv } };
  }
  return null;
}

const lastResync = new Map();
async function requestResync(contact) {
  const t = lastResync.get(contact.id) || 0;
  if (Date.now() - t < 60_000) return;
  lastResync.set(contact.id, Date.now());
  try { await encryptAndQueue(contact, uid(), { type: 'resync' }, { silentKeyChange: true }); } catch { /* ignore */ }
}

// پیام‌های گروهی/کانال: فقط از اعضای مجاز پذیرفته می‌شوند
function groupTarget(content, from) {
  if (content.kind === 'official') return isAdminUser(from) ? 'official' : null;
  if (typeof content.grp !== 'string' || !MID_RE.test(content.grp)) return null;
  const id = (content.kind === 'channel' ? 'c:' : 'g:') + content.grp;
  const chat = S.contacts.get(id);
  if (!chat || chat.left) return null;
  if (chat.type === 'channel' && !(chat.admins || []).includes(from)) return null;
  if (!(chat.members || []).includes(from)) return null;
  return id;
}

async function handleIncoming({ id, from, payload, ts }) {
  if (S.seen.includes(id) || (await messages.get(id))) { ack(id); return; }
  if (!S.directory.size || !S.directory.has(from)) await loadDirectory(); // برای بررسی مدیر و اعضا لازم است
  let c;
  try { c = await getContact(from); } catch { return; } // بعداً دوباره تحویل داده می‌شود

  let rec = null;
  let content = null;
  const build = (ct) => {
    content = ct;
    rec = null;
    const seen = [...S.seen, id].slice(-500);
    const ops = [{ store: 'kv', key: 'seen', put: seen }];
    if (ct && (ct.grp || ct.kind === 'official') && ['text', 'voice', 'vnote', 'photo', 'file'].includes(ct.type)) {
      const target = groupTarget(ct, from);
      if (target && typeof ct.mid === 'string' && MID_RE.test(ct.mid)) rec = recordFromContent(ct, ct.mid, target, from, ts);
    } else if (ct && !ct.grp && ct.kind !== 'official') {
      rec = recordFromContent(ct, id, from, from, ts);
    }
    if (rec) ops.push({ store: 'messages', put: rec });
    return ops;
  };
  try {
    await secure.decryptFrom(S.me.id, c, payload, id, build);
  } catch (e) {
    if (String(e.message).includes('identity-mismatch')) {
      try { c = await fetchContact(from); await secure.decryptFrom(S.me.id, c, payload, id, build); } catch { content = null; }
    } else content = null;
    if (!content) {
      const err = { id, chatId: from, mine: false, kind: 'error', ts };
      await messages.put(err);
      await bumpChat(c, 'پیام قابل باز شدن نبود', ts, true);
      ack(id);
      if (S.view === 'chat' && S.chatId === from) appendMessage(err);
      else if (S.view === 'chats') renderChatList();
      requestResync(c);
      return;
    }
  }
  S.seen = [...S.seen, id].slice(-500);
  ack(id);

  if (rec) {
    const chat = await getContact(rec.chatId);
    const viewing = S.view === 'chat' && S.chatId === rec.chatId && document.visibilityState === 'visible';
    const pv = isGroupId(rec.chatId) && chat.type !== 'official' ? `${nameOf(from)}: ${previewText(rec)}` : previewText(rec);
    await bumpChat(chat, pv, ts, !viewing);
    if (!isGroupId(rec.chatId)) S.typing.delete(from);
    if (S.view === 'chat' && S.chatId === rec.chatId) {
      appendMessage(rec);
      renderPeerStatus();
      if (viewing) markRead(rec.chatId);
    } else {
      if (S.view === 'chats') renderChatList();
      if (navigator.vibrate && !chat.muted) navigator.vibrate(30);
    }
    if (MEDIA_KINDS.includes(rec.kind)) fetchMedia(rec);
    updateTitle();
    return;
  }

  switch (content.type) {
    case 'call':
      calls.handle(from, content.sig, ts);
      break;
    case 'alert':
      if (S.me.isAdmin && content.kind === 'emergency') {
        const sys = { id: `sys-${uid()}`, chatId: from, mine: false, kind: 'system', ts, text: `⚠️ ${c.name} رمز اضطراری را وارد کرد. ممکن است در خطر باشد.` };
        await messages.put(sys);
        await bumpChat(c, sys.text, ts, true);
        toast(sys.text);
        if (navigator.vibrate) navigator.vibrate([300, 100, 300, 100, 300]);
        if (S.view === 'chat' && S.chatId === from) appendMessage(sys);
        else if (S.view === 'chats') renderChatList();
      }
      break;
    case 'profile':
      await applyProfile(c, content);
      break;
    case 'profile_req':
      if (Date.now() - (profileReplies.get(from) || 0) > 60_000) { profileReplies.set(from, Date.now()); sendProfile([from]); }
      break;
    case 'gstate':
      await applyGroupState(from, content.group);
      break;
    case 'gleave':
      await applyGroupLeave(from, content);
      break;
    case 'delete': {
      if (typeof content.target !== 'string') break;
      const chatId = content.grp || content.kind === 'official' ? groupTarget(content, from) : from;
      const target = chatId != null ? await messages.get(content.target) : null;
      if (target && target.chatId === chatId && !target.mine && (target.from === from || target.chatId === from)) {
        await removeMessageLocal(target);
        if (target.blob) api('/api/blob/done', { id: target.blob.id }).catch(() => {});
        if (S.view === 'chats') renderChatList();
      }
      break;
    }
    default:
      // 'resync' و انواع ناشناخته: فقط جلسه به‌روز می‌شود
  }
}

// ---------- عکس پروفایل (رمزنگاری‌شده برای هر عضو فرستاده می‌شود) ----------
const profileReplies = new Map();
function validPhoto(p) {
  if (p === null) return true;
  if (typeof p !== 'string' || p.length > 120_000 || !PHOTO_RE.test(p)) return false;
  try { const b = C.b64.to(p.slice(23, 31)); return b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff; } catch { return false; }
}

async function applyProfile(c, content) {
  if (!c || !validPhoto(content.photo) || !Number.isFinite(content.v)) return;
  if ((c.photoV || 0) >= content.v) return;
  c.photo = content.photo;
  c.photoV = content.v;
  await saveContact(c);
  if (S.view === 'chats') renderChatList();
  if (S.view === 'chat' && S.chatId === c.id) {
    const el = $app.querySelector('.peer .avatar');
    if (el) el.outerHTML = avatar(c);
  }
}

async function sendProfile(targets) {
  const mine = await kv.get('myPhoto');
  if (!mine) return;
  for (const id of targets) {
    if (id === S.me.id) continue;
    try { await encryptAndQueue(await getContact(id), uid(), { type: 'profile', photo: mine.photo, v: mine.v }, { silentKeyChange: true }); } catch { /* بعداً */ }
  }
}

async function makeAvatar(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('این عکس قابل خواندن نیست'));
      i.src = url;
    });
    const side = Math.min(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = canvas.height = 256;
    canvas.getContext('2d').drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, 256, 256);
    for (const q of [0.82, 0.7, 0.55]) {
      const d = canvas.toDataURL('image/jpeg', q);
      if (d.length < 100_000) return d;
    }
    throw new Error('عکس خیلی بزرگ است');
  } finally { URL.revokeObjectURL(url); }
}

async function setMyPhoto(photo) {
  const rec = { photo, v: Date.now() };
  await kv.set('myPhoto', rec);
  S.myPhoto = photo;
  if (!S.directory.size) await loadDirectory();
  sendProfile([...S.directory.keys()]); // اطلاعات پروفایل هم رمزنگاری‌شده فرستاده می‌شود
}

// ---------- گروه و کانال: وضعیت (اعضا، مدیران، نام) با پیام رمزشده پخش می‌شود ----------
function cleanGroup(g) {
  if (!g || typeof g.gid !== 'string' || !MID_RE.test(g.gid)) return null;
  const ids = (a) => (Array.isArray(a) ? [...new Set(a.map(Number).filter((n) => Number.isSafeInteger(n) && n > 0))].slice(0, 100) : []);
  const name = typeof g.name === 'string' ? g.name.trim().slice(0, 40) : '';
  if (!name || !['group', 'channel'].includes(g.kind)) return null;
  return { gid: g.gid, kind: g.kind, name, members: ids(g.members), admins: ids(g.admins), owner: Number(g.owner), v: Number(g.v) || 0 };
}

async function applyGroupState(from, raw) {
  const g = cleanGroup(raw);
  if (!g) return;
  const id = (g.kind === 'channel' ? 'c:' : 'g:') + g.gid;
  const cur = S.contacts.get(id);
  if (cur) {
    if (!(cur.admins || []).includes(from) || g.v <= (cur.v || 0)) return; // فقط مدیر فعلی می‌تواند تغییر دهد
  } else if (g.owner !== from || !g.admins.includes(from)) return;
  const removed = cur && (cur.members || []).includes(S.me.id) && !g.members.includes(S.me.id);
  const chat = {
    lastText: '', lastTs: Date.now(), unread: 0, ...cur,
    id, type: g.kind, gid: g.gid, name: g.name, members: g.members, admins: g.admins, owner: g.owner, v: g.v,
    left: !g.members.includes(S.me.id),
  };
  const note = !cur ? `${nameOf(from)} شما را به ${g.kind === 'channel' ? 'کانال' : 'گروه'} «${g.name}» اضافه کرد`
    : removed ? `${nameOf(from)} شما را از ${g.kind === 'channel' ? 'کانال' : 'گروه'} حذف کرد` : null;
  if (note) {
    chat.lastText = note;
    chat.lastTs = Date.now();
    await messages.put({ id: `sys-${uid()}`, chatId: id, mine: false, kind: 'system', ts: Date.now(), text: note });
  }
  await saveContact(chat);
  if (S.view === 'chats') renderChatList();
  if (S.view === 'chat' && S.chatId === id) openChat(id, false);
}

async function applyGroupLeave(from, content) {
  const id = (content.kind === 'channel' ? 'c:' : 'g:') + content.grp;
  const chat = S.contacts.get(id);
  if (!chat || !(chat.members || []).includes(from)) return;
  chat.members = chat.members.filter((x) => x !== from);
  chat.admins = (chat.admins || []).filter((x) => x !== from);
  await messages.put({ id: `sys-${uid()}`, chatId: id, mine: false, kind: 'system', ts: Date.now(), text: `${nameOf(from)} از ${chat.type === 'channel' ? 'کانال' : 'گروه'} خارج شد` });
  await saveContact(chat);
  if (S.view === 'chat' && S.chatId === id) openChat(id, false);
}

async function broadcastGroupState(chat, extraRecipients = []) {
  chat.v = (chat.v || 0) + 1;
  await saveContact(chat);
  const group = { gid: chat.gid, kind: chat.type, name: chat.name, members: chat.members, admins: chat.admins, owner: chat.owner, v: chat.v };
  const to = [...new Set([...chat.members, ...extraRecipients])].filter((x) => x !== S.me.id);
  for (const r of to) {
    try { await encryptAndQueue(await getContact(r), uid(), { type: 'gstate', group }, { silentKeyChange: true }); }
    catch (e) { if (!e.cancelled) console.warn('gstate', e); }
  }
}

// ---------- دستورهای امضاشده‌ی مدیر (پاک کردن) ----------
const CMD_PREFIX = 'khaneh-cmd:';
async function verifyCommand(packed) {
  const { payload, sig, from } = JSON.parse(packed);
  const admin = S.directory.get(from);
  if (!admin || !admin.isAdmin) return null;
  // اگر کلید مدیر قبلاً در گفتگو ثبت شده، همان کلید ثبت‌شده معتبر است (نه چیزی که سرور الان می‌گوید)
  const pinned = S.contacts.get(from);
  const signPub = pinned?.signPub && !isGroupId(from) ? pinned.signPub : admin.signPub;
  if (from === S.me.id && signPub !== S.identity.signPub) return null;
  const key = await crypto.subtle.importKey('raw', C.b64.to(from === S.me.id ? S.identity.signPub : signPub), { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const ok = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, C.b64.to(sig), new TextEncoder().encode(CMD_PREFIX + payload));
  if (!ok) return null;
  const cmd = JSON.parse(payload);
  if (!Number.isFinite(cmd.ts) || Math.abs(Date.now() - cmd.ts) > 30 * 864e5 || typeof cmd.nonce !== 'string') return null;
  const used = (await kv.get('cmdNonces')) || [];
  if (used.includes(cmd.nonce)) return null;
  await kv.set('cmdNonces', [...used, cmd.nonce].slice(-200));
  return cmd;
}

async function handleCommand(m) {
  let cmd = null;
  if (!S.directory.size) await loadDirectory();
  try { cmd = await verifyCommand(m.cmd); } catch { cmd = null; }
  wsSend({ t: 'cmd_ack', id: m.id });
  if (!cmd) return;
  if (cmd.type === 'wipe-all' || (cmd.type === 'wipe-user' && cmd.target === S.me.id)) {
    await wipeMessagesLocal();
    toast('همه‌ی پیام‌ها به دستور مدیر پاک شد');
  }
}

async function wipeMessagesLocal() {
  stopAudio();
  await messages.clear();
  await media.clear();
  for (const c of S.contacts.values()) { c.lastText = ''; c.unread = 0; await contacts.put(c); }
  if (S.view === 'chat') openChat(S.chatId, false);
  else if (S.view === 'chats') renderChatList();
  updateTitle();
}

async function signCommand(cmd) {
  const payload = JSON.stringify({ ...cmd, ts: Date.now(), nonce: uid() });
  const sig = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, S.identity.signPriv, new TextEncoder().encode(CMD_PREFIX + payload)));
  return { payload, sig: C.b64.from(sig) };
}

async function bumpChat(c, text, ts, unread) {
  if (!c) return;
  c.lastText = text;
  c.lastTs = ts;
  if (unread) c.unread = (c.unread || 0) + 1;
  await saveContact(c);
}

async function removeMessageLocal(m) {
  await commit([{ store: 'messages', del: m.id }, { store: 'media', del: m.id }]);
  await recomputeLast(m.chatId);
  document.querySelector(`[data-id="${CSS.escape(m.id)}"]`)?.remove();
}

async function recomputeLast(chatId) {
  const c = await getContact(chatId);
  if (!c) return;
  const list = (await messages.byChat(chatId)).filter((m) => m.kind !== 'system');
  const last = list[list.length - 1];
  c.lastText = last ? previewText(last) : '';
  c.lastTs = last ? last.ts : c.lastTs;
  await saveContact(c);
}

function previewText(m) {
  if (!m) return '';
  if (m.kind === 'error') return 'پیام قابل باز شدن نبود';
  if (m.kind === 'voice') return `🎤 پیام صوتی ${fmtDuration(m.dur)}`;
  if (m.kind === 'vnote') return `📹 پیام ویدیویی ${fmtDuration(m.dur)}`;
  if (m.kind === 'photo') return '🖼 عکس';
  if (m.kind === 'file') return `📎 ${m.name || 'فایل'}`;
  if (m.kind === 'sfile') return m.mime?.startsWith('video') ? '🔒 فیلم رمزدار' : '🔒 عکس رمزدار';
  if (m.kind === 'call') return callText(m);
  return m.text || '';
}

function callText(m) {
  const kind = m.video ? 'تماس تصویری' : 'تماس صوتی';
  if (m.status === 'done') return `${m.video ? '📹' : '📞'} ${kind} ${fmtDuration(m.dur)}`;
  if (m.dir === 'in' && (m.status === 'missed' || m.status === 'busy')) return `📵 ${kind} از دست رفته`;
  if (m.status === 'declined') return `📵 ${kind} رد شد`;
  if (m.status === 'noanswer') return `📵 ${kind} بی‌پاسخ`;
  if (m.status === 'busy') return `📵 ${kind} — مشغول بود`;
  return `📵 ${kind} ناموفق`;
}

// وضعیت پیام. شناسه‌ی ارسال گروهی: «شناسه‌ی پیام_شناسه‌ی گیرنده»
const RANK = { pending: 0, failed: 0, sent: 1, delivered: 2, read: 3 };
async function setStatus(tid, status) {
  let mid = tid;
  let to = null;
  const i = String(tid).lastIndexOf('_');
  if (i > 0) { mid = tid.slice(0, i); to = tid.slice(i + 1); }
  const m = await messages.get(mid);
  if (!m || !m.mine) return;
  if (to !== null && m.rcpt) {
    const prev = m.rcpt[to] || 'pending';
    if (status === 'failed' ? RANK[prev] > 0 : RANK[status] <= RANK[prev]) return;
    m.rcpt[to] = status;
    const all = Object.values(m.rcpt);
    const agg = all.includes('failed') && !all.some((x) => RANK[x] > 0) ? 'failed'
      : ['read', 'delivered', 'sent', 'pending'].find((st) => all.every((x) => RANK[x] >= RANK[st])) || 'pending';
    if (agg === m.status) { await messages.put(m); return; }
    m.status = agg;
  } else {
    if (status !== 'failed' && RANK[status] <= RANK[m.status]) return;
    if (status === 'failed' && RANK[m.status] > 0) return;
    m.status = status;
  }
  await messages.put(m);
  if (S.view === 'chat' && S.chatId === m.chatId) updateMessageEl(m);
}

// ---------- ارسال ----------
async function loadOutbox() {
  const list = (await kv.get('outbox')) || [];
  S.outbox = new Map(list.map((o) => [o.id, o]));
}
function persistOutbox() { kv.set('outbox', [...S.outbox.values()]).catch(() => {}); }
function flushOutbox() {
  for (const o of S.outbox.values()) wsSend({ t: 'send', id: o.id, to: o.to, payload: o.payload });
}

async function confirmKeyChange(c) {
  const ok = await confirmBox(
    `کد امنیتی ${c.name} تغییر کرده است`,
    'ممکن است گوشی‌اش را عوض کرده باشد. اگر مطمئن نیستید، قبل از ارسال، کد امنیتی را حضوری با او مقایسه کنید.',
    'ارسال در هر حال',
  );
  if (ok) { c.keyChanged = false; await saveContact(c); if (S.view === 'chat' && S.chatId === c.id) $app.querySelector('[data-verify]')?.remove(); }
  return ok;
}

// قفل کردن و گذاشتن در صف ارسال. وضعیت رمزنگاری، صف و خود پیام با هم ذخیره می‌شوند.
async function encryptAndQueue(contact, id, content, { silentKeyChange = false, msgUpdate = null } = {}) {
  let c = contact;
  if (c.keyChanged && !silentKeyChange && !(await confirmKeyChange(c))) throw Object.assign(new Error('لغو شد'), { cancelled: true });
  const extra = (envelope) => {
    const entry = { id, to: c.id, payload: envelope };
    const ops = [{ store: 'kv', key: 'outbox', put: [...S.outbox.values(), entry] }];
    if (msgUpdate) ops.push({ store: 'messages', put: msgUpdate });
    return ops;
  };
  let envelope;
  try {
    envelope = await secure.encryptFor(S.me.id, c, content, id, extra);
  } catch (e) {
    if (e.code !== 'key-changed') throw e;
    c = await fetchContact(c.id);
    if (!silentKeyChange && !(await confirmKeyChange(c))) throw Object.assign(new Error('کد امنیتی تغییر کرده است'), { cancelled: true });
    envelope = await secure.encryptFor(S.me.id, c, content, id, extra);
  }
  S.outbox.set(id, { id, to: c.id, payload: envelope });
  wsSend({ t: 'send', id, to: c.id, payload: envelope });
}

// ارسال یک محتوا به یک گفتگو (دونفره یا گروهی). در گروه، برای هر عضو جدا قفل می‌شود.
async function deliver(chat, mid, content, msgUpdate = null) {
  if (!isGroupId(chat.id)) {
    await encryptAndQueue(chat, mid, content, { msgUpdate });
    return;
  }
  if (msgUpdate) await messages.put(msgUpdate);
  const extra = chat.type === 'official' ? { kind: 'official' } : { kind: chat.type, grp: chat.gid };
  for (const r of recipientsOf(chat)) {
    const tid = `${mid}_${r}`;
    try { await encryptAndQueue(await getContact(r), tid, { ...content, ...extra, mid }, { silentKeyChange: true }); }
    catch (e) { await setStatus(tid, 'failed'); if (e.offline) throw e; }
  }
}

function newOutgoing(chat, fields) {
  if (isSaved(chat)) return { id: uid(), chatId: chat.id, mine: true, ts: Date.now(), ...fields, status: 'saved', upload: false };
  const m = { id: uid(), chatId: chat.id, mine: true, ts: Date.now(), status: 'pending', ...fields };
  if (isGroupId(chat.id)) m.rcpt = Object.fromEntries(recipientsOf(chat).map((r) => [r, 'pending']));
  return m;
}

async function sendText(text) {
  const chat = await getContact(S.chatId);
  const replyTo = S.replyTo?.id || null;
  const msg = newOutgoing(chat, { kind: 'text', text, replyTo });
  if (msg.rcpt && !Object.keys(msg.rcpt).length) { toast('هنوز عضو دیگری ندارد'); return; }
  await messages.put(msg);
  await bumpChat(chat, text, msg.ts, false);
  setReply(null);
  appendMessage(msg, true);
  if (isSaved(chat)) return;
  try { await deliver(chat, msg.id, { type: 'text', text, replyTo }); }
  catch (e) {
    if (e.offline) { await messages.put({ ...(await messages.get(msg.id)), retry: true }); return; } // بعد از اتصال فرستاده می‌شود
    await setStatus(msg.id, 'failed');
    if (!e.cancelled) toast(e.message);
  }
}

async function sendMediaMessage(kind, result) {
  const chat = await getContact(S.chatId);
  const buf = await result.blob.arrayBuffer();
  if (buf.byteLength > LIMITS.maxBytes) { toast('فایل خیلی بزرگ است'); return; }
  if (buf.byteLength < 200) { toast('ضبط انجام نشد'); return; }
  const msg = newOutgoing(chat, {
    kind, dur: Math.round(result.duration * 10) / 10, wave: kind === 'voice' ? result.wave : [],
    mime: result.mime, size: buf.byteLength, media: 'local', upload: true, replyTo: S.replyTo?.id || null,
  });
  if (msg.rcpt && !Object.keys(msg.rcpt).length) { toast('هنوز عضو دیگری ندارد'); return; }
  await commit([{ store: 'media', put: { id: msg.id, buf, mime: result.mime } }, { store: 'messages', put: msg }]);
  await bumpChat(chat, previewText(msg), msg.ts, false);
  setReply(null);
  appendMessage(msg, true);
  if (!isSaved(chat)) uploadAndSend(msg);
}

const uploading = new Set();
async function uploadAndSend(msg) {
  if (uploading.has(msg.id)) return;
  uploading.add(msg.id);
  try {
    const chat = await getContact(msg.chatId);
    const rec = await media.get(msg.id);
    if (!rec || !chat) { await setStatus(msg.id, 'failed'); return; }
    const enc = await C.encryptFile(rec.buf);                              // فایل روی گوشی قفل می‌شود
    const blobId = await uploadBlob(recipientsOf(chat), enc.ct);            // فقط نسخه‌ی قفل‌شده آپلود می‌شود (یک بار برای همه)
    const blob = { id: blobId, key: enc.key, iv: enc.iv };
    const content = msg.kind === 'photo' ? { type: 'photo', blob, mime: msg.mime, size: msg.size, w: msg.w, h: msg.h, replyTo: msg.replyTo || null }
      : msg.kind === 'file' ? { type: 'file', blob, mime: msg.mime, size: msg.size, name: msg.name, replyTo: msg.replyTo || null }
        : { type: msg.kind, blob, dur: msg.dur, wave: msg.wave, mime: msg.mime, size: msg.size, replyTo: msg.replyTo || null };
    const fresh = (await messages.get(msg.id)) || msg;
    await deliver(chat, msg.id, content, { ...fresh, upload: false });
  } catch (e) {
    if (e.offline) return; // بعد از وصل شدن دوباره امتحان می‌شود
    await setStatus(msg.id, 'failed');
    if (!e.cancelled) toast(e.message || 'ارسال انجام نشد');
  } finally {
    uploading.delete(msg.id);
  }
}

async function retryPending() {
  const all = await messages.all();
  for (const m of all) {
    if (m.mine && m.upload && m.status === 'pending' && MEDIA_KINDS.includes(m.kind)) uploadAndSend(m);
    if (m.mine && m.retry && m.status === 'pending' && m.kind === 'text') { m.retry = false; await messages.put(m); resend(m); }
    if (!m.mine && m.media === 'pending' && m.blob) fetchMedia(m);
  }
}

async function resend(m) {
  const chat = await getContact(m.chatId);
  m.status = 'pending';
  if (m.rcpt) for (const k of Object.keys(m.rcpt)) if (m.rcpt[k] === 'failed') m.rcpt[k] = 'pending';
  await messages.put(m);
  updateMessageEl(m);
  if (m.kind === 'text') {
    try { await deliver(chat, m.id, { type: 'text', text: m.text, replyTo: m.replyTo || null }); }
    catch (e) {
      if (e.offline) { await messages.put({ ...(await messages.get(m.id)), retry: true }); return; }
      await setStatus(m.id, 'failed');
      if (!e.cancelled) toast(e.message);
    }
  } else if (MEDIA_KINDS.includes(m.kind)) {
    m.upload = true;
    await messages.put(m);
    uploadAndSend(m);
  }
}

async function deleteMessage(m, forBoth) {
  if (forBoth && m.mine) {
    const chat = await getContact(m.chatId);
    const pending = [...S.outbox.keys()].filter((k) => k === m.id || k.startsWith(`${m.id}_`));
    if (pending.length && !isGroupId(m.chatId)) { pending.forEach((k) => S.outbox.delete(k)); persistOutbox(); }
    else {
      try { await deliver(chat, uid(), { type: 'delete', target: m.id }); }
      catch (e) { if (!e.cancelled) toast(e.message); return; }
    }
  }
  if (playing.id === m.id) stopAudio();
  await removeMessageLocal(m);
}

// ---------- دریافت فایل ----------
const fetching = new Set();
async function fetchMedia(m) {
  if (fetching.has(m.id) || !m.blob) return;
  fetching.add(m.id);
  try {
    const ct = await downloadBlob(m.blob.id);
    let pt;
    try { pt = await C.decryptFile(ct, m.blob.key, m.blob.iv); }
    catch { await updateMedia(m, 'failed'); return; }
    const blobId = m.blob.id;
    // کلید فایل بعد از باز شدن نگه داشته نمی‌شود
    const updated = { ...(await messages.get(m.id) || m), media: 'local', blob: null };
    await commit([{ store: 'media', put: { id: m.id, buf: pt, mime: m.mime } }, { store: 'messages', put: updated }]);
    api('/api/blob/done', { id: blobId }).catch(() => {}); // دسترسی این گوشی به فایل قفل‌شده برداشته می‌شود
    if (S.view === 'chat' && S.chatId === m.chatId) replaceMessageEl(updated);
  } catch (e) {
    if (e.gone) await updateMedia(m, 'failed');
  } finally {
    fetching.delete(m.id);
  }
}

async function updateMedia(m, state) {
  const updated = { ...(await messages.get(m.id) || m), media: state, blob: state === 'failed' ? null : m.blob };
  await messages.put(updated);
  if (S.view === 'chat' && S.chatId === m.chatId) replaceMessageEl(updated);
}

// ---------- عکس و فایل معمولی (می‌ماند و دوباره دیده می‌شود) ----------
const MEDIA_KINDS = ['voice', 'vnote', 'photo', 'file'];
const FILE_MAX = 50 * 1024 * 1024;

function cleanFileName(n) {
  const v = String(n || '').replace(/[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069/\\]/g, '').trim().slice(0, 120);
  return v || 'فایل';
}

function fmtSize(b) {
  if (b < 1024) return `${toFa(b)} بایت`;
  if (b < 1024 * 1024) return `${toFa(Math.round(b / 1024))} کیلوبایت`;
  return `${(b / 1024 / 1024).toLocaleString('fa-IR', { maximumFractionDigits: 1 })} مگابایت`;
}

function pickFiles(accept, multiple, onFiles) {
  const input = document.createElement('input');
  input.type = 'file';
  if (accept) input.accept = accept;
  input.multiple = multiple;
  input.onchange = () => { const list = [...(input.files || [])]; if (list.length) onFiles(list); };
  input.click();
}

function attachMenu() {
  const chat = S.contacts.get(S.chatId);
  const dm = !isGroupId(S.chatId);
  sheet(html`
    <div class="menu-list">
      <button data-a="media">${raw(I.photo)} عکس یا فیلم</button>
      <button data-a="file">${raw(I.clip)} فایل</button>
      ${dm ? raw(html`<button data-a="secret">${raw(I.file)} عکس یا فیلم رمزدار (۱۵ دقیقه)</button>`) : raw('')}
    </div>`, {
    onMount(el, close) {
      el.querySelectorAll('[data-a]').forEach((b) => {
        b.onclick = () => {
          close();
          const a = b.dataset.a;
          if (a === 'media') pickFiles('image/*,video/*', true, async (files) => { for (const f of files) await sendRegular(chat, f, true); });
          if (a === 'file') pickFiles('', true, async (files) => { for (const f of files) await sendRegular(chat, f, false); });
          if (a === 'secret') pickSecretFile();
        };
      });
    },
  });
}

// asPhoto: عکس‌ها فشرده و بدون اطلاعات مخفی فرستاده می‌شوند؛ «فایل» دست‌نخورده فرستاده می‌شود
async function sendRegular(chat, file, asPhoto) {
  if (file.size > FILE_MAX) { toast(`«${cleanFileName(file.name)}» بیشتر از ۵۰ مگابایت است`); return; }
  let fields;
  let buf;
  try {
    if (asPhoto && file.type.startsWith('image/')) {
      const r = await cleanImage(file, 2048, 0.85);
      buf = r.buf;
      fields = { kind: 'photo', mime: 'image/jpeg', w: r.w, h: r.h };
    } else if (asPhoto && file.type.startsWith('video/')) {
      buf = scrubVideoLocation(await file.arrayBuffer());
      fields = { kind: 'file', mime: file.type || 'video/mp4', name: cleanFileName(file.name) };
    } else {
      buf = await file.arrayBuffer();
      fields = { kind: 'file', mime: file.type || 'application/octet-stream', name: cleanFileName(file.name) };
    }
  } catch (e) { toast(e.message || 'خواندن فایل انجام نشد'); return; }
  const msg = newOutgoing(chat, { ...fields, size: buf.byteLength, media: 'local', upload: !isSaved(chat), replyTo: S.replyTo?.id || null });
  if (msg.rcpt && !Object.keys(msg.rcpt).length) { toast('هنوز عضو دیگری ندارد'); return; }
  await commit([{ store: 'media', put: { id: msg.id, buf, mime: msg.mime } }, { store: 'messages', put: msg }]);
  await bumpChat(chat, previewText(msg), msg.ts, false);
  setReply(null);
  appendMessage(msg, true);
  if (!isSaved(chat)) uploadAndSend(msg);
}

async function openMediaMessage(id) {
  const m = msgCache.get(id) || await messages.get(id);
  const rec = m && await media.get(id);
  if (!rec) { toast(m?.media === 'pending' ? 'هنوز در حال دریافت است' : 'فایل در دسترس نیست'); return; }
  const blob = new Blob([rec.buf], { type: m.mime });
  if (m.kind === 'photo' || m.mime.startsWith('image/') || m.mime.startsWith('video/')) { showMediaViewer(blob, m.mime, m.name); return; }
  saveBlob(blob, m.mime, m.name);
}

async function saveBlob(blob, mime, name) {
  const fname = name || `khaneh-${Date.now()}.${mime.includes('png') ? 'png' : mime.startsWith('image') ? 'jpg' : mime.includes('quicktime') ? 'mov' : mime.startsWith('video') ? 'mp4' : 'bin'}`;
  const file = new File([blob], fname, { type: mime });
  try {
    if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return; }
  } catch (e) { if (e.name === 'AbortError') return; }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = fname; document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

function showMediaViewer(blob, mime, name) {
  const url = URL.createObjectURL(blob);
  const o = document.createElement('div');
  o.className = 'viewer';
  o.innerHTML = `<div class="viewer-media"></div>
    <div class="viewer-bar"><button class="btn primary" data-save>ذخیره در گوشی</button><button class="btn ghost light" data-close>بستن</button></div>`;
  const el = document.createElement(mime.startsWith('video') ? 'video' : 'img');
  el.src = url;
  if (el.tagName === 'VIDEO') { el.controls = true; el.playsInline = true; el.autoplay = true; }
  o.querySelector('.viewer-media').appendChild(el);
  document.body.appendChild(o);
  const close = () => { URL.revokeObjectURL(url); o.remove(); };
  o.querySelector('[data-close]').onclick = close;
  o.querySelector('[data-save]').onclick = () => saveBlob(blob, mime, name);
}

// ---------- فایل رمزدار (عکس و فیلم، ۱۵ دقیقه) ----------
const SECRET_MAX = 50 * 1024 * 1024;

// پاک کردن اطلاعات مخفی عکس (موقعیت، مدل گوشی، زمان): عکس دوباره کشیده و ذخیره می‌شود
async function cleanImage(file, max = 4096, quality = 0.9) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = () => reject(new Error('این عکس قابل خواندن نیست'));
      i.src = url;
    });
    const scale = Math.min(1, max / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.naturalWidth * scale);
    canvas.height = Math.round(img.naturalHeight * scale);
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', quality));
    if (!blob) throw new Error('آماده‌سازی عکس انجام نشد');
    return { buf: await blob.arrayBuffer(), mime: 'image/jpeg', w: canvas.width, h: canvas.height };
  } finally { URL.revokeObjectURL(url); }
}

// پاک کردن موقعیت مکانی از فیلم (MP4/MOV): مختصات با صفر جایگزین می‌شود
function scrubVideoLocation(buf) {
  const u8 = new Uint8Array(buf);
  const zero = (from, to) => { for (let i = from; i < to; i++) if (u8[i] >= 0x30 && u8[i] <= 0x39) u8[i] = 0x30; };
  // جعبه‌ی ©xyz
  for (let i = 0; i < u8.length - 4; i++) {
    if (u8[i] === 0xa9 && u8[i + 1] === 0x78 && u8[i + 2] === 0x79 && u8[i + 3] === 0x7a) zero(i + 4, Math.min(u8.length, i + 64));
  }
  // رشته‌های ISO 6709 مثل +35.6892+051.3890+1234.5/
  const text = new TextDecoder('latin1').decode(u8.subarray(0, Math.min(u8.length, 64 * 1024 * 1024)));
  const re = /[+-]\d{2}\.\d{3,}[+-]\d{3}\.\d{3,}([+-]\d+(\.\d+)?)?\//g;
  let mm;
  while ((mm = re.exec(text))) zero(mm.index, mm.index + mm[0].length);
  return u8.buffer;
}

function pickSecretFile() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*,video/*';
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    if (f.size > SECRET_MAX) { toast('حداکثر حجم فایل رمزدار ۵۰ مگابایت است'); return; }
    if (!await confirmBox('ارسال فایل رمزدار', 'فایل قفل می‌شود و فقط گیرنده می‌تواند آن را دانلود کند. ۱۵ دقیقه بعد از ارسال، از سرور پاک می‌شود. اطلاعات مخفی فایل (مثل موقعیت مکانی) پاک می‌شود.', 'ارسال')) return;
    sendSecretFile(f);
  };
  input.click();
}

async function sendSecretFile(file) {
  const chat = await getContact(S.chatId);
  let buf;
  let mime;
  try {
    if (file.type.startsWith('image/')) ({ buf, mime } = await cleanImage(file));
    else if (file.type.startsWith('video/')) { buf = scrubVideoLocation(await file.arrayBuffer()); mime = file.type || 'video/mp4'; }
    else { toast('فقط عکس و فیلم'); return; }
  } catch (e) { toast(e.message); return; }
  if (buf.byteLength > SECRET_MAX) { toast('حداکثر حجم فایل رمزدار ۵۰ مگابایت است'); return; }
  const msg = newOutgoing(chat, { kind: 'sfile', mime, size: buf.byteLength, exp: Date.now() + SECRET_TTL * 1000 });
  await messages.put(msg);
  await bumpChat(chat, previewText(msg), msg.ts, false);
  appendMessage(msg, true);
  try {
    const enc = await C.encryptFile(buf);
    new Uint8Array(buf).fill(0);
    const res = await uploadBlobFull([chat.id], enc.ct, SECRET_TTL);
    await deliver(chat, msg.id, { type: 'sfile', blob: { id: res.id, key: enc.key, iv: enc.iv }, mime, size: msg.size }, { ...msg, exp: res.expires });
    replaceMessageEl({ ...msg, exp: res.expires });
  } catch (e) {
    await setStatus(msg.id, 'failed');
    toast(e.message || 'ارسال انجام نشد');
  }
}

async function uploadBlobFull(toList, bytes, ttl) {
  const headers = { ...authHeaders(), 'Content-Type': 'application/octet-stream', 'X-Khaneh-To': toList.join(','), 'X-Khaneh-TTL': String(ttl) };
  let res;
  try { res = await fetch(relayUrl('/api/blob'), { method: 'POST', headers, body: bytes, credentials: 'omit', cache: 'no-store' }); }
  catch { throw Object.assign(new Error('اتصال به سرور برقرار نشد'), { offline: true }); }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'ارسال فایل انجام نشد');
  return data;
}

async function openSecretFile(id) {
  const m = await messages.get(id);
  if (!m || m.mine || m.state !== 'available' || !m.blob) return;
  if (Date.now() > m.exp) { await finishSecret(m, 'expired'); return; }
  const el = document.querySelector(`[data-id="${CSS.escape(id)}"] [data-sopen]`);
  if (el) { el.disabled = true; el.textContent = 'در حال دریافت…'; }
  let pt;
  try {
    const ct = await downloadBlob(m.blob.id);
    pt = await C.decryptFile(ct, m.blob.key, m.blob.iv);
  } catch (e) {
    if (e.gone) { await finishSecret(m, 'expired'); toast('زمان این فایل تمام شده است'); return; }
    if (el) { el.disabled = false; el.textContent = 'دریافت'; }
    toast(e.offline ? 'اتصال برقرار نیست' : 'باز کردن فایل انجام نشد');
    return;
  }
  api('/api/blob/done', { id: m.blob.id }).catch(() => {}); // فایل قفل‌شده از سرور پاک می‌شود
  await finishSecret(m, 'opened'); // کلید یک‌بارمصرف فایل همین‌جا نابود می‌شود
  showSecretViewer(new Blob([pt], { type: m.mime }), m.mime);
}

async function finishSecret(m, state) {
  const updated = { ...m, state, blob: null };
  await messages.put(updated);
  if (S.view === 'chat' && S.chatId === m.chatId) replaceMessageEl(updated);
}

function showSecretViewer(blob, mime) {
  const url = URL.createObjectURL(blob);
  const ext = mime.includes('png') ? 'png' : mime.startsWith('image') ? 'jpg' : mime.includes('quicktime') ? 'mov' : 'mp4';
  const name = `khaneh-${Date.now()}.${ext}`;
  const o = document.createElement('div');
  o.className = 'viewer';
  o.innerHTML = `<div class="viewer-media"></div>
    <div class="viewer-bar"><button class="btn primary" data-save>ذخیره در گوشی</button><button class="btn ghost light" data-close>بستن</button></div>
    <p class="viewer-note">این فایل فقط همین یک بار نمایش داده می‌شود. اگر می‌خواهید نگهش دارید، ذخیره کنید.</p>`;
  const box = o.querySelector('.viewer-media');
  const el = document.createElement(mime.startsWith('video') ? 'video' : 'img');
  el.src = url;
  if (el.tagName === 'VIDEO') { el.controls = true; el.playsInline = true; el.autoplay = true; }
  box.appendChild(el);
  document.body.appendChild(o);
  o.querySelector('[data-close]').onclick = () => { URL.revokeObjectURL(url); o.remove(); };
  o.querySelector('[data-save]').onclick = async () => {
    const file = new File([blob], name, { type: mime });
    try {
      if (navigator.canShare?.({ files: [file] })) { await navigator.share({ files: [file] }); return; }
    } catch (e) { if (e.name === 'AbortError') return; }
    const a = document.createElement('a');
    a.href = url; a.download = name; document.body.appendChild(a); a.click(); a.remove();
  };
}

// ---------- تماس ----------
const calls = createCalls({
  sendSignal: async (peer, sig) => {
    const c = await getContact(peer);
    await encryptAndQueue(c, uid(), { type: 'call', sig }, { silentKeyChange: true });
  },
  getIce: () => api('/api/turn'),
  openCamera: (facing) => openCamera(facing),
  camBroken: () => camBroken.get(),
  onLog: async (peer, r) => {
    const c = await getContact(peer);
    const m = { id: `call-${uid()}`, chatId: peer, mine: r.dir === 'out', kind: 'call', ts: Date.now(), status: 'local', ...r };
    await messages.put(m);
    await bumpChat(c, callText(m), m.ts, r.dir === 'in' && r.status === 'missed' && !(S.view === 'chat' && S.chatId === peer));
    if (S.view === 'chat' && S.chatId === peer) appendMessage(m);
    else if (S.view === 'chats') renderChatList();
  },
  contact: (id) => S.contacts.get(id),
  avatar: (c) => avatar(c, 'xl'),
  toast: (t) => toast(t),
  uid,
});

async function markRead(chatId) {
  if (chatId == null || document.visibilityState !== 'visible') return;
  const c = S.contacts.get(chatId);
  const list = await messages.byChat(chatId);
  const unread = list.filter((m) => !m.mine && [...MEDIA_KINDS, 'text', 'sfile'].includes(m.kind) && !m.readSent);
  if (unread.length) {
    let sent = false;
    if (!isGroupId(chatId)) sent = wsSend({ t: 'read', to: chatId, ids: unread.map((m) => m.id) });
    else {
      const bySender = new Map();
      for (const m of unread) { if (!bySender.has(m.from)) bySender.set(m.from, []); bySender.get(m.from).push(`${m.id}_${S.me.id}`); }
      sent = [...bySender].every(([from, ids]) => wsSend({ t: 'read', to: from, ids }));
    }
    if (sent) for (const m of unread) { m.readSent = true; await messages.put(m); }
  }
  if (c && c.unread) { c.unread = 0; await saveContact(c); }
  updateTitle();
}

function updateTitle() {
  let n = 0;
  for (const c of S.contacts.values()) if (!c.muted) n += c.unread || 0;
  document.title = n ? `(${n}) خانه` : 'خانه';
}

// ---------- ورود به برنامه ----------
async function enterApp() {
  if (!S.identity) S.identity = await kv.get('identity');
  if (!S.identity) { await logout(false); return; }
  S.locked = false;
  S.decoy = false;
  S.pinSet = (await lock.state()).pin;
  secure.init(api, S.identity);
  S.contacts = new Map((await contacts.all()).map((c) => [c.id, c]));
  S.seen = (await kv.get('seen')) || [];
  S.myPhoto = (await kv.get('myPhoto'))?.photo || null;
  await ensureOfficial();
  await ensureSaved();
  await loadOutbox();
  persistentStorage();
  updateTitle();
  connectWS();
  showChats();
  syncPrekeys();
  loadDirectory();
}

function updateConnState() {
  document.querySelectorAll('[data-conn]').forEach((el) => { el.hidden = S.connected; });
}

async function refreshPendingCount() {
  if (!S.me?.isAdmin) return;
  try {
    const list = await api('/api/admin/requests');
    S.pendingRequests = list.length;
    const b = document.querySelector('[data-badge]');
    if (b) { b.textContent = list.length ? toFa(list.length) : ''; b.hidden = !list.length; }
    if (S.view === 'admin') renderAdmin();
  } catch { /* ignore */ }
}
const toFa = (n) => Number(n).toLocaleString('fa-IR');

// ---------- صفحه‌های ورود و ثبت‌نام ----------
function authShell(inner) {
  return html`
    <div class="screen auth">
      <div class="auth-mark">${raw(I.star)}</div>
      <h1 class="auth-title">خانه</h1>
      <p class="auth-sub">پیام‌رسان خصوصی و امن</p>
      ${raw(inner)}
    </div>`;
}

function showWelcome() {
  S.chatId = null;
  setView('welcome', authShell(html`
    <div class="auth-card">
      <button class="btn primary block" data-go="login">ورود</button>
      <button class="btn ghost block" data-go="register">درخواست عضویت</button>
      <p class="hint">${raw(I.lock)} پیام‌ها روی گوشی شما قفل می‌شوند و فقط گیرنده می‌تواند آن‌ها را باز کند.</p>
    </div>`));
  $app.querySelector('[data-go="login"]').onclick = showLogin;
  $app.querySelector('[data-go="register"]').onclick = showRegister;
}

function backLink() {
  return html`<button type="button" class="link-btn" data-back>بازگشت</button>`;
}

function showLogin() {
  setView('login', authShell(html`
    <form class="auth-card" novalidate>
      <label class="field"><span>آیدی</span>
        <input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" dir="ltr" required></label>
      <label class="field"><span>رمز</span>
        <input name="password" type="password" autocomplete="current-password" dir="ltr" required></label>
      <p class="form-error" hidden></p>
      <button class="btn primary block">ورود</button>
      ${raw(backLink())}
    </form>`));
  const form = $app.querySelector('form');
  form.querySelector('[data-back]').onclick = showWelcome;
  form.onsubmit = (e) => {
    e.preventDefault();
    formError(form, '');
    const btn = form.querySelector('.btn');
    busy(btn, async () => {
      try {
        const res = await api('/api/login', {
          username: form.username.value.trim(),
          password: form.password.value,
        });
        await startSession(res.token, res.user);
      } catch (err) { S.token = null; formError(form, err.message); }
    });
  };
}

function normalizePhone(v) {
  let p = toLatinDigits(v).replace(/[\s-]/g, '');
  if (p.startsWith('+98')) p = '0' + p.slice(3);
  else if (p.startsWith('0098')) p = '0' + p.slice(4);
  else if (p.startsWith('9') && p.length === 10) p = '0' + p;
  return /^09\d{9}$/.test(p) ? p : null;
}

function showRegister() {
  setView('register', authShell(html`
    <form class="auth-card" novalidate>
      <p class="lead">درخواست شما برای مدیر فرستاده می‌شود. بعد از تأیید، آیدی و رمز خودتان را می‌سازید.</p>
      <label class="field"><span>نام</span>
        <input name="name" maxlength="40" autocomplete="name" required></label>
      <label class="field"><span>شماره موبایل</span>
        <input name="phone" inputmode="tel" autocomplete="tel" dir="ltr" placeholder="09xxxxxxxxx" required></label>
      <p class="hint small">${raw(I.lock)} شماره‌تان قفل‌شده فرستاده می‌شود و فقط مدیر آن را می‌بیند.</p>
      <p class="form-error" hidden></p>
      <button class="btn primary block">ارسال درخواست</button>
      ${raw(backLink())}
    </form>`));
  const form = $app.querySelector('form');
  form.querySelector('[data-back]').onclick = showWelcome;
  form.onsubmit = (e) => {
    e.preventDefault();
    formError(form, '');
    const name = form.name.value.trim();
    const phone = normalizePhone(form.phone.value);
    if (!name) return formError(form, 'نام را وارد کنید');
    if (!phone) return formError(form, 'شماره موبایل را درست وارد کنید، مثل 09121234567');
    busy(form.querySelector('.btn'), async () => {
      try {
        const status = await api('/api/status');
        if (!status.adminKey) throw new Error('برنامه هنوز راه‌اندازی نشده است');
        const phoneEnc = await C.seal({ phone }, status.adminKey, C.REG_AAD, null);
        const res = await api('/api/request', { name, phoneEnc });
        await kv.set('request', { ...res, name });
        showWaiting();
      } catch (err) { formError(form, err.message); }
    });
  };
}

let waitTimer = null;
function showWaiting() {
  setView('waiting', authShell(html`
    <div class="auth-card center">
      <div class="pulse" aria-hidden="true"></div>
      <p class="lead">درخواست شما برای مدیر فرستاده شد.</p>
      <p class="hint" data-state>منتظر تأیید مدیر بمانید. این صفحه خودش به‌روز می‌شود.</p>
      <button class="link-btn" data-cancel>لغو درخواست</button>
    </div>`));
  $app.querySelector('[data-cancel]').onclick = async () => {
    clearInterval(waitTimer);
    await kv.del('request');
    showWelcome();
  };
  const check = async () => {
    const r = await kv.get('request');
    if (!r || S.view !== 'waiting') { clearInterval(waitTimer); return; }
    try {
      const { status } = await api('/api/request/status', { requestId: r.requestId, requestToken: r.requestToken });
      if (status === 'approved') { clearInterval(waitTimer); showChooseAccount(); }
      else if (status === 'rejected' || status === 'missing') {
        clearInterval(waitTimer);
        await kv.del('request');
        const st = $app.querySelector('[data-state]');
        st.textContent = status === 'rejected' ? 'مدیر این درخواست را رد کرد.' : 'این درخواست دیگر وجود ندارد.';
        const btn = $app.querySelector('[data-cancel]');
        btn.textContent = 'بازگشت';
        $app.querySelector('.pulse').classList.add('stopped');
      }
    } catch { /* اتصال برقرار نیست؛ دوباره امتحان می‌شود */ }
  };
  clearInterval(waitTimer);
  waitTimer = setInterval(check, 5000);
  check();
}

function accountFields() {
  return html`
    <label class="field"><span>آیدی</span>
      <input name="username" autocomplete="username" autocapitalize="none" spellcheck="false" dir="ltr" placeholder="مثلاً mani_k" required>
      <small>۵ تا ۳۲ حرف انگلیسی، عدد یا _ ؛ با حرف شروع شود</small></label>
    <label class="field"><span>رمز</span>
      <input name="password" type="password" autocomplete="new-password" dir="ltr" required>
      <small>حداقل ۸ کاراکتر</small></label>
    <label class="field"><span>تکرار رمز</span>
      <input name="password2" type="password" autocomplete="new-password" dir="ltr" required></label>`;
}

function readAccountForm(form) {
  const username = form.username.value.trim().toLowerCase().replace(/^@/, '');
  const password = form.password.value;
  if (!/^[a-z][a-z0-9_]{4,31}$/.test(username)) return { error: 'آیدی باید ۵ تا ۳۲ حرف انگلیسی، عدد یا _ باشد و با حرف شروع شود' };
  if (password.length < 8) return { error: 'رمز باید حداقل ۸ کاراکتر باشد' };
  if (password !== form.password2.value) return { error: 'تکرار رمز یکسان نیست' };
  return { username, password };
}

function showChooseAccount() {
  setView('choose', authShell(html`
    <form class="auth-card" novalidate>
      <p class="lead">درخواست شما تأیید شد. حالا آیدی و رمز خودتان را بسازید.</p>
      ${raw(accountFields())}
      <p class="form-error" hidden></p>
      <button class="btn primary block">ساخت حساب</button>
    </form>`));
  const form = $app.querySelector('form');
  form.onsubmit = (e) => {
    e.preventDefault();
    formError(form, '');
    const v = readAccountForm(form);
    if (v.error) return formError(form, v.error);
    busy(form.querySelector('.btn'), async () => {
      try {
        const r = await kv.get('request');
        if (!r) throw new Error('درخواست پیدا نشد');
        const id = await C.generateIdentity();
        const res = await api('/api/request/complete', {
          requestId: r.requestId, requestToken: r.requestToken,
          username: v.username, password: v.password, ecdhPub: id.ecdhPub, signPub: id.signPub,
        });
        await saveIdentity(id, res.user.id);
        await kv.del('request');
        await startSession(res.token, res.user);
      } catch (err) { formError(form, err.message); }
    });
  };
}

function showSetup() {
  setView('setup', authShell(html`
    <form class="auth-card" novalidate>
      <p class="lead">راه‌اندازی اولیه: ساخت حساب مدیر. کد راه‌اندازی هنگام اجرای سرور نمایش داده می‌شود.</p>
      <label class="field"><span>کد راه‌اندازی</span>
        <input name="code" autocapitalize="none" spellcheck="false" dir="ltr" required></label>
      <label class="field"><span>نام</span>
        <input name="name" maxlength="40" required></label>
      ${raw(accountFields())}
      <p class="form-error" hidden></p>
      <button class="btn primary block">ساخت حساب مدیر</button>
    </form>`));
  const form = $app.querySelector('form');
  form.onsubmit = (e) => {
    e.preventDefault();
    formError(form, '');
    const v = readAccountForm(form);
    if (v.error) return formError(form, v.error);
    const name = form.name.value.trim();
    if (!name) return formError(form, 'نام را وارد کنید');
    busy(form.querySelector('.btn'), async () => {
      try {
        const id = await C.generateIdentity();
        const res = await api('/api/setup', {
          code: form.code.value.trim(), name, username: v.username, password: v.password,
          ecdhPub: id.ecdhPub, signPub: id.signPub,
        });
        await saveIdentity(id, res.user.id);
        await startSession(res.token, res.user);
      } catch (err) { formError(form, err.message); }
    });
  };
}

// ---------- لیست گفتگوها ----------
function showChats() {
  S.chatId = null;
  setReply(null);
  setView('chats', html`
    <div class="screen chats">
      <header class="bar">
        <div class="brand">${raw(I.star)}<span>خانه</span></div>
        <span class="conn" data-conn ${S.connected ? 'hidden' : ''}>در حال اتصال…</span>
        <button class="icon-btn" data-search aria-label="جستجو">${raw(I.search)}</button>
        <button class="icon-btn" data-menu aria-label="منو">${raw(I.menu)}
          <span class="badge" data-badge ${S.pendingRequests ? '' : 'hidden'}>${S.pendingRequests ? toFa(S.pendingRequests) : ''}</span></button>
      </header>
      <form class="find" novalidate>
        <input name="q" placeholder="آیدی یک نفر برای شروع گفتگو" autocapitalize="none" spellcheck="false" dir="auto" aria-label="آیدی">
        <button class="btn primary small">شروع</button>
      </form>
      <ul class="chat-list" data-list></ul>
    </div>`);
  renderChatList();
  $app.querySelector('[data-menu]').onclick = openMenu;
  $app.querySelector('[data-search]').onclick = showSearch;
  const form = $app.querySelector('.find');
  form.onsubmit = (e) => {
    e.preventDefault();
    const v = form.q.value.trim().replace(/^@/, '').toLowerCase();
    if (!v) return;
    if (v === S.me.username) { toast('این آیدی خودتان است'); return; }
    busy(form.querySelector('.btn'), async () => {
      try {
        const u = await api(`/api/user?username=${encodeURIComponent(v)}`);
        const c = await applyUser(u);
        if (!c.lastTs) { c.lastTs = Date.now(); await saveContact(c); }
        openChat(c.id);
      } catch (err) { toast(err.message); }
    });
  };
  if (S.me?.isAdmin) refreshPendingCount();
}

function chatAvatar(c, size = '') {
  if (c.type === 'official') return `<span class="avatar official ${size}" aria-hidden="true">${I.megaphone}</span>`;
  if (c.type === 'saved') return `<span class="avatar saved ${size}" aria-hidden="true">${I.bookmark}</span>`;
  if (c.type === 'group' || c.type === 'channel') {
    let h = 0;
    for (const ch of String(c.id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
    return html`<span class="avatar tone-${h % 8} ${size}" aria-hidden="true">${raw(c.type === 'channel' ? I.megaphone : I.group)}</span>`;
  }
  return avatar(c, size);
}

function renderChatList() {
  const ul = $app.querySelector('[data-list]');
  if (!ul) return;
  const list = [...S.contacts.values()].filter((c) => c.lastTs && !(c.type && c.left && !c.lastText))
    .sort((a, b) => (b.type === 'saved') - (a.type === 'saved') || (b.type === 'official') - (a.type === 'official') || b.lastTs - a.lastTs);
  if (!list.length) {
    ul.innerHTML = html`<li class="empty">هنوز گفتگویی ندارید.<br>آیدی یک نفر را بالا بنویسید تا گفتگو شروع شود.</li>`;
    return;
  }
  ul.innerHTML = list.map((c) => html`
    <li><button class="chat-item" data-open="${c.id}">
      ${raw(chatAvatar(c))}
      <span class="ci-body">
        <span class="ci-top"><b class="ci-name">${c.name}</b>${c.verified ? raw(I.shield) : raw('')}<time>${c.lastTs > 1e6 ? shortTime(c.lastTs) : ''}</time></span>
        <span class="ci-bottom"><span class="ci-text">${c.lastText || ''}</span>
          ${c.unread ? raw(html`<span class="unread ${c.muted ? 'muted' : ''}">${toFa(c.unread)}</span>`) : raw('')}</span>
      </span>
    </button></li>`).join('');
  ul.querySelectorAll('[data-open]').forEach((b) => {
    const v = b.dataset.open;
    b.onclick = () => openChat(/^\d+$/.test(v) ? Number(v) : v);
  });
}

function openMenu() {
  sheet(html`
    <div class="menu-head">${raw(avatar(S.me, 'lg'))}<div><b>${S.me.name}</b><small dir="ltr">@${S.me.username}</small></div></div>
    <div class="menu-list">
      <button data-a="newgroup">گروه جدید</button>
      <button data-a="newchannel">کانال جدید</button>
      <button data-a="ready">تست آمادگی برای نت ملی</button>
      <button data-a="profile">پروفایل، قفل و امنیت</button>
      ${S.me.isAdmin ? raw(html`<button data-a="admin">پنل مدیریت ${S.pendingRequests ? raw(html`<span class="unread">${toFa(S.pendingRequests)}</span>`) : raw('')}</button>`) : raw('')}
      <button data-a="logout" class="danger-text">خروج از حساب</button>
    </div>`, {
    onMount(el, close) {
      el.querySelectorAll('[data-a]').forEach((b) => {
        b.onclick = async () => {
          close();
          const a = b.dataset.a;
          if (a === 'ready') showReadiness();
          if (a === 'newgroup') createGroupSheet('group');
          if (a === 'newchannel') createGroupSheet('channel');
          if (a === 'profile') showProfile();
          if (a === 'admin') showAdmin();
          if (a === 'logout' && await confirmBox('خروج از حساب', 'پیام‌ها و کلیدها روی این گوشی می‌مانند و با ورود دوباره برمی‌گردند.', 'خروج')) logout();
        };
      });
    },
  });
}

// ---------- صفحه‌ی گفتگو ----------
window.addEventListener('popstate', () => {
  if (S.locked || S.decoy) return;
  if (rec.active) cancelRecording();
  if (['chat', 'profile', 'admin', 'ready', 'search'].includes(S.view)) showChats();
});

async function openChat(chatId, push = true, focusId = null) {
  const c = await getContact(chatId);
  if (!c) { showChats(); return; }
  if (push && S.view !== 'chat') history.pushState({ chat: chatId }, '');
  S.chatId = chatId;
  setReply(null);
  const dm = !isGroupId(chatId);
  const postable = canPost(c);
  setView('chat', html`
    <div class="screen chat">
      <header class="bar chat-bar">
        <button class="icon-btn" data-back aria-label="بازگشت">${raw(I.back)}</button>
        <button class="peer" data-peer>
          ${raw(chatAvatar(c))}
          <span class="peer-text"><b>${c.name} ${c.verified ? raw(I.shield) : raw('')}</b><small data-status></small></span>
        </button>
        <span class="conn" data-conn ${S.connected ? 'hidden' : ''}>در حال اتصال…</span>
        ${dm ? raw(html`<button class="icon-btn" data-call="voice" aria-label="تماس صوتی">${raw(I.phone)}</button>
          <button class="icon-btn" data-call="video" aria-label="تماس تصویری">${raw(I.video)}</button>`) : raw('')}
      </header>
      ${c.keyChanged ? raw(html`<button class="banner" data-verify>کد امنیتی ${c.name} تغییر کرده است. برای بررسی بزنید.</button>`) : raw('')}
      <main class="msgs" data-msgs aria-live="polite"></main>
      ${postable ? raw('') : raw(html`<footer class="composer readonly"><p>${c.type === 'group' ? 'شما دیگر عضو این گروه نیستید' : 'فقط مدیران می‌توانند در این کانال پیام بگذارند'}</p>
        ${c.type === 'official' || c.type === 'channel' ? raw(html`<button class="btn ghost small" data-mute>${c.muted ? 'روشن کردن اعلان' : 'بی‌صدا کردن'}</button>`) : raw('')}</footer>`)}
      <footer class="composer" ${postable ? '' : 'hidden'}>
        <div class="reply-bar" data-replybar hidden></div>
        <form class="compose-row" novalidate>
          <button type="button" class="icon-btn attach" data-attach aria-label="ارسال عکس یا فایل">${raw(I.clip)}</button>
          <div class="rec-bar" data-recbar hidden>
            <button type="button" class="icon-btn rec-trash" data-rectrash aria-label="حذف ضبط" hidden>${raw(I.trash)}</button>
            <span class="rec-dot" aria-hidden="true"></span>
            <span class="rec-time" data-rectime>۰:۰۰</span>
            <span class="rec-hint" data-rechint>برای لغو به راست بکشید</span>
          </div>
          <textarea name="text" rows="1" placeholder="پیام" dir="auto" aria-label="پیام"></textarea>
          <div class="action-wrap">
            <div class="lock-pill" data-lockpill hidden>${raw(I.lock)}${raw(I.up)}</div>
            <button type="button" class="action-btn" data-action aria-label="ضبط پیام صوتی">${raw(I.mic)}</button>
          </div>
        </form>
      </footer>
    </div>`);

  $app.querySelector('[data-back]').onclick = () => history.back();
  $app.querySelector('[data-peer]').onclick = () => (dm ? showChatInfo(chatId) : showGroupInfo(chatId));
  const verify = $app.querySelector('[data-verify]');
  if (verify) verify.onclick = () => showChatInfo(chatId);
  $app.querySelectorAll('[data-call]').forEach((b) => { b.onclick = () => calls.start(chatId, b.dataset.call === 'video'); });
  const att = $app.querySelector('[data-attach]');
  if (att) att.onclick = attachMenu;
  const mute = $app.querySelector('[data-mute]');
  if (mute) mute.onclick = async () => { c.muted = !c.muted; await saveContact(c); openChat(chatId, false); };
  setupComposer(chatId);

  await renderMessages();
  if (focusId) {
    const t = $app.querySelector(`[data-id="${CSS.escape(focusId)}"]`);
    if (t) { t.scrollIntoView({ block: 'center' }); t.classList.add('flash'); setTimeout(() => t.classList.remove('flash'), 1500); }
  }
  renderPeerStatus();
  if (dm) refreshPeer(chatId);
  if (dm && Date.now() - (c.photoAsked || 0) > 864e5) {
    c.photoAsked = Date.now();
    saveContact(c);
    encryptAndQueue(c, uid(), { type: 'profile_req' }, { silentKeyChange: true }).catch(() => {});
  }
  markRead(chatId);
  clearInterval(S.sfTimer);
  S.sfTimer = setInterval(() => {
    if (S.view !== 'chat' || S.chatId !== chatId) { clearInterval(S.sfTimer); return; }
    for (const m of msgCache.values()) if (m.kind === 'sfile' && m.exp && (m.state === 'available' || m.mine)) replaceMessageEl(m);
  }, 30_000);
}

function setupComposer(chatId) {
  const form = $app.querySelector('.compose-row');
  const ta = form.text;
  const btn = form.querySelector('[data-action]');
  let lastTyping = 0;
  const grow = () => { ta.style.height = 'auto'; ta.style.height = Math.min(ta.scrollHeight, 140) + 'px'; };
  const updateBtn = () => {
    const hasText = !!ta.value.trim();
    const att = form.querySelector('[data-attach]');
    if (att) att.hidden = hasText;
    btn.dataset.mode = hasText ? 'send' : S.composeMode;
    btn.innerHTML = hasText ? I.send : (S.composeMode === 'video' ? I.cam : I.mic);
    btn.setAttribute('aria-label', hasText ? 'ارسال' : (S.composeMode === 'video' ? 'ضبط پیام ویدیویی (نگه دارید)' : 'ضبط پیام صوتی (نگه دارید)'));
  };
  updateBtn();
  ta.addEventListener('input', () => {
    grow();
    updateBtn();
    if (!isGroupId(chatId) && Date.now() - lastTyping > 3000 && ta.value) { lastTyping = Date.now(); wsSend({ t: 'typing', to: chatId }); }
  });
  ta.addEventListener('keydown', (e) => {
    if (!isTouch && e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); submit(); }
  });
  const submit = () => {
    const text = ta.value.trim();
    if (!text) return;
    ta.value = '';
    grow();
    updateBtn();
    sendText(text);
    if (isTouch) ta.focus();
  };
  form.onsubmit = (e) => { e.preventDefault(); submit(); };
  bindRecordButton(btn, () => btn.dataset.mode === 'send', submit, () => { S.composeMode = S.composeMode === 'voice' ? 'video' : 'voice'; updateBtn(); });

  $app.querySelector('[data-rectrash]').onclick = () => cancelRecording();
}

// ---------- ضبط ویس و ویدیو (نگه دار و ضبط کن، بکش برای لغو، بکش بالا برای قفل) ----------
const rec = { active: null, kind: null, locked: false, released: false, timer: null, overlay: null };

function bindRecordButton(btn, isSendMode, onSend, onToggle) {
  let holdTimer = null;
  let sx = 0;
  let sy = 0;
  let pressed = false;
  btn.addEventListener('pointerdown', (e) => {
    if (isSendMode()) return;
    if (rec.active && rec.locked) return;
    e.preventDefault();
    if (S.composeMode === 'video' && camBroken.get()) { nativeVideoNote(); return; } // دوربین خود آیفون
    pressed = true;
    sx = e.clientX; sy = e.clientY;
    // دوربین/میکروفون همین لحظه (داخل لمس) درخواست می‌شود؛ قبل از هر کار دیگری
    const mode = S.composeMode;
    let pre = null;
    if (mediaSupported()) { pre = requestMedia(mode); pre.catch(() => {}); }
    unlockAudio();
    try { btn.setPointerCapture(e.pointerId); } catch { /* ignore */ }
    holdTimer = setTimeout(() => { holdTimer = null; beginRecording(mode, pre); }, 220);
    btn._pre = pre;
  });
  btn.addEventListener('pointermove', (e) => {
    if (!pressed || !rec.active || rec.locked) return;
    const dx = e.clientX - sx;
    const dy = e.clientY - sy;
    const hint = $app.querySelector('[data-rechint]');
    if (hint) hint.style.opacity = String(Math.max(0.25, 1 - Math.max(0, dx) / 120));
    if (dx > 110) { pressed = false; cancelRecording(); return; }
    if (dy < -80) lockRecording();
  });
  const release = (cancel) => {
    if (!pressed) return;
    pressed = false;
    if (holdTimer) {
      clearTimeout(holdTimer); holdTimer = null;
      btn._pre?.then((st) => st.getTracks().forEach((t) => t.stop())).catch(() => {}); // ضربه‌ی کوتاه: دوربین بسته می‌شود
      if (!cancel) onToggle();
      return;
    }
    if (!rec.active) { rec.released = true; return; }
    if (rec.locked) return;
    if (cancel) cancelRecording(); else finishRecording();
  };
  btn.addEventListener('pointerup', () => release(false));
  btn.addEventListener('pointercancel', () => release(true));
  btn.addEventListener('click', (e) => {
    if (isSendMode()) { e.preventDefault(); onSend(); return; }
    if (rec.active && rec.locked) { e.preventDefault(); finishRecording(); }
  });
  btn.addEventListener('contextmenu', (e) => e.preventDefault());
}

async function beginRecording(kind, pre = null) {
  if (!mediaSupported()) { toast('این گوشی ضبط را پشتیبانی نمی‌کند'); return; }
  const r = new Recorder(kind === 'video' ? 'video' : 'voice');
  rec.active = r; rec.kind = r.kind; rec.locked = false; rec.released = false;
  showRecUI(true);
  try {
    // اگر دوربین یا میکروفون ظرف ۸ ثانیه جواب نداد، ضبط لغو می‌شود (هرگز گیر نمی‌کند)
    await Promise.race([r.start(pre), new Promise((_, rej) => setTimeout(() => rej(Object.assign(new Error('timeout'), { timeout: true })), 8000))]);
  } catch (e) {
    r.cancel();
    endRecUI();
    rec.active = null;
    if (e.name === 'NotAllowedError') toast(kind === 'video' ? 'برای ضبط ویدیو، اجازه‌ی دوربین و میکروفون را بدهید' : 'برای ضبط صدا، اجازه‌ی میکروفون را بدهید');
    else if (e.timeout) toast('دوربین یا میکروفون جواب نداد. برنامه را کامل ببندید و دوباره باز کنید.');
    else if (e.message !== 'cancelled') toast('ضبط شروع نشد');
    return;
  }
  if (rec.active !== r) { r.cancel(); return; }
  if (rec.released) { cancelRecording(); toast('برای ضبط، دکمه را نگه دارید'); return; }
  if (navigator.vibrate) navigator.vibrate(20);
  if (r.kind === 'video') {
    showVideoPreview(r.stream);
    setTimeout(() => {
      const v = rec.overlay?.querySelector('video');
      if (rec.active === r && v && v.videoWidth === 0) {
        camBroken.set(true);
        cancelRecording();
        toast('دوربین داخل برنامه روی این گوشی تصویر نمی‌دهد. از این به بعد با زدن دکمه، دوربین خود آیفون باز می‌شود.');
      }
    }, 2500);
  }
  const limit = r.kind === 'video' ? LIMITS.videoSeconds : LIMITS.voiceSeconds;
  rec.timer = setInterval(() => {
    const t = r.seconds;
    const el = $app.querySelector('[data-rectime]');
    if (el) el.textContent = fmtDuration(t);
    if (rec.overlay) rec.overlay.querySelector('.vrec-ring circle.p').style.strokeDashoffset = String(1 - Math.min(1, t / limit));
    if (t >= limit) finishRecording();
  }, 200);
}

// ویدیو مسیج با دوربین خود آیفون (وقتی دوربین داخل برنامه کار نمی‌کند)
function nativeVideoNote() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'video/*';
  input.setAttribute('capture', 'user');
  input.onchange = async () => {
    const f = input.files?.[0];
    if (!f) return;
    if (f.size > LIMITS.maxBytes) { toast('ویدیو خیلی بزرگ است؛ حداکثر ۵۰ مگابایت (حدود یک دقیقه)'); return; }
    const url = URL.createObjectURL(f);
    const duration = await new Promise((resolve) => {
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onloadedmetadata = () => resolve(Number.isFinite(v.duration) ? v.duration : 0);
      v.onerror = () => resolve(0);
      v.src = url;
      setTimeout(() => resolve(0), 4000);
    });
    URL.revokeObjectURL(url);
    if (duration > LIMITS.videoSeconds + 5) { toast('ویدیو مسیج حداکثر ۶۰ ثانیه است'); return; }
    const buf = scrubVideoLocation(await f.arrayBuffer());
    sendMediaMessage('vnote', { blob: new Blob([buf], { type: f.type || 'video/quicktime' }), mime: f.type || 'video/quicktime', duration: duration || 1, wave: [] });
  };
  input.click();
}

function lockRecording() {
  if (!rec.active || rec.locked) return;
  rec.locked = true;
  $app.querySelector('[data-lockpill]')?.setAttribute('hidden', '');
  $app.querySelector('[data-rectrash]')?.removeAttribute('hidden');
  const hint = $app.querySelector('[data-rechint]');
  if (hint) { hint.textContent = 'ضبط ادامه دارد'; hint.style.opacity = '1'; }
  const btn = $app.querySelector('[data-action]');
  if (btn) { btn.innerHTML = I.send; btn.setAttribute('aria-label', 'ارسال'); }
}

function showRecUI(on) {
  const bar = $app.querySelector('[data-recbar]');
  const ta = $app.querySelector('.compose-row textarea');
  const pill = $app.querySelector('[data-lockpill]');
  if (!bar) return;
  bar.hidden = !on; if (ta) ta.hidden = on; if (pill) pill.hidden = !on;
  $app.querySelector('[data-action]')?.classList.toggle('recording', on);
  if (on) {
    $app.querySelector('[data-rectime]').textContent = fmtDuration(0);
    const hint = $app.querySelector('[data-rechint]');
    hint.textContent = 'برای لغو به راست بکشید'; hint.style.opacity = '1';
    $app.querySelector('[data-rectrash]').hidden = true;
  }
}

function endRecUI() {
  clearInterval(rec.timer);
  rec.timer = null;
  showRecUI(false);
  rec.overlay?.remove();
  rec.overlay = null;
  const btn = $app.querySelector('[data-action]');
  if (btn) btn.innerHTML = S.composeMode === 'video' ? I.cam : I.mic;
}

function showVideoPreview(stream) {
  const o = document.createElement('div');
  o.className = 'vrec-overlay';
  o.innerHTML = `<div class="vrec-circle"><video autoplay muted playsinline webkit-playsinline></video>
    <svg class="vrec-ring" viewBox="0 0 100 100" aria-hidden="true"><circle class="bg" cx="50" cy="50" r="48" pathLength="1"/><circle class="p" cx="50" cy="50" r="48" pathLength="1"/></svg></div>`;
  document.body.appendChild(o);
  const v = o.querySelector('video');
  v.muted = true;
  v.playsInline = true;
  v.srcObject = stream;
  v.play().catch(() => {});
  rec.overlay = o;
}

async function finishRecording() {
  const r = rec.active;
  if (!r) return;
  rec.active = null;
  endRecUI();
  let result;
  try { result = await r.stop(); } catch { return; }
  if (result.duration < 0.8) { toast('خیلی کوتاه بود؛ دکمه را بیشتر نگه دارید'); return; }
  sendMediaMessage(r.kind === 'video' ? 'vnote' : 'voice', result);
}

function cancelRecording() {
  const r = rec.active;
  rec.active = null;
  r?.cancel();
  endRecUI();
}

async function refreshPeer(chatId) {
  try {
    await fetchContact(chatId);
    if (S.view === 'chat' && S.chatId === chatId) renderPeerStatus();
  } catch { /* ignore */ }
}

function renderPeerStatus() {
  const el = $app.querySelector('[data-status]');
  if (!el || S.view !== 'chat') return;
  const id = S.chatId;
  el.classList.remove('live');
  if (isGroupId(id)) {
    const c = S.contacts.get(id);
    if (c?.type === 'official') { el.textContent = 'کانال رسمی'; return; }
    if (c?.type === 'saved') { el.textContent = 'فقط روی همین گوشی'; return; }
    const n = (c?.members || []).length;
    el.textContent = `${c?.type === 'channel' ? 'کانال' : 'گروه'} • ${toFa(n)} عضو`;
    return;
  }
  const typingUntil = S.typing.get(id);
  if (typingUntil && typingUntil > Date.now()) { el.textContent = 'در حال نوشتن…'; el.classList.add('live'); }
  else if (S.online.has(id)) { el.textContent = 'آنلاین'; el.classList.add('live'); }
  else el.textContent = lastSeenText(S.lastSeen.get(id));
}

// ---------- نمایش پیام‌ها ----------
let msgCache = new Map();
async function renderMessages() {
  const box = $app.querySelector('[data-msgs]');
  const list = await messages.byChat(S.chatId);
  msgCache = new Map(list.map((m) => [m.id, m]));
  if (!list.length) {
    box.innerHTML = html`<div class="chat-empty">${raw(I.lock)}<p>پیام‌های این گفتگو روی گوشی شما قفل می‌شوند و فقط شما دو نفر می‌توانید آن‌ها را بخوانید.</p></div>`;
    return;
  }
  let lastDay = '';
  const parts = [];
  for (const m of list) {
    const d = dayKey(m.ts);
    if (d !== lastDay) { parts.push(html`<div class="day" data-day="${d}"><span>${dayLabel(m.ts)}</span></div>`); lastDay = d; }
    parts.push(msgHtml(m));
  }
  box.innerHTML = parts.join('');
  bindMessages(box);
  hydrateMedia(box);
  box.scrollTop = box.scrollHeight;
}

function tickHtml(m) {
  if (!m.mine || m.status === 'saved') return '';
  if (m.status === 'failed') return I.fail;
  if (m.status === 'pending') return I.clock;
  if (m.status === 'sent') return I.one;
  return I.two;
}

function quoteHtml(m) {
  if (!m.replyTo) return '';
  const r = msgCache.get(m.replyTo);
  const who = r ? (r.mine ? 'شما' : nameOf(isGroupId(r.chatId) ? r.from : r.chatId)) : '';
  return html`<button class="quote" data-jump="${m.replyTo}"><b>${who || 'پیام'}</b><span>${r ? previewText(r) : 'پیام حذف شده'}</span></button>`;
}

function metaHtml(m) {
  return html`<span class="meta"><time>${fmtTime.format(m.ts)}</time><span class="st st-${m.status || ''}">${raw(tickHtml(m))}</span></span>`;
}

function senderHtml(m) {
  if (m.mine || !isGroupId(m.chatId) || S.contacts.get(m.chatId)?.type === 'official') return '';
  return html`<b class="sender">${nameOf(m.from)}</b>`;
}

function msgHtml(m) {
  if (m.kind === 'system') return html`<div class="sys" data-id="${m.id}">${m.text}</div>`;
  if (m.kind === 'call') {
    return html`<div class="msg ${m.mine ? 'mine' : 'theirs'}" data-id="${m.id}"><div class="bubble call-bubble ${m.status === 'done' ? '' : 'missed'}">
      <p class="text">${callText(m)}</p><span class="meta"><time>${fmtTime.format(m.ts)}</time></span></div></div>`;
  }
  if (m.kind === 'sfile') {
    const left = Math.max(0, Math.round((m.exp - Date.now()) / 60000));
    const what = m.mime?.startsWith('video') ? 'فیلم رمزدار' : 'عکس رمزدار';
    let body;
    if (m.mine) body = html`<p class="sf-title">${raw(I.file)} ${what}</p><p class="sf-sub">${m.status === 'failed' ? 'ارسال نشد' : Date.now() > m.exp ? 'از سرور پاک شد' : `تا ${toFa(left)} دقیقه‌ی دیگر قابل دریافت است`}</p>`;
    else if (m.state === 'available' && Date.now() < m.exp) body = html`<p class="sf-title">${raw(I.file)} ${what}</p><p class="sf-sub">تا ${toFa(left)} دقیقه‌ی دیگر قابل دریافت است</p><button class="btn primary small" data-sopen>دریافت</button>`;
    else if (m.state === 'opened') body = html`<p class="sf-title">${raw(I.file)} ${what}</p><p class="sf-sub">دریافت و باز شد؛ کلیدش نابود شد</p>`;
    else body = html`<p class="sf-title">${raw(I.file)} ${what}</p><p class="sf-sub">زمانش تمام شد و از سرور پاک شد</p>`;
    return html`<div class="msg ${m.mine ? 'mine' : 'theirs'}" data-id="${m.id}"><div class="bubble sfile">${raw(senderHtml(m))}${raw(body)}${raw(metaHtml(m))}</div></div>`;
  }
  if (m.kind === 'error') {
    return html`<div class="msg theirs broken" data-id="${m.id}"><div class="bubble"><p class="text">این پیام قابل باز شدن نبود.</p>
      <span class="meta"><time>${fmtTime.format(m.ts)}</time></span></div></div>`;
  }
  const side = m.mine ? 'mine' : 'theirs';
  if (m.kind === 'photo') {
    const state = m.media === 'local' ? 'ready' : m.media;
    return html`
      <div class="msg ${side}" data-id="${m.id}">
        <div class="bubble photo-bubble">
          ${raw(senderHtml(m))}
          ${raw(quoteHtml(m))}
          <button class="photo" data-photo="${m.id}" data-state="${state}" data-pw="${m.w}" data-ph="${m.h}" aria-label="نمایش عکس">
            ${state === 'failed' ? raw('<span class="media-err">عکس دریافت نشد</span>') : state !== 'ready' ? raw('<span class="photo-wait">در حال دریافت…</span>') : raw('')}
          </button>
          ${raw(metaHtml(m))}
        </div>
      </div>`;
  }
  if (m.kind === 'file') {
    const state = m.media === 'local' ? 'ready' : m.media;
    const isVideo = m.mime?.startsWith('video/');
    return html`
      <div class="msg ${side}" data-id="${m.id}">
        <div class="bubble file-bubble">
          ${raw(senderHtml(m))}
          ${raw(quoteHtml(m))}
          <button class="file-row" data-fopen="${m.id}" data-state="${state}">
            <span class="file-icon">${raw(isVideo ? I.video : I.clip)}</span>
            <span class="file-info"><b dir="auto">${m.name || 'فایل'}</b>
              <small>${fmtSize(m.size)} • ${state === 'ready' ? (isVideo ? 'برای پخش بزنید' : 'برای ذخیره بزنید') : state === 'failed' ? 'دریافت نشد' : 'در حال دریافت…'}</small></span>
          </button>
          ${raw(metaHtml(m))}
        </div>
      </div>`;
  }
  if (m.kind === 'voice') {
    const state = m.media === 'local' ? 'ready' : m.media;
    return html`
      <div class="msg ${side}" data-id="${m.id}">
        <div class="bubble voice-bubble">
          ${raw(senderHtml(m))}
          ${raw(quoteHtml(m))}
          <div class="voice" data-voice="${m.id}" data-state="${state}">
            <button class="play-btn" data-play aria-label="پخش">${raw(state === 'ready' ? I.play : '')}</button>
            <div class="wave" data-wave="${(m.wave || []).join(',')}"></div>
          </div>
          <div class="voice-foot"><span class="vdur" data-vdur>${fmtDuration(m.dur)}</span>
            ${state === 'failed' ? raw('<span class="media-err">فایل دریافت نشد</span>') : raw('')}
            ${raw(metaHtml(m))}</div>
        </div>
      </div>`;
  }
  if (m.kind === 'vnote') {
    const state = m.media === 'local' ? 'ready' : m.media;
    return html`
      <div class="msg ${side} vnote-row" data-id="${m.id}">
        <div class="vnote" data-vnote="${m.id}" data-state="${state}">
          <video muted playsinline loop preload="auto"></video>
          <svg class="vnote-ring" viewBox="0 0 100 100" aria-hidden="true"><circle cx="50" cy="50" r="48.5" pathLength="1"/></svg>
          <span class="vnote-badge">${raw(I.mute)}<span>${fmtDuration(m.dur)}</span></span>
          ${state !== 'ready' ? raw(`<span class="vnote-state">${state === 'failed' ? 'فایل دریافت نشد' : 'در حال دریافت…'}</span>`) : raw('')}
          ${raw(metaHtml(m))}
        </div>
      </div>`;
  }
  return html`
    <div class="msg ${side}" data-id="${m.id}">
      <div class="bubble">
        ${raw(senderHtml(m))}
        ${raw(quoteHtml(m))}
        <p class="text" dir="auto">${m.text}</p>
        ${raw(metaHtml(m))}
      </div>
    </div>`;
}

function appendMessage(m, forceScroll = false) {
  const box = $app.querySelector('[data-msgs]');
  if (!box || !m) return;
  msgCache.set(m.id, m);
  box.querySelector('.chat-empty')?.remove();
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 160;
  const d = dayKey(m.ts);
  if (!box.querySelector(`[data-day="${CSS.escape(d)}"]`)) {
    box.insertAdjacentHTML('beforeend', html`<div class="day" data-day="${d}"><span>${dayLabel(m.ts)}</span></div>`);
  }
  box.insertAdjacentHTML('beforeend', msgHtml(m));
  bindMessages(box);
  hydrateMedia(box);
  if (nearBottom || forceScroll) box.scrollTo({ top: box.scrollHeight, behavior: 'smooth' });
}

function replaceMessageEl(m) {
  msgCache.set(m.id, m);
  const el = $app.querySelector(`[data-id="${CSS.escape(m.id)}"]`);
  if (!el) return;
  el.insertAdjacentHTML('afterend', msgHtml(m));
  el.remove();
  const box = $app.querySelector('[data-msgs]');
  bindMessages(box);
  hydrateMedia(box);
}

function updateMessageEl(m) {
  msgCache.set(m.id, m);
  const el = $app.querySelector(`[data-id="${CSS.escape(m.id)}"] .st`);
  if (el) { el.className = `st st-${m.status}`; el.innerHTML = tickHtml(m); }
}

// ---------- پخش ویس ----------
const player = new Audio();
player.preload = 'auto';
const playing = { id: null, url: null };

function stopAudio() {
  player.pause();
  if (playing.url) URL.revokeObjectURL(playing.url);
  const el = playing.id && document.querySelector(`[data-voice="${CSS.escape(playing.id)}"]`);
  if (el) { el.querySelector('[data-play]').innerHTML = I.play; paintWave(el, 0); }
  playing.id = null;
  playing.url = null;
}

async function toggleVoice(id) {
  const el = document.querySelector(`[data-voice="${CSS.escape(id)}"]`);
  if (playing.id === id) {
    if (player.paused) { player.play(); el.querySelector('[data-play]').innerHTML = I.pause; }
    else { player.pause(); el.querySelector('[data-play]').innerHTML = I.play; }
    return;
  }
  stopAudio();
  const recd = await media.get(id);
  if (!recd) return;
  playing.id = id;
  playing.url = URL.createObjectURL(new Blob([recd.buf], { type: recd.mime }));
  player.src = playing.url;
  player.playbackRate = S.speed;
  try { await player.play(); } catch { toast('پخش انجام نشد'); stopAudio(); return; }
  player.playbackRate = S.speed;
  el.querySelector('[data-play]').innerHTML = I.pause;
}

player.addEventListener('timeupdate', () => {
  if (!playing.id) return;
  const el = document.querySelector(`[data-voice="${CSS.escape(playing.id)}"]`);
  if (!el) return;
  const dur = Number.isFinite(player.duration) && player.duration > 0 ? player.duration : (msgCache.get(playing.id)?.dur || 1);
  paintWave(el, player.currentTime / dur);
  const d = el.closest('.bubble')?.querySelector('[data-vdur]');
  if (d) d.textContent = fmtDuration(player.currentTime);
});
player.addEventListener('ended', () => {
  const id = playing.id;
  stopAudio();
  const m = id && msgCache.get(id);
  const d = id && document.querySelector(`[data-id="${CSS.escape(id)}"] [data-vdur]`);
  if (d && m) d.textContent = fmtDuration(m.dur);
});

function paintWave(el, p) {
  const bars = el.querySelectorAll('.wave i');
  const on = Math.round(p * bars.length);
  bars.forEach((b, i) => b.classList.toggle('on', i < on));
}

// ---------- آماده‌سازی ویس و ویدیو بعد از نمایش ----------
let vObserver = null;
function hydrateMedia(box) {
  box.querySelectorAll('[data-voice]:not([data-h])').forEach((el) => {
    el.dataset.h = '1';
    const wave = el.querySelector('[data-wave]');
    const vals = (wave.dataset.wave || '').split(',').filter(Boolean).map(Number);
    const bars = vals.length ? vals : new Array(40).fill(4);
    for (const v of bars) {
      const i = document.createElement('i');
      i.style.height = `${Math.max(3, Math.round((v / 31) * 22))}px`;
      wave.appendChild(i);
    }
    if (el.dataset.state === 'ready') {
      el.querySelector('[data-play]').onclick = (e) => { e.stopPropagation(); toggleVoice(el.dataset.voice); };
      wave.onclick = (e) => {
        e.stopPropagation();
        if (playing.id !== el.dataset.voice) return;
        const r = wave.getBoundingClientRect();
        const p = Math.min(1, Math.max(0, (r.right - e.clientX) / r.width)); // راست‌به‌چپ
        if (Number.isFinite(player.duration)) player.currentTime = p * player.duration;
      };
    }
    const foot = el.closest('.bubble')?.querySelector('.voice-foot');
    if (foot && !foot.querySelector('.speed')) {
      const sp = document.createElement('button');
      sp.className = 'speed';
      sp.type = 'button';
      sp.textContent = speedLabel();
      sp.onclick = (e) => {
        e.stopPropagation();
        S.speed = S.speed === 1 ? 1.5 : S.speed === 1.5 ? 2 : 1;
        player.playbackRate = S.speed;
        document.querySelectorAll('.speed').forEach((b) => { b.textContent = speedLabel(); });
      };
      foot.prepend(sp);
    }
  });

  box.querySelectorAll('[data-photo]:not([data-h])').forEach(async (el) => {
    el.dataset.h = '1';
    const w = Number(el.dataset.pw) || 4;
    const h = Number(el.dataset.ph) || 3;
    el.style.aspectRatio = `${w} / ${Math.min(h, w * 2)}`;
    el.onclick = (e) => { e.stopPropagation(); if (el.dataset.state === 'ready') openMediaMessage(el.dataset.photo); };
    if (el.dataset.state !== 'ready') return;
    const recd = await media.get(el.dataset.photo);
    if (!recd) return;
    const url = URL.createObjectURL(new Blob([recd.buf], { type: 'image/jpeg' }));
    S.urls.push(url);
    const img = document.createElement('img');
    img.alt = '';
    img.src = url;
    el.appendChild(img);
  });
  box.querySelectorAll('[data-fopen]:not([data-h])').forEach((b) => {
    b.dataset.h = '1';
    b.onclick = (e) => { e.stopPropagation(); if (b.dataset.state === 'ready') openMediaMessage(b.dataset.fopen); };
  });
  box.querySelectorAll('[data-sopen]:not([data-h])').forEach((b) => {
    b.dataset.h = '1';
    b.onclick = (e) => { e.stopPropagation(); openSecretFile(b.closest('[data-id]').dataset.id); };
  });
  if (!vObserver) {
    vObserver = new IntersectionObserver((entries) => {
      for (const en of entries) {
        const v = en.target.querySelector('video');
        if (!v || !v.src || !v.muted) continue;
        if (en.isIntersecting) v.play().catch(() => {}); else v.pause();
      }
    }, { threshold: 0.4 });
  }
  box.querySelectorAll('[data-vnote]:not([data-h])').forEach(async (el) => {
    el.dataset.h = '1';
    if (el.dataset.state !== 'ready') return;
    const recd = await media.get(el.dataset.vnote);
    if (!recd) return;
    const url = URL.createObjectURL(new Blob([recd.buf], { type: recd.mime }));
    S.urls.push(url);
    const v = el.querySelector('video');
    v.src = url;
    vObserver.observe(el);
    const ring = el.querySelector('.vnote-ring circle');
    v.addEventListener('timeupdate', () => {
      if (v.muted) return;
      const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 1;
      ring.style.strokeDashoffset = String(1 - v.currentTime / d);
    });
    v.addEventListener('ended', () => { setVnoteMuted(el, true); });
    el.addEventListener('click', (e) => {
      if (e.target.closest('.quote')) return;
      if (v.muted) {
        // فقط یک ویدیو با صدا پخش شود
        document.querySelectorAll('[data-vnote].sound').forEach((o) => { if (o !== el) setVnoteMuted(o, true); });
        stopAudio();
        setVnoteMuted(el, false);
        v.currentTime = 0;
        v.play().catch(() => {});
      } else if (v.paused) v.play().catch(() => {});
      else v.pause();
    });
  });
}

function setVnoteMuted(el, muted) {
  const v = el.querySelector('video');
  v.muted = muted;
  v.loop = muted;
  el.classList.toggle('sound', !muted);
  el.querySelector('.vnote-ring circle').style.strokeDashoffset = '1';
  if (muted) v.play().catch(() => {});
}

const speedLabel = () => `${S.speed.toLocaleString('fa-IR')}×`;

// نگه داشتن انگشت = منو، کشیدن به چپ = پاسخ
function bindMessages(box) {
  box.querySelectorAll('.msg:not([data-bound])').forEach((el) => {
    el.dataset.bound = '1';
    const target = el.querySelector('.bubble, .vnote');
    let timer = null;
    let sx = 0; let sy = 0; let dx = 0; let tracking = false; let horizontal = false;
    const reset = () => { clearTimeout(timer); target.style.transform = ''; tracking = false; horizontal = false; dx = 0; };
    el.addEventListener('pointerdown', (e) => {
      if (e.target.closest('.quote, [data-play], .speed, .wave')) return;
      // روی عکس و فایل هم نگه داشتن منو را باز می‌کند
      sx = e.clientX; sy = e.clientY; dx = 0; tracking = true; horizontal = false;
      timer = setTimeout(() => { tracking = false; openMessageMenu(el.dataset.id); }, 480);
    });
    el.addEventListener('pointermove', (e) => {
      if (!tracking) return;
      const mx = e.clientX - sx;
      const my = e.clientY - sy;
      if (Math.abs(mx) > 8 || Math.abs(my) > 8) clearTimeout(timer);
      if (!horizontal && Math.abs(mx) > 12 && Math.abs(mx) > Math.abs(my) * 1.5) horizontal = true;
      if (horizontal) {
        dx = Math.max(-80, Math.min(0, mx));
        target.style.transform = `translateX(${dx}px)`;
      }
    });
    const end = () => {
      if (horizontal && dx < -55) {
        const m = msgCache.get(el.dataset.id);
        if (m && ['text', 'voice', 'vnote', 'photo', 'file'].includes(m.kind)) setReply(m);
      }
      reset();
    };
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', reset);
    el.addEventListener('pointerleave', () => { if (!horizontal) clearTimeout(timer); });
    el.addEventListener('contextmenu', (e) => { e.preventDefault(); reset(); openMessageMenu(el.dataset.id); });
    const q = el.querySelector('.quote');
    if (q) q.onclick = (e) => {
      e.stopPropagation();
      const t = box.querySelector(`[data-id="${CSS.escape(q.dataset.jump)}"]`);
      if (!t) return;
      t.scrollIntoView({ behavior: 'smooth', block: 'center' });
      t.classList.add('flash');
      setTimeout(() => t.classList.remove('flash'), 1200);
    };
  });
}

function openMessageMenu(id) {
  const m = msgCache.get(id);
  if (!m) return;
  if (!['text', 'voice', 'vnote', 'photo', 'file'].includes(m.kind)) {
    sheet(html`<div class="menu-list"><button data-a="del" class="danger-text">حذف برای من</button></div>`, {
      onMount(el, close) { el.querySelector('[data-a]').onclick = () => { close(); deleteMessage(m, false); }; },
    });
    return;
  }
  if (navigator.vibrate) navigator.vibrate(15);
  const preview = m.kind === 'text' ? (m.text.length > 120 ? m.text.slice(0, 120) + '…' : m.text) : previewText(m);
  sheet(html`
    <p class="menu-preview" dir="auto">${preview}</p>
    <div class="menu-list">
      ${m.mine && m.status === 'failed' ? raw('<button data-a="resend">ارسال دوباره</button>') : raw('')}
      <button data-a="reply">پاسخ</button>
      ${m.kind === 'text' ? raw('<button data-a="copy">کپی</button>') : raw('')}
      ${(m.kind === 'photo' || m.kind === 'file') && m.media === 'local' ? raw('<button data-a="save">ذخیره در گوشی</button>') : raw('')}
      <button data-a="delme" class="danger-text">${m.status === 'saved' ? 'حذف' : 'حذف برای من'}</button>
      ${m.mine && m.status !== 'failed' && m.status !== 'saved' ? raw('<button data-a="delall" class="danger-text">حذف برای هر دو</button>') : raw('')}
    </div>`, {
    onMount(el, close) {
      el.querySelectorAll('[data-a]').forEach((b) => {
        b.onclick = async () => {
          close();
          const a = b.dataset.a;
          if (a === 'resend') resend(m);
          if (a === 'reply') setReply(m);
          if (a === 'save') { const r = await media.get(m.id); if (r) saveBlob(new Blob([r.buf], { type: m.mime }), m.mime, m.name); }
          if (a === 'copy') { try { await navigator.clipboard.writeText(m.text); toast('کپی شد'); } catch { toast('کپی انجام نشد'); } }
          if (a === 'delme') deleteMessage(m, false);
          if (a === 'delall' && await confirmBox('حذف برای هر دو', 'این پیام از گوشی طرف مقابل هم پاک می‌شود.', 'حذف', true)) deleteMessage(m, true);
        };
      });
    },
  });
}

function setReply(m) {
  S.replyTo = m;
  const bar = document.querySelector('[data-replybar]');
  if (!bar) return;
  if (!m) { bar.hidden = true; bar.innerHTML = ''; return; }
  const who = m.mine ? 'شما' : nameOf(isGroupId(m.chatId) ? m.from : m.chatId);
  bar.hidden = false;
  bar.innerHTML = html`<div class="quote static"><b>پاسخ به ${who}</b><span>${previewText(m)}</span></div>
    <button class="icon-btn" data-x aria-label="لغو پاسخ">${raw(I.close)}</button>`;
  bar.querySelector('[data-x]').onclick = () => setReply(null);
  document.querySelector('.compose-row textarea')?.focus();
}

async function showChatInfo(chatId) {
  const c = await getContact(chatId);
  const code = c.ecdhPub ? await C.safetyCode(S.identity, c) : '—';
  sheet(html`
    <div class="menu-head">${raw(avatar(c, 'lg'))}<div><b>${c.name}</b><small dir="ltr">@${c.username}</small></div></div>
    <h2 class="sheet-title">کد امنیتی این گفتگو ${c.verified ? raw(I.shield) : raw('')}</h2>
    <p class="code" dir="ltr">${code}</p>
    <p class="sheet-text">این کد را حضوری با گوشی ${c.name} مقایسه کنید. اگر روی هر دو گوشی یکی بود، مطمئن باشید هیچ‌کس، حتی سرور، بین شما قرار نگرفته است.</p>
    <div class="sheet-actions">
      ${c.verified
        ? raw('<button class="btn ghost" data-unverify>برداشتن علامت تأیید</button>')
        : raw('<button class="btn primary" data-ok>کد را حضوری مقایسه کردم و یکی است</button>')}
    </div>`, {
    onMount(el, close) {
      const ok = el.querySelector('[data-ok]');
      if (ok) ok.onclick = async () => {
        c.keyChanged = false;
        c.verified = true;
        await saveContact(c);
        close();
        openChat(chatId, false);
      };
      const un = el.querySelector('[data-unverify]');
      if (un) un.onclick = async () => { c.verified = false; await saveContact(c); close(); openChat(chatId, false); };
    },
  });
}

// ---------- ساخت و مدیریت گروه و کانال ----------
function parseUsernames(text) {
  return [...new Set(String(text).split(/[\s,،]+/).map((x) => x.trim().replace(/^@/, '').toLowerCase()).filter(Boolean))];
}

async function resolveUsernames(names) {
  if (!S.directory.size) await loadDirectory();
  const byName = new Map([...S.directory.values()].map((u) => [u.username, u]));
  const ids = [];
  const missing = [];
  for (const n of names) { const u = byName.get(n); if (u && u.id !== S.me.id) ids.push(u.id); else if (!u) missing.push(n); }
  return { ids, missing };
}

function createGroupSheet(kind) {
  const label = kind === 'channel' ? 'کانال' : 'گروه';
  sheet(html`
    <h2 class="sheet-title">${label} جدید</h2>
    <form class="sheet-form" novalidate>
      <label class="field"><span>نام ${label}</span><input name="gname" maxlength="40" required></label>
      <label class="field"><span>آیدی اعضا</span>
        <input name="members" dir="ltr" autocapitalize="none" spellcheck="false" placeholder="maman_jan, baba_jan">
        <small>آیدی‌ها را با فاصله یا ویرگول جدا کنید</small></label>
      <p class="form-error" hidden></p>
      <div class="sheet-actions"><button class="btn primary">ساخت ${label}</button></div>
    </form>`, {
    onMount(el, close) {
      const form = el.querySelector('form');
      form.onsubmit = (e) => {
        e.preventDefault();
        formError(form, '');
        const name = form.gname.value.trim();
        if (!name) return formError(form, `نام ${label} را بنویسید`);
        busy(form.querySelector('.btn'), async () => {
          const { ids, missing } = await resolveUsernames(parseUsernames(form.members.value));
          if (missing.length) return formError(form, `این آیدی‌ها پیدا نشد: ${missing.join('، ')}`);
          if (kind === 'group' && ids.length < 2) return formError(form, 'گروه حداقل سه نفره است (شما و دو نفر دیگر)');
          const gid = uid();
          const chat = {
            id: (kind === 'channel' ? 'c:' : 'g:') + gid, type: kind, gid, name,
            members: [S.me.id, ...ids], admins: [S.me.id], owner: S.me.id, v: 0,
            lastText: `${label} ساخته شد`, lastTs: Date.now(), unread: 0,
          };
          await broadcastGroupState(chat);
          close();
          openChat(chat.id);
        });
      };
    },
  });
}

async function showGroupInfo(chatId) {
  const c = await getContact(chatId);
  if (!c) return;
  if (c.type === 'saved') {
    sheet(html`<div class="menu-head">${raw(chatAvatar(c, 'lg'))}<div><b>${c.name}</b><small>فقط روی همین گوشی</small></div></div>
      <p class="sheet-text">هر چیزی اینجا بگذارید (یادداشت، ویس، عکس، فایل) فقط روی همین گوشی و قفل‌شده ذخیره می‌شود و هیچ‌وقت به سرور فرستاده نمی‌شود. اگر آیکون برنامه پاک شود، این‌ها هم پاک می‌شوند.</p>`);
    return;
  }
  if (c.type === 'official') {
    sheet(html`<div class="menu-head">${raw(chatAvatar(c, 'lg'))}<div><b>${c.name}</b><small>اطلاعیه‌های مدیر</small></div></div>
      <p class="sheet-text">همه‌ی اعضا عضو این کانال هستند و فقط مدیر در آن پیام می‌گذارد. پیام‌ها مثل بقیه‌ی گفتگوها رمزنگاری سرتاسری دارند.</p>
      <div class="sheet-actions"><button class="btn ghost" data-mute>${c.muted ? 'روشن کردن اعلان' : 'بی‌صدا کردن'}</button></div>`, {
      onMount(el, close) { el.querySelector('[data-mute]').onclick = async () => { c.muted = !c.muted; await saveContact(c); close(); openChat(chatId, false); }; },
    });
    return;
  }
  const isAdmin = (c.admins || []).includes(S.me.id);
  const label = c.type === 'channel' ? 'کانال' : 'گروه';
  const rows = (c.members || []).map((id) => html`
    <li class="member"><span>${nameOf(id)} ${(c.admins || []).includes(id) ? raw('<span class="tag">مدیر</span>') : raw('')}</span>
      ${isAdmin && id !== S.me.id && !c.left ? raw(html`<button class="link-btn danger-text" data-remove="${id}">حذف</button>`) : raw('')}</li>`).join('');
  sheet(html`
    <div class="menu-head">${raw(chatAvatar(c, 'lg'))}<div><b>${c.name}</b><small>${label} • ${toFa((c.members || []).length)} عضو</small></div></div>
    <ul class="members">${raw(rows)}</ul>
    ${isAdmin && !c.left ? raw(html`<form class="sheet-form inline" novalidate data-addform>
      <input name="add" dir="ltr" autocapitalize="none" spellcheck="false" placeholder="آیدی عضو جدید" aria-label="آیدی عضو جدید">
      <button class="btn primary small">افزودن</button></form>
      <form class="sheet-form inline" novalidate data-renameform>
      <input name="rename" maxlength="40" value="${c.name}" aria-label="نام ${label}">
      <button class="btn ghost small">تغییر نام</button></form>`) : raw('')}
    <p class="sheet-text">پیام‌های این ${label} برای هر عضو جداگانه قفل می‌شود و سرور اعضا یا محتوا را نمی‌بیند.</p>
    <div class="sheet-actions">
      ${c.type === 'channel' ? raw(html`<button class="btn ghost" data-mute>${c.muted ? 'روشن کردن اعلان' : 'بی‌صدا کردن'}</button>`) : raw('')}
      ${!c.left ? raw(html`<button class="btn danger" data-leave>خروج از ${label}</button>`) : raw('')}
    </div>`, {
    onMount(el, close) {
      el.querySelectorAll('[data-remove]').forEach((b) => {
        b.onclick = async () => {
          const rid = Number(b.dataset.remove);
          if (!await confirmBox(`حذف ${nameOf(rid)}`, `از ${label} حذف می‌شود و پیام‌های بعدی را دریافت نمی‌کند.`, 'حذف', true)) return;
          c.members = c.members.filter((x) => x !== rid);
          c.admins = c.admins.filter((x) => x !== rid);
          await broadcastGroupState(c, [rid]);
          close(); openChat(chatId, false);
        };
      });
      const add = el.querySelector('[data-addform]');
      if (add) add.onsubmit = (e) => {
        e.preventDefault();
        busy(add.querySelector('.btn'), async () => {
          const { ids, missing } = await resolveUsernames(parseUsernames(add.add.value));
          if (missing.length || !ids.length) { toast(missing.length ? `پیدا نشد: ${missing.join('، ')}` : 'آیدی را بنویسید'); return; }
          c.members = [...new Set([...c.members, ...ids])];
          await broadcastGroupState(c);
          close(); openChat(chatId, false);
        });
      };
      const ren = el.querySelector('[data-renameform]');
      if (ren) ren.onsubmit = (e) => {
        e.preventDefault();
        const name = ren.rename.value.trim();
        if (!name) return;
        busy(ren.querySelector('.btn'), async () => { c.name = name; await broadcastGroupState(c); close(); openChat(chatId, false); });
      };
      const mute = el.querySelector('[data-mute]');
      if (mute) mute.onclick = async () => { c.muted = !c.muted; await saveContact(c); close(); openChat(chatId, false); };
      const leave = el.querySelector('[data-leave]');
      if (leave) leave.onclick = async () => {
        if (!await confirmBox(`خروج از ${label}`, 'پیام‌های بعدی این گفتگو را دریافت نمی‌کنید.', 'خروج', true)) return;
        for (const r of c.members.filter((x) => x !== S.me.id)) {
          try { await encryptAndQueue(await getContact(r), uid(), { type: 'gleave', kind: c.type, grp: c.gid }, { silentKeyChange: true }); } catch { /* ignore */ }
        }
        c.left = true;
        c.members = c.members.filter((x) => x !== S.me.id);
        await saveContact(c);
        close(); openChat(chatId, false);
      };
    },
  });
}

// ---------- قفل برنامه ----------
function showLockScreen(message = '') {
  S.view = 'lock';
  $app.dataset.view = 'lock';
  $app.innerHTML = html`
    <div class="screen auth lock-screen">
      <div class="auth-mark">${raw(I.lock)}</div>
      <h1 class="auth-title">خانه قفل است</h1>
      <p class="auth-sub">رمز قفل برنامه را وارد کنید</p>
      <form class="auth-card" novalidate>
        <input class="pin-input" name="pin" type="password" inputmode="numeric" autocomplete="off" maxlength="12" dir="ltr" aria-label="رمز قفل" autofocus>
        <p class="form-error" ${message ? '' : 'hidden'}>${message}</p>
        <button class="btn primary block">باز کردن</button>
      </form>
    </div>`;
  const form = $app.querySelector('form');
  form.pin.focus();
  form.onsubmit = (e) => {
    e.preventDefault();
    const pin = toLatinDigits(form.pin.value.trim());
    if (!pin) return;
    busy(form.querySelector('.btn'), async () => {
      const r = await lock.unlock(pin);
      if (r.key) { setDataKey(r.key); await enterApp(); return; }
      if (r.emergency) { await emergency(r.emergency); return; }
      form.pin.value = '';
      form.querySelector('.auth-card, form')?.classList.add('shake');
      setTimeout(() => form.classList.remove('shake'), 400);
      formError(form, r.wait ? `تلاش زیاد؛ ${toFa(r.wait)} ثانیه صبر کنید` : 'رمز اشتباه است');
    });
  };
}

function lockNow() {
  S.locked = true;
  calls.active || stopAudio();
  closeWS();
  setDataKey(null);
  S.contacts = new Map();
  msgCache = new Map();
  document.querySelectorAll('.sheet-wrap, .viewer').forEach((x) => x.remove());
  showLockScreen();
}

// رمز اضطراری: هشدار مخفی برای مدیر، بعد نمایش برنامه‌ی خالی یا پاک کردن همه‌چیز
async function emergency(action) {
  S.decoy = true;
  S.locked = true;
  await sendEmergencyAlert();
  if (action === 'wipe') {
    closeWS();
    try { await api('/api/logout', {}); } catch { /* ignore */ }
    S.token = null;
    await wipeDevice();
    location.replace(location.pathname);
    return;
  }
  closeWS();
  showDecoy();
}

async function sendEmergencyAlert() {
  try {
    const adm = await kv.get('adminContact');
    if (!adm || !S.me || adm.id === S.me.id || !S.identity) return;
    secure.init(api, S.identity);
    await loadOutbox();
    const id = uid();
    const done = new Promise((resolve) => { S.onSent = (sid) => { if (sid === id) resolve(); }; setTimeout(resolve, 5000); });
    connectWS();
    await encryptAndQueue({ ...adm, keyChanged: false }, id, { type: 'alert', kind: 'emergency' }, { silentKeyChange: true });
    await done;
  } catch { /* بی‌صدا */ } finally { S.onSent = null; }
}

function showDecoy() {
  S.view = 'decoy';
  $app.innerHTML = html`
    <div class="screen chats">
      <header class="bar"><div class="brand">${raw(I.star)}<span>خانه</span></div></header>
      <form class="find" novalidate>
        <input name="q" placeholder="آیدی یک نفر برای شروع گفتگو" autocapitalize="none" spellcheck="false" dir="auto" aria-label="آیدی">
        <button class="btn primary small">شروع</button>
      </form>
      <ul class="chat-list"><li class="empty">هنوز گفتگویی ندارید.<br>آیدی یک نفر را بالا بنویسید تا گفتگو شروع شود.</li></ul>
    </div>`;
  $app.querySelector('form').onsubmit = (e) => { e.preventDefault(); toast('کاربری با این آیدی پیدا نشد'); };
}

// اگر رمز قفل نگذاشته باشد، کلید داده بدون رمز باز می‌شود
async function openData() {
  const st = await lock.state();
  if (st.pin) { showLockScreen(); return false; }
  setDataKey(await lock.openWithoutPin());
  return true;
}

function lockSettingsHtml(st) {
  return html`
    <section class="card" data-lockcard>
      <h2>قفل برنامه</h2>
      <p class="muted">${st.pin ? 'قفل برنامه روشن است. پیام‌ها و فایل‌های روی این گوشی با رمز شما قفل شده‌اند و بعد از یک دقیقه بیرون بودن از برنامه، دوباره قفل می‌شود.' : 'با گذاشتن رمز، همه‌ی پیام‌ها و فایل‌های روی این گوشی با رمز شما قفل می‌شوند.'}</p>
      ${st.pin ? raw(html`
        <button class="btn ghost block" data-a="changepin">عوض کردن رمز قفل</button>
        <button class="btn ghost block" data-a="removepin">برداشتن قفل</button>`) : raw('<button class="btn primary block" data-a="setpin">گذاشتن رمز قفل</button>')}
    </section>
    <section class="card">
      <h2>رمز اضطراری</h2>
      <p class="muted">اگر کسی مجبورتان کرد برنامه را باز کنید، به‌جای رمز اصلی، رمز اضطراری را بزنید. یک هشدار مخفی برای مدیر فرستاده می‌شود و برنامه ${st.emergency === 'wipe' ? 'همه‌چیز را از این گوشی پاک می‌کند' : st.emergency === 'decoy' ? 'خالی نشان داده می‌شود' : 'خالی نشان داده می‌شود یا همه‌چیز پاک می‌شود'}.</p>
      ${!st.pin ? raw('<p class="muted small">اول رمز قفل برنامه را بگذارید.</p>')
        : st.emergency ? raw('<button class="btn ghost block" data-a="removeem">برداشتن رمز اضطراری</button>')
        : raw('<button class="btn primary block" data-a="setem">گذاشتن رمز اضطراری</button>')}
    </section>`;
}

function pinSheet({ title, fields, action, extra = '' }) {
  sheet(html`
    <h2 class="sheet-title">${title}</h2>
    <form class="sheet-form" novalidate>
      ${raw(fields.map((f) => html`<label class="field"><span>${f.label}</span><input name="${f.name}" type="password" inputmode="numeric" autocomplete="off" maxlength="12" dir="ltr"></label>`).join(''))}
      ${raw(extra)}
      <p class="form-error" hidden></p>
      <div class="sheet-actions"><button class="btn primary">ذخیره</button></div>
    </form>`, {
    onMount(el, close) {
      const form = el.querySelector('form');
      form.onsubmit = (e) => {
        e.preventDefault();
        formError(form, '');
        const v = Object.fromEntries(fields.map((f) => [f.name, toLatinDigits(form[f.name].value.trim())]));
        busy(form.querySelector('.btn'), async () => {
          try { await action(v, form); close(); showProfile(false); } catch (err) { formError(form, err.message); }
        });
      };
    },
  });
}

const pinOk = (p) => /^\d{6,12}$/.test(p);
function bindLockSettings() {
  const card = $app.querySelector('[data-lockcard]')?.parentElement;
  if (!card) return;
  card.querySelectorAll('[data-a]').forEach((b) => {
    b.onclick = () => {
      const a = b.dataset.a;
      if (a === 'setpin') pinSheet({
        title: 'گذاشتن رمز قفل', fields: [{ name: 'p1', label: 'رمز (۶ تا ۱۲ رقم)' }, { name: 'p2', label: 'تکرار رمز' }],
        action: async (v) => {
          if (!pinOk(v.p1)) throw new Error('رمز باید ۶ تا ۱۲ رقم باشد');
          if (v.p1 !== v.p2) throw new Error('تکرار رمز یکسان نیست');
          await lock.setPin(v.p1); S.pinSet = true; toast('قفل برنامه روشن شد');
        },
      });
      if (a === 'changepin') pinSheet({
        title: 'عوض کردن رمز قفل', fields: [{ name: 'old', label: 'رمز فعلی' }, { name: 'p1', label: 'رمز جدید' }, { name: 'p2', label: 'تکرار رمز جدید' }],
        action: async (v) => {
          if (!pinOk(v.p1)) throw new Error('رمز باید ۶ تا ۱۲ رقم باشد');
          if (v.p1 !== v.p2) throw new Error('تکرار رمز یکسان نیست');
          await lock.setPin(v.p1, v.old); toast('رمز قفل عوض شد');
        },
      });
      if (a === 'removepin') pinSheet({
        title: 'برداشتن قفل', fields: [{ name: 'old', label: 'رمز فعلی' }],
        action: async (v) => { await lock.removePin(v.old); S.pinSet = false; toast('قفل برنامه برداشته شد'); },
      });
      if (a === 'setem') pinSheet({
        title: 'گذاشتن رمز اضطراری',
        fields: [{ name: 'main', label: 'رمز قفل فعلی' }, { name: 'p1', label: 'رمز اضطراری (۶ تا ۱۲ رقم)' }, { name: 'p2', label: 'تکرار رمز اضطراری' }],
        extra: '<fieldset class="choice"><legend>وقتی رمز اضطراری زده شد:</legend><label><input type="radio" name="act" value="decoy" checked> برنامه خالی نشان داده شود</label><label><input type="radio" name="act" value="wipe"> همه‌چیز از این گوشی پاک شود</label></fieldset>',
        action: async (v, form) => {
          if (!pinOk(v.p1)) throw new Error('رمز باید ۶ تا ۱۲ رقم باشد');
          if (v.p1 !== v.p2) throw new Error('تکرار رمز یکسان نیست');
          await lock.setEmergency(v.p1, form.act.value, v.main); toast('رمز اضطراری ذخیره شد');
        },
      });
      if (a === 'removeem') confirmBox('برداشتن رمز اضطراری', '', 'بردار').then(async (ok) => { if (ok) { await lock.removeEmergency(); showProfile(false); } });
    };
  });
}

// ---------- جستجو (کاملاً روی خود گوشی) ----------
const normalize = (t) => String(t || '').toLowerCase()
  .replace(/[يى]/g, 'ی').replace(/ك/g, 'ک').replace(/[ةۀ]/g, 'ه').replace(/[أإآ]/g, 'ا')
  .replace(/[\u064B-\u065F\u0670\u200c\u200d\u0640]/g, '')
  .replace(/[۰-۹]/g, (d) => '۰۱۲۳۴۵۶۷۸۹'.indexOf(d)).replace(/[٠-٩]/g, (d) => '٠١٢٣٤٥٦٧٨٩'.indexOf(d));

async function showSearch() {
  history.pushState({ v: 'search' }, '');
  setView('search', html`
    <div class="screen page">
      <header class="bar">
        <button class="icon-btn" data-back aria-label="بازگشت">${raw(I.back)}</button>
        <input class="search-input" data-q placeholder="جستجو در پیام‌ها و گفتگوها" dir="auto" aria-label="جستجو" autocomplete="off">
      </header>
      <ul class="chat-list search-results" data-results><li class="empty">کلمه‌ای بنویسید. جستجو فقط روی همین گوشی انجام می‌شود.</li></ul>
    </div>`);
  $app.querySelector('[data-back]').onclick = () => history.back();
  const input = $app.querySelector('[data-q]');
  input.focus();
  let index = null;
  let timer = null;
  // اگر کاربر قبل از آماده شدن فهرست تایپ کند، بعد از آماده شدن جستجو انجام می‌شود
  input.oninput = () => { clearTimeout(timer); timer = setTimeout(() => { if (index) runSearch(input.value, index); }, 200); };
  const all = (await messages.all()).filter((m) => m.kind === 'text' || m.kind === 'file' || m.kind === 'system');
  index = all.map((m) => ({ m, n: normalize(m.kind === 'file' ? m.name : m.text) }));
  if (input.value) runSearch(input.value, index);
}

function runSearch(q, index) {
  const ul = $app.querySelector('[data-results]');
  if (!ul) return;
  const nq = normalize(q.trim());
  if (nq.length < 2) { ul.innerHTML = html`<li class="empty">حداقل دو حرف بنویسید.</li>`; return; }
  const chats = [...S.contacts.values()].filter((c) => c.lastTs && normalize(c.name).includes(nq));
  const hits = index.filter((x) => x.n.includes(nq)).sort((a, b) => b.m.ts - a.m.ts).slice(0, 100);
  if (!chats.length && !hits.length) { ul.innerHTML = html`<li class="empty">چیزی پیدا نشد.</li>`; return; }
  // بخش پیداشده در متن اصلی برجسته می‌شود (حتی اگر نیم‌فاصله یا شکل حروف فرق داشته باشد)
  const snippet = (text) => {
    const t = String(text || '');
    let norm = '';
    const map = [];
    for (let k = 0; k < t.length; k++) {
      const n = normalize(t[k]);
      for (let j = 0; j < n.length; j++) map.push(k);
      norm += n;
    }
    const i = norm.indexOf(nq);
    if (i < 0) return esc(t.slice(0, 90));
    const from = map[i];
    const to = map[i + nq.length - 1] + 1;
    const a2 = Math.max(0, from - 30);
    const b2 = Math.min(t.length, to + 50);
    return html`${a2 > 0 ? '…' : ''}${t.slice(a2, from)}<mark>${t.slice(from, to)}</mark>${t.slice(to, b2)}${b2 < t.length ? '…' : ''}`;
  };
  ul.innerHTML = [
    ...chats.map((c) => html`<li><button class="chat-item" data-go="${c.id}">${raw(chatAvatar(c))}
      <span class="ci-body"><span class="ci-top"><b class="ci-name">${c.name}</b></span><span class="ci-bottom"><span class="ci-text">گفتگو</span></span></span></button></li>`),
    ...hits.map(({ m }) => {
      const c = S.contacts.get(m.chatId) || { name: '', id: m.chatId };
      const who = m.mine ? 'شما' : isGroupId(m.chatId) ? nameOf(m.from) : c.name;
      return html`<li><button class="chat-item" data-go="${m.chatId}" data-mid="${m.id}">${raw(chatAvatar(c))}
        <span class="ci-body"><span class="ci-top"><b class="ci-name">${c.name}</b><time>${shortTime(m.ts)}</time></span>
        <span class="ci-bottom"><span class="ci-text">${isGroupId(m.chatId) ? `${who}: ` : ''}${raw(snippet(m.kind === 'file' ? m.name : m.text))}</span></span></span></button></li>`;
    }),
  ].join('');
  ul.querySelectorAll('[data-go]').forEach((b) => {
    const v = b.dataset.go;
    b.onclick = () => openChat(/^\d+$/.test(v) ? Number(v) : v, false, b.dataset.mid || null);
  });
}

// ---------- تست آمادگی برای نت ملی ----------
async function showReadiness() {
  if (S.view !== 'ready') history.pushState({ v: 'ready' }, '');
  setView('ready', html`
    <div class="screen page">
      <header class="bar">
        <button class="icon-btn" data-back aria-label="بازگشت">${raw(I.back)}</button>
        <h1 class="bar-title">تست آمادگی برای نت ملی</h1>
      </header>
      <div class="page-body">
        <p class="muted">این تست بررسی می‌کند که «خانه» بدون اینترنت بین‌الملل روی این گوشی باز می‌شود و به سرور ایران وصل می‌شود.</p>
        <ul class="checks" data-checks><li class="muted">در حال بررسی…</li></ul>
        <button class="btn ghost block" data-again>بررسی دوباره</button>
        <section class="card">
          <h2>تست دوربین و میکروفون</h2>
          <p class="muted">اگر ویدیو مسیج یا تماس تصویری تصویر ندارد، این تست را بزنید. چند روش باز کردن دوربین امتحان می‌شود و روشی که جواب بدهد، برای همیشه استفاده می‌شود.</p>
          <video class="cam-preview" data-campreview autoplay muted playsinline webkit-playsinline></video>
          <button class="btn primary block" data-camtest>تست دوربین</button>
          <ul class="checks" data-camres></ul>
        </section>
        <p class="muted small center">نسخه‌ی برنامه: <span dir="ltr">${VERSION}</span></p>
      </div>
    </div>`);
  $app.querySelector('[data-back]').onclick = () => history.back();
  $app.querySelector('[data-again]').onclick = runChecks;
  $app.querySelector('[data-camtest]').onclick = (e) => busy(e.currentTarget, async () => {
    const ul = $app.querySelector('[data-camres]');
    ul.innerHTML = html`<li class="muted">در حال امتحان روش‌ها… (حدود ۱۰ ثانیه). به صفحه نگاه کنید؛ باید تصویر خودتان را ببینید.</li>`;
    let res;
    try { res = await diagnoseCamera($app.querySelector('[data-campreview]')); } catch (err) { ul.innerHTML = html`<li class="form-error">${err.message}</li>`; return; }
    camBroken.set(!res.some((r) => r.ok));
    ul.innerHTML = res.map((r) => html`<li class="check ${r.ok ? 'ok' : 'bad'}">${raw(r.ok ? I.ok : I.warn)}<div><b>${r.label}</b><span>${r.detail}</span></div></li>`).join('')
      + html`<li class="verdict ${res.some((r) => r.ok) ? 'ok' : 'bad'}">${res.some((r) => r.ok) ? 'دوربین در این حالت تصویر می‌دهد؛ ویدیو مسیج داخل برنامه ضبط می‌شود.' : 'دوربین داخل برنامه تصویر نمی‌دهد. ویدیو مسیج با دوربین خود آیفون گرفته می‌شود و تماس تصویری، صوتی برقرار می‌شود. (معمولاً با به‌روزرسانی iOS درست می‌شود؛ بعد از آن دوباره این تست را بزنید.)'}</li>`;
  });
  runChecks();
}

async function runChecks() {
  const ul = $app.querySelector('[data-checks]');
  if (!ul) return;
  const rows = [];
  const add = (ok, title, detail) => rows.push({ ok, title, detail });

  const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  add(standalone, 'از آیکون صفحه‌ی اصلی باز شده',
    standalone ? 'برنامه از آیکون «خانه» باز شده است.' : 'در Safari دکمه‌ی اشتراک‌گذاری را بزنید، Add to Home Screen را انتخاب کنید و بعد برنامه را از آیکون باز کنید.');

  let cached = false;
  let missing = FILES.length;
  try {
    const cache = await caches.open(`khaneh-${VERSION}`);
    const hits = await Promise.all(FILES.map((f) => cache.match(new URL(f, location.href).href)));
    missing = hits.filter((h) => !h).length;
    cached = !!navigator.serviceWorker?.controller && FILES.length > 0 && missing === 0;
  } catch { /* ignore */ }
  add(cached, 'برنامه کامل روی گوشی ذخیره شده',
    cached ? 'برنامه بدون اینترنت بین‌الملل هم باز می‌شود.'
      : 'هنوز کامل ذخیره نشده. یک بار با اینترنت بین‌الملل برنامه را ببندید و دوباره از آیکون باز کنید.');

  const persisted = await persistentStorage();
  add(persisted !== false, 'حافظه‌ی ماندگار',
    persisted ? 'گوشی اطلاعات برنامه را هنگام کمبود فضا پاک نمی‌کند.'
      : 'گوشی تضمین نکرده که اطلاعات را نگه دارد. چند گیگابایت فضای خالی نگه دارید و آیکون را حذف نکنید.');

  let status = null;
  let ms = 0;
  try { const t = performance.now(); status = await api('/api/status'); ms = Math.round(performance.now() - t); } catch { /* ignore */ }
  add(!!status, 'اتصال به سرور ایران', status ? `وصل است (${toFa(ms)} میلی‌ثانیه).` : 'وصل نشد. اینترنت گوشی را بررسی کنید.');

  if (status) {
    if (status.certExpires) {
      const days = Math.floor((status.certExpires - Date.now()) / 864e5);
      add(days > 30, 'اعتبار گواهی امنیتی سرور',
        days > 30 ? `${toFa(days)} روز دیگر اعتبار دارد.` : `فقط ${toFa(Math.max(0, days))} روز دیگر اعتبار دارد. مدیر باید آن را تمدید کند.`);
    } else {
      add(null, 'اعتبار گواهی امنیتی سرور', 'سرور تاریخ گواهی را اعلام نکرده است (CERT_PATH تنظیم نشده).');
    }
  }

  let keysOk = !!S.identity;
  let detail = 'کلیدهای رمزنگاری روی این گوشی وجود دارد.';
  try {
    const st = await api('/api/prekeys/status');
    if (st.opks < 5 || st.spkId == null) { keysOk = false; detail = 'پیش‌کلیدها روی سرور کم است؛ برنامه را باز نگه دارید تا شارژ شود.'; }
    else detail = `کلیدها آماده‌اند (${toFa(st.opks)} پیش‌کلید روی سرور).`;
  } catch { if (!status) { keysOk = null; detail = 'بدون اتصال به سرور قابل بررسی نیست.'; } }
  add(keysOk, 'کلیدهای رمزنگاری', detail);

  const ls = await lock.state();
  add(ls.pin, 'قفل برنامه', ls.pin
    ? `روشن است${ls.emergency ? '؛ رمز اضطراری هم گذاشته شده.' : '. پیشنهاد می‌شود رمز اضطراری هم بگذارید.'}`
    : 'از بخش «پروفایل، قفل و امنیت» رمز قفل بگذارید تا اگر گوشی دست کسی افتاد، پیام‌ها خوانا نباشند.');

  try {
    const est = await navigator.storage?.estimate?.();
    if (est && est.quota) {
      const free = (est.quota - est.usage) / 1024 / 1024;
      add(free > 300, 'فضای ذخیره‌سازی', free > 300 ? 'فضای کافی برای پیام‌ها و فایل‌ها هست.' : 'فضای خالی کم است؛ کمی از حافظه‌ی گوشی را خالی کنید.');
    }
  } catch { /* ignore */ }

  ul.innerHTML = rows.map((r) => html`
    <li class="check ${r.ok === true ? 'ok' : r.ok === false ? 'bad' : 'info'}">
      ${raw(r.ok === true ? I.ok : I.warn)}
      <div><b>${r.title}</b><span>${r.detail}</span></div>
    </li>`).join('');
  const allOk = rows.every((r) => r.ok !== false);
  ul.insertAdjacentHTML('afterbegin', html`<li class="verdict ${allOk ? 'ok' : 'bad'}">${allOk ? 'این گوشی برای نت ملی آماده است.' : 'این گوشی هنوز کامل آماده نیست. موارد قرمز را درست کنید.'}</li>`);
}

// ---------- پروفایل ----------
async function showProfile(push = true) {
  if (push && S.view !== 'profile') history.pushState({ v: 'profile' }, '');
  const lockState = await lock.state();
  const fp = await C.fingerprint(S.identity.ecdhPub, S.identity.signPub);
  setView('profile', html`
    <div class="screen page">
      <header class="bar">
        <button class="icon-btn" data-back aria-label="بازگشت">${raw(I.back)}</button>
        <h1 class="bar-title">پروفایل و امنیت</h1>
      </header>
      <div class="page-body">
        <section class="card profile-card">${raw(avatar(S.me, 'xl'))}<b>${S.me.name}</b><small dir="ltr">@${S.me.username}</small>
          <div class="row-actions center"><button class="btn ghost small" data-photo-set>${S.myPhoto ? 'عوض کردن عکس' : 'گذاشتن عکس پروفایل'}</button>
          ${S.myPhoto ? raw('<button class="btn ghost small" data-photo-del>حذف عکس</button>') : raw('')}</div>
          <small class="muted">عکس پروفایل رمزنگاری‌شده فقط برای اعضای همین برنامه فرستاده می‌شود.</small></section>
        <section class="card">
          <h2>اثر انگشت کلید این گوشی</h2>
          <p class="code small" dir="ltr">${fp}</p>
          <p class="muted">کلیدهای شما روی همین گوشی ساخته شده‌اند و از آن خارج نمی‌شوند. هر پیام با یک کلید تازه قفل می‌شود و آن کلید بعد از استفاده نابود می‌شود.</p>
        </section>
        ${raw(lockSettingsHtml(lockState))}
        <form class="card" novalidate>
          <h2>تغییر رمز ورود به حساب</h2>
          <label class="field"><span>رمز فعلی</span><input name="old" type="password" autocomplete="current-password" dir="ltr"></label>
          <label class="field"><span>رمز جدید</span><input name="next" type="password" autocomplete="new-password" dir="ltr"></label>
          <p class="form-error" hidden></p>
          <button class="btn primary">ذخیره‌ی رمز جدید</button>
        </form>
        <section class="card">
          <button class="btn ghost block" data-logout>خروج از حساب</button>
          <button class="btn danger block" data-wipe>خروج و پاک کردن همه‌چیز از این گوشی</button>
        </section>
        <p class="muted small center">نسخه‌ی برنامه: <span dir="ltr">${VERSION}</span></p>
      </div>
    </div>`);
  $app.querySelector('[data-back]').onclick = () => history.back();
  bindLockSettings();
  $app.querySelector('[data-photo-set]').onclick = () => pickFiles('image/*', false, async ([f]) => {
    try { await setMyPhoto(await makeAvatar(f)); toast('عکس پروفایل ذخیره شد'); showProfile(false); } catch (e) { toast(e.message); }
  });
  const pd = $app.querySelector('[data-photo-del]');
  if (pd) pd.onclick = async () => { await setMyPhoto(null); showProfile(false); };
  const form = $app.querySelector('form.card');
  form.onsubmit = (e) => {
    e.preventDefault();
    formError(form, '');
    if (form.next.value.length < 8) return formError(form, 'رمز جدید باید حداقل ۸ کاراکتر باشد');
    busy(form.querySelector('.btn'), async () => {
      try {
        await api('/api/password', { oldPassword: form.old.value, newPassword: form.next.value });
        form.reset();
        toast('رمز عوض شد');
      } catch (err) { formError(form, err.message); }
    });
  };
  $app.querySelector('[data-logout]').onclick = async () => {
    if (await confirmBox('خروج از حساب', 'پیام‌ها و کلیدها روی این گوشی می‌مانند و با ورود دوباره برمی‌گردند.', 'خروج')) logout();
  };
  $app.querySelector('[data-wipe]').onclick = async () => {
    if (!await confirmBox('پاک کردن همه‌چیز', 'همه‌ی پیام‌ها، فایل‌ها و کلیدهای این گوشی برای همیشه پاک می‌شوند و قابل برگشت نیستند.', 'پاک کن', true)) return;
    try { await api('/api/logout', {}); } catch { /* ignore */ }
    S.token = null;
    S.ws?.close();
    await wipeDevice();
    location.replace(location.pathname);
  };
}

// ---------- پنل مدیریت ----------
let adminTab = 'requests';
async function showAdmin() {
  if (!S.me.isAdmin) return;
  if (S.view !== 'admin') history.pushState({ v: 'admin' }, '');
  setView('admin', html`
    <div class="screen page">
      <header class="bar">
        <button class="icon-btn" data-back aria-label="بازگشت">${raw(I.back)}</button>
        <h1 class="bar-title">پنل مدیریت</h1>
      </header>
      <div class="tabs" role="tablist">
        <button role="tab" data-tab="requests">درخواست‌ها</button>
        <button role="tab" data-tab="users">کاربران</button>
        <button role="tab" data-tab="security">امنیت سرور</button>
      </div>
      <div class="page-body" data-admin><p class="muted center">در حال بارگذاری…</p></div>
    </div>`);
  $app.querySelector('[data-back]').onclick = () => history.back();
  $app.querySelectorAll('[data-tab]').forEach((b) => {
    b.onclick = () => { adminTab = b.dataset.tab; renderAdmin(); };
  });
  renderAdmin();
}

async function decryptPhone(enc) {
  if (!enc) return '—';
  try { return (await C.open(enc, S.identity.ecdhPriv, C.REG_AAD, null)).phone; } catch { return 'قابل باز شدن نیست'; }
}

async function renderAdmin() {
  const box = $app.querySelector('[data-admin]');
  if (!box) return;
  $app.querySelectorAll('[data-tab]').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === adminTab)));
  try {
    if (adminTab === 'requests') {
      const list = await api('/api/admin/requests');
      S.pendingRequests = list.length;
      if (!list.length) { box.innerHTML = '<p class="muted center">درخواست تازه‌ای نیست.</p>'; return; }
      const rows = await Promise.all(list.map(async (r) => html`
        <li class="row-card">
          <div class="row-main"><b>${r.name}</b><span dir="ltr" class="mono">${await decryptPhone(r.phoneEnc)}</span>
            <small class="muted">${dayLabel(r.created)} ساعت ${fmtTime.format(r.created)}</small></div>
          <div class="row-actions">
            <button class="btn primary small" data-approve="${r.id}">تأیید</button>
            <button class="btn ghost small" data-reject="${r.id}">رد</button>
          </div>
        </li>`));
      box.innerHTML = html`<ul class="rows">${join(rows)}</ul>`;
      box.querySelectorAll('[data-approve],[data-reject]').forEach((b) => {
        b.onclick = () => busy(b, async () => {
          const approve = !!b.dataset.approve;
          try {
            await api('/api/admin/requests/decide', { id: b.dataset.approve || b.dataset.reject, approve });
            toast(approve ? 'تأیید شد' : 'رد شد');
            renderAdmin();
          } catch (err) { toast(err.message); }
        });
      });
    } else if (adminTab === 'security') {
      const alerts = await api('/api/admin/alerts');
      S.serverAlerts = 0;
      box.innerHTML = html`
        <section class="card">
          <h2>گزارش‌های ربات نگهبان</h2>
          ${alerts.length ? raw(html`<ul class="alerts">${join(alerts.map((a) => html`<li><time>${dayLabel(a.created)} ${fmtTime.format(a.created)}</time><span>${a.text}</span></li>`))}</ul>
            <button class="btn ghost small" data-clearalerts>پاک کردن گزارش‌ها</button>`) : raw('<p class="muted">گزارشی نیست.</p>')}
        </section>
        <section class="card danger-card">
          <h2>پاکسازی کلی</h2>
          <p class="muted">همه‌ی پیام‌ها و فایل‌ها از سرور و از گوشی همه‌ی اعضا (از جمله گوشی خودتان) پاک می‌شود. گوشی‌هایی که الان آفلاین هستند، به محض وصل شدن پاک می‌شوند. این دستور با کلید شما امضا می‌شود و کسی نمی‌تواند آن را جعل کند. حساب‌ها و گروه‌ها باقی می‌مانند.</p>
          <button class="btn danger block" data-wipeall>پاک کردن همه‌ی پیام‌ها</button>
        </section>`;
      box.querySelector('[data-clearalerts]')?.addEventListener('click', async () => { await api('/api/admin/alerts/clear', {}); renderAdmin(); });
      box.querySelector('[data-wipeall]').onclick = () => adminWipe({ type: 'wipe-all' }, 'پاک کردن همه‌ی پیام‌ها', 'این کار قابل برگشت نیست. برای تأیید، رمز ورود حساب مدیر را وارد کنید.');
    } else {
      const list = await api('/api/admin/users');
      const rows = await Promise.all(list.map(async (u) => html`
        <li class="row-card">
          <div class="row-main">
            <b>${u.name} ${u.isAdmin ? raw('<span class="tag">مدیر</span>') : raw('')} ${u.blocked ? raw('<span class="tag red">مسدود</span>') : raw('')}</b>
            <span dir="ltr" class="mono">@${u.username}</span>
            <span dir="ltr" class="mono">${await decryptPhone(u.phoneEnc)}</span>
            <small class="muted">${u.online ? 'آنلاین' : lastSeenText(u.lastSeen)}</small>
          </div>
          ${u.id === S.me.id ? raw('') : raw(html`<div class="row-actions">
            <button class="btn ghost small" data-reset="${u.id}" data-name="${u.name}">ریست رمز</button>
            <button class="btn ${u.blocked ? 'ghost' : 'danger'} small" data-block="${u.id}" data-to="${u.blocked ? '0' : '1'}" data-name="${u.name}">${u.blocked ? 'رفع مسدودی' : 'مسدود کردن'}</button>
          </div>`)}
        </li>`));
      box.innerHTML = html`<ul class="rows">${join(rows)}</ul>`;
      box.querySelectorAll('[data-reset]').forEach((b) => {
        b.onclick = () => resetUserSheet(Number(b.dataset.reset), b.dataset.name);
      });
      box.querySelectorAll('[data-block]').forEach((b) => {
        b.onclick = async () => {
          const blocking = b.dataset.to === '1';
          if (blocking && !await confirmBox(`مسدود کردن ${b.dataset.name}`, 'از حساب خارج می‌شود و دیگر نمی‌تواند وارد شود یا پیام بگیرد.', 'مسدود کن', true)) return;
          try {
            await api('/api/admin/users/block', { id: Number(b.dataset.block), blocked: blocking });
            renderAdmin();
          } catch (err) { toast(err.message); }
        };
      });
    }
  } catch (err) {
    box.innerHTML = html`<p class="form-error">${err.message}</p>`;
  }
}

function resetUserSheet(id, name) {
  sheet(html`
    <h2 class="sheet-title">ریست رمز ${name}</h2>
    <form class="sheet-form" novalidate>
      <p class="sheet-text">یک رمز موقت ساخته می‌شود و او از همه‌ی گوشی‌ها خارج می‌شود.</p>
      <fieldset class="choice"><legend>پیام‌های روی گوشی‌اش:</legend>
        <label><input type="radio" name="keep" value="keep" checked> باقی بماند</label>
        <label><input type="radio" name="keep" value="wipe"> پاک شود</label></fieldset>
      <label class="field" data-pw hidden><span>رمز ورود حساب مدیر (برای تأیید پاک کردن)</span><input name="pw" type="password" autocomplete="current-password" dir="ltr"></label>
      <p class="form-error" hidden></p>
      <div class="sheet-actions"><button class="btn primary">ساخت رمز موقت</button></div>
    </form>`, {
    onMount(el, close) {
      const form = el.querySelector('form');
      form.querySelectorAll('[name=keep]').forEach((r) => { r.onchange = () => { form.querySelector('[data-pw]').hidden = form.keep.value !== 'wipe'; }; });
      form.onsubmit = (e) => {
        e.preventDefault();
        formError(form, '');
        const wipe = form.keep.value === 'wipe';
        if (wipe && !form.pw.value) return formError(form, 'رمز مدیر را وارد کنید');
        busy(form.querySelector('.btn'), async () => {
          try {
            if (wipe) await api('/api/admin/wipe', { password: form.pw.value, ...(await signCommand({ type: 'wipe-user', target: id })) });
            const r = await api('/api/admin/users/reset', { id });
            close();
            sheet(html`<h2 class="sheet-title">رمز موقت ${name}</h2>
              <p class="code" dir="ltr">${r.tempPassword}</p>
              <p class="sheet-text">این رمز را حضوری به او بدهید. بعد از ورود، از بخش پروفایل رمزش را عوض کند.${wipe ? ' پیام‌های روی گوشی‌اش، به محض وصل شدن، پاک می‌شود.' : ''}</p>`);
          } catch (err) { formError(form, err.message); }
        });
      };
    },
  });
}

function adminWipe(cmd, title, text) {
  sheet(html`
    <h2 class="sheet-title">${title}</h2>
    <form class="sheet-form" novalidate>
      <p class="sheet-text">${text}</p>
      <label class="field"><span>رمز ورود حساب مدیر</span><input name="pw" type="password" autocomplete="current-password" dir="ltr"></label>
      <p class="form-error" hidden></p>
      <div class="sheet-actions"><button class="btn danger">پاک کن</button></div>
    </form>`, {
    onMount(el, close) {
      const form = el.querySelector('form');
      form.onsubmit = (e) => {
        e.preventDefault();
        formError(form, '');
        busy(form.querySelector('.btn'), async () => {
          try {
            const r = await api('/api/admin/wipe', { password: form.pw.value, ...(await signCommand(cmd)) });
            close();
            toast(`دستور پاک کردن برای ${toFa(r.count)} حساب فرستاده شد`);
          } catch (err) { formError(form, err.message); }
        });
      };
    },
  });
}

// ---------- شروع ----------
async function boot() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js', { scope: './', updateViaCache: 'none' }).catch(() => {});
  }
  if (!globalThis.crypto?.subtle) {
    setView('error', authShell('<div class="auth-card"><p class="form-error">این برنامه فقط با آدرس امن (https) کار می‌کند.</p></div>'));
    return;
  }
  try { S.status = await api('/api/status'); } catch { S.status = null; }

  const sess = await kv.get('session');
  if (sess?.token) {
    S.token = sess.token;
    S.me = sess.user;
    try {
      const me = await api('/api/me');
      await ensureIdentity(me);
      S.me = { ...me, ecdhPub: S.identity.ecdhPub, signPub: S.identity.signPub };
      await kv.set('session', { token: S.token, user: S.me });
    } catch (err) {
      if (!S.token) return; // نشست باطل شده و صفحه‌ی ورود نمایش داده شده
      // سرور در دسترس نیست؛ با اطلاعات ذخیره‌شده ادامه می‌دهیم
    }
    if (!S.identity) S.identity = await kv.get('identity');
    if (!(await openData())) return; // صفحه‌ی قفل نمایش داده شد
    await enterApp();
    return;
  }
  if (S.status?.needsSetup) { showSetup(); return; }
  if (await kv.get('request')) { showWaiting(); return; }
  showWelcome();
}

boot();
