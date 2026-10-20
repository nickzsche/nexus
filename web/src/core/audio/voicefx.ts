/**
 * Çip ses efektleri: WebAudio düğüm zincirleri (gecikme eklemez, CPU ucuz). Profil tablosu Python voicefx.py ile aynıdır.
 *
 * `buildChain(ctx, profile, intensity)` her tur başında yeniden kurulur. intensity 0–1.5: kuru/ıslak oranı
 * (çıkış = (1−k)·kuru + k·ıslak; k>1'de efekt abartılır).
 */
import type { FxProfile } from '../../types';

export interface FxChain {
  input: AudioNode;
  output: AudioNode;
  dispose(): void;
  intro?: AudioBuffer | null;
}

interface Stage { in: AudioNode; out: AudioNode }
type Ctx = BaseAudioContext;

/** Aşamaları ve durdurulması gereken kaynakları izler. */
class Rig {
  nodes: AudioNode[] = [];
  sources: Array<AudioScheduledSourceNode> = [];
  constructor(public ctx: Ctx) {}
  track<T extends AudioNode>(n: T): T { this.nodes.push(n); return n; }
  gain(v = 1): GainNode { const g = this.track(this.ctx.createGain()); g.gain.value = v; return g; }
  osc(freq: number, type: OscillatorType = 'sine'): OscillatorNode {
    const o = this.ctx.createOscillator();
    o.type = type; o.frequency.value = freq; o.start();
    this.sources.push(o); this.nodes.push(o);
    return o;
  }
  dispose(): void {
    for (const s of this.sources) { try { s.stop(); } catch { /* zaten durdu */ } }
    for (const n of this.nodes) { try { n.disconnect(); } catch { /* yok say */ } }
    this.nodes = []; this.sources = [];
  }
}

const clamp = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));

// ------------------------------------------------------------------ yapı taşları
function biquad(r: Rig, type: BiquadFilterType, freq: number, gainDb = 0, q = 0.707): Stage {
  const f = r.track(r.ctx.createBiquadFilter());
  f.type = type; f.frequency.value = freq; f.gain.value = gainDb; f.Q.value = q;
  return { in: f, out: f };
}

function series(...stages: Stage[]): Stage {
  for (let i = 0; i < stages.length - 1; i++) stages[i].out.connect(stages[i + 1].in);
  return { in: stages[0].in, out: stages[stages.length - 1].out };
}

/** Kuru/ıslak paralel karışım: out = (1−mix)·kuru + mix·ıslak. */
function mixStage(r: Rig, wet: Stage, mix: number, dryScale = 1): Stage {
  const input = r.gain(1), out = r.gain(1);
  const dry = r.gain((1 - mix) * dryScale), w = r.gain(mix);
  input.connect(dry).connect(out);
  input.connect(wet.in);
  wet.out.connect(w).connect(out);
  return { in: input, out };
}

const shelf = (r: Rig, f: number, gain: number): Stage => biquad(r, 'highshelf', f, gain * 18);
const highpass = (r: Rig, f: number): Stage => biquad(r, 'highpass', f);
const bandpass = (r: Rig, lo: number, hi: number): Stage => series(biquad(r, 'highpass', lo), biquad(r, 'lowpass', hi));
const lowpassMix = (r: Rig, f: number, mix: number): Stage => mixStage(r, biquad(r, 'lowpass', f), mix);

function ring(r: Rig, hz: number, mix: number): Stage {
  const g = r.gain(0);                                   // taban 0, osilatör genliği modüle eder
  r.osc(hz).connect(g.gain);
  const boost = r.gain(1.6);
  g.connect(boost);
  return mixStage(r, { in: g, out: boost }, mix);
}

function comb(r: Rig, ms: number, fb: number, mix = 1): Stage {
  const sum = r.gain(1 / (1 + Math.abs(fb)));            // Python'daki normalizasyon
  const d = r.track(r.ctx.createDelay(1));
  d.delayTime.value = ms / 1000;
  const f = r.gain(fb);
  sum.connect(d); d.connect(f); f.connect(sum);
  const st: Stage = { in: sum, out: sum };
  return mix >= 1 ? st : mixStage(r, st, mix);
}

