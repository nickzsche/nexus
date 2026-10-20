/** Merkezi durum. Çekirdek (core/) yazar, arayüz (ui/) okur. Tek doğru kaynak. */
import { create } from 'zustand';
import { CHIP_KEYS } from '../types';
import type {
  ArenaState, ChaosKind, ChatLine, ChipKey, ConfirmRequest, LedgerSummary, LineKind, RivalryEvent, RivalryMatrix,
  Settings, Status, StorySnapshot, TimerInfo, Telemetry, Toast,
} from '../types';

export const DEFAULT_SETTINGS: Settings = {
  userName: '', drama: 'normal', storyEnabled: true, micEnabled: true, echoCancel: true, listenMode: 'always',
  bargeRms: 0.06, inputDeviceId: null, outputDeviceId: null, voiceOverrides: {}, fxIntensity: {},
  liveModels: ['gemini-2.5-flash-native-audio-latest'],          // kullanıcının seçtiği model; sormadan değiştirme
  textModels: ['gemini-flash-latest', 'gemini-3-flash-preview', 'gemini-3.5-flash', 'gemini-3.7-flash', 'gemini-flash-lite-latest'],
  ttsModels: ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'],
  activeChip: 'atlas', workspace: '', shellConfirm: true, sfx: true, onboarded: false,
};

export const emptyMatrix = (): RivalryMatrix =>
  Object.fromEntries(CHIP_KEYS.map((a) => [a, Object.fromEntries(CHIP_KEYS.map((b) => [b, a === b ? 100 : 0]))])) as RivalryMatrix;

export const emptyTelemetry = (): Telemetry => ({
  mic: 0, spk: 0, speaker: null, latencyMs: null, latencyHistory: [], sessionSec: 0, turns: 0, toolCalls: 0,
  reconnects: 0, fps: 0, rtt: null, battery: null,
});

export const emptyArena = (): ArenaState => ({ phase: 'idle', a: null, b: null, topic: '', lines: [], speaking: null, winner: null });

export type ModalId = 'settings' | 'arena' | 'repair' | 'onboarding' | 'chips' | null;

export interface NexusState {
  // --- çekirdeğin yazdığı durum
  active: ChipKey;
  status: Status;
  model: string;
  hasKey: boolean;
  micOn: boolean;
  lines: ChatLine[];
  matrix: RivalryMatrix;
  events: RivalryEvent[];
  story: StorySnapshot;
  timers: TimerInfo[];
  ledger: LedgerSummary;
  telemetry: Telemetry;
  settings: Settings;
  confirm: ConfirmRequest | null;
  arena: ArenaState;
  handoff: { from: ChipKey; to: ChipKey; at: number } | null;
  chip: { switchedAt: number; from: ChipKey | null };          // çip değişimi animasyonunu tetikler
  chaos: { kind: ChaosKind; at: number } | null;
  toasts: Toast[];
  // --- arayüz durumu
  modal: ModalId;

  // --- eylemler (çekirdek bunları çağırır)
  setActive(k: ChipKey): void;
  setStatus(s: Status): void;
  setModel(m: string): void;
  setHasKey(b: boolean): void;
  setMicOn(b: boolean): void;
  /** Kısmi parça ekler. `delta` açık satıra eklenir; final=true satırı kapatır. */
  appendLine(p: { who: ChatLine['who']; kind: LineKind; delta: string; final: boolean }): void;
  addSystemLine(text: string): void;
  clearLines(): void;
  setMatrix(m: RivalryMatrix, events?: RivalryEvent[]): void;
  setStory(s: StorySnapshot): void;
  setTimers(t: TimerInfo[]): void;
  setLedger(l: LedgerSummary): void;
  patchTelemetry(p: Partial<Telemetry>): void;
  pushLatency(ms: number): void;
  patchSettings(p: Partial<Settings>): void;
  setConfirm(c: ConfirmRequest | null): void;
  setArena(p: Partial<ArenaState>): void;
  resetArena(): void;
  setHandoff(h: { from: ChipKey; to: ChipKey } | null): void;
  markChipSwitch(from: ChipKey | null): void;
  triggerChaos(k: ChaosKind): void;
  toast(text: string, tone?: Toast['tone']): void;
  dismissToast(id: number): void;
  openModal(m: ModalId): void;
}

