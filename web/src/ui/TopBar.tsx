import { core } from '../core/api';
import { useNexus } from '../state/store';
import type { Drama } from '../types';
import { useClock } from './hooks';
import { sfx } from './sfx';

const DRAMAS: { v: Drama; l: string }[] = [{ v: 'sakin', l: 'SAKİN' }, { v: 'normal', l: 'NORMAL' }, { v: 'kaos', l: 'KAOS' }];

export function TopBar() {
  const status = useNexus((s) => s.status);
  const model = useNexus((s) => s.model);
  const drama = useNexus((s) => s.settings.drama);
  const locked = useNexus((s) => s.story.locked);
  const open = useNexus((s) => s.openModal);
  const clock = useClock();
  const dot = status === 'off' || status === 'error' ? 'err' : status === 'connecting' ? 'wait' : 'on';
  return (
    <header className="top">
      <div className="brand">
        <svg viewBox="0 0 32 32" aria-hidden="true"><path d="M16 3l11 6.5v13L16 29 5 22.5v-13z" /><circle cx="16" cy="16" r="4.5" /><circle cx="16" cy="16" r="1.6" className="fill" /></svg>
        <b>NEXUS</b>
      </div>
      <span className={`dot ${dot}`} title={status} />
      <span className="model" title="Konuşma modeli">{model || 'bağlanıyor…'}</span>
      <div className="spacer" />
      <div className="seg" role="radiogroup" aria-label="Drama seviyesi">
        {DRAMAS.map((d) => (
          <button key={d.v} role="radio" aria-checked={drama === d.v} onClick={() => { sfx.click(); core().saveSettings({ drama: d.v }); }}>{d.l}</button>
        ))}
      </div>
      {locked && (
        <button className="ibtn broken" onClick={() => { sfx.alert(); open('repair'); }} aria-label="Çip Tamiri: zincirli çipler var" title="Çip Tamiri">
          <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3h10l4 4v10l-4 4H7l-4-4V7zM10 8l2 3-2 2 3 3" /></svg>
        </button>
      )}
      <span className="clock">{clock}</span>
      <button className="ibtn" onClick={() => { sfx.click(); open('settings'); }} aria-label="Ayarlar" title="Ayarlar">
        <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3" /><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.9 4.9l2.1 2.1M17 17l2.1 2.1M4.9 19.1L7 17M17 7l2.1-2.1" /></svg>
      </button>
    </header>
  );
}