const impulseCache = new WeakMap<Ctx, Map<string, AudioBuffer>>();
function impulse(ctx: Ctx, seconds: number, damp: number): AudioBuffer {
  const key = `${seconds}|${damp}`;
  let m = impulseCache.get(ctx);
  if (!m) { m = new Map(); impulseCache.set(ctx, m); }
  const hit = m.get(key);
  if (hit) return hit;
  const len = Math.max(1, Math.floor(ctx.sampleRate * seconds));
  const buf = ctx.createBuffer(2, len, ctx.sampleRate);
  for (let c = 0; c < 2; c++) {
    const d = buf.getChannelData(c);
    let lp = 0;
    const a = 1 - 0.8 * damp;                             // tek kutuplu sönüm (yüksekleri törpüler)
    for (let i = 0; i < len; i++) {
      lp += a * ((Math.random() * 2 - 1) - lp);
      d[i] = lp * Math.pow(1 - i / len, 3);               // üstel benzeri sönüm
    }
  }
  m.set(key, buf);
  return buf;
}

function reverb(r: Rig, decay: number, damp: number, wet: number): Stage {
  const c = r.track(r.ctx.createConvolver());
  c.buffer = impulse(r.ctx, Math.min(decay * 1.2, 3), damp);
  c.normalize = true;
  return mixReverb(r, c, wet);
}

/** Python: çıkış = x·(1 − 0.5·wet) + y·wet. */
function mixReverb(r: Rig, conv: ConvolverNode, wet: number): Stage {
  const input = r.gain(1), out = r.gain(1);
  const dry = r.gain(1 - wet * 0.5), w = r.gain(wet * 1.4);
  input.connect(dry).connect(out);
  input.connect(conv);
  conv.connect(w).connect(out);
  return { in: input, out };
}

function curveStage(r: Rig, fn: (x: number) => number, mix = 1): Stage {
  const ws = r.track(r.ctx.createWaveShaper());
  const n = 2048, c = new Float32Array(n);
  for (let i = 0; i < n; i++) c[i] = fn((i / (n - 1)) * 2 - 1);
  ws.curve = c;
  ws.oversample = 'none';
  const st: Stage = { in: ws, out: ws };
  return mix >= 1 ? st : mixStage(r, st, mix);
}

const drive = (r: Rig, amount: number, mix = 1): Stage => curveStage(r, (x) => Math.tanh(x * amount) / Math.tanh(amount), mix);

function crush(r: Rig, bits: number, hold = 1): Stage {
  const levels = 2 ** (bits - 1);
  const q = curveStage(r, (x) => Math.round(x * levels) / levels);
  if (hold <= 1) return q;
  return series(q, biquad(r, 'lowpass', ctxRate(r) / (2 * hold) * 0.9));   // örnek tutmanın yüksek kesilmesi
}
const ctxRate = (r: Rig): number => r.ctx.sampleRate;

function tremolo(r: Rig, rate: number, depth: number): Stage {
  const g = r.gain(1 - depth / 2);
  const lfoAmp = r.gain(depth / 2);
  r.osc(rate).connect(lfoAmp).connect(g.gain);
  return { in: g, out: g };
}

function chorus(r: Rig, ms: number, depthMs: number, rate = 0.4, mix = 0.5): Stage {
  const d = r.track(r.ctx.createDelay(0.2));
  d.delayTime.value = ms / 1000;
  const lfo = r.gain(depthMs / 1000);
  r.osc(rate).connect(lfo).connect(d.delayTime);
  return mixStage(r, { in: d, out: d }, mix);
}

