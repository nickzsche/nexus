import { beforeEach, describe, expect, it, vi } from 'vitest';
import { FakeAudioContext, type FakeNode } from './fake-audio';
import { Player } from './player';

const pcm = (ms: number) => new Uint8Array((24000 * ms) / 1000 * 2);

beforeEach(() => {
  FakeAudioContext.instances = [];
  (globalThis as any).AudioContext = FakeAudioContext;
});

const ctxOf = () => FakeAudioContext.instances[0];

describe('Player', () => {
  it('ensure AudioContext\'i 24 kHz oluşturur ve sürdürür', async () => {
    const p = new Player();
    await p.ensure();
    expect(ctxOf().sampleRate).toBe(24000);
    expect(ctxOf().state).toBe('running');
  });

  it('ardışık parçalar boşluksuz zamanlanır', async () => {
    const p = new Player();
    await p.ensure();
    p.startTurn('atlas');
    p.playPcm(pcm(100));
    p.playPcm(pcm(100));
    p.playPcm(pcm(50));
    const src = ctxOf().allStarted.filter((n) => n.kind === 'source');
    expect(src).toHaveLength(3);
    expect(src[1].startedAt!).toBeCloseTo(src[0].startedAt! + 0.1, 5);
    expect(src[2].startedAt!).toBeCloseTo(src[1].startedAt! + 0.1, 5);
    expect(p.busy).toBe(true);
  });

  it('kesinti: clear her şeyi durdurur, busy false olur, idle çağrılır', async () => {
    const p = new Player();
    await p.ensure();
    const idle = vi.fn();
    p.onIdle(idle);
    p.startTurn('atlas');
    p.playPcm(pcm(200));
    p.clear();
    expect(ctxOf().allStarted.filter((n) => n.kind === 'source').every((n) => n.stopped)).toBe(true);
    expect(p.busy).toBe(false);
    expect(idle).toHaveBeenCalledTimes(1);
    expect(p.level).toBe(0);
  });

  it('parçalar bitince idle bir kez çağrılır; onIdle aboneliği iptal edilebilir', async () => {
    const p = new Player();
    await p.ensure();
    const idle = vi.fn();
    const off = p.onIdle(idle);
    p.playPcm(pcm(50));
    p.playPcm(pcm(50));
    const src = ctxOf().allStarted.filter((n) => n.kind === 'source');
    src[0].onended!();
    expect(idle).not.toHaveBeenCalled();
    src[1].onended!();
    expect(idle).toHaveBeenCalledTimes(1);
    off();
    p.playPcm(pcm(10));
    ctxOf().allStarted.filter((n) => n.kind === 'source').at(-1)!.onended!();
    expect(idle).toHaveBeenCalledTimes(1);
  });

  it('telsiz (SENTINEL) turu giriş sesiyle başlar, diğerleri başlamaz', async () => {
    const p = new Player();
    await p.ensure();
    p.startTurn('atlas');
    expect(ctxOf().allStarted.filter((n) => n.kind === 'source')).toHaveLength(0);
    p.startTurn('sentinel');
    expect(ctxOf().allStarted.filter((n) => n.kind === 'source')).toHaveLength(1);
  });

  it('her tur yeni FX zinciri kurar ve eskisini söker', async () => {
    const p = new Player();
    await p.ensure();
    p.startTurn('atlas');
    const nodes = ctxOf().nodes.slice();
    const osc = (): FakeNode[] => ctxOf().nodes.filter((n) => n.kind === 'oscillator' && !n.stopped);
    p.startTurn('pulse');            // pulse: tremolo osilatörü
    p.startTurn('atlas');            // pulse zinciri sökülmeli
    expect(osc()).toHaveLength(0);
    expect(ctxOf().nodes.length).toBeGreaterThan(nodes.length);
  });

  it('playOnce çalıp bitince çözülür ve zinciri söker', async () => {
    const p = new Player();
    const done = p.playOnce('forge', pcm(100));
    await Promise.resolve(); await Promise.resolve();
    const src = ctxOf().allStarted.filter((n) => n.kind === 'source').at(-1)!;
    expect(p.busy).toBe(true);
    src.onended!();
    await done;
    expect(p.busy).toBe(false);
  });

  it('çok kısa (1 bayt) veri yok sayılır', async () => {
    const p = new Player();
    await p.ensure();
    p.playPcm(new Uint8Array(1));
    expect(p.busy).toBe(false);
  });
});
