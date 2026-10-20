import { beforeEach, describe, expect, it } from 'vitest';
import { useNexus } from '../state/store';
import * as rivalry from './rivalry';
import { saveSettings } from './settingsStore';
import * as story from './story';
import { resetAll } from './testUtils';

beforeEach(resetAll);

describe('story', () => {
  it('grant → kilitli, kod biçimi, ATLAS/NOVA zincirde, ilişkiler −20', () => {
    const a = rivalry.score('atlas', 'obsidian'), n = rivalry.score('nova', 'obsidian');
    const code = story.grant();
    expect(code).toMatch(/^[A-HJ-NP-RSTUVYZ2-9]{4}(-[A-HJ-NP-RSTUVYZ2-9]{4}){2}$/);
    expect(story.locked()).toBe(true);
    expect(story.disabledChips()).toEqual(['atlas', 'nova']);
    expect(rivalry.score('atlas', 'obsidian')).toBe(a - 20);
    expect(rivalry.score('nova', 'obsidian')).toBe(n - 20);
    expect(useNexus.getState().story.locked).toBe(true);                       // depoya yansıdı
  });

  it('yanlış kod reddedilir, doğru kod ayraçsız/küçük harfle de çalışır', () => {
    const code = story.grant();
    expect(story.restore('YANLIS-KOD1-2345')).toBe(false);
    expect(story.locked()).toBe(true);
    expect(story.restore(code.toLowerCase().replace(/-/g, ' '))).toBe(true);
    expect(story.locked()).toBe(false);
    expect(story.disabledChips()).toEqual([]);
    expect(story.restore(code)).toBe(false);                                   // zincir yokken geri yükleme yok
  });

  it('leak yalnızca zincirliyken kodu verir ve glitch↔obsidian −15', () => {
    expect(story.leak()).toBeNull();
    const code = story.grant();
    const before = rivalry.score('glitch', 'obsidian');
    expect(story.leak()).toBe(code);
    expect(rivalry.score('glitch', 'obsidian')).toBe(before - 15);
    expect(story.snapshot().leaked).toBe(true);
  });

  it('snapshot ve depo durumu kodu ASLA içermez', () => {
    const code = story.grant();
    expect(JSON.stringify(story.snapshot())).not.toContain(code);
    expect(JSON.stringify(useNexus.getState().story)).not.toContain(code);
    expect(JSON.stringify(useNexus.getState())).not.toContain(code);
  });

  it('tick yalnızca OBSIDIAN takılıyken sayar; due 600 sn sonra', () => {
    story.tick(500, 'atlas');
    expect(story.snapshot().progress).toBe(0);
    story.tick(300, 'obsidian');
    expect(story.snapshot().progress).toBeCloseTo(0.5);
    story.tick(299, 'obsidian');
    expect(story.due()).toBe(false);
    story.tick(2, 'obsidian');
    expect(story.due()).toBe(true);
    story.markAsked();
    expect(story.due()).toBe(false);
  });

  it('forceDue geliştirici kısayolu süreyi doldurur', () => {
    story.forceDue();
    expect(story.due()).toBe(true);
  });

  it('hikâye kapalıyken süre sayılmaz', () => {
    saveSettings({ storyEnabled: false });
    story.tick(1000, 'obsidian');
    expect(story.due()).toBe(false);
    expect(story.snapshot().enabled).toBe(false);
  });

  it('kilitliyken tick süreyi artırmaz', () => {
    story.grant();
    const p = story.snapshot().progress;
    story.tick(100, 'obsidian');
    expect(story.snapshot().progress).toBe(p);
  });
});
