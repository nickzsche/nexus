import { useState } from 'react';
import type { ReactNode } from 'react';
import { core } from '../core/api';
import { CHIPS } from '../data/chips';
import { useNexus } from '../state/store';
import { CHIP_KEYS } from '../types';
import type { ChipKey } from '../types';
import { fmtDur, scoreLabel, signed } from './hooks';
import { sfx } from './sfx';

export function Panel({ title, right, children, className = '' }: { title: string; right?: ReactNode; children: ReactNode; className?: string }) {
  return (
    <section className={`panel ${className}`}>
      <header><h2>{title}</h2>{right}</header>
      <div className="pbody">{children}</div>
    </section>
  );
}

const money = (n: number) => (n < 0 ? '−' : n > 0 ? '+' : '') + Math.abs(Math.round(n)).toLocaleString('tr-TR') + ' ₺';

function Spark({ data, max, height = 34, warn = 2500, bad = 4000 }: { data: number[]; max?: number; height?: number; warn?: number; bad?: number }) {
  if (data.length < 2) return <div className="spark-empty">ölçüm bekleniyor</div>;
  const m = max ?? Math.max(...data, 1);
  const w = 160;
  const pts = data.map((v, i) => `${(i / (data.length - 1)) * w},${height - 2 - Math.min(1, v / m) * (height - 4)}`).join(' ');
  const last = data[data.length - 1];
  const col = last >= bad ? 'var(--bad)' : last >= warn ? 'var(--warn)' : 'var(--main)';
  return (
    <svg className="spark" viewBox={`0 0 ${w} ${height}`} preserveAspectRatio="none" aria-hidden="true">
      <polyline points={`0,${height} ${pts} ${w},${height}`} fill={col} opacity=".13" stroke="none" />
      <polyline points={pts} fill="none" stroke={col} strokeWidth="1.6" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function Gauge({ v, label }: { v: number; label: string }) {
  const r = 22, c = 2 * Math.PI * r * 0.75, p = Math.max(0, Math.min(100, v)) / 100;
  return (
    <div className="gauge" title={`${label} %${Math.round(v)}`}>
      <svg viewBox="0 0 60 60" aria-hidden="true">
        <circle cx="30" cy="30" r={r} className="g-bg" strokeDasharray={`${c} 999`} transform="rotate(135 30 30)" />
        <circle cx="30" cy="30" r={r} className={v > 85 ? 'g-fg hot' : 'g-fg'} strokeDasharray={`${c * p} 999`} transform="rotate(135 30 30)" />
      </svg>
      <b>{Math.round(v)}%</b><span>{label}</span>
    </div>
  );
}

export function Telemetry() {
  const t = useNexus((s) => s.telemetry);
  const lat = t.latencyMs;
  const tone = lat == null ? '' : lat >= 4000 ? 'bad' : lat >= 2500 ? 'warn' : 'ok';
  const desktop = t.cpu != null;
  return (
    <Panel title="TELEMETRİ" right={<span className="tag">{desktop ? 'masaüstü' : 'web'}</span>}>
      <div className="lat">
        <div><small>Gecikme · söz bitti → ilk ses</small><div className={`big ${tone}`}>{lat == null ? '—' : lat}<i>ms</i></div></div>
        <Spark data={t.latencyHistory} max={Math.max(4000, ...t.latencyHistory)} />
      </div>
      <div className="bars">
        <label>Mikrofon<span className="meter"><i style={{ width: `${Math.min(100, t.mic * 300)}%` }} /></span></label>
        <label>Hoparlör<span className="meter spk"><i style={{ width: `${Math.min(100, t.spk * 100)}%` }} /></span></label>
      </div>
      <dl className="kv">
        <div><dt>Oturum</dt><dd>{fmtDur(t.sessionSec)}</dd></div>
        <div><dt>Tur</dt><dd>{t.turns}</dd></div>
        <div><dt>Araç</dt><dd>{t.toolCalls}</dd></div>
        <div><dt>Yeniden bağlanma</dt><dd className={t.reconnects ? 'warn' : ''}>{t.reconnects}</dd></div>
        <div><dt>FPS</dt><dd className={t.fps && t.fps < 40 ? 'warn' : ''}>{t.fps || '—'}</dd></div>
        <div><dt>Ağ RTT</dt><dd>{t.rtt == null ? '—' : `${t.rtt} ms`}</dd></div>
        <div><dt>Pil</dt><dd>{t.battery ? `%${Math.round(t.battery.level * 100)}${t.battery.charging ? ' ⚡' : ''}` : '—'}</dd></div>
      </dl>
      {desktop && (
        <div className="gauges">
          <Gauge v={t.cpu ?? 0} label="CPU" /><Gauge v={t.ram ?? 0} label="RAM" /><Gauge v={t.disk ?? 0} label="Disk" />
          <div className="net">↓ {Math.round(t.netDown ?? 0)} kB/s · ↑ {Math.round(t.netUp ?? 0)} kB/s</div>
        </div>
      )}
    </Panel>
  );
}

export function Timers() {
  const timers = useNexus((s) => s.timers);
  return (
    <Panel title="ZAMANLAYICILAR">
      {timers.length === 0 ? <p className="empty">Çalışan zamanlayıcı yok.</p> : (
        <ul className="timers">
          {timers.map((tm) => {
            const p = tm.total ? tm.remaining / tm.total : 0;
            const c = 2 * Math.PI * 15;
            return (
              <li key={tm.id}>
                <svg viewBox="0 0 38 38" aria-hidden="true"><circle cx="19" cy="19" r="15" className="t-bg" /><circle cx="19" cy="19" r="15" className="t-fg" strokeDasharray={`${c * p} ${c}`} transform="rotate(-90 19 19)" /></svg>
                <span>{tm.label}</span><b>{fmtDur(tm.remaining)}</b>
              </li>
            );
          })}
        </ul>
      )}
    </Panel>
  );
}

export function Ledger() {
  const l = useNexus((s) => s.ledger);
  const tot = Math.max(1, l.income30 + l.expense30);
  return (
    <Panel title="LEDGER · 30 GÜN">
      <div className={`big ${l.net30 < 0 ? 'bad' : 'ok'}`}>{money(l.net30)}</div>
      <div className="split" aria-hidden="true"><i style={{ width: `${(l.income30 / tot) * 100}%` }} /></div>
      <p className="sub">Gelir {Math.round(l.income30).toLocaleString('tr-TR')} ₺ · Gider {Math.round(l.expense30).toLocaleString('tr-TR')} ₺ · {l.count} kayıt</p>
    </Panel>
  );
}

const ABBR: Record<ChipKey, string> = { atlas: 'ATL', nova: 'NOV', obsidian: 'OBS', sentinel: 'SEN', forge: 'FRG', iris: 'IRS', pulse: 'PLS', ledger: 'LDG', oracle: 'ORC', glitch: 'GLT' };

export function Matrix() {
  const m = useNexus((s) => s.matrix);
  const active = useNexus((s) => s.active);
  const [sel, setSel] = useState<{ a: ChipKey; b: ChipKey } | null>(null);
  const [hov, setHov] = useState<{ a: ChipKey; b: ChipKey } | null>(null);
  const cur = hov ?? sel;
  const sc = cur ? m[cur.a][cur.b] : null;
  return (
    <Panel title="İLİŞKİ MATRİSİ">
      <div className="matrix" role="grid" aria-label="Çipler arası ilişki puanları">
        <div className="mrow head"><span />{CHIP_KEYS.map((k) => <span key={k} style={{ color: CHIPS[k].colors.main }}>{ABBR[k]}</span>)}</div>
        {CHIP_KEYS.map((a) => (
          <div className="mrow" key={a} role="row">
            <span className="mlab" style={{ color: CHIPS[a].colors.main }}>{ABBR[a]}</span>
            {CHIP_KEYS.map((b) => {
              const s = m[a][b];
              const same = a === b;
              const bg = same ? 'rgba(255,255,255,.03)' : s < 0 ? `rgba(255,78,94,${0.08 + (-s / 100) * 0.75})` : `rgba(77,255,154,${0.06 + (s / 100) * 0.6})`;
              const hl = a === active || b === active;
              return (
                <button key={b} className={`mcell${hl ? ' hl' : ''}${sel && sel.a === a && sel.b === b ? ' sel' : ''}`} style={{ background: bg }} disabled={same}
                  aria-label={`${CHIPS[a].name} ile ${CHIPS[b].name}: ${signed(s)} ${scoreLabel(s)}`} role="gridcell"
                  onMouseEnter={() => setHov({ a, b })} onMouseLeave={() => setHov(null)} onFocus={() => setHov({ a, b })} onBlur={() => setHov(null)}
                  onClick={() => { sfx.click(); setSel({ a, b }); }} />
              );
            })}
          </div>
        ))}
      </div>
      <div className="mcap" aria-live="polite">
        {cur && sc != null ? <><b>{CHIPS[cur.a].name} ↔ {CHIPS[cur.b].name}</b> <span className={sc < 0 ? 'bad' : 'ok'}>{signed(sc)}</span> {scoreLabel(sc)}</> : 'Bir hücreye gel ya da tıkla.'}
        {sel && sc != null && <button className="mini" onClick={() => { sfx.confirm(); core().makePeace(sel.a, sel.b); }}>Barıştır +10</button>}
      </div>
    </Panel>
  );
}

export function Events() {
  const ev = useNexus((s) => s.events);
  return (
    <Panel title="SON OLAYLAR">
      {ev.length === 0 ? <p className="empty">Henüz olay yok.</p> : (
        <ul className="events">
          {ev.slice(0, 6).map((e, i) => (
            <li key={`${e.ts}-${i}`}><b className={e.delta < 0 ? 'bad' : 'ok'}>{signed(e.delta)}</b><span>{e.reason}</span></li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export function LinkStatus() {
  const status = useNexus((s) => s.status);
  const model = useNexus((s) => s.model);
  const hasKey = useNexus((s) => s.hasKey);
  const story = useNexus((s) => s.story);
  const dot = status === 'off' || status === 'error' ? 'err' : status === 'connecting' ? 'wait' : 'on';
  return (
    <Panel title="BAĞLANTI">
      <div className="link-row"><span className={`dot ${dot}`} /><span>{status === 'error' ? 'bağlantı hatası' : status === 'connecting' ? 'bağlanıyor…' : status === 'off' ? 'kapalı' : 'canlı oturum açık'}</span></div>
      <div className="kvline"><span>Model</span><b>{model || '—'}</b></div>
      <div className="kvline"><span>API anahtarı</span><b className={hasKey ? 'ok' : 'warn'}>{hasKey ? 'tanımlı' : 'yok'}</b></div>
      {story.enabled && <div className="kvline"><span>Hikâye</span><b className={story.locked ? 'bad' : ''}>{story.locked ? 'ZİNCİRLİ' : `%${Math.round(story.progress * 100)}`}</b></div>}
    </Panel>
  );
}

export function ArenaButton() {
  const open = useNexus((s) => s.openModal);
  const phase = useNexus((s) => s.arena.phase);
  return <button className="arena-btn" onClick={() => { sfx.arena(); open('arena'); }}>{phase === 'idle' || phase === 'end' ? '⚔  ARENA' : '⚔  ARENA SÜRÜYOR'}</button>;
}