let lineId = 1;
let toastId = 1;
const openLines = new Map<string, number>();          // "who|kind" → açık satırın id'si

export const useNexus = create<NexusState>((set, get) => ({
  active: 'atlas', status: 'off', model: '', hasKey: false, micOn: false,
  lines: [], matrix: emptyMatrix(), events: [],
  story: { enabled: true, locked: false, chained: [], progress: 0, leaked: false },
  timers: [], ledger: { net30: 0, income30: 0, expense30: 0, count: 0 },
  telemetry: emptyTelemetry(), settings: { ...DEFAULT_SETTINGS },
  confirm: null, arena: emptyArena(), handoff: null, chip: { switchedAt: 0, from: null }, chaos: null, toasts: [],
  modal: null,

  setActive: (k) => set({ active: k }),
  setStatus: (s) => set({ status: s }),
  setModel: (m) => set({ model: m }),
  setHasKey: (b) => set({ hasKey: b }),
  setMicOn: (b) => set({ micOn: b }),

  appendLine: ({ who, kind, delta, final }) => {
    const key = `${who}|${kind}`;
    const lines = get().lines.slice();
    const openId = openLines.get(key);
    let idx = openId == null ? -1 : lines.findIndex((l) => l.id === openId);
    if (idx < 0) {
      if (!delta && final) return;                       // boş kapanış: açık satır yoksa yok say
      const line: ChatLine = { id: lineId++, who, kind, text: '', final: false, ts: Date.now() };
      lines.push(line);
      idx = lines.length - 1;
      openLines.set(key, line.id);
    }
    lines[idx] = { ...lines[idx], text: lines[idx].text + delta, final };
    if (final) openLines.delete(key);
    set({ lines: lines.slice(-80) });
  },
  addSystemLine: (text) => {
    const lines = get().lines.slice();
    lines.push({ id: lineId++, who: 'system', kind: 'system', text, final: true, ts: Date.now() });
    set({ lines: lines.slice(-80) });
  },
  clearLines: () => { openLines.clear(); set({ lines: [] }); },

  setMatrix: (m, events) => set(events ? { matrix: m, events } : { matrix: m }),
  setStory: (s) => set({ story: s }),
  setTimers: (t) => set({ timers: t }),
  setLedger: (l) => set({ ledger: l }),
  patchTelemetry: (p) => set((st) => ({ telemetry: { ...st.telemetry, ...p } })),
  pushLatency: (ms) => set((st) => ({
    telemetry: { ...st.telemetry, latencyMs: ms, latencyHistory: [...st.telemetry.latencyHistory, ms].slice(-30) },
  })),
  patchSettings: (p) => set((st) => ({ settings: { ...st.settings, ...p } })),
  setConfirm: (c) => set({ confirm: c }),
  setArena: (p) => set((st) => ({ arena: { ...st.arena, ...p } })),
  resetArena: () => set({ arena: emptyArena() }),
  setHandoff: (h) => set({ handoff: h ? { ...h, at: Date.now() } : null }),
  markChipSwitch: (from) => set({ chip: { switchedAt: Date.now(), from } }),
  triggerChaos: (k) => set({ chaos: { kind: k, at: Date.now() } }),
  toast: (text, tone = 'info') => {
    const id = toastId++;
    set((st) => ({ toasts: [...st.toasts, { id, text, tone }].slice(-4) }));
    setTimeout(() => get().dismissToast(id), tone === 'error' ? 7000 : 4000);
  },
  dismissToast: (id) => set((st) => ({ toasts: st.toasts.filter((t) => t.id !== id) })),
  openModal: (m) => set({ modal: m }),
}));
