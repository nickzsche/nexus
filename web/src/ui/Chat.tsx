import { useEffect, useRef, useState } from 'react';
import { core } from '../core/api';
import { CHIPS } from '../data/chips';
import { useNexus } from '../state/store';
import { sfx } from './sfx';

function MicButton() {
  const on = useNexus((s) => s.micOn);
  const ref = useRef<HTMLButtonElement>(null);
  useEffect(() => useNexus.subscribe((s) => { ref.current?.style.setProperty('--mic', String(Math.min(1, s.telemetry.mic * 3))); }), []);
  return (
    <button ref={ref} type="button" className={`mic${on ? ' on' : ''}`} aria-pressed={on} aria-label={on ? 'Mikrofonu kapat (Ctrl+Boşluk)' : 'Mikrofonu aç (Ctrl+Boşluk)'}
      title="Ctrl+Boşluk" onClick={() => { sfx.click(); void core().setMic(!on); }}>
      {on ? <span className="wave" aria-hidden="true"><i /><i /><i /><i /><i /></span>
        : <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3a3 3 0 0 0-3 3v6a3 3 0 0 0 6 0V6a3 3 0 0 0-3-3zM6 11a6 6 0 0 0 12 0M12 17v4" /></svg>}
    </button>
  );
}

export function Chat() {
  const lines = useNexus((s) => s.lines);
  const status = useNexus((s) => s.status);
  const listen = useNexus((s) => s.settings.listenMode);
  const box = useRef<HTMLDivElement>(null);
  const [text, setText] = useState('');
  useEffect(() => { const b = box.current; if (b && b.scrollHeight - b.scrollTop - b.clientHeight < 140) b.scrollTop = b.scrollHeight; }, [lines]);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    sfx.click();
    core().sendText(t);
    setText('');
    requestAnimationFrame(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; });
  };

  return (
    <div className="chat">
      <div className="log" ref={box} role="log" aria-live="polite" aria-label="Konuşma dökümü">
        {lines.length === 0 && <p className="empty center">Bir şey söyle ya da yaz. Ctrl+Boşluk ile mikrofonu açabilirsin.</p>}
        {lines.slice(-40).map((l) => {
          if (l.kind === 'system') return <div key={l.id} className="line sys">{l.text}</div>;
          const user = l.kind === 'user';
          const c = l.who !== 'user' && l.who !== 'system' ? CHIPS[l.who] : null;
          return (
            <div key={l.id} className={`line ${l.kind}${l.final ? '' : ' live'}`} style={c ? ({ '--c': c.colors.main } as React.CSSProperties) : undefined}>
              <span className="who">{user ? 'SEN' : c?.name}{l.kind === 'interject' && <em> ⚡ ARAYA GİRDİ</em>}</span>
              <span className="txt">{l.text}</span>
            </div>
          );
        })}
      </div>
      <form className="composer" onSubmit={submit}>
        <MicButton />
        <input value={text} onChange={(e) => setText(e.target.value)} placeholder={status === 'listening' ? 'Dinliyorum… ya da yaz' : 'Çipe bir şey söyle ya da yaz…'} aria-label="Mesaj" autoComplete="off" />
        <button type="submit" className="send">GÖNDER</button>
        {listen === 'ptt' && <span className="ptt-hint">Boşluk tuşunu basılı tut: konuş</span>}
      </form>
    </div>
  );
}
