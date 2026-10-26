// ضبط و پخش ویس مسیج و ویدیو مسیج
// روی آیفون، Safari صدا را به شکل audio/mp4 و تصویر را به شکل video/mp4 ضبط می‌کند.

export const LIMITS = {
  voiceSeconds: 300,      // ۵ دقیقه
  videoSeconds: 60,       // ۶۰ ثانیه
  maxBytes: 50 * 1024 * 1024,
};

const VOICE_TYPES = ['audio/mp4', 'audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus'];
const VIDEO_TYPES = ['video/mp4', 'video/webm;codecs=vp8,opus', 'video/webm'];
export const ALLOWED_MIME = /^(audio\/(mp4|webm|ogg|aac|mpeg)|video\/(mp4|webm|quicktime))(;[ a-z0-9=,.\-"]*)?$/i;

function pickType(list) {
  if (typeof MediaRecorder === 'undefined') return null;
  for (const t of list) if (MediaRecorder.isTypeSupported?.(t)) return t;
  return '';
}

export function mediaSupported() {
  return !!(navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined');
}

let audioCtx = null;
// باید داخل لمس کاربر صدا زده شود (محدودیت آیفون)
export function unlockAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
  } catch { /* ignore */ }
}

// ---------- دوربین و میکروفون ----------
// قانون iOS برای برنامه‌های صفحه‌ی اصلی: دوربین باید دقیقاً در لحظه‌ی لمس درخواست شود.
// پس در مسیر ضبط و تماس فقط یک درخواست ساده و هم‌زمان با لمس انجام می‌شود (بدون بررسی پنهان).
const AUDIO = { echoCancellation: true, noiseSuppression: true };
const MIC = { audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } };

// اگر دوربین داخل برنامه تصویر ندهد (مثلاً iOS 17 در برنامه‌ی صفحه‌ی اصلی)، این علامت گذاشته می‌شود
// و از آن به بعد ویدیو مسیج با دوربین خود آیفون گرفته می‌شود و تماس تصویری صوتی برقرار می‌شود.
export const camBroken = {
  get: () => { try { return localStorage.getItem('khaneh-cam-broken') === '1'; } catch { return false; } },
  set: (v) => { try { if (v) localStorage.setItem('khaneh-cam-broken', '1'); else localStorage.removeItem('khaneh-cam-broken'); } catch { /* ignore */ } },
};

export function openCamera(facing = 'user') {
  return navigator.mediaDevices.getUserMedia({ audio: AUDIO, video: { facingMode: facing } });
}

export function requestMedia(kind) {
  return kind === 'video' ? openCamera('user') : navigator.mediaDevices.getUserMedia(MIC);
}

