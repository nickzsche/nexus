import { describe, expect, it } from 'vitest';
import { MIC_FRAME, MIC_WORKLET } from './worklets';

interface Posted { pcm: ArrayBuffer; rms: number }

function load(rate: number) {
  const posted: Posted[] = [];
  let Cls: any;
  class AudioWorkletProcessor { port = { postMessage: (m: Posted) => { posted.push(m); } }; }
  new Function('AudioWorkletProcessor', 'registerProcessor', 'sampleRate', MIC_WORKLET)(
    AudioWorkletProcessor, (_name: string, c: unknown) => { Cls = c; }, rate);
  return { proc: new Cls(), posted };
}

function feedSine(rate: number, seconds: number, amp = 0.5) {
  const { proc, posted } = load(rate);
  const block = 128, blocks = Math.floor((rate * seconds) / block);
  let n = 0;
  for (let b = 0; b < blocks; b++) {
    const ch = new Float32Array(block);
    for (let i = 0; i < block; i++) ch[i] = amp * Math.sin((2 * Math.PI * 440 * n++) / rate);
    expect(proc.process([[ch]])).toBe(true);
  }
  return posted;
}

describe('nexus-mic worklet', () => {
  it('48 kHz girişi 16 kHz, 20 ms (640 bayt) parçalara indirir', () => {
    const posted = feedSine(48000, 1);
    expect(posted.length).toBeGreaterThanOrEqual(48);
    expect(posted.length).toBeLessThanOrEqual(50);
    for (const p of posted) expect(p.pcm.byteLength).toBe(MIC_FRAME * 2);
    expect(posted[10].rms).toBeCloseTo(0.5 / Math.SQRT2, 1);          // sinüs rms ≈ genlik/√2
  });

  it('16 kHz girişte olduğu gibi geçer', () => {
    expect(feedSine(16000, 1).length).toBeGreaterThanOrEqual(48);
  });

  it('44.1 kHz gibi tam bölünmeyen hızda da kayma olmaz', () => {
    const posted = feedSine(44100, 2);
    expect(Math.abs(posted.length - 100)).toBeLessThanOrEqual(2);
  });

  it('sessiz girişte rms 0, giriş yoksa çökmez', () => {
    const { proc, posted } = load(16000);
    for (let i = 0; i < 20; i++) proc.process([[new Float32Array(128)]]);
    expect(posted.every((p) => p.rms === 0)).toBe(true);
    expect(proc.process([[]])).toBe(true);
    expect(proc.process([])).toBe(true);
  });

  it('aşırı genlik int16 aralığında kırpılır', () => {
    const posted = feedSine(16000, 0.1, 3);
    const a = new Int16Array(posted[0].pcm);
    expect(Math.max(...a)).toBeLessThanOrEqual(32767);
    expect(Math.min(...a)).toBeGreaterThanOrEqual(-32768);
  });
});
