/** Hafıza: bütün çiplerin ortak bildikleri ve çipe özel notlar. Yerel depolama. */
import type { ChipKey } from '../types';
import { readJson, writeJson } from './settingsStore';

const FILE = 'nexus.memory';
const MAX_ITEMS = 200;

interface Item { text: string; ts: number }
interface Data { shared: Item[]; chips: Partial<Record<ChipKey, Item[]>> }

const load = (): Data => {
  const d = readJson<Partial<Data>>(FILE, {});
  return { shared: d.shared ?? [], chips: d.chips ?? {} };
};

export function add(text: string, chip?: ChipKey): void {
  const t = text.trim();
  if (!t) throw new Error('boş kayıt');
  const d = load();
  const bucket = chip ? (d.chips[chip] ??= []) : d.shared;
  if (bucket.some((i) => i.text.toLowerCase() === t.toLowerCase())) return;    // aynı bilgi iki kez yazılmaz
  bucket.push({ text: t, ts: Date.now() });
  bucket.splice(0, Math.max(0, bucket.length - MAX_ITEMS));
  writeJson(FILE, d);
}

export function remove(match: string, chip?: ChipKey): number {
  const m = match.trim().toLowerCase();
  if (!m) return 0;
  const d = load();
  const buckets = chip ? [d.chips[chip] ?? []] : [d.shared, ...Object.values(d.chips).map((b) => b ?? [])];
  let removed = 0;
  for (const b of buckets) {
    const keep = b.filter((i) => !i.text.toLowerCase().includes(m));
    removed += b.length - keep.length;
    b.splice(0, b.length, ...keep);
  }
  writeJson(FILE, d);
  return removed;
}

export function items(chip?: ChipKey): string[] {
  const d = load();
  return (chip ? d.chips[chip] ?? [] : d.shared).map((i) => i.text);
}

export function promptBlock(chip: ChipKey): string {
  const shared = items().slice(-30);
  const own = items(chip).slice(-15);
  const out: string[] = [];
  if (shared.length) out.push('Kullanıcı hakkında bildiklerin:\n' + shared.map((t) => `- ${t}`).join('\n'));
  if (own.length) out.push('Senin kendi notların:\n' + own.map((t) => `- ${t}`).join('\n'));
  return out.join('\n\n');
}
