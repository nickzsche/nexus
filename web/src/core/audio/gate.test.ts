import { describe, expect, it } from 'vitest';
import { MicGate, type GateAction } from './gate';

const CH = new Uint8Array(640);                    // 20 ms @ 16 kHz int16

function run(g: MicGate, pattern: number[], busy = false): { audio: number; ends: number } {
  let audio = 0, ends = 0;
  for (const rms of pattern) for (const a of g.feed(CH, rms, busy) as GateAction[]) { if (a.type === 'audio') audio++; else ends++; }
  return { audio, ends };
}
const rep = (v: number, n: number): number[] => Array(n).fill(v);

describe('MicGate', () => {
  it('sessizlik ve tek seferlik tıkırtı hiçbir şey göndermez', () => {
    const g = new MicGate();
    expect(run(g, rep(0.004, 200))).toEqual({ audio: 0, ends: 0 });
    expect(run(g, [0.004, 0.2, 0.004, 0.004, 0.2, 0.004])).toEqual({ audio: 0, ends: 0 });
  });

  it('konuşma preroll ile gider, sessizlikten sonra bir kez end verir', () => {
    const g = new MicGate();
    run(g, rep(0.004, 30));
    const r = run(g, [...rep(0.2, 10), ...rep(0.004, 30)]);
    expect(r.ends).toBe(1);
    expect(r.audio).toBeGreaterThanOrEqual(10 + 12);               // konuşma + 240 ms önden ekleme
    expect(g.speaking).toBe(false);
  });

  it('end ~350 ms sonra gelir (800 ms değil)', () => {
    const g = new MicGate();
    run(g, rep(0.2, 10));
    let n = 0;
    for (;;) { n++; if (g.feed(CH, 0.004).some((a) => a.type === 'end')) break; if (n > 100) throw new Error('end gelmedi'); }
    expect(n).toBeGreaterThanOrEqual(15);
    expect(n).toBeLessThanOrEqual(20);
  });

  it('hoparlör yankısı yok sayılır, yüksek sesli araya girme geçer', () => {
    const g = new MicGate();
    expect(run(g, rep(0.05, 40), true)).toEqual({ audio: 0, ends: 0 });
    expect(run(g, rep(0.6, 10), true).audio).toBeGreaterThan(0);
  });

  it('gürültülü odaya uyum sağlar', () => {
    const g = new MicGate();
    run(g, rep(0.03, 300));
    expect(g.floor).toBeGreaterThan(0.02);
    expect(run(g, rep(0.03, 20))).toEqual({ audio: 0, ends: 0 });
  });

  it('reset durumu sıfırlar; eşik hoparlör çalarken ≥ barge', () => {
    const g = new MicGate();
    run(g, rep(0.2, 10));
    expect(g.speaking).toBe(true);
    g.reset();
    expect(g.speaking).toBe(false);
    expect(g.threshold(true, 0.3)).toBeGreaterThanOrEqual(0.3);
    expect(g.threshold(false, 0.3)).toBeLessThan(0.3);
  });
});
