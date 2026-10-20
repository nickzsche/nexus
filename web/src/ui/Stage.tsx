/**
 * SAHNE: ortada reaktör halkası, çevresinde yörüngede 10 çip düğümü (aralarında ilişki çizgileri), parçacıklar,
 * şok dalgaları, devir ışık izi, araya girme darbeleri ve arena arkı. Tek canvas, tek rAF döngüsü;
 * React yalnızca erişilebilir düğme katmanını ve yazıları çizer, hareketler DOM'a doğrudan yazılır.
 */
import { memo, useEffect, useRef } from 'react';
import { core } from '../core/api';
import { CHIPS } from '../data/chips';
import { useNexus } from '../state/store';
import type { ChipKey } from '../types';
import { CHIP_KEYS } from '../types';
import { scoreLabel, signed } from './hooks';
import { sfx } from './sfx';

type RGB = [number, number, number];
const hex = (h: string): RGB => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16)) as RGB;
const rgba = (c: RGB, a: number) => `rgba(${c[0] | 0},${c[1] | 0},${c[2] | 0},${Math.max(0, Math.min(1, a))})`;
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const lerpC = (a: RGB, b: RGB, t: number): RGB => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
const tri = (x: number) => (2 / Math.PI) * Math.asin(Math.sin(x));
const ease = (t: number) => (t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2);
const GRAY: RGB = [120, 132, 146];

const SHELLS: { k: number; w: number; sp: number }[][] = [
  [{ k: 3, w: 0.6, sp: 1 }, { k: 7, w: 0.4, sp: -1.2 }],
  [{ k: 4, w: 0.5, sp: 0.8 }, { k: 6, w: 0.5, sp: -1 }],
  [{ k: 5, w: 0.6, sp: 1.1 }, { k: 8, w: 0.4, sp: -0.7 }],
  [{ k: 2, w: 0.5, sp: 0.6 }, { k: 9, w: 0.5, sp: -1.3 }],
];
const SHELL_R = [1.0, 1.14, 1.28, 1.44];
const SHELL_AMP = [0.13, 0.1, 0.08, 0.06];

interface Pt { a: number; r: number; s: number; sp: number; ph: number }

