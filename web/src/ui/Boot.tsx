import { useEffect, useState } from 'react';
import { sfx } from './sfx';

const LINES = ['çekirdek halka ........ hazır', 'çip konstelasyonu ..... 10/10', 'ilişki matrisi ........ yüklendi', 'ses hattı ............. bekleniyor', 'beyin ................. bağlanıyor'];

/** Açılış sekansı (~2.5 sn): altıgen çizilir, günlük satırları akar, perde kalkar. Tıkla ya da Esc ile atlanır. */
export function Boot({ onDone }: { onDone: () => void }) {
  const [n, setN] = useState(0);
  const [out, setOut] = useState(false);
  useEffect(() => {
    sfx.boot();
    const iv = setInterval(() => setN((x) => Math.min(LINES.length, x + 1)), 330);
    const t1 = setTimeout(() => setOut(true), 2300);
    const t2 = setTimeout(onDone, 2900);
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') onDone(); };
    addEventListener('keydown', esc);
    return () => { clearInterval(iv); clearTimeout(t1); clearTimeout(t2); removeEventListener('keydown', esc); };
  }, [onDone]);
  return (
    <div className={`boot${out ? ' out' : ''}`} onClick={onDone} role="presentation">
      <svg viewBox="0 0 120 120" aria-hidden="true">
        <path className="b-hex" d="M60 8l44 26v52L60 112 16 86V34z" />
        <circle className="b-ring" cx="60" cy="60" r="20" />
        <circle className="b-dot" cx="60" cy="60" r="5" />
      </svg>
      <div className="b-name">NEXUS</div>
      <pre className="b-log">{LINES.slice(0, n).join('\n')}</pre>
      <small>geçmek için tıkla</small>
    </div>
  );
}
