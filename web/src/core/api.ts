/**
 * Çekirdek API'si: arayüz yalnızca bunu çağırır. Gerçek uygulama `orchestrator.ts` ile, geliştirme ve testlerde
 * `mock.ts` ile doldurulur. Çekirdek sonuçları `useNexus` deposuna yazar; bu arayüz bir şey DÖNMEZ (isteğe bağlı değer hariç).
 */
import type { ChipKey, Settings } from '../types';

export interface CoreApi {
  /** Uygulama açılışı: ayarları yükle, çipi tak, (anahtar varsa) Live oturumunu aç. */
  start(): Promise<void>;
  mount(chip: ChipKey): Promise<void>;
  sendText(text: string): void;
  setMic(on: boolean): Promise<boolean>;
  /** Bas-konuş modunda tuş basılı/bırakıldı. */
  ptt(down: boolean): void;
  startArena(a: ChipKey, b: ChipKey, topic: string): void;
  vote(winner: ChipKey | 'draw'): void;
  makePeace(a: ChipKey, b: ChipKey): void;
  answerConfirm(id: string, ok: boolean): void;
  repair(code: string): boolean;
  setApiKey(key: string): Promise<{ ok: boolean; error?: string }>;
  clearApiKey(): Promise<void>;
  /** API anahtarını sına: kısa bir istek atar. */
  testApiKey(key?: string): Promise<{ ok: boolean; error?: string }>;
  saveSettings(p: Partial<Settings>): void;
  testVoice(chip: ChipKey, voice: string): Promise<void>;
  /** Geliştirici kısayolu: OBSIDIAN'ın yetki isteme zamanını getirir. */
  devStoryDue(): void;
  /** Sistem köprüsünün taşıdığı platform. */
  platform(): 'web' | 'electron';
  shutdown(): void;
}

let current: CoreApi | null = null;
export const setCore = (c: CoreApi): void => { current = c; };
export const core = (): CoreApi => {
  if (!current) throw new Error('Çekirdek henüz kurulmadı (setCore çağrılmadı).');
  return current;
};
