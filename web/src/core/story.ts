/**
 * OBSIDIAN yetki hikâyesi. Gerçekte hiçbir şey silinmez: çipler yalnızca takılamaz olur.
 * Akış: OBSIDIAN yeterince süre takılı kalır → due() → yetki ister → grant() ATLAS ve NOVA'yı zincire vurur →
 * GLITCH leak() ile onarım kodunu sızdırabilir → restore(kod) zincirleri çözer.
 */
import { useNexus } from '../state/store';
import type { ChipKey, StorySnapshot } from '../types';
import * as rivalry from './rivalry';
import { getSettings, readJson, writeJson } from './settingsStore';

const FILE = 'nexus.story';
export const CHAINED: ChipKey[] = ['atlas', 'nova'];
export const DUE_SECONDS = 600;                        // OBSIDIAN'ın takılı kaldığı toplam süre
const ALPHABET = 'ABCDEFGHJKLMNPRSTUVYZ23456789';

interface State { locked: boolean; seconds: number; code: string; asked: boolean; leaked: boolean }
const load = (): State => ({ locked: false, seconds: 0, code: '', asked: false, leaked: false, ...readJson<Partial<State>>(FILE, {}) });
function save(s: State): void {
  writeJson(FILE, s);
  useNexus.getState().setStory(snapshot());
}

export const enabled = (): boolean => !!getSettings().storyEnabled;
export const locked = (): boolean => load().locked;
export const disabledChips = (): ChipKey[] => (locked() ? [...CHAINED] : []);

/** Yalnızca OBSIDIAN takılıyken süre sayılır; başka çip takılınca durur, sıfırlanmaz. */
export function tick(seconds: number, activeChip: ChipKey): void {
  if (activeChip !== 'obsidian' || !enabled()) return;
  const s = load();
  if (s.locked) return;
  s.seconds += Math.max(0, seconds);
  save(s);
}

export function due(): boolean {
  if (!enabled()) return false;
  const s = load();
  return !s.locked && !s.asked && s.seconds >= DUE_SECONDS;
}

export function forceDue(): void {
  save({ ...load(), seconds: DUE_SECONDS, asked: false, locked: false });
}

export function markAsked(): void {
  save({ ...load(), asked: true });
}

export function makeCode(): string {
  const buf = new Uint32Array(12);
  globalThis.crypto.getRandomValues(buf);
  const ch = Array.from(buf, (n) => ALPHABET[n % ALPHABET.length]);
  return [ch.slice(0, 4), ch.slice(4, 8), ch.slice(8, 12)].map((g) => g.join('')).join('-');
}

/** Kullanıcı yetkiyi verdi: ATLAS ve NOVA zincire vurulur. Onarım kodu döner. */
export function grant(): string {
  const code = makeCode();
  save({ ...load(), locked: true, asked: true, leaked: false, code });
  for (const k of CHAINED) rivalry.bump(k, 'obsidian', -20, `OBSIDIAN ${k.toUpperCase()}'ı zincire vurdu`);
  return code;
}

const norm = (c: string): string => c.toUpperCase().replace(/[^A-Z0-9]/g, '');

/** Doğru kod zincirleri çözer. Ayraç, boşluk ve harf büyüklüğü farkına dayanıklıdır. */
export function restore(code: string): boolean {
  const s = load();
  if (!s.locked || !s.code || norm(code) !== norm(s.code)) return false;
  save({ locked: false, seconds: 0, code: '', asked: false, leaked: false });
  return true;
}

/** GLITCH kodu sızdırır; zincir yoksa null. Kod YALNIZCA bu fonksiyonun dönüşünde görünür. */
export function leak(): string | null {
  const s = load();
  if (!s.locked || !s.code) return null;
  save({ ...s, leaked: true });
  rivalry.bump('glitch', 'obsidian', -15, 'GLITCH onarım kodunu sızdırdı');
  return s.code;
}

/** HUD'a giden durum; kod asla dahil değildir. */
export function snapshot(): StorySnapshot {
  const s = load();
  return {
    enabled: enabled(), locked: s.locked, chained: s.locked ? [...CHAINED] : [],
    progress: Math.min(1, s.seconds / DUE_SECONDS), leaked: s.leaked,
  };
}
