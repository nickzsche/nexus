/** Çipler arası ilişki: puanlar (−100…+100), olaylar, araya girme seçimi, arena sonuçları. */
import { CHIPS } from '../data/chips';
import { useNexus } from '../state/store';
import { CHIP_KEYS } from '../types';
import type { ChipKey, RivalryEvent, RivalryMatrix } from '../types';
import { getSettings, readJson, writeJson } from './settingsStore';

const FILE = 'nexus.rivalry';
const MAX_EVENTS = 60;
export const INTERJECT_THRESHOLD = -15;
export const COMBO_THRESHOLD = 60;

const pairKey = (a: ChipKey, b: ChipKey): string => [a, b].sort().join('|');

// Başlangıç puanları (çiftin sırası önemsiz); Python rivalry.py ile aynı.
const RAW: [ChipKey, ChipKey, number][] = [
  ['atlas', 'nova', 40], ['atlas', 'obsidian', -70], ['atlas', 'sentinel', 30], ['atlas', 'forge', 25], ['atlas', 'iris', 20],
  ['atlas', 'pulse', 30], ['atlas', 'ledger', 20], ['atlas', 'oracle', 35], ['atlas', 'glitch', -10],
  ['nova', 'obsidian', -45], ['nova', 'sentinel', 5], ['nova', 'forge', 15], ['nova', 'iris', 25], ['nova', 'pulse', 10],
  ['nova', 'ledger', -5], ['nova', 'oracle', 20], ['nova', 'glitch', 30],
  ['obsidian', 'sentinel', -72], ['obsidian', 'forge', -35], ['obsidian', 'iris', -20], ['obsidian', 'pulse', -30],
  ['obsidian', 'ledger', -25], ['obsidian', 'oracle', -40], ['obsidian', 'glitch', -30],
  ['sentinel', 'forge', -20], ['sentinel', 'iris', 10], ['sentinel', 'pulse', 25], ['sentinel', 'ledger', 5],
  ['sentinel', 'oracle', -15], ['sentinel', 'glitch', -50],
  ['forge', 'iris', 15], ['forge', 'pulse', -25], ['forge', 'ledger', -10], ['forge', 'oracle', 10], ['forge', 'glitch', -20],
  ['iris', 'pulse', 10], ['iris', 'ledger', 0], ['iris', 'oracle', 30], ['iris', 'glitch', 5],
  ['pulse', 'ledger', 5], ['pulse', 'oracle', 0], ['pulse', 'glitch', -35],
  ['ledger', 'oracle', -20], ['ledger', 'glitch', -40],
  ['oracle', 'glitch', -25],
];
export const BASE: Record<string, number> = Object.fromEntries(RAW.map(([a, b, s]) => [pairKey(a, b), s]));

export const DRAMA = {
  sakin: { prob: 0, cooldownSec: 0, retort: 0 },
  normal: { prob: 0.28, cooldownSec: 90, retort: 0.5 },
  kaos: { prob: 0.65, cooldownSec: 20, retort: 0.9 },
} as const;

interface Saved { scores: Record<string, number>; events: RivalryEvent[] }
const load = (): Saved => {
  const d = readJson<Partial<Saved>>(FILE, {});
  return { scores: d.scores ?? {}, events: d.events ?? [] };
};

let lastInterject = 0;
const lastSpoke = new Map<ChipKey, number>();

export function score(a: ChipKey, b: ChipKey): number {
  if (a === b) return 100;
  const k = pairKey(a, b);
  const saved = load().scores[k];
  return saved ?? BASE[k] ?? 0;
}

export function label(s: number): string {
  if (s <= -70) return 'ezeli düşman';
  if (s <= -40) return 'düşman';
  if (s <= -15) return 'gergin';
  if (s < 15) return 'nötr';
  if (s < 50) return 'iyi';
  return 'kardeş';
}

export function matrix(): RivalryMatrix {
  return Object.fromEntries(
    CHIP_KEYS.map((a) => [a, Object.fromEntries(CHIP_KEYS.map((b) => [b, score(a, b)]))]),
  ) as RivalryMatrix;
}

export function events(limit = 8): RivalryEvent[] {
  return load().events.slice(-limit).reverse();       // en yeni önce
}

