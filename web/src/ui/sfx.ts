/** WebAudio ile sentezlenmiş arayüz sesleri (dosya yok). settings.sfx kapalıysa sessiz. */
import { useNexus } from '../state/store';

let ctx: AudioContext | null = null;
let lastHover = 0;

const ac = (): AudioContext | null => {
  // Tarayıcı, kullanıcı etkileşimi olmadan ses bağlamı açmaya izin vermez: önce etkileşim bekle.
  if (!ctx && typeof navigator !== 'undefined' && navigator.userActivation && !navigator.userActivation.hasBeenActive) return null;
  try {
    ctx = ctx ?? new (window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext)();
    if (ctx.state === 'suspended') void ctx.resume();
    return ctx;
  } catch { return null; }
};

function tone(f: number, d = 0.06, type: OscillatorType = 'sine', vol = 0.03, slide = 0, delay = 0): void {
  if (!useNexus.getState().settings.sfx) return;
  const c = ac();
  if (!c) return;
  const o = c.createOscillator();
  const g = c.createGain();
  const t = c.currentTime + delay;
  o.type = type;
  o.frequency.setValueAtTime(f, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + d);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + d);
  o.connect(g).connect(c.destination);
  o.start(t);
  o.stop(t + d + 0.02);
}

export const sfx = {
  click: () => tone(720, 0.05, 'square', 0.02),
  hover: () => { const n = performance.now(); if (n - lastHover > 90) { lastHover = n; tone(1500, 0.025, 'sine', 0.012); } },
  confirm: () => { tone(660, 0.08, 'sine', 0.04); tone(990, 0.12, 'sine', 0.04, 0, 0.08); },
  error: () => tone(170, 0.25, 'sawtooth', 0.04, 90),
  mount: () => tone(260, 0.28, 'triangle', 0.04, 920),
  arena: () => { tone(110, 0.6, 'sine', 0.06); tone(165, 0.6, 'sine', 0.04, 0, 0.05); },
  alert: () => { tone(880, 0.1, 'square', 0.03); tone(660, 0.14, 'square', 0.03, 0, 0.12); },
  boot: () => { tone(330, 0.12, 'sine', 0.035); tone(495, 0.12, 'sine', 0.035, 0, 0.1); tone(660, 0.22, 'sine', 0.035, 0, 0.2); },
};