function StageImpl() {
  const wrap = useRef<HTMLDivElement>(null);
  const cv = useRef<HTMLCanvasElement>(null);
  const btns = useRef<Record<string, HTMLButtonElement | null>>({});
  const tip = useRef<HTMLDivElement>(null);
  const hover = useRef<ChipKey | null>(null);
  const nameEl = useRef<HTMLDivElement>(null);
  const roleEl = useRef<HTMLDivElement>(null);
  const stEl = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const canvas = cv.current;
    const box = wrap.current;
    if (!canvas || !box) return;
    const g = canvas.getContext('2d');
    if (!g) return;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let W = 0, H = 0, dpr = 1, raf = 0, last = performance.now(), frames = 0, fpsT = last;

    const fit = () => {
      const r = box.getBoundingClientRect();
      dpr = Math.min(2, devicePixelRatio || 1);
      W = Math.max(200, r.width); H = Math.max(200, r.height);
      canvas.width = Math.round(W * dpr); canvas.height = Math.round(H * dpr);
      canvas.style.width = W + 'px'; canvas.style.height = H + 'px';
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    const ro = new ResizeObserver(fit);
    ro.observe(box);
    fit();

    // --- durum
    const st0 = useNexus.getState();
    let curMain = hex(CHIPS[st0.active].colors.main);
    let curAcc = hex(CHIPS[st0.active].colors.accent);
    let level = 0;
    let lastSwitch = st0.chip.switchedAt;
    let lastHandoff = st0.handoff?.at ?? 0;
    let lastLine = st0.lines.length ? st0.lines[st0.lines.length - 1].id : 0;
    let shock = -1;
    let handoff: { from: ChipKey; to: ChipKey; t0: number } | null = null;
    const pulses: { from: ChipKey; to: ChipKey; t0: number; c: RGB }[] = [];
    const nodes = Object.fromEntries(CHIP_KEYS.map((k, i) => [k, { x: 0, y: 0, s: 1, al: 1, ang: (i / 10) * Math.PI * 2 - Math.PI / 2 }])) as Record<ChipKey, { x: number; y: number; s: number; al: number; ang: number }>;
    const parts: Pt[] = Array.from({ length: 110 }, () => ({ a: Math.random() * 6.283, r: Math.random(), s: 0.6 + Math.random() * 1.8, sp: (Math.random() - 0.5) * 0.25, ph: Math.random() * 6.283 }));
    const cracks = Object.fromEntries(CHIP_KEYS.map((k, i) => [k, [0, 1, 2].map((j) => ({ a: (i * 1.7 + j * 2.1) % 6.283, l: 0.5 + ((i + j) % 3) * 0.2 }))]));

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      frames++;
      if (now - fpsT >= 1000) { useNexus.getState().patchTelemetry({ fps: Math.round((frames * 1000) / (now - fpsT)) }); frames = 0; fpsT = now; }
      const t = now / 1000;
      const S = useNexus.getState();
      const chip = CHIPS[S.active];
      const style = chip.ring.style;
      const speed = chip.ring.speed * (reduced ? 0.3 : 1);

      // renk morph (600 ms'e yakın)
      const kk = 1 - Math.exp(-dt / 0.2);
      curMain = lerpC(curMain, hex(chip.colors.main), kk);
      curAcc = lerpC(curAcc, hex(chip.colors.accent), kk);

      // olay tetikleyicileri
      if (S.chip.switchedAt !== lastSwitch) { lastSwitch = S.chip.switchedAt; shock = t; }
      if (S.handoff && S.handoff.at !== lastHandoff) { lastHandoff = S.handoff.at; handoff = { from: S.handoff.from, to: S.handoff.to, t0: t }; }
      const ln = S.lines.length ? S.lines[S.lines.length - 1] : null;
      if (ln && ln.id > lastLine) {
        lastLine = ln.id;
        if (ln.kind === 'interject' && ln.who !== 'user' && ln.who !== 'system') pulses.push({ from: ln.who, to: S.active, t0: t, c: hex(CHIPS[ln.who].colors.main) });
      }

      // ses seviyesi
      const T = S.telemetry;
      const target = S.status === 'speaking' ? Math.max(T.spk, 0.3) : S.status === 'listening' ? T.mic * 0.9 + 0.07
        : S.status === 'thinking' ? 0.32 + 0.12 * Math.sin(t * 6) : 0.05 + 0.02 * Math.sin(t * 1.4);
      level += (target - level) * (1 - Math.exp(-dt * 9));
      const amp = reduced ? 0.1 : level;

      // yerleşim
      const cx = W / 2, cy = H / 2;
      const Ro = Math.max(60, Math.min(W / 2 - 52, H / 2 - 46));
      const R = Ro * 0.45;
      const arena = S.arena.phase !== 'idle' && S.arena.a && S.arena.b ? S.arena : null;

      g.clearRect(0, 0, W, H);

      // --- parçacıklar
      const thinking = S.status === 'thinking';
      for (const p of parts) {
        p.a += (thinking ? 1.6 : p.sp) * dt * (reduced ? 0 : 1);
        const rr = thinking ? lerp(Ro * (0.35 + p.r * 0.7), R * 1.7, 0.4 + 0.3 * Math.sin(t * 2 + p.ph)) : Ro * (0.3 + p.r * 0.85) * (1 + 0.03 * Math.sin(t * 0.6 + p.ph));
        const x = cx + Math.cos(p.a) * rr, y = cy + Math.sin(p.a) * rr;
        g.fillStyle = rgba(curMain, (thinking ? 0.55 : 0.22) * (0.5 + 0.5 * Math.sin(t * 1.3 + p.ph)) + 0.05);
        g.beginPath(); g.arc(x, y, p.s * (thinking ? 1.3 : 1), 0, 6.283); g.fill();
      }

      // --- yörünge halkası
      g.lineWidth = 1;
      g.strokeStyle = rgba(curMain, 0.1);
      g.beginPath(); g.arc(cx, cy, Ro, 0, 6.283); g.stroke();
      g.save(); g.translate(cx, cy); g.rotate(t * 0.02 * speed);
      g.strokeStyle = rgba(curMain, 0.16); g.setLineDash([2, 12]);
      g.beginPath(); g.arc(0, 0, Ro * 1.045, 0, 6.283); g.stroke(); g.setLineDash([]);
      g.restore();

      // --- düğüm konumları
      const rot = t * 0.012 * (reduced ? 0 : 1);
      let hp = 0;
      if (handoff) { hp = Math.min(1, (t - handoff.t0) / 1.1); if (hp >= 1) handoff = null; }
      for (const k of CHIP_KEYS) {
        const n = nodes[k];
        let tx = cx + Math.cos(n.ang + rot) * Ro, ty = cy + Math.sin(n.ang + rot) * Ro;
        let ts = k === S.active ? 1.75 : 1, ta = 1;
        if (arena) {
          if (k === arena.a) { tx = cx - Ro * 0.92; ty = cy; ts = 2.1; }
          else if (k === arena.b) { tx = cx + Ro * 0.92; ty = cy; ts = 2.1; }
          else ta = 0.25;
        }
        if (handoff && hp < 1) { if (k === handoff.from) ts *= 1 - 0.35 * ease(hp); if (k === handoff.to) ts *= 1 + 0.45 * ease(hp); }
        const sp = 1 - Math.exp(-dt * 6);
        n.x = lerp(n.x || tx, tx, sp); n.y = lerp(n.y || ty, ty, sp); n.s = lerp(n.s, ts, sp); n.al = lerp(n.al, ta, sp);
      }

      // --- ilişki çizgileri
      const chained = new Set(S.story.chained);
      for (let i = 0; i < 10; i++) for (let j = i + 1; j < 10; j++) {
        const a = CHIP_KEYS[i], b = CHIP_KEYS[j];
        const sc = S.matrix[a][b];
        const involves = a === S.active || b === S.active;
        if (Math.abs(sc) < 40 && !involves) continue;
        const al = (involves ? 0.12 + Math.abs(sc) / 160 : Math.abs(sc) / 420) * Math.min(nodes[a].al, nodes[b].al);
        const col: RGB = sc < 0 ? [255, 78, 94] : [77, 255, 154];
        g.strokeStyle = rgba(col, al); g.lineWidth = 0.6 + Math.abs(sc) / 60;
        g.beginPath(); g.moveTo(nodes[a].x, nodes[a].y);
        g.quadraticCurveTo(cx + (nodes[a].x + nodes[b].x - 2 * cx) * 0.25, cy + (nodes[a].y + nodes[b].y - 2 * cy) * 0.25, nodes[b].x, nodes[b].y); g.stroke();
      }
      // zincir çizgileri
      g.setLineDash([5, 6]);
      for (const k of chained) { g.strokeStyle = rgba(GRAY, 0.4); g.lineWidth = 1.4; g.beginPath(); g.moveTo(nodes[k].x, nodes[k].y); g.lineTo(cx, cy); g.stroke(); }
      g.setLineDash([]);

      // --- reaktör: çentikler, yaylar
      g.save(); g.translate(cx, cy);
      g.rotate(t * 0.05 * speed);
      g.beginPath();
      for (let i = 0; i < 120; i++) { const a = (i / 120) * 6.283, long = i % 5 === 0, r1 = R * 1.62, r2 = r1 + R * (long ? 0.1 : 0.045); g.moveTo(Math.cos(a) * r1, Math.sin(a) * r1); g.lineTo(Math.cos(a) * r2, Math.sin(a) * r2); }
      g.strokeStyle = rgba(curMain, 0.35); g.lineWidth = 1.2; g.stroke();
      g.restore();
      const arcs = thinking ? [[2.4, 0.9], [-3.1, 0.7], [1.7, 1.1]] : [[0.25 * speed, 0.7], [-0.4 * speed, 0.5], [0.15 * speed, 0.9]];
      arcs.forEach(([w, len], i) => {
        const r = R * (1.72 + i * 0.07), a0 = t * w + i * 2;
        g.strokeStyle = rgba(i === 1 ? curAcc : curMain, thinking ? 0.9 : 0.5); g.lineWidth = i === 0 ? 2.4 : 1.4;
        g.beginPath(); g.arc(cx, cy, r, a0, a0 + len); g.stroke();
      });

      // --- kabuklar (dalga)
      g.save();
      g.shadowColor = rgba(curMain, 0.9); g.shadowBlur = 14 + level * 26;
      const sharp = style === 'sharp', fluid = style === 'fluid';
      for (let s = 0; s < 4; s++) {
        g.beginPath();
        const N = 150;
        for (let i = 0; i <= N; i++) {
          const a = (i / N) * 6.283;
          let n = 0;
          for (const h of SHELLS[s]) {
            const x = a * (fluid ? Math.max(2, h.k - 1) : sharp ? h.k + 3 : h.k) + t * h.sp * speed;
            n += h.w * (sharp ? tri(x) : fluid ? Math.sin(x) + 0.35 * Math.sin(x * 1.7 + 1) : Math.sin(x));
          }
          const r = R * SHELL_R[s] + n * R * SHELL_AMP[s] * (fluid ? 1.5 : sharp ? 1.15 : 1) * (0.28 + amp * 2.6);
          const px = cx + Math.cos(a) * r, py = cy + Math.sin(a) * r;
          if (i) g.lineTo(px, py); else g.moveTo(px, py);
        }
        g.closePath();
        g.strokeStyle = rgba(curMain, 0.95 - s * 0.2); g.lineWidth = s ? 1.3 : 2.4;
        g.lineJoin = sharp ? 'miter' : 'round';
        g.stroke();
      }
      g.restore();
      // kalp
      const hg = g.createRadialGradient(cx, cy, 0, cx, cy, R * 0.95);
      hg.addColorStop(0, rgba(curMain, 0.4 * (0.55 + level * 1.4))); hg.addColorStop(1, rgba(curMain, 0));
      g.fillStyle = hg; g.beginPath(); g.arc(cx, cy, R * 0.95, 0, 6.283); g.fill();
      if (S.status === 'speaking') {
        g.strokeStyle = rgba(curAcc, 0.35 * level * 2); g.lineWidth = 2;
        g.beginPath(); g.arc(cx, cy, R * (1.78 + level * 0.5 + 0.03 * Math.sin(t * 18)), 0, 6.283); g.stroke();
      }

      // --- şok dalgası
      if (shock >= 0) {
        const p = (t - shock) / 0.95;
        if (p >= 1) shock = -1;
        else {
          g.strokeStyle = rgba(curMain, (1 - p) * 0.9); g.lineWidth = 3 * (1 - p) + 1;
          g.beginPath(); g.arc(cx, cy, lerp(R, Ro * 1.25, ease(p)), 0, 6.283); g.stroke();
          g.strokeStyle = rgba(curAcc, (1 - p) * 0.5); g.lineWidth = 1.5;
          g.beginPath(); g.arc(cx, cy, lerp(R * 0.8, Ro * 1.1, ease(Math.min(1, p * 1.2))), 0, 6.283); g.stroke();
        }
      }

      // --- araya girme darbeleri
      for (let i = pulses.length - 1; i >= 0; i--) {
        const p = pulses[i], u = (t - p.t0) / 0.9;
        if (u >= 1) { pulses.splice(i, 1); continue; }
        const a = nodes[p.from], b = nodes[p.to], e = ease(u);
        const x = lerp(a.x, b.x, e), y = lerp(a.y, b.y, e);
        const grd = g.createRadialGradient(x, y, 0, x, y, 22);
        grd.addColorStop(0, rgba(p.c, 0.95)); grd.addColorStop(1, rgba(p.c, 0));
        g.fillStyle = grd; g.beginPath(); g.arc(x, y, 22, 0, 6.283); g.fill();
        g.strokeStyle = rgba(p.c, 0.5 * (1 - u)); g.lineWidth = 2;
        g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(x, y); g.stroke();
      }

      // --- devir ışık izi
      if (handoff) {
        const a = nodes[handoff.from], b = nodes[handoff.to];
        for (let i = 0; i < 14; i++) {
          const u = Math.max(0, ease(hp) - i * 0.022);
          const mx = cx, my = cy;
          const x = (1 - u) * (1 - u) * a.x + 2 * (1 - u) * u * mx + u * u * b.x;
          const y = (1 - u) * (1 - u) * a.y + 2 * (1 - u) * u * my + u * u * b.y;
          g.fillStyle = rgba(lerpC(hex(CHIPS[handoff.from].colors.main), hex(CHIPS[handoff.to].colors.main), u), (1 - i / 14) * 0.95);
          g.beginPath(); g.arc(x, y, 7 - i * 0.4, 0, 6.283); g.fill();
        }
      }

      // --- arena arkı
      if (arena && arena.a && arena.b) {
        const a = nodes[arena.a], b = nodes[arena.b];
        const ca = hex(CHIPS[arena.a].colors.main), cb = hex(CHIPS[arena.b].colors.main);
        for (let pass = 0; pass < 2; pass++) {
          g.beginPath(); g.moveTo(a.x, a.y);
          const N = 26, nx = -(b.y - a.y), ny = b.x - a.x, len = Math.hypot(nx, ny) || 1;
          for (let i = 1; i < N; i++) {
            const u = i / N, env = Math.sin(u * Math.PI) * (arena.speaking ? 22 : 9);
            const j = (Math.random() - 0.5) * env;
            g.lineTo(lerp(a.x, b.x, u) + (nx / len) * j, lerp(a.y, b.y, u) + (ny / len) * j);
          }
          g.lineTo(b.x, b.y);
          const lg = g.createLinearGradient(a.x, a.y, b.x, b.y);
          lg.addColorStop(0, rgba(ca, pass ? 0.9 : 0.25)); lg.addColorStop(1, rgba(cb, pass ? 0.9 : 0.25));
          g.strokeStyle = lg; g.lineWidth = pass ? 1.4 : 5; g.stroke();
        }
      }

      // --- düğümler
      for (const k of CHIP_KEYS) {
        const n = nodes[k], c = hex(CHIPS[k].colors.main);
        const isChained = chained.has(k);
        const col = isChained ? GRAY : c;
        const speaking = T.speaker === k || arena?.speaking === k;
        const pulse = speaking ? 1 + 0.18 * Math.sin(t * 14) : 1;
        const r = 9 * n.s * pulse;
        g.globalAlpha = n.al;
        const gl = g.createRadialGradient(n.x, n.y, 0, n.x, n.y, r * 3.2);
        gl.addColorStop(0, rgba(col, k === S.active || speaking ? 0.5 : 0.2)); gl.addColorStop(1, rgba(col, 0));
        g.fillStyle = gl; g.beginPath(); g.arc(n.x, n.y, r * 3.2, 0, 6.283); g.fill();
        g.fillStyle = rgba(lerpC(col, [3, 7, 11], 0.7), 0.95);
        g.beginPath(); g.arc(n.x, n.y, r, 0, 6.283); g.fill();
        g.strokeStyle = rgba(col, k === S.active ? 1 : 0.8); g.lineWidth = k === S.active ? 2.6 : 1.6;
        if (isChained) g.setLineDash([4, 5]);
        g.beginPath(); g.arc(n.x, n.y, r, 0, 6.283); g.stroke(); g.setLineDash([]);
        if (isChained) {
          g.strokeStyle = rgba(GRAY, 0.9); g.lineWidth = 1.2;
          for (const cr of cracks[k]) { g.beginPath(); g.moveTo(n.x + Math.cos(cr.a) * r * 0.2, n.y + Math.sin(cr.a) * r * 0.2); g.lineTo(n.x + Math.cos(cr.a + 0.3) * r * (0.6 + cr.l * 0.5), n.y + Math.sin(cr.a + 0.3) * r * (0.6 + cr.l * 0.5)); g.stroke(); }
        } else {
          g.fillStyle = rgba(col, 0.95); g.beginPath(); g.arc(n.x, n.y, r * 0.28, 0, 6.283); g.fill();
        }
        // etiket
        g.font = `600 ${k === S.active || arena ? 12 : 10.5}px Rajdhani, sans-serif`;
        g.textAlign = 'center'; g.fillStyle = rgba(isChained ? GRAY : lerpC(c, [255, 255, 255], 0.45), k === S.active ? 1 : 0.82);
        g.fillText(CHIPS[k].name, n.x, n.y + r + 14);
        g.globalAlpha = 1;
        // erişilebilir düğme konumu
        const b = btns.current[k];
        if (b) b.style.transform = `translate(${n.x - 24}px, ${n.y - 24}px)`;
      }
      // ipucu konumu
      const hk = hover.current;
      if (hk && tip.current) tip.current.style.transform = `translate(${nodes[hk].x}px, ${nodes[hk].y - 44}px) translate(-50%,-100%)`;
    };
    raf = requestAnimationFrame(frame);

    // durum yazıları (React yeniden çizimi olmadan)
    const unsub = useNexus.subscribe((s, p) => {
      if (s.active !== p.active) { if (nameEl.current) nameEl.current.textContent = CHIPS[s.active].name; if (roleEl.current) roleEl.current.textContent = CHIPS[s.active].role; }
      if (s.status !== p.status && stEl.current) stEl.current.textContent = STATUS_TEXT[s.status];
    });
    return () => { cancelAnimationFrame(raf); ro.disconnect(); unsub(); };
  }, []);

  const showTip = (k: ChipKey) => {
    const S = useNexus.getState();
    hover.current = k;
    sfx.hover();
    if (tip.current) {
      const sc = k === S.active ? null : S.matrix[S.active][k];
      tip.current.textContent = sc == null ? `${CHIPS[k].name} · ${CHIPS[k].role}` : `${CHIPS[S.active].name} ↔ ${CHIPS[k].name}  ${signed(sc)}  ${scoreLabel(sc)}`;
      tip.current.style.opacity = '1';
    }
  };
  const hideTip = () => { hover.current = null; if (tip.current) tip.current.style.opacity = '0'; };
  const active = useNexus.getState().active;
  const status = useNexus.getState().status;

  return (
    <div className="stage" ref={wrap}>
      <canvas ref={cv} aria-hidden="true" />
      <div className="core-text" aria-live="polite">
        <div className="core-name" ref={nameEl}>{CHIPS[active].name}</div>
        <div className="core-role" ref={roleEl}>{CHIPS[active].role}</div>
        <div className="core-state" ref={stEl}>{STATUS_TEXT[status]}</div>
      </div>
      <div className="nodes" role="group" aria-label="Çipler">
        {CHIP_KEYS.map((k, i) => (
          <button key={k} className="node-btn" ref={(el) => { btns.current[k] = el; }} data-chip={k}
            aria-label={`${CHIPS[k].name}, ${CHIPS[k].role}. Ctrl+${(i + 1) % 10}`}
            onClick={() => { sfx.mount(); void core().mount(k); }}
            onMouseEnter={() => showTip(k)} onMouseLeave={hideTip} onFocus={() => showTip(k)} onBlur={hideTip} />
        ))}
        <div className="node-tip" ref={tip} role="tooltip" />
      </div>
    </div>
  );
}

export const STATUS_TEXT: Record<string, string> = {
  off: 'kapalı', connecting: 'bağlanıyor', idle: 'hazır', listening: 'dinliyor', thinking: 'düşünüyor', speaking: 'konuşuyor', error: 'hata',
};

export const Stage = memo(StageImpl);
