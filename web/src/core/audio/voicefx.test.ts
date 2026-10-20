import { describe, expect, it } from 'vitest';
import { asCtx, FakeAudioContext, type FakeNode } from './fake-audio';
import { buildChain, FX_PROFILES, radioIntro } from './voicefx';
import type { FxProfile } from '../../types';

const profiles = FX_PROFILES.filter((p) => p !== 'none');

describe('voicefx', () => {
  it('11 profil tanımlı (10 efekt + none)', () => {
    expect(FX_PROFILES.sort()).toEqual(['ether', 'bright', 'cathedral', 'dry', 'glitch', 'hall', 'none', 'obsidian', 'pulse', 'radio', 'workshop'].sort());
  });

  it.each(profiles)('%s: zincir kurulur, giriş/çıkış var, dispose kaynakları durdurur', (p) => {
    const ctx = new FakeAudioContext({ sampleRate: 24000 });
    const ch = buildChain(asCtx(ctx), p as FxProfile, 1);
    expect(ch.input).toBeDefined();
    expect(ch.output).toBeDefined();
    const started = ctx.allStarted.length;
    expect(ctx.nodes.length).toBeGreaterThan(2);
    ch.dispose();
    const sources = ctx.nodes.filter((n) => n.kind === 'oscillator' || n.kind === 'source');
    expect(sources.every((n) => n.stopped)).toBe(true);
    expect(sources.length).toBe(started);
    expect(ctx.nodes.every((n) => n.disconnected)).toBe(true);
  });

  it('kuru/ıslak oranı: k=1 → kuru 0, ıslak 1; k=0.5 → 0.5/0.5; k=0 → doğrudan geçiş; k>1.5 kırpılır', () => {
    const dryOf = (k: number) => {
      const ctx = new FakeAudioContext({ sampleRate: 24000 });
      const ch = buildChain(asCtx(ctx), 'hall', k);
      const input = ch.input as unknown as FakeNode;
      return { ctx, input, out: ch.output as unknown as FakeNode };
    };
    let r = dryOf(1);
    expect((r.input.connections[0] as FakeNode).gain.value).toBeCloseTo(0);
    r = dryOf(0.5);
    expect((r.input.connections[0] as FakeNode).gain.value).toBeCloseTo(0.5);
    r = dryOf(0);
    expect(r.input.connections).toEqual([r.out]);                      // etkisiz geçiş
    r = dryOf(9);
    expect((r.input.connections[0] as FakeNode).gain.value).toBeCloseTo(-0.5);   // 1.5'e kırpıldı
  });

  it('none profili geçiş zinciridir', () => {
    const ctx = new FakeAudioContext();
    const ch = buildChain(asCtx(ctx), 'none');
    expect((ch.input as unknown as FakeNode).connections).toEqual([ch.output]);
    expect(ch.intro).toBeNull();
  });

  it('yalnızca telsiz (radio) giriş sesi üretir; squelch + bip', () => {
    const ctx = new FakeAudioContext({ sampleRate: 24000 });
    expect(buildChain(asCtx(ctx), 'radio').intro).not.toBeNull();
    expect(buildChain(asCtx(ctx), 'hall').intro).toBeNull();
    const intro = radioIntro(asCtx(ctx)) as unknown as { length: number; getChannelData(c: number): Float32Array };
    const d = intro.getChannelData(0);
    expect(intro.length).toBeCloseTo(0.23 * 24000, -2);
    expect(Math.max(...d.map(Math.abs))).toBeLessThanOrEqual(0.31);    // taşma yok
    expect(Math.max(...d.slice(intro.length - 20).map(Math.abs))).toBeLessThan(0.005);   // bip pencerelenmiş: sonu sıfıra iner, tık yok
  });

  it('reverb profili aynı bağlamda impulsu önbellekler', () => {
    const ctx = new FakeAudioContext({ sampleRate: 24000 });
    buildChain(asCtx(ctx), 'hall');
    const n1 = ctx.count('convolver');
    const b1 = ctx.nodes.find((n) => n.kind === 'convolver')!.buffer;
    buildChain(asCtx(ctx), 'hall');
    const conv = ctx.nodes.filter((n) => n.kind === 'convolver');
    expect(conv.length).toBe(n1 * 2);
    expect(conv[conv.length - 1].buffer).toBe(b1);
  });
});
