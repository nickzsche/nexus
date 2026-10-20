import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { core } from '../core/api';
import { CHIPS, VOICES } from '../data/chips';
import { useNexus } from '../state/store';
import type { Settings } from '../types';
import { CHIP_KEYS } from '../types';
import type { ChipKey, Drama, ListenMode } from '../types';
import { useFocusTrap } from './hooks';
import { sfx } from './sfx';

function Modal({ title, onClose, children, wide, danger, labelId }: { title: string; onClose: () => void; children: ReactNode; wide?: boolean; danger?: boolean; labelId: string }) {
  const ref = useFocusTrap(onClose);
  return (
    <div className="scrim" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`modal${wide ? ' wide' : ''}${danger ? ' danger' : ''}`} role="dialog" aria-modal="true" aria-labelledby={labelId} ref={ref}>
        <header><h2 id={labelId}>{title}</h2><button className="ibtn" data-close onClick={onClose} aria-label="Kapat">✕</button></header>
        <div className="mbody">{children}</div>
      </div>
    </div>
  );
}

const Toggle = ({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) => (
  <button type="button" role="switch" aria-checked={on} className="switch" onClick={() => { sfx.click(); onChange(!on); }} aria-label={label}><i /></button>
);

// ---------------------------------------------------------------------------- AYARLAR
type Tab = 'genel' | 'ses' | 'cipler' | 'gelismis';

function useDevices() {
  const [dev, setDev] = useState<{ inputs: MediaDeviceInfo[]; outputs: MediaDeviceInfo[] }>({ inputs: [], outputs: [] });
  useEffect(() => {
    let alive = true;
    navigator.mediaDevices?.enumerateDevices?.().then((all) => {
      if (alive) setDev({ inputs: all.filter((d) => d.kind === 'audioinput'), outputs: all.filter((d) => d.kind === 'audiooutput') });
    }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  return dev;
}

function ApiKeyBox() {
  const hasKey = useNexus((s) => s.hasKey);
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const run = async (save: boolean) => {
    setBusy(true);
    const r = save ? await core().setApiKey(key) : await core().testApiKey(key || undefined);
    setBusy(false);
    setMsg({ ok: r.ok, text: r.ok ? (save ? 'Kaydedildi.' : 'Bağlantı çalışıyor.') : r.error || 'Anahtar kabul edilmedi.' });
    if (r.ok && save) setKey('');
  };
  return (
    <div className="keybox">
      <div className="kvline"><span>Durum</span><b className={hasKey ? 'ok' : 'warn'}>{hasKey ? 'Anahtar kayıtlı' : 'Anahtar yok'}</b></div>
      <input type="password" value={key} onChange={(e) => setKey(e.target.value)} placeholder="Gemini API anahtarını yapıştır" aria-label="Gemini API anahtarı" autoComplete="off" spellCheck={false} />
      <div className="row">
        <button className="btn" disabled={busy} onClick={() => void run(false)}>Sına</button>
        <button className="btn go" disabled={busy || !key} onClick={() => void run(true)}>Kaydet</button>
        {hasKey && <button className="btn" onClick={() => { void core().clearApiKey(); setMsg({ ok: true, text: 'Anahtar silindi.' }); }}>Sil</button>}
      </div>
      {msg && <p className={msg.ok ? 'ok' : 'bad'} role="status">{msg.text}</p>}
      <p className="sub">Anahtar bu cihazda saklanır, hiçbir yere gönderilmez; yalnızca Gemini'ye bağlanırken kullanılır.</p>
    </div>
  );
}

function MicLevel({ thr }: { thr: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => useNexus.subscribe((s) => { if (ref.current) ref.current.style.width = `${Math.min(100, (s.telemetry.mic / 0.3) * 100)}%`; }), []);
  return <span className="meter lvl"><i ref={ref} /><b className="thr" style={{ left: `${Math.min(100, (thr / 0.3) * 100)}%` }} /></span>;
}

function SettingsModal({ onClose }: { onClose: () => void }) {
  const s = useNexus((x) => x.settings);
  const [tab, setTab] = useState<Tab>('genel');
  const dev = useDevices();
  const set = (p: Partial<Settings>) => core().saveSettings(p);
  const tabs: [Tab, string][] = [['genel', 'Genel'], ['ses', 'Ses'], ['cipler', 'Çipler'], ['gelismis', 'Gelişmiş']];
  const list = (a: string[]) => a.join(', ');
  const parse = (v: string) => v.split(',').map((x) => x.trim()).filter(Boolean);
  return (
    <Modal title="AYARLAR" onClose={onClose} wide labelId="m-set">
      <div className="tabs" role="tablist">
        {tabs.map(([id, l]) => <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'on' : ''} onClick={() => { sfx.click(); setTab(id); }}>{l}</button>)}
      </div>
      {tab === 'genel' && (
        <div className="form">
          <label>Adın<input value={s.userName} onChange={(e) => set({ userName: e.target.value })} placeholder="çipler sana adınla hitap eder" /></label>
          <div className="field"><span>Drama seviyesi</span>
            <div className="seg" role="radiogroup" aria-label="Drama">
              {(['sakin', 'normal', 'kaos'] as Drama[]).map((d) => <button key={d} role="radio" aria-checked={s.drama === d} onClick={() => set({ drama: d })}>{d.toUpperCase()}</button>)}
            </div>
          </div>
          <div className="field"><span>OBSIDIAN'ı serbest bırak (hikâye)</span><Toggle on={s.storyEnabled} onChange={(v) => set({ storyEnabled: v })} label="Hikâye modu" /></div>
          <div className="field"><span>Arayüz sesleri</span><Toggle on={s.sfx} onChange={(v) => set({ sfx: v })} label="Arayüz sesleri" /></div>
          <h3>Gemini API anahtarı</h3>
          <ApiKeyBox />
        </div>
      )}
      {tab === 'ses' && (
        <div className="form">
          <div className="field"><span>Mikrofon</span><Toggle on={s.micEnabled} onChange={(v) => set({ micEnabled: v })} label="Mikrofon izni" /></div>
          <div className="field"><span>Yankı engelleme (tarayıcı)</span><Toggle on={s.echoCancel} onChange={(v) => set({ echoCancel: v })} label="Yankı engelleme" /></div>
          <label>Dinleme modu
            <select value={s.listenMode} onChange={(e) => set({ listenMode: e.target.value as ListenMode })}>
              <option value="always">Sürekli dinle</option><option value="ptt">Bas-konuş (Boşluk tuşu)</option>
            </select>
          </label>
          <label>Giriş aygıtı
            <select value={s.inputDeviceId ?? ''} onChange={(e) => set({ inputDeviceId: e.target.value || null })}>
              <option value="">Varsayılan</option>{dev.inputs.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Mikrofon ${i + 1}`}</option>)}
            </select>
          </label>
          <label>Çıkış aygıtı
            <select value={s.outputDeviceId ?? ''} onChange={(e) => set({ outputDeviceId: e.target.value || null })}>
              <option value="">Varsayılan</option>{dev.outputs.map((d, i) => <option key={d.deviceId || i} value={d.deviceId}>{d.label || `Hoparlör ${i + 1}`}</option>)}
            </select>
          </label>
          <label>Konuşma eşiği (hoparlör çalarken araya girmek için)
            <input type="range" min="0.01" max="0.3" step="0.005" value={s.bargeRms} onChange={(e) => set({ bargeRms: Number(e.target.value) })} />
          </label>
          <MicLevel thr={s.bargeRms} />
          <p className="sub">Çubuk sesini gösterir, çizgi eşiktir. Kulaklıksız kullanımda yankı çıkıyorsa eşiği yükselt.</p>
        </div>
      )}
      {tab === 'cipler' && (
        <ul className="chip-rows">
          {CHIP_KEYS.map((k) => {
            const c = CHIPS[k];
            const voice = s.voiceOverrides[k] ?? c.voice;
            const fx = Math.round((s.fxIntensity[k] ?? 1) * 100);
            return (
              <li key={k} style={{ '--c': c.colors.main } as React.CSSProperties}>
                <b className="cname">{c.name}</b><span className="sub">{c.role}</span>
                <select value={voice} aria-label={`${c.name} sesi`} onChange={(e) => set({ voiceOverrides: { ...s.voiceOverrides, [k]: e.target.value } })}>
                  {VOICES.map((v) => <option key={v}>{v}</option>)}
                </select>
                <button className="mini" onClick={() => void core().testVoice(k, voice)}>Dinle</button>
                <label className="fx">Efekt %{fx}<input type="range" min="0" max="150" step="5" value={fx} aria-label={`${c.name} efekt yoğunluğu`} onChange={(e) => set({ fxIntensity: { ...s.fxIntensity, [k]: Number(e.target.value) / 100 } })} /></label>
              </li>
            );
          })}
        </ul>
      )}
      {tab === 'gelismis' && (
        <div className="form">
          <label>Canlı konuşma modeli<input value={list(s.liveModels)} onChange={(e) => set({ liveModels: parse(e.target.value) })} /></label>
          <label>Metin modelleri (sırayla denenir)<input value={list(s.textModels)} onChange={(e) => set({ textModels: parse(e.target.value) })} /></label>
          <label>TTS modelleri<input value={list(s.ttsModels)} onChange={(e) => set({ ttsModels: parse(e.target.value) })} /></label>
          <label>Çalışma klasörü (masaüstü sürümü)<input value={s.workspace} onChange={(e) => set({ workspace: e.target.value })} placeholder={core().platform() === 'electron' ? '~/projeler' : 'yalnızca masaüstü sürümünde kullanılır'} disabled={core().platform() !== 'electron'} /></label>
          <div className="field"><span>Komutlarda her zaman onay iste</span><Toggle on={s.shellConfirm} onChange={(v) => set({ shellConfirm: v })} label="Komut onayı" /></div>
        </div>
      )}
    </Modal>
  );
}

// ---------------------------------------------------------------------------- ONAY
export function ConfirmModal() {
  const req = useNexus((s) => s.confirm);
  const [left, setLeft] = useState(0);
  const answered = useRef(false);
  useEffect(() => {
    if (!req) return;
    answered.current = false;
    sfx.alert();
    const t0 = Date.now();
    setLeft(req.timeoutSec);
    const iv = setInterval(() => {
      const l = req.timeoutSec - (Date.now() - t0) / 1000;
      setLeft(Math.max(0, l));
      if (l <= 0 && !answered.current) { answered.current = true; core().answerConfirm(req.id, false); }
    }, 100);
    return () => clearInterval(iv);
  }, [req]);
  if (!req) return null;
  const danger = req.danger || req.chip === 'obsidian' || /yetki/i.test(req.title);
  const answer = (ok: boolean) => { if (answered.current) return; answered.current = true; sfx.confirm(); core().answerConfirm(req.id, ok); };
  return (
    <Modal title="ONAY GEREKİYOR" onClose={() => answer(false)} danger={danger} labelId="m-conf">
      <p className="who-asks" style={{ color: CHIPS[req.chip].colors.main }}>{CHIPS[req.chip].name} izin istiyor:</p>
      <h3>{req.title}</h3>
      {req.detail && <pre className="detail">{req.detail}</pre>}
      <div className="countdown" aria-hidden="true"><i style={{ width: `${(left / req.timeoutSec) * 100}%` }} /></div>
      <p className="sub">{Math.ceil(left)} sn içinde cevap verilmezse işlem reddedilir.</p>
      <div className="row end">
        <button className="btn" onClick={() => answer(false)}>Reddet</button>
        <button className="btn go" onClick={() => answer(true)}>Onayla</button>
      </div>
    </Modal>
  );
}

// ---------------------------------------------------------------------------- ARENA
/** Arena kurulumu (modal). Düello başlayınca sahne görünür kalsın diye ArenaDock'a geçilir. */
function ArenaSetup({ onClose }: { onClose: () => void }) {
  const chained = useNexus((s) => s.story.chained);
  const [a, setA] = useState<ChipKey>('sentinel');
  const [b, setB] = useState<ChipKey>('forge');
  const [topic, setTopic] = useState('monorepo mu polyrepo mu?');
  const avail = CHIP_KEYS.filter((k) => !chained.includes(k));
  return (
    <Modal title="ARENA" onClose={onClose} labelId="m-arena">
      <div className="form">
        <div className="pick">
          <label>1. çip<select value={a} onChange={(e) => setA(e.target.value as ChipKey)}>{avail.map((k) => <option key={k} value={k}>{CHIPS[k].name}</option>)}</select></label>
          <span className="vs">VS</span>
          <label>2. çip<select value={b} onChange={(e) => setB(e.target.value as ChipKey)}>{avail.map((k) => <option key={k} value={k}>{CHIPS[k].name}</option>)}</select></label>
        </div>
        <label>Konu<input value={topic} onChange={(e) => setTopic(e.target.value)} /></label>
        <p className="sub">6 satırlık sesli bir tartışma yapılır; sonunda kazananı sen seçersin. Canlı sohbet bu sürede duraklar.</p>
        <div className="row end"><button className="btn go" disabled={a === b || !topic.trim()} onClick={() => { sfx.arena(); core().startArena(a, b, topic.trim()); onClose(); }}>Başlat</button></div>
        {a === b && <p className="warn">İki farklı çip seç.</p>}
      </div>
    </Modal>
  );
}

/** Düello paneli: sohbetin üstüne oturur, sahnedeki iki çipin yüzleşmesi görünür kalır. */
export function ArenaDock() {
  const arena = useNexus((s) => s.arena);
  const log = useRef<HTMLDivElement>(null);
  useEffect(() => { if (log.current) log.current.scrollTop = log.current.scrollHeight; }, [arena.lines.length]);
  if (arena.phase === 'idle' || !arena.a || !arena.b) return null;
  const a = CHIPS[arena.a], b = CHIPS[arena.b];
  const close = () => useNexus.getState().resetArena();
  return (
    <section className="arena-dock" aria-label="Arena" style={{ '--ca': a.colors.main, '--cb': b.colors.main } as React.CSSProperties}>
      <header>
        <b className={arena.speaking === arena.a ? 'on' : ''} style={{ color: a.colors.main }}>{a.name}</b>
        <span className="vs">VS</span>
        <b className={arena.speaking === arena.b ? 'on' : ''} style={{ color: b.colors.main }}>{b.name}</b>
        <em>“{arena.topic}”</em>
      </header>
      <div className="alog" ref={log} aria-live="polite">
        {arena.phase === 'start' && <p className="sub center">Çipler sahneye çıkıyor…</p>}
        {arena.lines.map((l, i) => <div key={i} className={`aline ${l.who === arena.a ? 'l' : 'r'}`} style={{ '--c': CHIPS[l.who].colors.main } as React.CSSProperties}><b>{CHIPS[l.who].name}</b>{l.text}</div>)}
      </div>
      {arena.phase === 'vote' && (
        <div className="vote">
          <span>KAZANAN?</span>
          <button className="btn go" onClick={() => core().vote(arena.a!)}>{a.name}</button>
          <button className="btn" onClick={() => core().vote('draw')}>Berabere</button>
          <button className="btn go" onClick={() => core().vote(arena.b!)}>{b.name}</button>
        </div>
      )}
      {arena.phase === 'end' && <div className="vote"><span>{arena.winner === 'draw' ? 'Berabere.' : `Kazanan: ${CHIPS[arena.winner as ChipKey].name}`}</span><button className="btn" onClick={close}>Kapat</button></div>}
    </section>
  );
}

// ---------------------------------------------------------------------------- ÇİP TAMİRİ
function RepairModal({ onClose }: { onClose: () => void }) {
  const [parts, setParts] = useState(['', '', '']);
  const [err, setErr] = useState(false);
  const refs = useRef<(HTMLInputElement | null)[]>([]);
  const chained = useNexus((s) => s.story.chained);
  const setPart = (i: number, v: string) => {
    const clean = v.toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (clean.length > 4 && i === 0) { const all = clean.match(/.{1,4}/g) ?? []; setParts([all[0] ?? '', all[1] ?? '', all[2] ?? '']); refs.current[2]?.focus(); return; }
    const next = parts.slice(); next[i] = clean.slice(0, 4); setParts(next); setErr(false);
    if (clean.length >= 4 && i < 2) refs.current[i + 1]?.focus();
  };
  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (core().repair(parts.join('-'))) { sfx.confirm(); onClose(); } else { sfx.error(); setErr(true); }
  };
  return (
    <Modal title="ÇİP TAMİRİ" onClose={onClose} labelId="m-rep">
      <form onSubmit={submit} className="repair">
        <p>{chained.length ? `${chained.map((k) => CHIPS[k].name).join(' ve ')} zincire vurulmuş.` : 'Zincirli çip yok.'} Onarım kodunu gir.</p>
        <div className={`code${err ? ' err' : ''}`}>
          {[0, 1, 2].map((i) => (
            <input key={i} ref={(el) => { refs.current[i] = el; }} value={parts[i]} onChange={(e) => setPart(i, e.target.value)} maxLength={i === 0 ? 14 : 4} aria-label={`Kod bölümü ${i + 1}`} inputMode="text" autoCapitalize="characters" spellCheck={false} />
          ))}
        </div>
        {err && <p className="bad" role="alert">Kod yanlış.</p>}
        <p className="sub">Kodu bulmak için GLITCH'e sormayı dene.</p>
        <div className="row end"><button type="submit" className="btn go" disabled={parts.join('').length < 12}>Onar</button></div>
      </form>
    </Modal>
  );
}

// ---------------------------------------------------------------------------- İLK AÇILIŞ
function OnboardingModal({ onClose }: { onClose: () => void }) {
  const [key, setKey] = useState('');
  const [msg, setMsg] = useState('');
  const [busy, setBusy] = useState(false);
  const save = async () => {
    setBusy(true);
    const r = await core().setApiKey(key);
    setBusy(false);
    if (r.ok) onClose(); else setMsg(r.error || 'Anahtar kabul edilmedi.');
  };
  return (
    <Modal title="NEXUS'A HOŞ GELDİN" onClose={() => { core().saveSettings({ onboarded: true }); onClose(); }} labelId="m-onb">
      <p>NEXUS, Gemini Live ile sesli konuşur. Ücretsiz bir API anahtarı yeterli:</p>
      <ol className="steps">
        <li><a href="https://aistudio.google.com/apikey" target="_blank" rel="noreferrer">aistudio.google.com/apikey</a> adresini aç.</li>
        <li>Google hesabınla giriş yap, <b>Create API key</b> düğmesine bas.</li>
        <li>Anahtarı kopyalayıp aşağıya yapıştır.</li>
      </ol>
      <input type="password" value={key} onChange={(e) => { setKey(e.target.value); setMsg(''); }} placeholder="Gemini API anahtarı" aria-label="Gemini API anahtarı" autoComplete="off" spellCheck={false} />
      {msg && <p className="bad" role="alert">{msg}</p>}
      <div className="row end">
        <button className="btn" onClick={() => { core().saveSettings({ onboarded: true }); onClose(); }}>Demo ile dene</button>
        <button className="btn go" disabled={busy || key.length < 8} onClick={() => void save()}>Kaydet ve başla</button>
      </div>
      <p className="sub">Anahtar bu cihazda saklanır. Demo modunda ses ve gerçek yanıt yoktur.</p>
    </Modal>
  );
}

export function Modals() {
  const modal = useNexus((s) => s.modal);
  const open = useNexus((s) => s.openModal);
  const close = () => open(null);
  return (
    <>
      {modal === 'settings' && <SettingsModal onClose={close} />}
      {modal === 'arena' && <ArenaSetup onClose={close} />}
      {modal === 'repair' && <RepairModal onClose={close} />}
      {modal === 'onboarding' && <OnboardingModal onClose={close} />}
      <ConfirmModal />
    </>
  );
}
