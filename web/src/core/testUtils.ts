/** Çekirdek testleri için ortak yardımcılar (yalnızca testlerden içe aktarılır). */
import { vi } from 'vitest';
import { DEFAULT_SETTINGS, emptyMatrix, useNexus } from '../state/store';
import type { ChipKey, SystemBridge } from '../types';
import { setBridge, webBridge } from './bridge';
import * as rivalry from './rivalry';
import { clearTimers } from './tools/timers';
import type { ToolContext } from './tools/registry';

export function resetAll(): void {
  localStorage.clear();
  useNexus.setState({
    settings: { ...DEFAULT_SETTINGS }, hasKey: false, timers: [], toasts: [], chaos: null, matrix: emptyMatrix(), events: [],
    story: { enabled: true, locked: false, chained: [], progress: 0, leaked: false },
    ledger: { net30: 0, income30: 0, expense30: 0, count: 0 },
  });
  rivalry.resetRuntime();
  clearTimers();
  setBridge(webBridge);
}

export const fakeBridge = (): SystemBridge & { call: ReturnType<typeof vi.fn> } => ({
  platform: 'electron', has: () => true, call: vi.fn(async () => ({ result: 'köprü-tamam' })),
});

export function fakeCtx(chip: ChipKey = 'atlas', over: Partial<ToolContext> = {}) {
  const ctx = {
    chip,
    confirm: vi.fn(async () => true),
    sendImage: vi.fn(),
    handoff: vi.fn((to: ChipKey) => `${to} devralıyor.`),
    debate: vi.fn(() => 'Arena başlıyor.'),
    bridge: webBridge,
    ...over,
  };
  return ctx as ToolContext & { confirm: ReturnType<typeof vi.fn>; sendImage: ReturnType<typeof vi.fn>; handoff: ReturnType<typeof vi.fn>; debate: ReturnType<typeof vi.fn> };
}