/** Rastgele kısa bloklarda sesi kısan kapı (kekeleme hissi). Kontrol sinyali döngülü tampon: CPU'ya yük bindirmez. */
function stutter(r: Rig, p: number, ms: number): Stage {
  const rate = r.ctx.sampleRate;
  const block = Math.max(8, Math.floor((ms / 1000) * rate));
  const blocks = 48;
  const buf = r.ctx.createBuffer(1, block * blocks, rate);
  const d = buf.getChannelData(0);
  let seed = 7;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let b = 0; b < blocks; b++) {
    const dip = rnd() < p;
    const v = dip ? 0.12 : 1;
    for (let i = 0; i < block; i++) d[b * block + i] = v;
  }
  const src = r.ctx.createBufferSource();
  src.buffer = buf; src.loop = true; src.start();
  r.sources.push(src); r.nodes.push(src);
  const g = r.gain(0);                                    // taban 0; kapı eğrisi parametreyi sürer
  src.connect(g.gain);
  return { in: g, out: g };
}

// ------------------------------------------------------------------ profiller
const PROFILES: Record<FxProfile, (r: Rig) => Stage[]> = {
  hall:      (r) => [reverb(r, 0.8, 0.45, 0.12)],
  bright:    (r) => [shelf(r, 3500, 0.35), reverb(r, 0.5, 0.3, 0.06)],
  obsidian:  (r) => [lowpassMix(r, 5200, 0.6), ring(r, 55, 0.6), comb(r, 9, 0.48), reverb(r, 1.3, 0.55, 0.14)],
  radio:     (r) => [bandpass(r, 320, 3300), drive(r, 2.2), crush(r, 10, 2)],
  workshop:  (r) => [drive(r, 1.8, 0.3), comb(r, 22, 0.25, 0.5)],
  ether:     (r) => [chorus(r, 14, 4), reverb(r, 1.4, 0.6, 0.22), shelf(r, 5000, 0.25)],
  pulse:     (r) => [tremolo(r, 1.2, 0.22), highpass(r, 120)],
  dry:       (r) => [drive(r, 1.2, 0.25)],
  cathedral: (r) => [chorus(r, 22, 2), reverb(r, 2.2, 0.72, 0.3)],
  glitch:    (r) => [stutter(r, 0.14, 70), crush(r, 8), ring(r, 110, 0.5)],
  none:      () => [],
};

export const FX_PROFILES = Object.keys(PROFILES) as FxProfile[];

/** Telsiz: kısa squelch gürültüsü + 1750 Hz bip. */
export function radioIntro(ctx: Ctx): AudioBuffer {
  const rate = ctx.sampleRate;
  const noiseN = Math.floor(0.12 * rate), gapN = Math.floor(0.02 * rate), beepN = Math.floor(0.09 * rate);
  const buf = ctx.createBuffer(1, noiseN + gapN + beepN, rate);
  const d = buf.getChannelData(0);
  let seed = 3;
  const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);
  for (let i = 0; i < noiseN; i++) d[i] = (rnd() * 2 - 1) * 0.14 * (1 - i / noiseN);
  for (let i = 0; i < beepN; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (beepN - 1));      // Hann penceresi
    d[noiseN + gapN + i] = Math.sin((2 * Math.PI * 1750 * i) / rate) * 0.3 * w;
  }
  return buf;
}

export function buildChain(ctx: BaseAudioContext, profile: FxProfile, intensity = 1): FxChain {
  const rig = new Rig(ctx);
  const stages = (PROFILES[profile] ?? PROFILES.none)(rig);
  const k = clamp(intensity, 0, 1.5);
  const input = rig.gain(1);
  const output = rig.gain(1);
  if (!stages.length || k === 0) {
    input.connect(output);                                // etkisiz geçiş
  } else {
    const chain = series(...stages);
    const dry = rig.gain(1 - k), wet = rig.gain(k);       // out = x + (y − x)·k
    input.connect(dry).connect(output);
    input.connect(chain.in);
    chain.out.connect(wet).connect(output);
  }
  return {
    input, output,
    intro: profile === 'radio' ? radioIntro(ctx) : null,
    dispose: () => rig.dispose(),
  };
}
