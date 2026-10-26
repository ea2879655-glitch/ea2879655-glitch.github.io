// سرویس‌ورکر «خانه» — برنامه همیشه از حافظه‌ی گوشی باز می‌شود (Cache-First).
// نسخه‌ی جدید فقط وقتی نصب می‌شود که مدیر نسخه‌ی تازه‌ای منتشر کند و گوشی به آدرس برنامه دسترسی داشته باشد.
// سرور ایران هیچ نقشی در کد برنامه ندارد.
const VERSION = "2026-10-26-a4ef4622ee";
const FILES = [
  "./",
  "./css/app.css",
  "./icons/icon-180.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./index.html",
  "./js/app.js",
  "./js/calls.js",
  "./js/config.js",
  "./js/crypto.js",
  "./js/lock.js",
  "./js/media.js",
  "./js/ratchet.js",
  "./js/secure.js",
  "./js/store.js",
  "./js/version.js",
  "./khaneh-ca.mobileconfig",
  "./manifest.webmanifest"
];
const CACHE = `khaneh-${VERSION}`;

self.addEventListener('install', (e) => {
  e.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // همه‌ی فایل‌ها با هم ذخیره می‌شوند؛ اگر یکی ناقص بماند، نسخه‌ی قبلی سر جایش می‌ماند
    await cache.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })));
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.filter((k) => k.startsWith('khaneh-') && k !== CACHE).map((k) => caches.delete(k)));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== 'GET' || url.origin !== self.location.origin) return; // درخواست‌های سرور ایران از اینجا رد نمی‌شوند
  e.respondWith((async () => {
    const cache = await caches.open(CACHE);
    const hit = await cache.match(e.request, { ignoreSearch: true });
    if (hit) return hit;
    if (e.request.mode === 'navigate') {
      const index = await cache.match(new URL('./index.html', self.location).href);
      if (index) return index;
    }
    return fetch(e.request);
  })());
});
