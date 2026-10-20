import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useNexus } from './store';

const S = () => useNexus.getState();

describe('store.appendLine', () => {
  beforeEach(() => { S().clearLines(); });

  it('parçaları (delta) açık satırda birleştirir ve final ile kapatır', () => {
    S().appendLine({ who: 'atlas', kind: 'ai', delta: 'Merhaba', final: false });
    S().appendLine({ who: 'atlas', kind: 'ai', delta: ' şef.', final: false });
    expect(S().lines).toHaveLength(1);
    expect(S().lines[0].text).toBe('Merhaba şef.');
    expect(S().lines[0].final).toBe(false);
    S().appendLine({ who: 'atlas', kind: 'ai', delta: '', final: true });
    expect(S().lines[0].final).toBe(true);
    expect(S().lines[0].text).toBe('Merhaba şef.');
  });

  it('final sonrası yeni parça yeni satır açar', () => {
    S().appendLine({ who: 'atlas', kind: 'ai', delta: 'bir', final: true });
    S().appendLine({ who: 'atlas', kind: 'ai', delta: 'iki', final: false });
    expect(S().lines.map((l) => l.text)).toEqual(['bir', 'iki']);
  });

  it('açık satır yokken boş kapanış satır oluşturmaz', () => {
    S().appendLine({ who: 'atlas', kind: 'ai', delta: '', final: true });
    expect(S().lines).toHaveLength(0);
  });

  it('kullanıcı ve çip satırları birbirine karışmaz; araya girme ayrı satırdır', () => {
    S().appendLine({ who: 'user', kind: 'user', delta: 'selam', final: false });
    S().appendLine({ who: 'atlas', kind: 'ai', delta: 'merhaba', final: false });
    S().appendLine({ who: 'sentinel', kind: 'interject', delta: 'hm', final: false });
    S().appendLine({ who: 'user', kind: 'user', delta: ' dünya', final: true });
    expect(S().lines.map((l) => [l.who, l.text])).toEqual([['user', 'selam dünya'], ['atlas', 'merhaba'], ['sentinel', 'hm']]);
  });

  it('en fazla 80 satır tutar', () => {
    for (let i = 0; i < 95; i++) S().addSystemLine('s' + i);
    expect(S().lines).toHaveLength(80);
    expect(S().lines[79].text).toBe('s94');
  });
});

describe('store diğer eylemler', () => {
  it('gecikme geçmişi 30 ile sınırlı ve son değer saklanır', () => {
    for (let i = 0; i < 40; i++) S().pushLatency(1000 + i);
    expect(S().telemetry.latencyHistory).toHaveLength(30);
    expect(S().telemetry.latencyMs).toBe(1039);
  });

  it('setArena kısmi birleştirir, resetArena sıfırlar', () => {
    S().setArena({ phase: 'running', a: 'forge', b: 'sentinel' });
    S().setArena({ speaking: 'forge' });
    expect(S().arena).toMatchObject({ phase: 'running', a: 'forge', speaking: 'forge' });
    S().resetArena();
    expect(S().arena.phase).toBe('idle');
  });

  describe('toast', () => {
    beforeEach(() => vi.useFakeTimers());
    afterEach(() => vi.useRealTimers());
    it('kendiliğinden kaybolur ve en fazla 4 tane tutulur', () => {
      for (let i = 0; i < 6; i++) S().toast('t' + i);
      expect(S().toasts).toHaveLength(4);
      vi.advanceTimersByTime(4100);
      expect(S().toasts).toHaveLength(0);
    });
  });
});
