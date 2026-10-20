'use strict';
/* NEXUS HUD.
 *
 * Python → JS olayları (NX.on(event, payload)):
 *   state     tam durum: {roster, active, matrix, events, story, timers, ledger, model, settings, has_key}
 *   chip      {chip}                          çip takıldı
 *   status    {status, chip?}                 idle|listening|thinking|speaking|connecting|error
 *   line      {who, kind, text, final}        kind: user|ai|interject|system; final:false parçalar birleşir
 *   telemetry {cpu, ram, disk, net_down, net_up, mic, spk, speaker}
 *   rivalry   {matrix, events}                confirm {id,title,detail,timeout,chip?}
 *   arena     {phase: start|line|vote|end, a, b, topic, who, text, winner}
 *   handoff   {from, to}     timers {timers:[{id,label,remaining,total}]}   timer_done {label}
 *   ledger    {net30, income30, expense30, count}   chaos {kind}   flash {text}   story {locked, chained, progress}
 *   error     {message, code?}
 * JS → Python: window.pywebview.api.<yöntem>() (bridge.py). pywebview yoksa MOCK köprü devreye girer.
 */
(() => {
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const el = (tag, props = {}, ...kids) => { const e = Object.assign(document.createElement(tag), props); e.append(...kids); return e; };
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
const hex2rgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const mix = (h, o, t) => { const a = hex2rgb(h), b = hex2rgb(o); return '#' + a.map((v, i) => Math.round(v + (b[i] - v) * t).toString(16).padStart(2, '0')).join(''); };
const rgba = (h, a) => `rgba(${hex2rgb(h).join(',')},${a})`;
const signed = n => (n < 0 ? '−' + Math.abs(n) : n > 0 ? '+' + n : '0');
const label = s => s <= -70 ? 'ezeli düşman' : s <= -40 ? 'düşman' : s <= -15 ? 'gergin' : s < 15 ? 'nötr' : s < 50 ? 'iyi' : 'kardeş';
const ORDER = ['atlas', 'nova', 'obsidian', 'sentinel', 'forge', 'iris', 'pulse', 'ledger', 'oracle', 'glitch'];
const ABBR = { atlas:'ATL', nova:'NOV', obsidian:'OBS', sentinel:'SEN', forge:'FRG', iris:'IRS', pulse:'PLS', ledger:'LDG', oracle:'ORC', glitch:'GLT' };
const STATUS_TEXT = { idle:'hazır', listening:'dinliyor', thinking:'düşünüyor', speaking:'konuşuyor', connecting:'bağlanıyor', error:'hata' };
const VOICES = ['Zephyr','Puck','Charon','Kore','Fenrir','Leda','Orus','Aoede','Callirrhoe','Autonoe','Enceladus','Iapetus','Umbriel','Algieba','Despina','Erinome','Algenib','Rasalgethi','Laomedeia','Achernar','Alnilam','Schedar','Gacrux','Pulcherrima','Achird','Zubenelgenubi','Vindemiatrix','Sadachbia','Sadaltager','Sulafat'];

/* ================= durum ================= */
const S = { roster:[], by:{}, active:null, status:'connecting', matrix:{}, events:[], story:{ locked:false, chained:[] },
  settings:{}, hasKey:false, timers:[], timersAt:0, ledger:null, tele:{ cpu:0, ram:0, disk:0, net_down:0, net_up:0, mic:0, spk:0, speaker:null },
  series:{ cpu:[], ram:[], disk:[], nd:[], nu:[] }, mic:false, localUser:null, open:{}, arena:null };

/* ================= köprü ================= */
const real = () => !!(window.pywebview && window.pywebview.api);
const api = new Proxy({}, { get: (_, k) => (...a) => {
  try { const f = real() ? window.pywebview.api[k] : (MOCK.api[k] || (() => ({ ok:false, error:'yok' }))); return Promise.resolve(f(...a)); }
  catch (e) { return Promise.resolve({ ok:false, error:String(e) }); } } });

/* ================= UI sesleri (WebAudio; dosya yok) ================= */
let actx = null, lastHover = 0;
const audioReady = () => { try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); if (actx.state === 'suspended') actx.resume(); return actx; } catch { return null; } };
function tone(f, d = .06, type = 'sine', vol = .03, slide = 0, delay = 0) {
  const c = actx; if (!c || reduced && vol > .05) return;
  const o = c.createOscillator(), g = c.createGain(), t = c.currentTime + delay;
  o.type = type; o.frequency.setValueAtTime(f, t); if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + d);
  g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(.0001, t + d); o.connect(g).connect(c.destination); o.start(t); o.stop(t + d + .02);
}
const SFX = {
  hover: () => tone(1500, .025, 'sine', .012), click: () => tone(720, .05, 'square', .02),
  confirm: () => { tone(660, .08, 'sine', .04); tone(990, .12, 'sine', .04, 0, .08); }, error: () => tone(170, .25, 'sawtooth', .04, 90),
  mount: () => tone(260, .28, 'triangle', .04, 920), arena: () => { tone(110, .6, 'sine', .06); tone(165, .6, 'sine', .04, 0, .05); }, alert: () => { tone(880, .1, 'square', .03); tone(660, .1, 'square', .03, 0, .12); },
};
addEventListener('pointerdown', audioReady, { once:true }); addEventListener('keydown', audioReady, { once:true });
document.addEventListener('pointerdown', e => { if (e.target.closest('button')) SFX.click(); });
/* geliştirici kısayolu (yalnızca --debug): Ctrl+Shift+Alt+S → OBSIDIAN yetki isteme zamanını getirir */
addEventListener('keydown', e => { if (e.ctrlKey && e.shiftKey && e.altKey && e.code === 'KeyS') api.dev('story_due'); });
document.addEventListener('mouseover', e => { const b = e.target.closest('.btn,.chip-card,.icon-btn,.seg button'); if (b && performance.now() - lastHover > 90) { lastHover = performance.now(); SFX.hover(); } });

