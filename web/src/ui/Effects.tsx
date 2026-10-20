import { useEffect, useRef, useState } from 'react';
import { CHIPS } from '../data/chips';
import { useNexus } from '../state/store';
import { sfx } from './sfx';

const GLYPHS = 'ABCDEFGHJKLMNPRSTUVYZ0123456789#%&@<>/\\|';
const pick = () => GLYPHS[Math.floor(Math.random() * GLYPHS.length)];

/** Çip değişince büyük ad "belirir" (karışık harflerden çözülür) + ekran titremesi. */
export function SwitchOverlay() {
  const at = useNexus((s) => s.chip.switchedAt);
  const active = useNexus((s) => s.active);
  const [shown, setShown] = useState<{ text: string; key: number } | null>(null);
  const first = useRef(true);
  useEffect(() => {
    if (first.current) { first.current = false; return; }
    if (!at) return;
    const name = CHIPS[active].name;
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    document.getElementById('app')?.classList.add('glitch');
    setTimeout(() => document.getElementById('app')?.classList.remove('glitch'), reduced ? 0 : 420);
    sfx.mount();
    let i = 0;
    setShown({ text: reduced ? name : name.split('').map(pick).join(''), key: at });
    const iv = setInterval(() => {
      i++;
      setShown({ text: name.split('').map((ch, j) => (j < i ? ch : pick())).join(''), key: at });
      if (i > name.length) { clearInterval(iv); setTimeout(() => setShown(null), 650); }
    }, reduced ? 10 : 70);
    return () => clearInterval(iv);
  }, [at, active]);
  if (!shown) return null;
  return <div className="switch-overlay" aria-hidden="true"><b>{shown.text}</b></div>;
}

/** Kaos efektleri: shake, static, invert, rain, scramble. */
export function Chaos() {
  const chaos = useNexus((s) => s.chaos);
  const cv = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    if (!chaos) return;
    const app = document.getElementById('app');
    const kind = chaos.kind;
    if (kind === 'shake') { app?.classList.add('chaos-shake'); const t = setTimeout(() => app?.classList.remove('chaos-shake'), 650); return () => { clearTimeout(t); app?.classList.remove('chaos-shake'); }; }
    if (kind === 'invert') { app?.classList.add('chaos-invert'); const t = setTimeout(() => app?.classList.remove('chaos-invert'), 1250); return () => { clearTimeout(t); app?.classList.remove('chaos-invert'); }; }
    if (kind === 'scramble') {
      const nodes: { n: Text; orig: string; cur: string }[] = [];
      const walker = document.createTreeWalker(app ?? document.body, NodeFilter.SHOW_TEXT);
      let n: Node | null;
      while ((n = walker.nextNode())) { const tx = n as Text; if (tx.nodeValue && tx.nodeValue.trim().length > 1 && !tx.parentElement?.closest('input,textarea,canvas,svg,script,style')) nodes.push({ n: tx, orig: tx.nodeValue, cur: tx.nodeValue }); }
      const mix = (s: string) => s.replace(/[A-Za-zÇĞİÖŞÜçğıöşü0-9]/g, (c) => (Math.random() < 0.55 ? GLYPHS[Math.floor(Math.random() * GLYPHS.length)] : c));
      const iv = setInterval(() => nodes.forEach((o) => { if (o.n.nodeValue === o.cur) { o.cur = mix(o.orig); o.n.nodeValue = o.cur; } }), 70);
      const end = setTimeout(() => { clearInterval(iv); nodes.forEach((o) => { if (o.n.nodeValue === o.cur) o.n.nodeValue = o.orig; }); }, 1000);
      return () => { clearInterval(iv); clearTimeout(end); nodes.forEach((o) => { if (o.n.nodeValue === o.cur) o.n.nodeValue = o.orig; }); };
    }
    const c = cv.current;
    const g = c?.getContext('2d');
    if (!c || !g) return;
    c.width = Math.ceil(innerWidth / 4); c.height = Math.ceil(innerHeight / 4);
    let raf = 0;
    const t0 = performance.now();
    const dur = kind === 'rain' ? 3000 : 1000;
    const cols = Math.ceil(c.width / 5);
    const drops = Array.from({ length: cols }, () => Math.random() * -40);
    const draw = (now: number) => {
      const p = (now - t0) / dur;
      if (p >= 1) { g.clearRect(0, 0, c.width, c.height); return; }
      if (kind === 'static') {
        const im = g.createImageData(c.width, c.height);
        for (let i = 0; i < im.data.length; i += 4) { const v = Math.random() * 255; im.data[i] = im.data[i + 1] = im.data[i + 2] = v; im.data[i + 3] = 110 * (1 - p); }
        g.putImageData(im, 0, 0);
      } else {
        g.fillStyle = 'rgba(3,7,11,.18)'; g.fillRect(0, 0, c.width, c.height);
        g.font = '7px JetBrains Mono, monospace'; g.fillStyle = '#39FF14';
        drops.forEach((y, i) => { g.fillText(pick(), i * 5, y * 7); drops[i] = y > c.height / 7 && Math.random() > 0.96 ? 0 : y + 0.7; });
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => { cancelAnimationFrame(raf); g.clearRect(0, 0, c.width, c.height); };
  }, [chaos]);
  const k = chaos?.kind;
  return <canvas ref={cv} className={`chaos-canvas${k === 'static' || k === 'rain' ? ' on' : ''}`} aria-hidden="true" />;
}

export function Toasts() {
  const toasts = useNexus((s) => s.toasts);
  return (
    <div className="toasts" role="status" aria-live="polite">
      {toasts.map((t) => <div key={t.id} className={`toast ${t.tone}`}>{t.text}</div>)}
    </div>
  );
}