// «تست دوربین»: چند روش با یک پیش‌نمایش واقعی و قابل دیدن امتحان می‌شود
export const CAMERA_METHODS = [
  { id: 'simple', label: 'دوربین جلو', get: () => navigator.mediaDevices.getUserMedia({ audio: AUDIO, video: { facingMode: 'user' } }) },
  { id: 'videoonly', label: 'فقط تصویر (بدون صدا)', get: () => navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user' } }) },
  { id: 'basic', label: 'بدون هیچ تنظیم', get: () => navigator.mediaDevices.getUserMedia({ audio: true, video: true }) },
];

async function framesIn(video, stream, timeout) {
  video.muted = true;
  video.playsInline = true;
  video.srcObject = stream;
  try { await video.play(); } catch { /* ادامه */ }
  const track = stream.getVideoTracks()[0];
  const t0 = performance.now();
  while (performance.now() - t0 < timeout) {
    if (video.videoWidth > 0 && video.readyState >= 2) return { ok: true, w: video.videoWidth, h: video.videoHeight };
    await new Promise((r) => setTimeout(r, 100));
  }
  return { ok: false, w: video.videoWidth, muted: track?.muted, state: track?.readyState };
}

// اولین روش داخل همان لمس دکمه اجرا می‌شود؛ پیش‌نمایش در صفحه دیده می‌شود
export async function diagnoseCamera(previewEl) {
  const out = [];
  for (const m of CAMERA_METHODS) {
    let stream;
    try { stream = await m.get(); } catch (e) { out.push({ label: m.label, ok: false, detail: `باز نشد (${e.name || e.message})` }); continue; }
    const r = await framesIn(previewEl, stream, 3000);
    stream.getTracks().forEach((t) => t.stop());
    previewEl.srcObject = null;
    out.push({ label: m.label, ok: r.ok, detail: r.ok ? `تصویر می‌رسد (${r.w}×${r.h})` : `تصویر نمی‌رسد (${r.muted ? 'دوربین قطع است' : r.state || 'بدون تصویر'})` });
  }
  return out;
}

export class Recorder {
  constructor(kind) {
    this.kind = kind; // 'voice' | 'video'
    this.stream = null;
    this.rec = null;
    this.chunks = [];
    this.levels = [];
    this.t0 = 0;
    this.cancelled = false;
  }

  // preStream: جریانی که همان لحظه‌ی لمس انگشت گرفته شده (برای برنامه‌ی صفحه‌ی اصلی آیفون لازم است)
  async start(preStream = null) {
    const video = this.kind === 'video';
    this.stream = preStream ? await preStream : video
      ? await openCamera('user')
      : await navigator.mediaDevices.getUserMedia(MIC);
    if (this.cancelled) { this._stopTracks(); throw new Error('cancelled'); }
    const mimeType = pickType(video ? VIDEO_TYPES : VOICE_TYPES);
    const opts = video ? { videoBitsPerSecond: 450_000, audioBitsPerSecond: 48_000 } : { audioBitsPerSecond: 32_000 };
    if (mimeType) opts.mimeType = mimeType;
    this.rec = new MediaRecorder(this.stream, opts);
    this.rec.ondataavailable = (e) => { if (e.data && e.data.size) this.chunks.push(e.data); };
    this.rec.start(250);
    this.t0 = performance.now();
    if (!video) this._meter(); // سنجش صدا فقط برای ویس (روی آیفون با دوربین تداخل نکند)
  }

  _meter() {
    try {
      if (!audioCtx) return;
      const src = audioCtx.createMediaStreamSource(this.stream);
      const an = audioCtx.createAnalyser();
      an.fftSize = 512;
      src.connect(an);
      const buf = new Uint8Array(an.fftSize);
      this.meterTimer = setInterval(() => {
        an.getByteTimeDomainData(buf);
        let sum = 0;
        for (let i = 0; i < buf.length; i++) { const v = (buf[i] - 128) / 128; sum += v * v; }
        this.levels.push(Math.sqrt(sum / buf.length));
      }, 80);
      this.meterNodes = [src, an];
    } catch { /* اندازه‌گیری صدا اختیاری است */ }
  }

  get seconds() { return this.t0 ? (performance.now() - this.t0) / 1000 : 0; }

  stop() {
    return new Promise((resolve, reject) => {
      if (!this.rec || this.rec.state === 'inactive') { this._cleanup(); reject(new Error('not-recording')); return; }
      const duration = this.seconds;
      this.rec.onstop = () => {
        const type = (this.rec.mimeType || this.chunks[0]?.type || (this.kind === 'video' ? 'video/mp4' : 'audio/mp4'));
        const blob = new Blob(this.chunks, { type });
        const levels = this.levels;
        this._cleanup();
        resolve({ blob, mime: type, duration, wave: waveform(levels) });
      };
      this.rec.stop();
    });
  }

  cancel() {
    this.cancelled = true;
    if (this.rec && this.rec.state !== 'inactive') { this.rec.onstop = null; try { this.rec.stop(); } catch { /* ignore */ } }
    this._cleanup();
  }

  _stopTracks() { this.stream?.getTracks().forEach((t) => t.stop()); }

  _cleanup() {
    clearInterval(this.meterTimer);
    try { this.meterNodes?.forEach((n) => n.disconnect()); } catch { /* ignore */ }
    this._stopTracks();
  }
}

// تبدیل سطح صدا به ۴۸ میله با مقدار ۰ تا ۳۱
export function waveform(levels, bars = 48) {
  if (!levels.length) return new Array(bars).fill(3);
  const out = [];
  for (let i = 0; i < bars; i++) {
    const a = Math.floor((i * levels.length) / bars);
    const b = Math.max(a + 1, Math.floor(((i + 1) * levels.length) / bars));
    let m = 0;
    for (let j = a; j < b; j++) m = Math.max(m, levels[j]);
    out.push(m);
  }
  const max = Math.max(...out, 0.02);
  return out.map((v) => Math.max(2, Math.min(31, Math.round((v / max) * 31))));
}

export function fmtDuration(sec) {
  const s = Math.max(0, Math.round(sec));
  const m = Math.floor(s / 60);
  const r = String(s % 60).padStart(2, '0');
  return `${m}:${r}`.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
}

export function cleanMime(m) {
  return typeof m === 'string' && m.length < 80 && ALLOWED_MIME.test(m) ? m : null;
}
