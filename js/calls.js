// تماس صوتی و تصویری «خانه»
//
// امنیت:
// - صدا و تصویر با رمزنگاری داخلی WebRTC (DTLS-SRTP) مستقیم بین دو گوشی قفل می‌شود.
// - اطلاعات شروع تماس (SDP)، که «اثر انگشت» رمزنگاری تماس داخلش است، فقط داخل پیام‌های
//   Double Ratchet فرستاده می‌شود. پس سرور نمی‌تواند اثر انگشت خودش را جا بزند و وسط تماس بنشیند.
// - اگر تماس از سرور TURN رد شود، سرور فقط بسته‌های قفل‌شده را جابه‌جا می‌کند.

const RING_TIMEOUT = 45_000;

export function createCalls(ctx) {
  // ctx: { sendSignal(peerId, obj), getIce(), onLog(peerId, rec), contact(peerId), avatar(contact), toast(text), uid() }
  let cur = null;
  let overlay = null;
  let ringer = null;

  const ICON = {
    hang: '<svg viewBox="0 0 24 24"><path d="M3 15.5c5-4.6 13-4.6 18 0l-2.4 2.4-3.3-1.6v-2.6c-2.1-.7-4.5-.7-6.6 0v2.6l-3.3 1.6z" fill="currentColor"/></svg>',
    accept: '<svg viewBox="0 0 24 24"><path d="M6.6 3.5l2.6 3.1-1.4 2.3c1.2 2.5 3 4.3 5.4 5.4l2.3-1.4 3.1 2.6-1.5 3c-7.3-.4-12.9-6-13.3-13.3z" fill="currentColor"/></svg>',
    mic: '<svg viewBox="0 0 24 24"><rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/><path d="M5.5 11a6.5 6.5 0 0013 0M12 17.5V21" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    cam: '<svg viewBox="0 0 24 24"><rect x="3" y="7" width="12" height="10" rx="2" fill="currentColor"/><path d="M15 11l6-3.5v9L15 13z" fill="currentColor"/></svg>',
    speaker: '<svg viewBox="0 0 24 24"><path d="M4 9.5h3.5L12 5.5v13l-4.5-4H4z" fill="currentColor"/><path d="M15.5 9a4 4 0 010 6M18 6.5a7.5 7.5 0 010 11" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
    flip: '<svg viewBox="0 0 24 24"><path d="M4 8h11l-3-3M20 16H9l3 3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
  };

  const fmt = (s) => {
    const m = Math.floor(s / 60);
    return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`.replace(/\d/g, (d) => '۰۱۲۳۴۵۶۷۸۹'[d]);
  };

  function iceDone(pc, ms = 3500) {
    return new Promise((resolve) => {
      if (pc.iceGatheringState === 'complete') { resolve(); return; }
      const t = setTimeout(resolve, ms);
      pc.addEventListener('icegatheringstatechange', () => {
        if (pc.iceGatheringState === 'complete') { clearTimeout(t); resolve(); }
      });
    });
  }

  async function media(video) {
    if (video && ctx.camBroken?.()) {
      // دوربین داخل برنامه روی این گوشی کار نمی‌کند: تماس صوتی (تصویر طرف مقابل همچنان دیده می‌شود)
      ctx.toast('دوربین این گوشی داخل برنامه کار نمی‌کند؛ تصویر شما فرستاده نمی‌شود.');
      return navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    }
    if (video && ctx.openCamera) return ctx.openCamera('user');
    return navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      video: video ? { facingMode: 'user' } : false,
    });
  }

  async function makePc() {
    let iceServers = [];
    try { iceServers = (await ctx.getIce()).iceServers || []; } catch { /* بدون TURN هم امتحان می‌شود */ }
    const pc = new RTCPeerConnection({ iceServers, bundlePolicy: 'max-bundle' });
    pc.ontrack = (e) => {
      const v = overlay?.querySelector('.call-remote');
      if (v && v.srcObject !== e.streams[0]) { v.srcObject = e.streams[0]; v.play().catch(() => {}); }
    };
    pc.onconnectionstatechange = () => {
      if (!cur || cur.pc !== pc) return;
      const st = pc.connectionState;
      if (st === 'connected') {
        clearTimeout(cur.dropTimer);
        if (!cur.t0) { cur.t0 = Date.now(); cur.status = 'active'; stopRing(); render(); startClock(); }
      } else if (st === 'failed') end('failed', true);
      else if (st === 'disconnected') {
        clearTimeout(cur.dropTimer);
        cur.dropTimer = setTimeout(() => { if (cur && cur.pc === pc && pc.connectionState !== 'connected') end('failed', true); }, 8000);
      }
    };
    return pc;
  }

  function attachLocal() {
    const v = overlay?.querySelector('.call-local');
    if (v && cur?.local) { v.srcObject = cur.local; v.play().catch(() => {}); }
  }

  // ---------- زنگ ----------
  function startRing(incoming) {
    stopRing();
    try {
      const ac = new (window.AudioContext || window.webkitAudioContext)();
      const beep = () => {
        const o = ac.createOscillator();
        const g = ac.createGain();
        o.frequency.value = incoming ? 620 : 440;
        g.gain.value = 0.0001;
        o.connect(g); g.connect(ac.destination);
        const t = ac.currentTime;
        g.gain.exponentialRampToValueAtTime(0.18, t + 0.05);
        g.gain.exponentialRampToValueAtTime(0.0001, t + (incoming ? 0.9 : 1.2));
        o.start(t); o.stop(t + 1.3);
      };
      beep();
      ringer = { ac, timer: setInterval(beep, incoming ? 1800 : 3000) };
    } catch { ringer = null; }
    if (incoming && navigator.vibrate) navigator.vibrate([400, 300, 400]);
  }
  function stopRing() {
    if (!ringer) return;
    clearInterval(ringer.timer);
    ringer.ac.close().catch(() => {});
    ringer = null;
  }

  // ---------- صفحه‌ی تماس ----------
  function render() {
    if (!cur) return;
    const c = ctx.contact(cur.peer) || { name: '' };
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.className = 'call-overlay';
      overlay.setAttribute('role', 'dialog');
      overlay.innerHTML = `
        <video class="call-remote" autoplay playsinline webkit-playsinline></video>
        <video class="call-local" autoplay playsinline webkit-playsinline muted></video>
        <div class="call-top"><div class="call-avatar"></div><b class="call-name"></b><span class="call-status" data-cstatus></span></div>
        <div class="call-actions" data-cactions></div>`;
      document.body.appendChild(overlay);
      overlay.querySelector('.call-avatar').innerHTML = ctx.avatar(c);
      overlay.querySelector('.call-name').textContent = c.name || '';
      attachLocal();
    }
    overlay.classList.toggle('video', !!cur.video);
    overlay.classList.toggle('live', cur.status === 'active');
    overlay.classList.toggle('cam-off', !!cur.camOff);
    const status = overlay.querySelector('[data-cstatus]');
    status.textContent = {
      calling: 'در حال تماس…',
      ringing: cur.video ? 'تماس تصویری ورودی' : 'تماس صوتی ورودی',
      connecting: 'در حال اتصال…',
      active: cur.t0 ? fmt((Date.now() - cur.t0) / 1000) : '',
    }[cur.status] || '';
    const a = overlay.querySelector('[data-cactions]');
    if (cur.status === 'ringing') {
      a.innerHTML = `<button class="call-btn hang" data-c="decline" aria-label="رد تماس">${ICON.hang}</button>
        <button class="call-btn accept" data-c="accept" aria-label="پاسخ">${ICON.accept}</button>`;
    } else {
      a.innerHTML = `
        <button class="call-btn ${cur.speaker ? 'off' : ''}" data-c="speaker" aria-label="بلندگو" aria-pressed="${!!cur.speaker}">${ICON.speaker}</button>
        <button class="call-btn ${cur.muted ? 'off' : ''}" data-c="mute" aria-label="${cur.muted ? 'روشن کردن میکروفون' : 'بی‌صدا'}" aria-pressed="${!!cur.muted}">${ICON.mic}</button>
        ${cur.video ? `<button class="call-btn ${cur.camOff ? 'off' : ''}" data-c="cam" aria-label="${cur.camOff ? 'روشن کردن دوربین' : 'خاموش کردن دوربین'}" aria-pressed="${!!cur.camOff}">${ICON.cam}</button>
        <button class="call-btn" data-c="flip" aria-label="عوض کردن دوربین">${ICON.flip}</button>` : ''}
        <button class="call-btn hang" data-c="hang" aria-label="قطع تماس">${ICON.hang}</button>`;
    }
    a.querySelectorAll('[data-c]').forEach((b) => { b.onclick = () => action(b.dataset.c); });
  }

  function startClock() {
    clearInterval(cur.clock);
    cur.clock = setInterval(() => {
      const s = overlay?.querySelector('[data-cstatus]');
      if (s && cur?.t0) s.textContent = fmt((Date.now() - cur.t0) / 1000);
    }, 1000);
  }

  async function action(a) {
    if (!cur) return;
    if (a === 'decline') { ctx.sendSignal(cur.peer, { op: 'decline', callId: cur.id }).catch(() => {}); end('declined', false); }
    if (a === 'accept') accept();
    if (a === 'hang') { ctx.sendSignal(cur.peer, { op: cur.t0 ? 'end' : 'cancel', callId: cur.id }).catch(() => {}); end(cur.t0 ? 'done' : (cur.role === 'out' ? 'cancelled' : 'declined'), false); }
    if (a === 'mute') {
      cur.muted = !cur.muted;
      cur.local?.getAudioTracks().forEach((t) => { t.enabled = !cur.muted; });
      render();
    }
    if (a === 'cam') {
      cur.camOff = !cur.camOff;
      cur.local?.getVideoTracks().forEach((t) => { t.enabled = !cur.camOff; });
      render();
    }
    if (a === 'flip') flip();
    if (a === 'speaker') {
      const want = !cur.speaker;
      if (await routeAudio(want)) { cur.speaker = want; render(); }
      else ctx.toast('این گوشی اجازه‌ی عوض کردن بلندگو از داخل برنامه را نمی‌دهد. صدا را با دکمه‌های کناری گوشی تنظیم کنید.');
    }
  }

  // انتخاب خروجی صدا (بلندگو یا گوشی). روی اندروید و کامپیوتر با setSinkId انجام می‌شود.
  // Safari آیفون این امکان را به وب‌اپ‌ها نمی‌دهد و مسیر صدا را خودش تعیین می‌کند.
  async function routeAudio(speaker) {
    const v = overlay?.querySelector('.call-remote');
    if (!v || typeof v.setSinkId !== 'function') return false;
    try {
      const outs = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audiooutput');
      if (!outs.length) return false;
      const find = (re) => outs.find((d) => re.test(d.label));
      const target = speaker
        ? find(/speaker|بلندگو|loud/i) || outs.find((d) => d.deviceId === 'default') || outs[0]
        : find(/earpiece|receiver|handset|phone/i) || outs.find((d) => d.deviceId === 'communications') || outs.find((d) => d.deviceId === 'default') || outs[0];
      await v.setSinkId(target.deviceId);
      return true;
    } catch { return false; }
  }

  async function flip() {
    if (!cur?.pc || !cur.local) return;
    cur.facing = cur.facing === 'environment' ? 'user' : 'environment';
    try {
      const s = await navigator.mediaDevices.getUserMedia({ video: { facingMode: cur.facing } });
      const track = s.getVideoTracks()[0];
      const sender = cur.pc.getSenders().find((x) => x.track && x.track.kind === 'video');
      if (sender) await sender.replaceTrack(track);
      cur.local.getVideoTracks().forEach((t) => { cur.local.removeTrack(t); t.stop(); });
      cur.local.addTrack(track);
      overlay?.classList.toggle('rear', cur.facing === 'environment');
      attachLocal();
    } catch { ctx.toast('عوض کردن دوربین انجام نشد'); }
  }

  function cleanup() {
    stopRing();
    if (!cur) return;
    clearTimeout(cur.ringTimer);
    clearTimeout(cur.dropTimer);
    clearInterval(cur.clock);
    try { cur.pc?.close(); } catch { /* ignore */ }
    cur.local?.getTracks().forEach((t) => t.stop());
    overlay?.remove();
    overlay = null;
  }

  function end(status, notifyPeer) {
    if (!cur) return;
    const c = cur;
    if (notifyPeer) ctx.sendSignal(c.peer, { op: 'end', callId: c.id }).catch(() => {});
    cleanup();
    cur = null;
    const dur = c.t0 ? Math.round((Date.now() - c.t0) / 1000) : 0;
    ctx.onLog(c.peer, { dir: c.role, video: !!c.video, status: dur ? 'done' : status, dur });
    if (status === 'failed' && !dur) ctx.toast('تماس وصل نشد');
  }

  // ---------- شروع تماس ----------
  async function start(peer, video) {
    if (cur) { ctx.toast('یک تماس در جریان است'); return; }
    if (!window.RTCPeerConnection || !navigator.mediaDevices?.getUserMedia) { ctx.toast('این گوشی تماس را پشتیبانی نمی‌کند'); return; }
    cur = { id: ctx.uid(), peer, video, role: 'out', status: 'calling', facing: 'user', speaker: !!video };
    render();
    startRing(false);
    try {
      cur.local = await media(video);
    } catch {
      ctx.toast(video ? 'برای تماس تصویری اجازه‌ی دوربین و میکروفون را بدهید' : 'برای تماس اجازه‌ی میکروفون را بدهید');
      cleanup(); cur = null; return;
    }
    if (!cur) { return; }
    attachLocal();
    const me = cur;
    try {
      me.pc = await makePc();
      me.local.getTracks().forEach((t) => me.pc.addTrack(t, me.local));
      // اگر دوربین این گوشی کار نکند، تصویر طرف مقابل همچنان دریافت می‌شود
      if (video && !me.local.getVideoTracks().length) { me.pc.addTransceiver('video', { direction: 'recvonly' }); me.camOff = true; render(); }
      await me.pc.setLocalDescription(await me.pc.createOffer());
      await iceDone(me.pc);
      if (cur !== me) return;
      await ctx.sendSignal(peer, { op: 'offer', callId: me.id, video: !!video, sdp: me.pc.localDescription.sdp, ts: Date.now() });
    } catch (e) {
      if (cur === me) { ctx.toast(e.message || 'تماس برقرار نشد'); cleanup(); cur = null; }
      return;
    }
    me.ringTimer = setTimeout(() => {
      if (cur === me && !me.t0) { ctx.sendSignal(peer, { op: 'cancel', callId: me.id }).catch(() => {}); end('noanswer', false); }
    }, RING_TIMEOUT);
  }

  async function accept() {
    const me = cur;
    if (!me || me.status !== 'ringing') return;
    me.status = 'connecting';
    stopRing();
    render();
    try {
      me.local = await media(me.video);
    } catch {
      try { me.local = await media(false); me.video = false; } catch {
        ctx.toast('برای پاسخ دادن اجازه‌ی میکروفون را بدهید');
        ctx.sendSignal(me.peer, { op: 'decline', callId: me.id }).catch(() => {});
        end('declined', false);
        return;
      }
    }
    attachLocal();
    if (me.video && !me.local.getVideoTracks().length) me.camOff = true;
    try {
      me.pc = await makePc();
      await me.pc.setRemoteDescription({ type: 'offer', sdp: me.offer });
      me.local.getTracks().forEach((t) => me.pc.addTrack(t, me.local));
      await me.pc.setLocalDescription(await me.pc.createAnswer());
      await iceDone(me.pc);
      if (cur !== me) return;
      await ctx.sendSignal(me.peer, { op: 'answer', callId: me.id, sdp: me.pc.localDescription.sdp });
      render();
    } catch { end('failed', true); }
  }

  // ---------- پیام‌های تماس که از طرف مقابل می‌رسند ----------
  async function handle(from, m, serverTs) {
    if (!m || typeof m.op !== 'string' || typeof m.callId !== 'string' || m.callId.length > 64) return;
    if (m.op === 'offer') {
      if (typeof m.sdp !== 'string' || m.sdp.length > 200_000) return;
      const age = Date.now() - Math.max(Number(m.ts) || 0, serverTs || 0);
      if (age > RING_TIMEOUT) { ctx.onLog(from, { dir: 'in', video: !!m.video, status: 'missed', dur: 0 }); return; }
      if (cur) { ctx.sendSignal(from, { op: 'busy', callId: m.callId }).catch(() => {}); ctx.onLog(from, { dir: 'in', video: !!m.video, status: 'missed', dur: 0 }); return; }
      cur = { id: m.callId, peer: from, video: !!m.video, role: 'in', status: 'ringing', offer: m.sdp, facing: 'user', speaker: !!m.video };
      render();
      startRing(true);
      const me = cur;
      me.ringTimer = setTimeout(() => { if (cur === me && me.status === 'ringing') end('missed', false); }, RING_TIMEOUT - Math.min(age, 20_000));
      return;
    }
    if (!cur || cur.id !== m.callId || cur.peer !== from) return;
    if (m.op === 'answer' && cur.role === 'out' && cur.pc && typeof m.sdp === 'string') {
      clearTimeout(cur.ringTimer);
      cur.status = 'connecting';
      stopRing();
      render();
      try { await cur.pc.setRemoteDescription({ type: 'answer', sdp: m.sdp }); } catch { end('failed', true); }
      return;
    }
    if (m.op === 'decline') { end('declined', false); ctx.toast('تماس رد شد'); return; }
    if (m.op === 'busy') { end('busy', false); ctx.toast('مشغول است'); return; }
    if (m.op === 'cancel') { end('missed', false); return; }
    if (m.op === 'end') { end('done', false); }
  }

  return { start, handle, get active() { return !!cur; } };
}
