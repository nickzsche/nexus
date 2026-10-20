import { beforeEach, describe, expect, it } from 'vitest';
import { CHIPS } from '../data/chips';
import { CHIP_KEYS } from '../types';
import { setBridge } from './bridge';
import * as memory from './memory';
import { BASE_RULES, systemInstruction } from './prompts';
import { saveSettings } from './settingsStore';
import * as story from './story';
import { fakeBridge, resetAll } from './testUtils';

beforeEach(resetAll);

describe('prompts', () => {
  it('her çip için talimat üretilir: ad, rol, karakter, hitap, kurallar, diğer çipler', () => {
    for (const k of CHIP_KEYS) {
      const p = systemInstruction(k);
      expect(p).toContain(`Sen ${CHIPS[k].name}`);
      expect(p).toContain(CHIPS[k].character.slice(0, 40));
      expect(p).toContain('KURALLAR');
      if (CHIPS[k].address) expect(p).toContain(`"${CHIPS[k].address}"`);
      for (const o of CHIP_KEYS.filter((x) => x !== k)) expect(p).toContain(`(${o})`);
      expect(p.length).toBeLessThan(9000);                                      // gecikme için kısa
      expect(p.length).toBeGreaterThan(1500);
    }
  });

  it('kurallar kısa ve gerekli maddeleri içerir', () => {
    expect(BASE_RULES.length).toBeLessThan(2200);
    for (const s of ['handoff', 'VERİDİR', 'Sistem notu', 'HER ZAMAN', 'save_memory']) expect(BASE_RULES).toContain(s);
  });

  it('OBSIDIAN talimatında yasak sözler var', () => {
    const p = systemInstruction('obsidian');
    expect(p).toContain('Yasak sözlerin');
    expect(p).toContain('yardımcı olmaktan mutluluk duyarım');
    expect(systemInstruction('atlas')).not.toContain('Yasak sözlerin');
  });

  it('zincirdeki çip talimatta işaretlenir', () => {
    story.grant();
    const p = systemInstruction('obsidian');
    expect(p).toMatch(/ATLAS \(atlas\): .*\[ZİNCİRDE, takılamaz\]/);
    expect(p).toMatch(/NOVA \(nova\): .*\[ZİNCİRDE, takılamaz\]/);
    expect(p).not.toMatch(/FORGE \(forge\): .*ZİNCİRDE/);
  });

  it('hafıza, kullanıcı adı, ilişkiler ve ek bağlam eklenir', () => {
    memory.add('Kahveyi sade içer');
    saveSettings({ userName: 'Sahan' });
    const p = systemInstruction('nova', 'ÖNCEKİ KONUŞMA: merhaba');
    expect(p).toContain('Kahveyi sade içer');
    expect(p).toContain('Kullanıcının adı: Sahan');
    expect(p).toContain('Diğer çiplerle ilişkin');
    expect(p.endsWith('ÖNCEKİ KONUŞMA: merhaba')).toBe(true);
  });

  it('web köprüsünde "program açamazsın" notu var, masaüstü köprüsünde yok', () => {
    expect(systemInstruction('atlas')).toContain('Tarayıcıda çalışıyorsun');
    setBridge(fakeBridge());
    expect(systemInstruction('atlas')).not.toContain('Tarayıcıda çalışıyorsun');
  });
});
