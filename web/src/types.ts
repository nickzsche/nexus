/** NEXUS web: paylaşılan tipler. Çekirdek (core/), ses (core/audio) ve arayüz (ui/) bu sözleşmeye dayanır. */

export const CHIP_KEYS = ['atlas', 'nova', 'obsidian', 'sentinel', 'forge', 'iris', 'pulse', 'ledger', 'oracle', 'glitch'] as const;
export type ChipKey = (typeof CHIP_KEYS)[number];

export type FxProfile = 'hall' | 'bright' | 'obsidian' | 'radio' | 'workshop' | 'ether' | 'pulse' | 'dry' | 'cathedral' | 'glitch' | 'none';
export type RingStyle = 'smooth' | 'fluid' | 'sharp';

export interface ChipColors { main: string; accent: string; deep: string; ink: string }

export interface ChipDef {
  key: ChipKey;
  name: string;
  role: string;
  voice: string;                 // Gemini hazır sesi
  fx: FxProfile;
  address: string;               // kullanıcıya hitap ('' = yok)
  colors: ChipColors;
  ring: { style: RingStyle; speed: number };
  domain: string[];              // rakiplerin araya girmesini tetikleyen konu kelimeleri
  style: string;                 // TTS üslup ipucu
  character: string;             // ikinci tekil şahıs kişilik talimatı
  greeting: string;              // takılınca söylenecek selamın tadı
  tools: string[];               // çipe özel araçlar (COMMON hariç)
  forbidden?: string[];          // yasak sözler (kötü çip)
}

export type Status = 'off' | 'connecting' | 'idle' | 'listening' | 'thinking' | 'speaking' | 'error';
export type Drama = 'sakin' | 'normal' | 'kaos';
export type LineKind = 'user' | 'ai' | 'interject' | 'system';
export type ChaosKind = 'shake' | 'static' | 'invert' | 'rain' | 'scramble';
export type ListenMode = 'always' | 'ptt';

export interface ChatLine {
  id: number;
  who: ChipKey | 'user' | 'system';
  kind: LineKind;
  text: string;
  final: boolean;
  ts: number;
}

export interface RivalryEvent { ts: number; a: ChipKey; b: ChipKey; delta: number; reason: string }
export type RivalryMatrix = Record<ChipKey, Record<ChipKey, number>>;

export interface TimerInfo { id: number; label: string; remaining: number; total: number }
export interface LedgerSummary { net30: number; income30: number; expense30: number; count: number }

export interface Telemetry {
  mic: number;                   // 0–1
  spk: number;                   // 0–1
  speaker: ChipKey | null;       // şu an konuşan çip
  latencyMs: number | null;      // son "söz bitti → ilk ses"
  latencyHistory: number[];
  sessionSec: number;
  turns: number;
  toolCalls: number;
  reconnects: number;
  fps: number;
  rtt: number | null;            // ağ gidiş-dönüş (ms)
  battery: { level: number; charging: boolean } | null;
  // yalnızca masaüstü (Electron) köprüsü doldurur:
  cpu?: number; ram?: number; disk?: number; netDown?: number; netUp?: number;
}

export interface ConfirmRequest { id: string; title: string; detail: string; timeoutSec: number; chip: ChipKey; danger?: boolean }

export interface ArenaLine { who: ChipKey; text: string }
export interface ArenaState {
  phase: 'idle' | 'start' | 'running' | 'vote' | 'end';
  a: ChipKey | null; b: ChipKey | null; topic: string;
  lines: ArenaLine[]; speaking: ChipKey | null; winner: ChipKey | 'draw' | null;
}

export interface StorySnapshot { enabled: boolean; locked: boolean; chained: ChipKey[]; progress: number; leaked: boolean }

export interface Settings {
  userName: string;
  drama: Drama;
  storyEnabled: boolean;
  micEnabled: boolean;
  echoCancel: boolean;
  listenMode: ListenMode;
  bargeRms: number;              // hoparlör çalarken konuşma sayılacak seviye (0–1)
  inputDeviceId: string | null;
  outputDeviceId: string | null;
  voiceOverrides: Partial<Record<ChipKey, string>>;
  fxIntensity: Partial<Record<ChipKey, number>>;
  liveModels: string[];          // varsayılan: yalnızca gemini-2.5-flash-native-audio-latest
  textModels: string[];
  ttsModels: string[];
  activeChip: ChipKey;
  workspace: string;             // masaüstü sürümü için
  shellConfirm: boolean;
  sfx: boolean;
  onboarded: boolean;
}

export interface Toast { id: number; text: string; tone: 'info' | 'warn' | 'error' | 'ok' }

/** Sistem köprüsü: web'de sınırlı, Electron'da tam. Araçlar işletim sistemi işini buradan ister. */
export interface SystemBridge {
  platform: 'web' | 'electron';
  /** Araç adına göre sistem işi. Desteklenmiyorsa { error } döner. */
  call(tool: string, args: Record<string, unknown>): Promise<unknown>;
  has(tool: string): boolean;
  telemetry?(): Promise<Partial<Telemetry>>;
}
