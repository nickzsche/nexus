import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useNexus } from '../state/store';
import { MockCore } from './mock';

const S = () => useNexus.getState();
const until = async (cond: () => boolean, ms = 3000) => {
  const end = Date.now() + ms;
  while (!cond()) { if (Date.now() > end) throw new Error('zaman aşımı'); await new Promise((r) => setTimeout(r, 5)); }
};

let m: MockCore;
beforeEach(async () => {
  localStorage.clear();
  history.replaceState(null, '', '/?ready');
  S().clearLines();
  S().setArena({ phase: 'idle', a: null, b: null, lines: [], winner: null, speaking: null });
  S().setStory({ enabled: true, locked: false, chained: [], progress: 0, leaked: false });
  S().patchSettings({ activeChip: 'atlas', drama: 'sakin' });
  S().setActive('atlas');
  m = new MockCore();
  m.speed = 0;
  await m.start();
  await until(() => S().status === 'idle' && S().lines.some((l) => l.who === 'atlas' && l.final));
});
afterEach(() => m.shutdown());

describe('MockCore', () => {
  it('?ready ile anahtarlı ve karşılanmış başlar, 10×10 matris doludur', () => {
    expect(S().hasKey).toBe(true);
    expect(S().settings.onboarded).toBe(true);
    expect(S().matrix.atlas.obsidian).toBe(-70);
    expect(S().matrix.obsidian.atlas).toBe(-70);
    expect(S().model).toContain('gemini-2.5-flash-native-audio');
  });

  it('çip takınca aktif çip, geçiş damgası ve selam gelir', async () => {
    const before = S().chip.switchedAt;
    await m.mount('forge');
    expect(S().active).toBe('forge');
    expect(S().chip.switchedAt).toBeGreaterThanOrEqual(before);
    expect(S().chip.from).toBe('atlas');
    expect(S().lines.some((l) => l.who === 'forge' && l.text.includes('Tezgâh'))).toBe(true);
  });

  it('yazılan mesaj kullanıcı satırı ve çip cevabı üretir; durum geri döner', async () => {
    m.sendText('Merhaba');
    expect(S().lines.some((l) => l.kind === 'user' && l.text === 'Merhaba')).toBe(true);
    await until(() => S().telemetry.turns >= 1 && S().status === 'idle');
    expect(S().lines.filter((l) => l.who === 'atlas' && l.final).length).toBeGreaterThanOrEqual(2);
    expect(S().telemetry.latencyMs).not.toBeNull();
  });

  it('/zincir ATLAS ve NOVA\'yı zincire vurur; zincirli çip takılamaz', async () => {
    m.sendText('/zincir');
    expect(S().story).toMatchObject({ locked: true, chained: ['atlas', 'nova'] });
    expect(S().active).toBe('obsidian');
    await m.mount('nova');
    expect(S().active).toBe('obsidian');
    expect(S().toasts.some((t) => t.text.includes('zincire vurulmuş'))).toBe(true);
    expect(S().matrix.atlas.obsidian).toBeLessThan(-70);
  });

  it('çip tamiri: yanlış kod olmaz, doğru kod (ayraç/harf büyüklüğünden bağımsız) zinciri çözer', () => {
    m.sendText('/zincir');
    expect(m.repair('YANLIS')).toBe(false);
    expect(S().story.locked).toBe(true);
    expect(m.repair('kara 1234 zncr')).toBe(true);
    expect(S().story).toMatchObject({ locked: false, chained: [] });
  });

  it('onay: istek depoya yazılır, cevap onu temizler ve sistem satırı ekler', () => {
    m.sendText('/onay');
    const c = S().confirm!;
    expect(c).toBeTruthy();
    expect(c.timeoutSec).toBeGreaterThan(0);
    m.answerConfirm(c.id, true);
    expect(S().confirm).toBeNull();
    expect(S().lines.some((l) => l.kind === 'system' && l.text.includes('Onaylandı'))).toBe(true);
  });

  it('yetki talebi onaylanırsa zincir kurulur, reddedilirse kurulmaz', async () => {
    m.sendText('/yetki');
    await until(() => S().confirm?.danger === true);
    expect(S().confirm!.chip).toBe('obsidian');
    m.answerConfirm(S().confirm!.id, false);
    await until(() => S().status === 'idle');
    expect(S().story.locked).toBe(false);
    m.sendText('/yetki');
    await until(() => S().confirm != null);
    m.answerConfirm(S().confirm!.id, true);
    await until(() => S().story.locked);
    expect(S().story.chained).toEqual(['atlas', 'nova']);
  });

  it('devir: kaynak konuşur, handoff damgası oluşur, hedef çip aktif olur', async () => {
    m.sendText('/devret forge depoya bak');
    await until(() => S().active === 'forge', 4000);
    expect(S().handoff).toMatchObject({ from: 'atlas', to: 'forge' });
    expect(S().events.some((e) => e.reason.includes('devretti'))).toBe(true);
  });

  it('arena: başla → 6 satır → oylama → kazanan puanı etkiler', async () => {
    const before = S().matrix.forge.sentinel;
    m.startArena('sentinel', 'forge', 'monorepo');
    expect(S().arena.phase).toBe('start');
    await until(() => S().arena.phase === 'vote', 6000);
    expect(S().arena.lines).toHaveLength(6);
    m.vote('forge');
    expect(S().arena).toMatchObject({ phase: 'end', winner: 'forge' });
    expect(S().matrix.forge.sentinel).toBe(before - 6);
  });

  it('arena aynı çiple ya da zincirli çiple başlamaz', () => {
    m.startArena('forge', 'forge', 'x');
    expect(S().arena.phase).toBe('idle');
    m.sendText('/zincir');
    m.startArena('atlas', 'forge', 'x');
    expect(S().arena.phase).toBe('idle');
  });

  it('zamanlayıcı, kaos ve barışma çalışır', () => {
    m.sendText('/zamanlayici');
    expect(S().timers).toHaveLength(1);
    expect(S().timers[0]).toMatchObject({ label: 'çay', total: 90 });
    m.sendText('/kaos rain');
    expect(S().chaos?.kind).toBe('rain');
    const s0 = S().matrix.atlas.nova;
    m.makePeace('atlas', 'nova');
    expect(S().matrix.atlas.nova).toBe(s0 + 10);
  });

  it('API anahtarı: kısa anahtar reddedilir, geçerli anahtar hasKey yapar ve silinebilir', async () => {
    expect((await m.testApiKey('abc')).ok).toBe(false);
    S().setHasKey(false);
    expect((await m.setApiKey('AIza-uzun-bir-anahtar')).ok).toBe(true);
    expect(S().hasKey).toBe(true);
    await m.clearApiKey();
    expect(S().hasKey).toBe(false);
  });

  it('ayarlar kaydedilir ve yeniden yüklenir', () => {
    m.saveSettings({ drama: 'kaos', userName: 'Sahan' });
    expect(S().settings.drama).toBe('kaos');
    expect(JSON.parse(localStorage.getItem('nexus.mock.settings')!)).toMatchObject({ drama: 'kaos', userName: 'Sahan' });
  });
});
