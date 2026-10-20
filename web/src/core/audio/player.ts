/** Çalma: 24 kHz PCM'i boşluksuz zamanlar, çipin FX zincirinden geçirir, kesintide anında susturur. */
import { CHIPS } from '../../data/chips';
import type { ChipKey } from '../../types';
import { buildChain, type FxChain } from './voicefx';

const RATE = 24000;
const LEAD = 0.04;                   // ilk parça için küçük ön pay (s)

function toBuffer(ctx: BaseAudioContext, pcm: Uint8Array): AudioBuffer {
  const n = pcm.byteLength >> 1;
  const dv = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
  const buf = ctx.createBuffer(1, Math.max(1, n), RATE);
  const ch = buf.getChannelData(0);
  for (let i = 0; i < n; i++) ch[i] = dv.getInt16(i * 2, true) / 32768;
  return buf;
}

export class Player {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private meter = new Uint8Array(256);
  private chain: FxChain | null = null;
  private sources = new Set<AudioBufferSourceNode>();
  private nextTime = 0;
  private sinkId: string | null = null;
  private idleCbs = new Set<() => void>();
  private wasBusy = false;

  /** Kullanıcı jestiyle çağır: AudioContext'i oluşturur ve sürdürür (otomatik oynatma politikası). */
  async ensure(): Promise<void> {
    const ctx = this.getCtx();
    if (ctx.state === 'suspended') await ctx.resume();
  }

  async setSink(deviceId: string | null): Promise<void> {
    this.sinkId = deviceId;
    const ctx = this.ctx as (AudioContext & { setSinkId?: (id: string) => Promise<void> }) | null;
    if (ctx?.setSinkId) { try { await ctx.setSinkId(deviceId ?? ''); } catch { /* aygıt yok: varsayılana düşer */ } }
  }

  private getCtx(): AudioContext {
    if (this.ctx) return this.ctx;
    const ctx = new AudioContext({ sampleRate: RATE, latencyHint: 'interactive' });
    const master = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    master.connect(analyser);
    analyser.connect(ctx.destination);
    this.ctx = ctx; this.master = master; this.analyser = analyser;
    if (this.sinkId) void this.setSink(this.sinkId);
    return ctx;
  }

  /** Yeni tur: FX zincirini sıfırdan kur; varsa giriş sesini (örn. telsiz squelch) çal. */
  startTurn(chip: ChipKey, intensity = 1): void {
    const ctx = this.getCtx();
    this.chain?.dispose();
    this.chain = buildChain(ctx, CHIPS[chip].fx, intensity);
    this.chain.output.connect(this.master!);
    const intro = this.chain.intro;
    if (intro) {
      const src = ctx.createBufferSource();
      src.buffer = intro;
      src.connect(this.master!);                           // giriş sesi efektten geçmez
      this.schedule(src, intro.duration);
    }
  }

  playPcm(pcm24k: Uint8Array): void {
    if (pcm24k.byteLength < 2) return;
    const ctx = this.getCtx();
    const src = ctx.createBufferSource();
    const buf = toBuffer(ctx, pcm24k);
    src.buffer = buf;
    src.connect(this.chain ? this.chain.input : this.master!);
    this.schedule(src, buf.duration);
  }

  private schedule(src: AudioBufferSourceNode, duration: number): void {
    const ctx = this.ctx!;
    const t = Math.max(this.nextTime, ctx.currentTime + LEAD);
    src.start(t);
    this.nextTime = t + duration;                          // sonraki parça tam bitişte başlar: boşluk yok
    this.sources.add(src);
    this.wasBusy = true;
    src.onended = () => {
      this.sources.delete(src);
      try { src.disconnect(); } catch { /* yok say */ }
      this.checkIdle();
    };
  }

  private checkIdle(): void {
    if (!this.sources.size && this.wasBusy) {
      this.wasBusy = false;
      this.nextTime = 0;
      for (const cb of [...this.idleCbs]) cb();
    }
  }

  /** Kesinti: tüm planlı sesi anında durdur. */
  clear(): void {
    for (const s of [...this.sources]) {
      s.onended = null;
      try { s.stop(); } catch { /* başlamamış olabilir */ }
      try { s.disconnect(); } catch { /* yok say */ }
    }
    this.sources.clear();
    this.nextTime = 0;
    this.checkIdleAfterClear();
  }

  private checkIdleAfterClear(): void {
    if (this.wasBusy) {
      this.wasBusy = false;
      for (const cb of [...this.idleCbs]) cb();
    }
  }

  get busy(): boolean {
    return this.sources.size > 0 || (this.ctx !== null && this.ctx.currentTime < this.nextTime - 0.01);
  }

  /** Çıkış seviyesi 0–1 (AnalyserNode RMS). */
  get level(): number {
    if (!this.analyser || !this.busy) return 0;
    this.analyser.getByteTimeDomainData(this.meter);
    let s = 0;
    for (const v of this.meter) s += (v - 128) ** 2;
    return Math.min(1, Math.sqrt(s / this.meter.length) / 40);
  }

  onIdle(cb: () => void): () => void {
    this.idleCbs.add(cb);
    return () => { this.idleCbs.delete(cb); };
  }

  /** Arena / araya girme: ana kuyruğa karışmadan kendi zinciriyle çalar; bitince çözülür. */
  async playOnce(chip: ChipKey, pcm24k: Uint8Array, intensity = 1): Promise<void> {
    await this.ensure();
    const ctx = this.ctx!;
    const chain = buildChain(ctx, CHIPS[chip].fx, intensity);
    chain.output.connect(this.master!);
    const src = ctx.createBufferSource();
    const buf = toBuffer(ctx, pcm24k);
    src.buffer = buf;
    src.connect(chain.input);
    let introMs = 0;
    const t0 = ctx.currentTime + LEAD;
    if (chain.intro) {
      const i = ctx.createBufferSource();
      i.buffer = chain.intro;
      i.connect(this.master!);
      i.start(t0);
      introMs = chain.intro.duration;
    }
    await new Promise<void>((resolve) => {
      src.onended = () => resolve();
      src.start(t0 + introMs);
      this.sources.add(src);
      this.wasBusy = true;
    });
    this.sources.delete(src);
    try { src.disconnect(); } catch { /* yok say */ }
    chain.dispose();
    this.checkIdle();
  }
}
