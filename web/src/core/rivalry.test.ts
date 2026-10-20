import { beforeEach, describe, expect, it } from 'vitest';
import { CHIPS } from '../data/chips';
import { CHIP_KEYS } from '../types';
import * as rivalry from './rivalry';
import { saveSettings } from './settingsStore';
import { resetAll } from './testUtils';

const seeded = (seed: number) => () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296);
const all = [...CHIP_KEYS];

beforeEach(resetAll);

describe('rivalry', () => {
  it('etiketler eşiklere göre', () => {
    expect([-100, -70, -69, -40, -39, -15, -14, 14, 15, 49, 50].map(rivalry.label)).toEqual(
      ['ezeli düşman', 'ezeli düşman', 'düşman', 'düşman', 'gergin', 'gergin', 'nötr', 'nötr', 'iyi', 'iyi', 'kardeş']);
  });

  it('başlangıç puanları Python tablosuyla aynı', () => {
    expect(rivalry.score('atlas', 'obsidian')).toBe(-70);
    expect(rivalry.score('obsidian', 'atlas')).toBe(-70);          // sıra önemsiz
    expect(rivalry.score('sentinel', 'forge')).toBe(-20);
    expect(rivalry.score('atlas', 'atlas')).toBe(100);
    expect(rivalry.label(rivalry.score('atlas', 'obsidian'))).toBe('ezeli düşman');
  });

  it('matris 10×10 ve simetrik', () => {
    const m = rivalry.matrix();
    for (const a of all) for (const b of all) expect(m[a][b]).toBe(m[b][a]);
    expect(Object.keys(m)).toHaveLength(10);
  });

  it('bump −100…+100 ile sınırlı, olay kaydeder, depoya yansıtır', async () => {
    expect(rivalry.bump('atlas', 'nova', +500, 'x')).toBe(100);
    expect(rivalry.bump('atlas', 'nova', -500, 'y')).toBe(-100);
    expect(rivalry.events(2).map((e) => e.reason)).toEqual(['y', 'x']);       // en yeni önce
    const { useNexus } = await import('../state/store');
    expect(useNexus.getState().matrix.atlas.nova).toBe(-100);
  });

  it('kalıcı: localStorage içinde durur ve olay sayısı sınırlı', () => {
    rivalry.bump('forge', 'iris', -9, 'kalıcı');
    const saved = JSON.parse(localStorage.getItem('nexus.rivalry')!);
    expect(saved.scores['forge|iris']).toBe(6);
    for (let i = 0; i < 80; i++) rivalry.bump('forge', 'iris', 0, `e${i}`);
    expect(JSON.parse(localStorage.getItem('nexus.rivalry')!).events.length).toBeLessThanOrEqual(60);
  });

  it('win −6, makePeace +10, combo ≥60', () => {
    const before = rivalry.score('forge', 'sentinel');
    rivalry.win('forge', 'sentinel');
    expect(rivalry.score('forge', 'sentinel')).toBe(before - 6);
    const b2 = rivalry.score('atlas', 'obsidian');
    rivalry.makePeace('atlas', 'obsidian');
    expect(rivalry.score('atlas', 'obsidian')).toBe(b2 + 10);
    expect(rivalry.combo('atlas', 'nova')).toBe(false);
    rivalry.bump('atlas', 'nova', 20, 'dost');
    expect(rivalry.combo('atlas', 'nova')).toBe(true);
  });

  it('sakin seviyede hiç araya girilmez', () => {
    saveSettings({ drama: 'sakin' });
    for (let i = 0; i < 300; i++) {
      expect(rivalry.pickInterjector('forge', 'deploy ettim', all, { rng: seeded(i), now: i * 1e7 })).toBeNull();
    }
  });

  it('kaosta yalnızca düşmanlar seçilir, dostlar asla', () => {
    saveSettings({ drama: 'kaos' });
    const enemies = new Set(all.filter((k) => k !== 'forge' && rivalry.score('forge', k) <= -15));
    const seen = new Set<string>();
    for (let i = 0; i < 400; i++) {
      const p = rivalry.pickInterjector('forge', 'deploy ettim', all, { rng: seeded(i + 1), now: (i + 1) * 1e7 });
      if (p) { expect(enemies.has(p)).toBe(true); seen.add(p); }
    }
    expect(seen.size).toBeGreaterThan(1);
    expect(enemies.has('sentinel')).toBe(true);
    expect(rivalry.score('forge', 'atlas')).toBeGreaterThan(-15);              // dost
  });

  it('konu adayın alanına değince ağırlık artar (sentinel "deploy")', () => {
    saveSettings({ drama: 'kaos' });
    let withTopic = 0, without = 0;
    for (let i = 0; i < 600; i++) {
      if (rivalry.pickInterjector('forge', 'deploy güvenlik', all, { rng: seeded(i + 9), now: (i + 1) * 1e7 }) === 'sentinel') withTopic++;
      if (rivalry.pickInterjector('forge', 'merhaba nasılsın', all, { rng: seeded(i + 9), now: (i + 1) * 1e7 }) === 'sentinel') without++;
    }
    expect(withTopic).toBeGreaterThan(without);
  });

  it('bekleme süresi: normalde 90 sn içinde ikinci kez girilmez', () => {
    saveSettings({ drama: 'normal' });
    const always = () => 0;                                                     // olasılık turunu hep geçer
    const first = rivalry.pickInterjector('forge', 'x', all, { rng: always, now: 1_000_000 });
    expect(first).not.toBeNull();
    expect(rivalry.pickInterjector('forge', 'x', all, { rng: always, now: 1_000_000 + 89_000 })).toBeNull();
    expect(rivalry.pickInterjector('forge', 'x', all, { rng: always, now: 1_000_000 + 91_000 })).not.toBeNull();
  });

  it('wantsRetort drama seviyesine bağlı', () => {
    saveSettings({ drama: 'sakin' });
    expect(rivalry.wantsRetort(() => 0)).toBe(false);
    saveSettings({ drama: 'kaos' });
    expect(rivalry.wantsRetort(() => 0.5)).toBe(true);
    expect(rivalry.wantsRetort(() => 0.95)).toBe(false);
  });

  it('promptBlock ilişkileri ve son olayları yazar', () => {
    rivalry.bump('atlas', 'glitch', -2, 'GLITCH araya girdi: deneme');
    const b = rivalry.promptBlock('atlas');
    expect(b).toContain(CHIPS.obsidian.name);
    expect(b).toContain('ezeli düşman');
    expect(b).toContain('GLITCH araya girdi: deneme');

  });
});