/** Puanı değiştirir (−100…+100'e sıkıştırılır), olayı kaydeder ve depoya yansıtır; yeni puanı döner. */
export function bump(a: ChipKey, b: ChipKey, delta: number, reason = ''): number {
  if (a === b) return 100;
  const d = load();
  const next = Math.max(-100, Math.min(100, score(a, b) + delta));
  d.scores[pairKey(a, b)] = next;
  d.events.push({ ts: Date.now(), a, b, delta, reason });
  d.events = d.events.slice(-MAX_EVENTS);
  writeJson(FILE, d);
  useNexus.getState().setMatrix(matrix(), events(8));
  return next;
}

export const win = (winner: ChipKey, loser: ChipKey): number =>
  bump(winner, loser, -6, `${winner.toUpperCase()} arenada ${loser.toUpperCase()}'ı yendi`);
export const makePeace = (a: ChipKey, b: ChipKey): number =>
  bump(a, b, +10, `${a.toUpperCase()} ve ${b.toUpperCase()} barıştı`);
export const combo = (a: ChipKey, b: ChipKey): boolean => a !== b && score(a, b) >= COMBO_THRESHOLD;

export function resetRuntime(): void {
  lastInterject = 0;
  lastSpoke.clear();
}
export function noteSpoke(chip: ChipKey, now: number = Date.now()): void {
  lastSpoke.set(chip, now);
}

const dramaCfg = () => DRAMA[getSettings().drama] ?? DRAMA.normal;

/**
 * Aktif çiple puanı ≤ −15 olan adaylardan biri; konu adayın alanına değerse ağırlık ×2.5, yakın zamanda
 * konuşmuşsa ×0.3. Dostlar asla araya girmez; "sakin" seviyede hiç girilmez.
 */
export function pickInterjector(
  active: ChipKey, text: string, available: ChipKey[],
  opts: { rng?: () => number; now?: number } = {},
): ChipKey | null {
  const { prob, cooldownSec } = dramaCfg();
  const now = opts.now ?? Date.now();
  const rng = opts.rng ?? Math.random;
  if (prob <= 0 || now - lastInterject < cooldownSec * 1000) return null;
  const low = text.toLowerCase();
  const cands: { k: ChipKey; w: number }[] = [];
  for (const k of available) {
    if (k === active || !CHIPS[k]) continue;
    const s = score(active, k);
    if (s > INTERJECT_THRESHOLD) continue;
    let w = -s / 10;
    if (CHIPS[k].domain.some((word) => low.includes(word))) w *= 2.5;
    if (now - (lastSpoke.get(k) ?? 0) < 60_000) w *= 0.3;
    cands.push({ k, w });
  }
  if (cands.length === 0 || rng() >= prob) return null;
  const total = cands.reduce((t, c) => t + c.w, 0);
  let r = rng() * total;
  let pick = cands[cands.length - 1].k;
  for (const c of cands) {
    r -= c.w;
    if (r < 0) { pick = c.k; break; }
  }
  lastInterject = now;
  return pick;
}

export const wantsRetort = (rng: () => number = Math.random): boolean => rng() < dramaCfg().retort;

/** Çipin talimatına eklenen ilişki özeti ve son olaylar. */
export function promptBlock(chip: ChipKey): string {
  const lines: string[] = [];
  for (const other of CHIP_KEYS) {
    if (other === chip) continue;
    const s = score(chip, other);
    if (Math.abs(s) >= 15) {
      lines.push(`- ${CHIPS[other].name}: ${label(s)} (${s > 0 ? '+' : ''}${s})${combo(chip, other) ? ' (birlikte iyi çalışırsınız)' : ''}`);
    }
  }
  const recent = events(20).filter((e) => e.a === chip || e.b === chip).slice(0, 5);
  const out: string[] = [];
  if (lines.length) out.push('Diğer çiplerle ilişkin (üslubuna yansıt, iş yine de yapılır):\n' + lines.join('\n'));
  if (recent.length) out.push('Son olaylar:\n' + recent.map((e) => `- ${e.reason}`).join('\n'));
  return out.join('\n\n');
}