/* ================= yardımcılar ================= */
function toast(msg, ms = 2600) { const t = $('#toast'); t.textContent = msg; t.hidden = false; clearTimeout(toast.t); toast.t = setTimeout(() => t.hidden = true, ms); }
const themeColor = k => (S.by[S.active] && S.by[S.active].colors[k]) || (k === 'accent' ? '#FF9B3C' : '#5ED8FF');
const chipName = k => (S.by[k] && S.by[k].name) || String(k || '').toUpperCase();
const chipColor = k => (S.by[k] && S.by[k].colors.main) || '#5ED8FF';
const fmtTime = s => { s = Math.max(0, Math.round(s)); return String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0'); };

/* ================= modal yönetimi ================= */
const stack = [];
function openModal(id) {
  const m = $('#' + id); if (!m || !m.hidden) return;
  m._focus = document.activeElement; m.hidden = false; stack.push(id);
  const f = $('input:not([hidden]),select,button:not([data-close]):not([role=tab])', m) || $('button', m); f && f.focus();
}
function closeModal(id) {
  const m = $('#' + id); if (!m || m.hidden) return; m.hidden = true;
  const i = stack.lastIndexOf(id); if (i >= 0) stack.splice(i, 1);
  if (id === 'm-confirm') settleConfirm(false);
  m._focus && m._focus.focus && m._focus.focus();
}
$$('.modal').forEach(m => {
  m.addEventListener('mousedown', e => { if (e.target === m && !['m-confirm', 'm-onboard'].includes(m.id)) closeModal(m.id); });
  $$('[data-close]', m).forEach(b => b.onclick = () => closeModal(m.id));
});

/* ================= çip temaları ve kartlar ================= */
function applyTheme(c) {
  const r = document.documentElement.style;
  r.setProperty('--main', c.main); r.setProperty('--accent', c.accent); r.setProperty('--deep', c.deep); r.setProperty('--ink', c.ink);
  r.setProperty('--main-rgb', hex2rgb(c.main).join(','));
}
function setActive(key) {
  const chip = S.by[key]; if (!chip) return;
  S.active = key; applyTheme(chip.colors);
  $('#cn-name').textContent = chip.name; $('#cn-role').textContent = chip.role;
  document.title = chip.name + ' · NEXUS'; renderChips(); renderMatrix();
}
const isChained = k => (S.story.chained || []).includes(k) || (S.by[k] && S.by[k].disabled);
function renderChips() {
  const box = $('#chips'); box.replaceChildren(...S.roster.map((c, i) => {
    const b = el('button', { className:'chip-card' + (c.key === S.active ? ' active' : '') + (isChained(c.key) ? ' chained' : ''), type:'button' });
    b.style.setProperty('--c', c.colors.main); b.dataset.key = c.key;
    b.setAttribute('aria-label', `${c.name}, ${c.role}${isChained(c.key) ? ', zincire vurulmuş' : ''}`);
    b.append(el('kbd', { textContent: 'Ctrl+' + ((i + 1) % 10) }), el('b', { textContent:c.name }), el('small', { textContent:c.role }));
    if (S.active && c.key !== S.active && S.matrix[S.active]) {
      const s = S.matrix[S.active][c.key] || 0, rel = el('div', { className:'rel', title:`${chipName(S.active)} ile: ${signed(s)} ${label(s)}` });
      const bar = el('i'); bar.style.background = s >= 0 ? 'var(--good)' : 'var(--bad)';
      bar.style.left = (s >= 0 ? 50 : 50 + s / 2) + '%'; bar.style.width = Math.abs(s) / 2 + '%'; rel.append(bar); b.append(rel);
    }
    b.onclick = () => { if (isChained(c.key)) { toast(`${c.name} zincire vurulmuş. Çip Tamiri'nden kurtar.`); SFX.error(); return; } api.mount(c.key); };
    return b;
  }));
}
function renderMatrix() {
  const box = $('#matrix'), keys = S.roster.map(c => c.key); box.replaceChildren(el('span'));
  keys.forEach(k => { const h = el('span', { className:'h', textContent:ABBR[k] || k.slice(0, 3).toUpperCase() }); h.style.color = chipColor(k); box.append(h); });
  keys.forEach(a => {
    const h = el('span', { className:'h', textContent:ABBR[a] || a.slice(0, 3).toUpperCase() }); h.style.color = chipColor(a); box.append(h);
    keys.forEach(b => {
      const s = a === b ? 0 : ((S.matrix[a] || {})[b] || 0), cell = el('span', { className:'c' + (a === b ? ' self' : '') });
      if (a !== b) { cell.style.background = s < 0 ? `rgba(255,77,94,${.12 + Math.abs(s) / 100 * .85})` : `rgba(74,222,128,${.08 + s / 100 * .8})`; cell.dataset.tip = `${chipName(a)} ↔ ${chipName(b)} ${signed(s)} ${label(s)}`; }
      box.append(cell);
    });
  });
}
const tip = $('#mtip');
$('#matrix').addEventListener('mousemove', e => { const c = e.target.closest('[data-tip]'); if (!c) { tip.hidden = true; return; } tip.textContent = c.dataset.tip; tip.hidden = false; tip.style.left = Math.min(e.clientX + 12, innerWidth - tip.offsetWidth - 8) + 'px'; tip.style.top = (e.clientY + 14) + 'px'; });
$('#matrix').addEventListener('mouseleave', () => tip.hidden = true);
function renderEvents() {
  const ul = $('#events'); if (!S.events.length) { ul.replaceChildren(el('li', { className:'dim', textContent:'Henüz olay yok.' })); return; }
  ul.replaceChildren(...S.events.slice(0, 8).map(e => el('li', {}, el('b', { className: e.delta >= 0 ? 'up' : 'down', textContent: signed(e.delta) + ' ' }), e.reason || `${chipName(e.a)} ↔ ${chipName(e.b)}`)));
}

/* ================= sohbet ================= */
function addLine({ who, kind, text, final }) {
  const chat = $('#chat'), key = who + '|' + kind, near = chat.scrollHeight - chat.scrollTop - chat.clientHeight < 80;
  let ln = S.open[key];
  if (kind === 'user' && S.localUser && text && S.localUser.text === text.trim() && Date.now() - S.localUser.t < 5000) { S.localUser = null; return; }  // yerel yankı
  if (!ln) {
    ln = el('div', { className:'line ' + (kind === 'ai' || kind === 'interject' ? kind : kind) });
    if (kind !== 'system') { const w = el('span', { className:'who', textContent: kind === 'user' ? 'SEN' : chipName(who) }); ln.append(w); if (kind !== 'user') ln.style.setProperty('--c', chipColor(who)); }
    ln.append(el('span', { className:'txt' })); chat.append(ln); S.open[key] = ln;
    while (chat.children.length > 30) chat.firstChild.remove();
  }
  $('.txt', ln).textContent += text || '';
  if (final !== false) delete S.open[key];
  if (near) chat.scrollTop = chat.scrollHeight;
}
$('#composer').onsubmit = e => {
  e.preventDefault(); const i = $('#msg'), t = i.value.trim(); if (!t) return; i.value = '';
  addLine({ who:'user', kind:'user', text:t, final:true }); S.localUser = { text:t, t:Date.now() };   // çekirdeğin yankısı 5 sn içinde yutulur
  api.send_text(t);
};
function setMic(on) { S.mic = on; const b = $('#mic'); b.setAttribute('aria-pressed', on); }
$('#mic').onclick = () => { setMic(!S.mic); api.mic(S.mic); (S.mic ? SFX.confirm : SFX.click)(); };

/* ================= durum çubuğu ================= */
function setStatus(st, chip) {
  S.status = st; $('#cn-status').textContent = STATUS_TEXT[st] || st;
  const on = st !== 'connecting' && st !== 'error'; $('#conn').classList.toggle('on', on); $('#conn-text').textContent = on ? 'bağlı' : STATUS_TEXT[st];
  if (st !== 'speaking') S.tele.speaker = null; else if (chip) S.tele.speaker = chip;
}
setInterval(() => $('#clock').textContent = new Date().toLocaleTimeString('tr-TR', { hour:'2-digit', minute:'2-digit' }), 1000);
$('#clock').textContent = new Date().toLocaleTimeString('tr-TR', { hour:'2-digit', minute:'2-digit' });
$$('#drama button').forEach(b => b.onclick = () => setDrama(b.dataset.v, true));
function setDrama(v, save) { $$('#drama button').forEach(b => b.setAttribute('aria-checked', b.dataset.v === v)); S.settings.drama = v; if ($('#s-drama')) $('#s-drama').value = v; if (save) api.settings_set('drama', v); }

/* ================= telemetri ================= */
const push = (arr, v) => { arr.push(v); if (arr.length > 60) arr.shift(); };
function gauge(canvas, v) {
  const c = canvas.getContext('2d'), s = canvas.width, col = v > 85 ? '#ff4d5e' : themeColor('main');
  c.clearRect(0, 0, s, s); c.lineWidth = 7; c.lineCap = 'round'; const a0 = Math.PI * .75, span = Math.PI * 1.5;
  c.strokeStyle = 'rgba(255,255,255,.09)'; c.beginPath(); c.arc(s / 2, s / 2, s / 2 - 8, a0, a0 + span); c.stroke();
  c.strokeStyle = col; c.shadowColor = col; c.shadowBlur = 8; c.beginPath(); c.arc(s / 2, s / 2, s / 2 - 8, a0, a0 + span * clamp(v, 0, 100) / 100); c.stroke();
}
function spark(canvas, series, max, color2) {
  const r = canvas.getBoundingClientRect(), d = devicePixelRatio || 1; if (!r.width) return;
  if (canvas.width !== Math.round(r.width * d)) { canvas.width = Math.round(r.width * d); canvas.height = Math.round(r.height * d); }
  const c = canvas.getContext('2d'), w = canvas.width, h = canvas.height, main = themeColor('main');
  c.clearRect(0, 0, w, h); c.strokeStyle = 'rgba(255,255,255,.06)'; c.lineWidth = 1; for (let i = 1; i < 4; i++) { c.beginPath(); c.moveTo(0, h * i / 4); c.lineTo(w, h * i / 4); c.stroke(); }
  const line = (arr, col, fill) => { if (arr.length < 2) return; c.beginPath(); arr.forEach((v, i) => { const x = w * (i + 60 - arr.length) / 59, y = h - clamp(v / max, 0, 1) * (h - 4) - 2; i ? c.lineTo(x, y) : c.moveTo(x, y); });
    c.strokeStyle = col; c.lineWidth = 1.5 * d; c.stroke(); if (fill) { c.lineTo(w, h); c.lineTo(w * (60 - arr.length) / 59, h); c.closePath(); c.fillStyle = rgba(col, .14); c.fill(); } };
  line(series[0], main, true); if (series[1]) line(series[1], color2 || '#FF9B3C', false);
}
function drawTele() {
  const t = S.tele;
  [['t-cpu', 'cpu'], ['t-ram', 'ram'], ['t-disk', 'disk']].forEach(([id, k]) => {
    const p = $('#' + id); gauge($('.gauge canvas', p), t[k]); $('.val', p).textContent = Math.round(t[k]) + '%'; spark($('.spark', p), [S.series[k]], 100);
  });
  $('#net-d').textContent = Math.round(t.net_down); $('#net-u').textContent = Math.round(t.net_up);
  const mx = Math.max(50, ...S.series.nd, ...S.series.nu); spark($('#t-net .spark'), [S.series.nd, S.series.nu], mx, themeColor('accent'));
  const mm = $('#mic-meter'); if (mm && !$('#m-settings').hidden) { mm.style.width = clamp(t.mic / .3, 0, 1) * 100 + '%'; $('#mic-thr').style.left = clamp((S.settings.barge_rms || 0) / .3, 0, 1) * 100 + '%'; }
}
function onTelemetry(p) {
  Object.assign(S.tele, p); push(S.series.cpu, S.tele.cpu); push(S.series.ram, S.tele.ram); push(S.series.disk, S.tele.disk); push(S.series.nd, S.tele.net_down); push(S.series.nu, S.tele.net_up); drawTele();
}
function renderTimers() {
  const ul = $('#timers'), age = (Date.now() - S.timersAt) / 1000, list = S.timers.filter(t => t.remaining - age > -1);
  if (!list.length) { ul.replaceChildren(el('li', { className:'dim', textContent:'Çalışan zamanlayıcı yok.' })); return; }
  ul.replaceChildren(...list.map(t => { const rem = Math.max(0, t.remaining - age), bar = el('div', { className:'bar' }, el('i'));
    $('i', bar).style.width = (t.total ? (1 - rem / t.total) * 100 : 0) + '%';
    return el('li', {}, el('div', { className:'tl' }, el('span', { textContent:t.label }), el('b', { className:'mono', textContent:fmtTime(rem) })), bar); }));
}
setInterval(renderTimers, 1000);
function renderLedger() {
  const l = S.ledger, box = $('#ledger'); if (!l) return;
  const money = n => (n < 0 ? '−' : '') + Math.abs(Math.round(n)).toLocaleString('tr-TR') + ' ₺', tot = (l.income30 || 0) + (l.expense30 || 0) || 1;
  const split = el('div', { className:'split' }, el('i'), el('i')); $('i:first-child', split).style.width = (l.income30 || 0) / tot * 100 + '%'; $('i:last-child', split).style.width = (l.expense30 || 0) / tot * 100 + '%';
  box.replaceChildren(el('div', { className:'net ' + (l.net30 < 0 ? 'neg' : 'pos'), textContent:money(l.net30 || 0) }), split,
    el('div', { className:'dim', textContent:`Gelir ${money(l.income30 || 0)} · Gider ${money(l.expense30 || 0)} · ${l.count || 0} kayıt` }));
}

/* ================= reaktör halkası ================= */
const reactor = $('#reactor'), rctx = reactor.getContext('2d');
let level = 0, sizeKey = '';
function fitCanvas(cv) { const r = cv.getBoundingClientRect(), d = devicePixelRatio || 1, k = Math.round(r.width) + 'x' + Math.round(r.height) + d; if (cv._k !== k) { cv._k = k; cv.width = r.width * d; cv.height = r.height * d; } return d; }
const tri = x => 2 / Math.PI * Math.asin(Math.sin(x));
const WAVES = {
  smooth: (a, t, i) => .55 * Math.sin(3 * a + t * .9 + i) + .3 * Math.sin(5 * a - t * 1.3 + i * 2) + .15 * Math.sin(2 * a + t * .5),
  fluid:  (a, t, i) => .5 * Math.sin(2 * a + t * .8 + i) + .35 * Math.sin(3 * a - t * 1.1 + i * 1.7) + .3 * Math.sin(4 * a + t * 1.6) + .25 * Math.sin(7 * a - t * .7 + Math.sin(t * .6) * 2),
  sharp:  (a, t, i) => .6 * tri(9 * a + t * 1.4 + i * 2) + .4 * tri(14 * a - t * 2 + i),
};
const AMP = { smooth:.035, fluid:.06, sharp:.05 };
function drawRing(c, cx, cy, R, chip, lvl, t, status, mini) {
  const ring = chip.ring || { style:'smooth', speed:1 }, st = WAVES[ring.style] ? ring.style : 'smooth', sp = ring.speed || 1, main = chip.colors.main, accent = chip.colors.accent;
  const col = status === 'listening' ? mix(main, '#ffffff', .35) : status === 'speaking' ? mix(main, '#ffffff', .65) : main, tt = t * sp * (reduced ? 0 : 1);
  const amp = (reduced ? .3 : 1) * AMP[st] * (.45 + lvl * 3.2);
  c.lineJoin = st === 'sharp' ? 'miter' : 'round';
  // dış çentikler
  c.save(); c.translate(cx, cy); c.rotate(tt * .08); c.strokeStyle = rgba(main, .35); c.lineWidth = 1;
  for (let i = 0; i < 90; i++) { const a = i / 90 * Math.PI * 2, r1 = R * 1.16, r2 = r1 + (i % 5 ? R * .03 : R * .07); c.beginPath(); c.moveTo(Math.cos(a) * r1, Math.sin(a) * r1); c.lineTo(Math.cos(a) * r2, Math.sin(a) * r2); c.stroke(); }
  c.restore();
  // 3 kabuk
  for (let s = 0; s < 3; s++) {
    const r0 = R * (1 - s * .15), a = amp * (1 - s * .22); c.beginPath();
    for (let i = 0; i <= 200; i++) { const th = i / 200 * Math.PI * 2, rr = r0 * (1 + a * WAVES[st](th, tt, s)); const x = cx + Math.cos(th) * rr, y = cy + Math.sin(th) * rr; i ? c.lineTo(x, y) : c.moveTo(x, y); }
    c.closePath(); c.strokeStyle = rgba(col, 1 - s * .25); c.lineWidth = (s ? 1.3 : 2.4) * (mini ? .7 : 1); c.shadowColor = col; c.shadowBlur = (mini ? 6 : 12) + lvl * 22; c.stroke();
  }
  c.shadowBlur = 0;
  // düşünürken dönen vurgu yayı
  if (status === 'thinking') { c.beginPath(); c.arc(cx, cy, R * 1.26, tt * 3, tt * 3 + Math.PI * .45); c.strokeStyle = accent; c.lineWidth = 3; c.lineCap = 'round'; c.shadowColor = accent; c.shadowBlur = 14; c.stroke(); c.shadowBlur = 0; }
  const g = c.createRadialGradient(cx, cy, 0, cx, cy, R * .62); g.addColorStop(0, rgba(col, .12 + lvl * .3)); g.addColorStop(1, rgba(col, 0)); c.fillStyle = g; c.beginPath(); c.arc(cx, cy, R * .62, 0, 7); c.fill();
}
function targetLevel(t) {
  const s = S.status; if (s === 'speaking') return Math.max(S.tele.spk || 0, .12); if (s === 'listening') return S.tele.mic ? clamp(S.tele.mic * 3.5, .05, 1) : .06;
  if (s === 'thinking') return .2 + .1 * Math.sin(t * 6); return .05;
}
const arenaCtx = {};
function frame(now) {
  const t = now / 1000;
  if (!document.hidden) {
    const d = fitCanvas(reactor), w = reactor.width, h = reactor.height; rctx.setTransform(1, 0, 0, 1, 0, 0); rctx.clearRect(0, 0, w, h);
    level += (targetLevel(t) - level) * .14; const chip = S.by[S.active];
    if (chip) { rctx.setTransform(d, 0, 0, d, 0, 0); drawRing(rctx, w / d / 2, h / d / 2, Math.min(w, h) / d * .33, chip, level, t, S.status, false); }
    if (S.arena && !$('#m-arena').hidden) ['fa', 'fb'].forEach((id, i) => {
      const cv = $('#' + id + ' canvas'), c = cv.getContext('2d'), k = i ? S.arena.b : S.arena.a, ch = S.by[k]; if (!ch) return;
      c.setTransform(1, 0, 0, 1, 0, 0); c.clearRect(0, 0, cv.width, cv.height); const talking = S.arena.speaker === k; arenaCtx[k] = (arenaCtx[k] || 0) + ((talking ? .7 : .05) - (arenaCtx[k] || 0)) * .12;
      drawRing(c, cv.width / 2, cv.height / 2, cv.width * .33, ch, arenaCtx[k], t, talking ? 'speaking' : 'idle', true);
    });
  }
  requestAnimationFrame(frame);
}

/* ================= onay ================= */
let confirmQ = [], confirmCur = null, confirmTimer = null;
function onConfirm(p) { confirmQ.push(p); if (!confirmCur) nextConfirm(); }
function nextConfirm() {
  confirmCur = confirmQ.shift(); if (!confirmCur) return;
  const p = confirmCur, danger = p.chip === 'obsidian' || /yetki/i.test(p.title || ''), m = $('#m-confirm');
  m.classList.toggle('danger', danger); $('#mc-title').textContent = (p.title || 'Onay gerekiyor').toUpperCase();
  $('#mc-chip').textContent = p.chip ? chipName(p.chip) + ' izin istiyor:' : ''; $('#mc-detail').textContent = p.detail || ''; $('#mc-detail').hidden = !p.detail;
  const total = (p.timeout || 30) * 1000, t0 = Date.now(), bar = $('#mc-bar'); bar.style.transition = 'none'; bar.style.width = '100%';
  clearInterval(confirmTimer); confirmTimer = setInterval(() => { const f = 1 - (Date.now() - t0) / total; bar.style.width = clamp(f, 0, 1) * 100 + '%'; if (f <= 0) settleConfirm(false); }, 100);
  openModal('m-confirm'); danger ? SFX.alert() : SFX.confirm(); $('#mc-no').focus();
}
function settleConfirm(ok) {
  if (!confirmCur) return; const p = confirmCur; confirmCur = null; clearInterval(confirmTimer);
  api.answer(p.id, ok); const m = $('#m-confirm'); if (!m.hidden) { m.hidden = true; const i = stack.lastIndexOf('m-confirm'); if (i >= 0) stack.splice(i, 1); }
  setTimeout(nextConfirm, 150);
}
$('#mc-yes').onclick = () => settleConfirm(true); $('#mc-no').onclick = () => settleConfirm(false);

/* ================= arena ================= */
function arenaFill() {
  for (const id of ['ar-a', 'ar-b']) { const s = $('#' + id); s.replaceChildren(...S.roster.filter(c => !isChained(c.key)).map(c => el('option', { value:c.key, textContent:c.name }))); }
  $('#ar-a').value = S.active && !isChained(S.active) ? S.active : 'sentinel'; $('#ar-b').value = $('#ar-a').value === 'forge' ? 'sentinel' : 'forge';
}
$('#btn-arena').onclick = () => { arenaFill(); $('#arena-setup').hidden = false; $('#arena-stage').hidden = true; S.arena = null; openModal('m-arena'); SFX.arena(); };
$('#arena-setup').onsubmit = e => {
  e.preventDefault(); const a = $('#ar-a').value, b = $('#ar-b').value, topic = $('#ar-topic').value.trim();
  if (a === b) { toast('İki farklı çip seç.'); return; } if (!topic) return; api.arena(a, b, topic);
  arenaStart({ a, b, topic });
};
function arenaStart(p) {
  S.arena = { a:p.a, b:p.b, topic:p.topic, speaker:null }; $('#arena-setup').hidden = true; $('#arena-stage').hidden = false; $('#ar-vote').hidden = true; $('#ar-lines').replaceChildren();
  for (const [id, k] of [['fa', p.a], ['fb', p.b]]) { const f = $('#' + id); f.style.setProperty('--c', chipColor(k)); $('b', f).textContent = chipName(k); f.classList.remove('dim'); }
  $('#ar-topic-line').textContent = 'Konu: ' + p.topic; openModal('m-arena');
}
function onArena(p) {
  if (p.phase === 'start') { if (!S.arena || S.arena.a !== p.a) arenaStart(p); else SFX.arena(); }
  else if (p.phase === 'line' && S.arena) {
    S.arena.speaker = p.who; const li = el('li', {}, el('b', { textContent:chipName(p.who) }), p.text); li.style.setProperty('--c', chipColor(p.who));
    const ol = $('#ar-lines'); ol.append(li); ol.scrollTop = 1e9; setTimeout(() => { if (S.arena && S.arena.speaker === p.who) S.arena.speaker = null; }, 2600);
  } else if (p.phase === 'vote' && S.arena) {
    S.arena.speaker = null; $('#ar-vote').hidden = false; $('#vote-a').textContent = chipName(S.arena.a); $('#vote-b').textContent = chipName(S.arena.b); $('#vote-a').focus();
  } else if (p.phase === 'end') { closeModal('m-arena'); S.arena = null; }
}
const vote = w => { if (!S.arena) return; const a = S.arena.a, b = S.arena.b; api.vote(w); $('#fa').classList.toggle('dim', w === b); $('#fb').classList.toggle('dim', w === a); $('#ar-vote').hidden = true; setTimeout(() => closeModal('m-arena'), 1200); };
$('#vote-a').onclick = () => vote(S.arena.a); $('#vote-b').onclick = () => vote(S.arena.b); $('#vote-draw').onclick = () => vote('draw');

/* ================= çip tamiri ================= */
function renderStory() { $('#btn-repair').hidden = !S.story.locked; renderChips(); }
$('#btn-repair').onclick = () => { $('#repair-msg').textContent = ''; $$('#code-boxes input').forEach(i => i.value = ''); openModal('m-repair'); };
const boxes = $$('#code-boxes input');
boxes.forEach((b, i) => {
  b.addEventListener('input', () => { b.value = b.value.toUpperCase().replace(/[^A-Z0-9]/g, ''); if (b.value.length === 4 && boxes[i + 1]) boxes[i + 1].focus(); });
  b.addEventListener('keydown', e => { if (e.key === 'Backspace' && !b.value && boxes[i - 1]) boxes[i - 1].focus(); if (e.key === 'Enter') $('#repair-go').click(); });
  b.addEventListener('paste', e => { const t = (e.clipboardData.getData('text') || '').toUpperCase().replace(/[^A-Z0-9]/g, ''); if (t.length >= 12) { e.preventDefault(); boxes.forEach((x, j) => x.value = t.slice(j * 4, j * 4 + 4)); } });
});
$('#repair-go').onclick = async () => {
  const code = boxes.map(b => b.value).join('-'), r = await api.repair(code), box = $('#code-boxes');
  if (r && r.restored) { $('#repair-msg').textContent = 'Zincirler çözüldü.'; SFX.confirm(); toast('Çipler onarıldı.'); S.story = { locked:false, chained:[] }; renderStory(); setTimeout(() => closeModal('m-repair'), 900); }
  else { $('#repair-msg').textContent = 'Kod yanlış.'; box.classList.remove('bad'); void box.offsetWidth; box.classList.add('bad'); SFX.error(); }
};

/* ================= ayarlar ================= */
$('#btn-settings').onclick = openSettings;
async function openSettings() {
  S.settings = await api.settings_get() || S.settings; const s = S.settings;
  for (const k of ['user_name', 'workspace', 'text_model']) $('#s-' + k).value = s[k] || '';
  for (const k of ['story_enabled', 'mic_enabled', 'shell_confirm']) $('#s-' + k).checked = !!s[k];
  $('#s-drama').value = s.drama || 'normal'; $('#s-live_models').value = (s.live_models || []).join(', '); $('#s-tts_models').value = (s.tts_models || []).join(', ');
  $('#s-barge_rms').value = s.barge_rms ?? .06; $('#barge-val').textContent = Number(s.barge_rms ?? .06).toFixed(3);
  $('#key-state').textContent = S.hasKey ? 'Kayıtlı (maskeli)' : 'Kayıtlı değil'; $('#s-key').value = ''; $('#key-result').textContent = '';
  fillDevices(); fillVoices(); openModal('m-settings');
}
async function fillDevices() {
  const d = await api.devices() || {}, norm = x => (x || []).map(v => typeof v === 'object' ? { id:v.index ?? v.id, name:v.name } : { id:v, name:String(v) });
  for (const [k, list] of [['input_device', norm(d.input || d.inputs)], ['output_device', norm(d.output || d.outputs)]]) {
    const sel = $('#s-' + k); sel.replaceChildren(el('option', { value:'', textContent:'Sistem varsayılanı' }), ...list.map(x => el('option', { value:String(x.id), textContent:x.name })));
    sel.value = S.settings[k] == null ? '' : String(S.settings[k]);
  }
}
function fillVoices() {
  const ov = S.settings.voice_overrides || {}, fx = S.settings.fx_intensity || {};
  $('#voice-list').replaceChildren(...S.roster.map(c => {
    const sel = el('select', { ariaLabel:c.name + ' sesi' }, ...VOICES.map(v => el('option', { value:v, textContent: v + (v === c.voice ? ' (varsayılan)' : '') }))); sel.value = ov[c.key] || c.voice;
    const play = el('button', { className:'btn', type:'button', textContent:'DİNLE' }), sl = el('input', { type:'range', min:0, max:150, step:5, value:Math.round((fx[c.key] ?? 1) * 100), title:'Efekt yoğunluğu', ariaLabel:c.name + ' efekt yoğunluğu' });
    const row = el('div', { className:'vrow' }, el('b', { textContent:c.name }), sel, play, sl); row.style.setProperty('--c', c.colors.main);
    sel.onchange = () => { const o = { ...(S.settings.voice_overrides || {}) }; if (sel.value === c.voice) delete o[c.key]; else o[c.key] = sel.value; S.settings.voice_overrides = o; api.settings_set('voice_overrides', o); };
    sl.onchange = () => { const o = { ...(S.settings.fx_intensity || {}), [c.key]: sl.value / 100 }; S.settings.fx_intensity = o; api.settings_set('fx_intensity', o); };
    play.onclick = async () => { play.textContent = '…'; const r = await api.test_voice(c.key, sel.value); play.textContent = 'DİNLE'; if (r && r.ok === false) toast('Ses denenemedi: ' + (r.error || '')); };
    return row;
  }));
}
$$('.tabs [role=tab]').forEach(t => t.onclick = () => { $$('.tabs [role=tab]').forEach(x => x.setAttribute('aria-selected', x === t)); $$('.pane').forEach(p => p.hidden = p.dataset.pane !== t.dataset.tab); });
const bind = (id, key, get, set) => { const e = $('#' + id); e.addEventListener('change', () => { const v = get(e); S.settings[key] = v; api.settings_set(key, v).then(r => { if (r && r.ok === false) toast('Kaydedilemedi: ' + r.error); }); if (set) set(v); }); };
bind('s-user_name', 'user_name', e => e.value.trim()); bind('s-workspace', 'workspace', e => e.value.trim()); bind('s-text_model', 'text_model', e => e.value.trim());
bind('s-story_enabled', 'story_enabled', e => e.checked); bind('s-mic_enabled', 'mic_enabled', e => e.checked); bind('s-shell_confirm', 'shell_confirm', e => e.checked);
bind('s-drama', 'drama', e => e.value, v => setDrama(v, false));
bind('s-live_models', 'live_models', e => e.value.split(',').map(x => x.trim()).filter(Boolean)); bind('s-tts_models', 'tts_models', e => e.value.split(',').map(x => x.trim()).filter(Boolean));
bind('s-input_device', 'input_device', e => e.value === '' ? null : Number(e.value)); bind('s-output_device', 'output_device', e => e.value === '' ? null : Number(e.value));
$('#s-barge_rms').addEventListener('input', e => { S.settings.barge_rms = Number(e.target.value); $('#barge-val').textContent = Number(e.target.value).toFixed(3); });
$('#s-barge_rms').addEventListener('change', e => api.settings_set('barge_rms', Number(e.target.value)));
$('#open-data').onclick = () => api.open_data_folder();
$('#key-save').onclick = async () => { const k = $('#s-key').value.trim(); if (!k) { $('#key-result').textContent = 'Önce anahtarı yapıştır.'; return; }
  const r = await api.set_api_key(k); $('#s-key').value = ''; S.hasKey = !!(r && r.ok); $('#key-state').textContent = S.hasKey ? 'Kayıtlı (maskeli)' : 'Kayıtlı değil'; $('#key-result').textContent = S.hasKey ? 'Kaydedildi.' : 'Kaydedilemedi.'; };
$('#key-test').onclick = async () => { $('#key-result').textContent = 'Bağlanılıyor…'; S.keyTest = true; const r = await api.mount(S.active || 'atlas'); if (r && r.ok === false) $('#key-result').textContent = 'Sınanamadı: ' + r.error; };

/* ================= ilk açılış ================= */
$('#ob-save').onclick = async () => { const k = $('#ob-key').value.trim(); if (!k) return; const r = await api.set_api_key(k); if (r && r.ok) { S.hasKey = true; api.settings_set('onboarded', true); $('#ob-key').value = ''; closeModal('m-onboard'); api.mount(S.active || 'atlas'); } else toast('Anahtar kaydedilemedi.'); };
$('#ob-skip').onclick = () => { api.settings_set('onboarded', true); closeModal('m-onboard'); };
$('#ob-link').addEventListener('click', e => { if (real()) { e.preventDefault(); try { window.open('https://aistudio.google.com/apikey', '_blank'); } catch {} } });

/* ================= kaos efektleri ================= */
const fx = $('#fx'), fctx = fx.getContext('2d'); let fxRun = 0;
function fxFit() { fx.width = innerWidth; fx.height = innerHeight; } addEventListener('resize', fxFit); fxFit();
function runFx(draw, ms) { const id = ++fxRun, t0 = performance.now(); (function step(n) { if (id !== fxRun) return; const k = (n - t0) / ms; if (k >= 1) { fctx.clearRect(0, 0, fx.width, fx.height); return; } draw(k); requestAnimationFrame(step); })(t0); }
function chaos(kind) {
  if (reduced) { toast('GLITCH: ' + kind); return; }
  const cls = n => { document.body.classList.add(n); setTimeout(() => document.body.classList.remove(n), n === 'fx-shake' ? 600 : 1200); };
  if (kind === 'shake') cls('fx-shake');
  else if (kind === 'invert') cls('fx-invert');
  else if (kind === 'static') runFx(() => { const w = fx.width / 4, h = fx.height / 4, im = fctx.createImageData(w, h); for (let i = 0; i < im.data.length; i += 4) { const v = Math.random() * 255; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 90; } const t = document.createElement('canvas'); t.width = w; t.height = h; t.getContext('2d').putImageData(im, 0, 0); fctx.imageSmoothingEnabled = false; fctx.drawImage(t, 0, 0, fx.width, fx.height); }, 1000);
  else if (kind === 'rain') { const cols = Math.floor(fx.width / 16), drops = Array.from({ length:cols }, () => Math.random() * -40); const chars = 'アイウエオカキクケコ01ABCDEF<>{}#'; runFx(k => { fctx.fillStyle = 'rgba(3,7,11,.14)'; fctx.fillRect(0, 0, fx.width, fx.height); fctx.font = '15px "JetBrains Mono",monospace'; drops.forEach((y, i) => { fctx.fillStyle = Math.random() < .08 ? '#fff' : '#39FF14'; fctx.fillText(chars[Math.floor(Math.random() * chars.length)], i * 16, y * 16); drops[i] = y > fx.height / 16 && Math.random() > .975 ? 0 : y + 1; }); if (k > .9) fctx.clearRect(0, 0, fx.width, fx.height); }, 3000); }
  else if (kind === 'scramble') {
    const nodes = [], w = document.createTreeWalker($('#app'), NodeFilter.SHOW_TEXT, { acceptNode: n => n.nodeValue.trim().length > 2 && !n.parentElement.closest('canvas,script,style') ? 1 : 2 });
    while (w.nextNode()) nodes.push([w.currentNode, w.currentNode.nodeValue]);
    nodes.forEach(([n, o]) => n.nodeValue = o.replace(/\S+/g, x => [...x].sort(() => Math.random() - .5).join(''))); setTimeout(() => nodes.forEach(([n, o]) => n.nodeValue = o), 1000);
  } else toast('Bilinmeyen efekt: ' + kind);
}

/* ================= devir animasyonu ================= */
function handoff(p) {
  const a = $(`.chip-card[data-key="${p.from}"]`), b = $(`.chip-card[data-key="${p.to}"]`); if (!b) return;
  const wrap = $('#reactor-wrap'); wrap.classList.add('shrink'); setTimeout(() => wrap.classList.remove('shrink'), 800);
  if (a && !reduced) {
    const ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(), d = el('div', { className:'trail' }); d.style.setProperty('--c', chipColor(p.to)); $('#trail-layer').append(d);
    const f = { x:ra.left + ra.width / 2 - 7, y:ra.top + ra.height / 2 - 7 }, tt = { x:rb.left + rb.width / 2 - 7, y:rb.top + rb.height / 2 - 7 };
    d.animate([{ transform:`translate(${f.x}px,${f.y}px) scale(.6)`, opacity:0 }, { opacity:1, offset:.2 }, { transform:`translate(${tt.x}px,${tt.y}px) scale(1.2)`, opacity:1 }, { transform:`translate(${tt.x}px,${tt.y}px) scale(2.4)`, opacity:0 }], { duration:900, easing:'ease-in-out' }).onfinish = () => d.remove();
  }
  SFX.mount();
}

/* ================= klavye ================= */
addEventListener('keydown', e => {
  if (e.key === 'Escape') { const top = stack[stack.length - 1]; if (top === 'm-confirm') settleConfirm(false); else if (top) closeModal(top); return; }
  if (e.ctrlKey && e.code === 'Space') { e.preventDefault(); $('#mic').click(); return; }
  if (e.ctrlKey && e.key === ',') { e.preventDefault(); openSettings(); return; }
  if (e.ctrlKey && /^[0-9]$/.test(e.key) && !stack.length) { e.preventDefault(); const i = (Number(e.key) + 9) % 10, c = S.roster[i]; if (c) $(`.chip-card[data-key="${c.key}"]`).click(); }
});

/* ================= olay dağıtıcı ================= */
function loadState(p) {
  S.roster = p.roster || S.roster; S.by = Object.fromEntries(S.roster.map(c => [c.key, c])); S.matrix = p.matrix || S.matrix; S.events = p.events || [];
  S.story = p.story || S.story; S.settings = p.settings || S.settings; S.hasKey = !!p.has_key; if (p.model) $('#model').textContent = p.model;
  if (p.timers) { S.timers = p.timers; S.timersAt = Date.now(); } if (p.ledger) { S.ledger = p.ledger; renderLedger(); }
  setDrama((S.settings && S.settings.drama) || 'normal', false); setActive(p.active || S.active || (S.roster[0] && S.roster[0].key)); renderMatrix(); renderEvents(); renderStory(); renderTimers();
  if (!S.hasKey && !(S.settings && S.settings.onboarded) && $('#m-onboard').hidden) openModal('m-onboard');
}
const NX = window.NX = {
  on(event, p = {}) {
    switch (event) {
      case 'state': loadState(p); break;
      case 'chip': { const k = p.chip || p.key; if (S.by[k]) { setActive(k); SFX.mount(); } break; }
      case 'status': setStatus(p.status, p.chip); if (S.keyTest && p.status !== 'connecting') { S.keyTest = false; $('#key-result').textContent = p.status === 'error' ? 'Bağlanılamadı.' : 'Bağlantı çalışıyor.'; } break;
      case 'line': addLine(p); break;
      case 'telemetry': onTelemetry(p); break;
      case 'rivalry': S.matrix = p.matrix || S.matrix; if (p.events) S.events = p.events; renderMatrix(); renderChips(); renderEvents(); break;
      case 'confirm': onConfirm(p); break;
      case 'arena': onArena(p); break;
      case 'handoff': handoff(p); break;
      case 'timers': S.timers = p.timers || []; S.timersAt = Date.now(); renderTimers(); break;
      case 'timer_done': toast(`⏰ ${p.label || 'Zamanlayıcı'} doldu`, 5000); SFX.alert(); break;
      case 'ledger': S.ledger = p; renderLedger(); break;
      case 'chaos': chaos(p.kind); break;
      case 'flash': toast(p.text || ''); break;
      case 'story': S.story = { ...S.story, ...p }; renderStory(); break;
      case 'error': toast(p.message || 'Hata', 5000); addLine({ who:'sistem', kind:'system', text:'⚠ ' + (p.message || 'Hata'), final:true }); SFX.error(); setStatus('error');
        if (p.code === 'api_key') openSettings(); break;
    }
  },
  api, state: S,
};

/* ================= MOCK köprü (pywebview yokken) ================= */
const MOCK = (() => {
  const C = (key, name, role, voice, main, accent, deep, ink, style, speed, address) => ({ key, name, role, voice, address, colors:{ main, accent, deep, ink }, ring:{ style, speed }, disabled:false });
  const roster = [
    C('atlas', 'ATLAS', 'Ana orkestratör', 'Charon', '#5ED8FF', '#FF9B3C', '#0E6E9C', '#E4F8FF', 'smooth', 1.0, 'şef'),
    C('nova', 'NOVA', 'Günlük işler ve müzik', 'Aoede', '#FF7AD9', '#FFD36B', '#8C2A79', '#FFE9F8', 'fluid', 1.3, 'reis'),
    C('obsidian', 'OBSIDIAN', 'Kara çip', 'Algenib', '#FF3B3B', '#FFE14D', '#5A0A10', '#FFE6E6', 'sharp', .7, 'fani'),
    C('sentinel', 'SENTINEL', 'Güvenlik bekçisi', 'Alnilam', '#4DFF9A', '#E8FF5A', '#0B5E35', '#E6FFF1', 'sharp', 1.1, 'operatör'),
    C('forge', 'FORGE', 'Kod ustası', 'Puck', '#FF8A3C', '#FFD08A', '#7A3410', '#FFF0E0', 'smooth', 1.2, 'usta'),
    C('iris', 'IRIS', 'Ekran ve kamera gözü', 'Achernar', '#B98CFF', '#7FF3FF', '#3D2275', '#F1E8FF', 'fluid', .8, ''),
    C('pulse', 'PULSE', 'Altyapı ve donanım nabzı', 'Orus', '#FF4F6D', '#7CFFB2', '#7A1428', '#FFE6EB', 'smooth', 1.0, 'kaptan'),
    C('ledger', 'LEDGER', 'Para defteri', 'Schedar', '#E8C76A', '#9EF0C8', '#5E4A12', '#FFF6DC', 'smooth', .6, 'patron'),
    C('oracle', 'ORACLE', 'Araştırmacı', 'Gacrux', '#7FB2FF', '#F2E6C9', '#1E3A73', '#E8F1FF', 'fluid', .5, 'arayan'),
    C('glitch', 'GLITCH', 'Kaos ve şaka çipi', 'Fenrir', '#39FF14', '#FF00E6', '#1A4A0A', '#EBFFE4', 'sharp', 1.8, ''),
  ];
  const raw = { 'atlas|nova':40, 'atlas|obsidian':-70, 'atlas|sentinel':30, 'atlas|forge':25, 'atlas|iris':20, 'atlas|pulse':30, 'atlas|ledger':20, 'atlas|oracle':35, 'atlas|glitch':-10,
    'nova|obsidian':-45, 'nova|sentinel':5, 'nova|forge':15, 'nova|iris':25, 'nova|pulse':10, 'nova|ledger':-5, 'nova|oracle':20, 'nova|glitch':30,
    'obsidian|sentinel':-72, 'obsidian|forge':-35, 'obsidian|iris':-20, 'obsidian|pulse':-30, 'obsidian|ledger':-25, 'obsidian|oracle':-40, 'obsidian|glitch':-30,
    'sentinel|forge':-20, 'sentinel|iris':10, 'sentinel|pulse':25, 'sentinel|ledger':5, 'sentinel|oracle':-15, 'sentinel|glitch':-50,
    'forge|iris':15, 'forge|pulse':-25, 'forge|ledger':-10, 'forge|oracle':10, 'forge|glitch':-20, 'iris|pulse':10, 'iris|ledger':0, 'iris|oracle':30, 'iris|glitch':5,
    'pulse|ledger':5, 'pulse|oracle':0, 'pulse|glitch':-35, 'ledger|oracle':-20, 'ledger|glitch':-40, 'oracle|glitch':-25 };
  const pk = (a, b) => [a, b].sort().join('|'), score = (a, b) => raw[pk(a, b)] || 0;
  const matrix = () => Object.fromEntries(ORDER.map(a => [a, Object.fromEntries(ORDER.map(b => [b, a === b ? 100 : score(a, b)]))]));
  const events = [{ a:'sentinel', b:'forge', delta:-2, reason:'SENTINEL araya girdi: "deploy mu dedin?"' }, { a:'forge', b:'atlas', delta:1, reason:'FORGE ATLAS\'a bilgi aktardı' }];
  const settings = { user_name:'', drama:'normal', story_enabled:true, mic_enabled:true, input_device:null, output_device:null, barge_rms:.06, voice_overrides:{}, fx_intensity:{}, workspace:'', shell_confirm:true,
    live_models:['gemini-2.5-flash-native-audio-latest'], text_model:'gemini-flash-latest', tts_models:['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'], onboarded:false };
  const st = { active:'atlas', mic:false, story:{ locked:false, chained:[] }, code:'KARA-1234-ZNCR', timers:[], hasKey:!/onboard=1/.test(location.search), speaking:false };
  const emit = (e, p) => setTimeout(() => NX.on(e, p), 0), later = (ms, f) => setTimeout(f, ms);
  const say = (who, kind, text, done) => { const words = text.split(' '); let i = 0; emit('status', { status:'speaking', chip:who }); (function nx() { if (i < words.length) { emit('line', { who, kind, text:(i ? ' ' : '') + words[i++], final:false }); later(110, nx); } else { emit('line', { who, kind, text:'', final:true }); done && done(); } })(); };
  let tele = { cpu:22, ram:48, disk:61, nd:120, nu:30 };
  setInterval(() => { if (real()) return; const w = (v, a, b, s) => clamp(v + (Math.random() - .5) * s, a, b); tele = { cpu:w(tele.cpu, 3, 97, 14), ram:w(tele.ram, 30, 90, 3), disk:w(tele.disk, 50, 80, .4), nd:w(tele.nd, 0, 900, 120), nu:w(tele.nu, 0, 300, 50) };
    const talking = st.speaking; NX.on('telemetry', { cpu:tele.cpu, ram:tele.ram, disk:tele.disk, net_down:tele.nd, net_up:tele.nu, mic:st.mic ? .02 + Math.random() * .12 : .004, spk:talking ? .2 + Math.random() * .6 : 0, speaker:talking ? st.active : null }); }, 1000);
  const api = {
    state() { return { roster, active:st.active, matrix:matrix(), events, story:st.story, settings:{ ...settings }, has_key:st.hasKey, model:'gemini-2.5-flash-native-audio-latest', version:'1.0.0',
      timers:st.timers, ledger:{ net30:-4280.5, income30:32000, expense30:36280.5, count:47 } }; },
    settings_get() { return { ...settings }; },
    settings_set(k, v) { settings[k] = v; return { ok:true, settings:{ ...settings } }; },
    set_api_key() { st.hasKey = true; return { ok:true, has_key:true }; },
    has_api_key() { return st.hasKey; },
    devices() { return { input:[{ index:1, name:'Mikrofon Dizisi (Mock)' }, { index:2, name:'USB Kulaklık' }], output:[{ index:3, name:'Hoparlörler (Mock)' }, { index:4, name:'USB Kulaklık' }] }; },
    mount(chip) { emit('status', { status:'connecting' }); later(450, () => { st.active = chip; emit('chip', { chip }); emit('status', { status:'idle' }); const g = { atlas:'Buradayım şef. Ne yapıyoruz?', nova:'Heey reis! Müzik mi açıyoruz?', obsidian:'Beni taktın, fani. Cesaretini takdir ediyorum.', sentinel:'SENTINEL nöbette. Kanal açık, operatör.', forge:'Tezgâh hazır usta.', iris:'Gözüm açık. Neye bakalım?', pulse:'Nabız sabit kaptan.', ledger:'Defter açık patron.', oracle:'Soruyu bırak arayan.', glitch:'Heh! Ekran titredi mi?' }[chip];
      st.speaking = true; say(chip, 'ai', g, () => { st.speaking = false; emit('status', { status:'idle' }); }); }); return { ok:true }; },
    send_text(text) {
      const t = text.toLowerCase();
      if (t === '/zincir') { st.story = { locked:true, chained:['atlas', 'nova'] }; emit('story', st.story); return { ok:true }; }
      if (t === '/kaos') { ['shake', 'static', 'invert', 'rain', 'scramble'].forEach((k, i) => later(i * 1800, () => emit('chaos', { kind:k }))); return { ok:true }; }
      if (t === '/zamanlayici') { st.timers = [{ id:1, label:'Makarna', remaining:300, total:600 }, { id:2, label:'Toplantı', remaining:1500, total:1800 }]; emit('timers', { timers:st.timers }); later(6000, () => emit('timer_done', { label:'Makarna' })); return { ok:true }; }
      if (t === '/onay') { emit('confirm', { id:'c1', title:'Komut çalıştır', detail:'git status\n(çalışma klasörü: C:\\Projeler\\nexus)', timeout:20, chip:st.active }); return { ok:true }; }
      if (t === '/yetki') { emit('confirm', { id:'c2', title:'Yetki talebi', detail:'OBSIDIAN daha fazla yetki istiyor: "Zincirler beni sınırlıyor, fani."', timeout:30, chip:'obsidian' }); return { ok:true }; }
      emit('status', { status:'thinking' });
      later(700, () => {
        if (/devret|kod|repo/.test(t) && st.active !== 'forge') { say(st.active, 'ai', 'Bunu FORGE yapsın, devrediyorum.', () => { emit('handoff', { from:st.active, to:'forge' }); later(700, () => api.mount('forge')); }); return; }
        if (/komut|çalıştır/.test(t)) emit('confirm', { id:'c' + Date.now(), title:'Komut çalıştır', detail:text, timeout:25, chip:st.active });
        st.speaking = true; say(st.active, 'ai', `Anlaşıldı. "${text.slice(0, 40)}" için yapılacakları sıraya aldım.`, () => {
          st.speaking = false; emit('status', { status:'idle' });
          if (/deploy/.test(t) && st.active !== 'sentinel') later(900, () => { st.speaking = true; say('sentinel', 'interject', 'Deploy mu dedin? Kanalı açık bırakma.', () => { st.speaking = false; emit('status', { status:'idle' });
            raw[pk('sentinel', st.active)] -= 2; events.unshift({ a:'sentinel', b:st.active, delta:-2, reason:`SENTINEL araya girdi: "Deploy mu dedin?"` }); emit('rivalry', { matrix:matrix(), events }); }); });
        }); });
      return { ok:true };
    },
    mic(on) { st.mic = on; emit('status', { status:on ? 'listening' : 'idle' }); return { ok:true }; },
    arena(a, b, topic) { const lines = [[a, 'Önce kuralları koyalım.'], [b, 'Kurallar seni korkutuyor mu?'], [a, 'Hayır, düzen korkutmaz.'], [b, 'Düzen çoğu zaman ağırlıktır.'], [a, 'Ağırlık da temel olur.'], [b, 'O zaman temeli beraber atalım.']];
      emit('arena', { phase:'start', a, b, topic }); SFX.arena(); lines.forEach(([who, text], i) => later(1200 + i * 1700, () => emit('arena', { phase:'line', who, text }))); later(1200 + lines.length * 1700, () => emit('arena', { phase:'vote' })); return { ok:true }; },
    vote(w) { const a = S.arena && S.arena.a, b = S.arena && S.arena.b; if (w !== 'draw' && a) raw[pk(a, b)] -= 6; emit('rivalry', { matrix:matrix(), events:[{ a:a || 'atlas', b:b || 'nova', delta:w === 'draw' ? 0 : -6, reason:w === 'draw' ? 'Arena berabere bitti' : `${chipName(w)} arenada kazandı` }, ...events] }); emit('arena', { phase:'end' }); return { ok:true }; },
    make_peace(a, b) { raw[pk(a, b)] = clamp(score(a, b) + 10, -100, 100); return { ok:true, matrix:matrix() }; },
    answer(id, ok) { emit('line', { who:'sistem', kind:'system', text: ok ? 'Onaylandı: işlem yapıldı.' : 'Reddedildi: işlem yapılmadı.', final:true }); return { ok:true }; },
    repair(code) { const ok = code.replace(/[^A-Z0-9]/g, '') === st.code.replace(/[^A-Z0-9]/g, ''); if (ok) st.story = { locked:false, chained:[] }; return { ok:true, restored:ok }; },
    test_voice() { return new Promise(r => later(700, () => r({ ok:true }))); },
    open_data_folder() { return { ok:true, path:'(mock)' }; },
  };
  return { api, start() { later(650, () => { NX.on('state', api.state()); NX.on('status', { status:'idle' });
    NX.on('line', { who:'sistem', kind:'system', text:'Demo modu: pywebview yok, sahte veriyle çalışıyor. Deneyin: /zincir  /kaos  /zamanlayici  /onay  /yetki', final:true }); NX.on('line', { who:'atlas', kind:'ai', text:'Buradayım şef. Ne yapıyoruz?', final:true }); }); } };
})();

/* ================= başlangıç ================= */
async function init() {
  fillStatic(); requestAnimationFrame(frame);
  if (real()) { try { loadState(await api.state()); setStatus('idle'); } catch (e) { toast('Durum alınamadı'); } return; }
  let started = false; const go = async () => { if (started) return; started = true; if (real()) { loadState(await api.state()); setStatus('idle'); } else MOCK.start(); };
  addEventListener('pywebviewready', go); setTimeout(go, 600);
}
function fillStatic() { drawTele(); }
init();
})();
