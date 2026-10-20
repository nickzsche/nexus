/** LEDGER: gelir/gider defteri (yerel depolama). Her değişiklikte özet depoya yansır. */
import { useNexus } from '../../state/store';
import { readJson, writeJson } from '../settingsStore';
import { num, prop, registerTool, schema, str } from './registry';

const FILE = 'nexus.ledger';
export interface Entry { id: number; ts: number; amount: number; kind: 'gelir' | 'gider'; category: string; note: string }

const entries = (): Entry[] => readJson<Entry[]>(FILE, []);
const save = (e: Entry[]): void => { writeJson(FILE, e); publishLedger(); };
const r2 = (n: number): number => Math.round(n * 100) / 100;

export function summary(days = 30) {
  const cutoff = Date.now() - days * 86400_000;
  const rows = entries().filter((e) => e.ts >= cutoff);
  const income = r2(rows.filter((e) => e.kind === 'gelir').reduce((t, e) => t + e.amount, 0));
  const expense = r2(rows.filter((e) => e.kind === 'gider').reduce((t, e) => t + e.amount, 0));
  const cats: Record<string, number> = {};
  for (const e of rows) if (e.kind === 'gider') cats[e.category] = r2((cats[e.category] ?? 0) + e.amount);
  return {
    gun: days, gelir: income, gider: expense, net: r2(income - expense), kayit: rows.length,
    kategoriler: Object.fromEntries(Object.entries(cats).sort((a, b) => b[1] - a[1])),
  };
}

export function publishLedger(): void {
  const s = summary(30);
  useNexus.getState().setLedger({ net30: s.net, income30: s.gelir, expense30: s.gider, count: s.kayit });
}

registerTool({
  name: 'ledger_add', description: 'Deftere gelir ya da gider kaydı ekler.',
  parameters: schema({
    amount: prop('number', 'Tutar (pozitif)'), category: prop('string', 'Örn. market, kira'), note: prop('string', 'Not'),
    kind: prop('string', 'Varsayılan gider', { enum: ['gelir', 'gider'] }),
  }, ['amount']),
  handler(a) {
    const amount = num(a, 'amount', NaN);
    if (!Number.isFinite(amount) || amount <= 0) return { error: 'Tutar sıfırdan büyük bir sayı olmalı.' };
    const kind = str(a, 'kind') === 'gelir' ? 'gelir' : 'gider';
    const list = entries();
    const id = (list.at(-1)?.id ?? 0) + 1;
    list.push({ id, ts: Date.now(), amount: r2(amount), kind, category: str(a, 'category') || 'genel', note: str(a, 'note') });
    save(list);
    return { id, kind, amount: r2(amount), ozet: summary(30) };
  },
});

registerTool({
  name: 'ledger_summary', description: 'Son N günün gelir, gider ve net özetini verir.',
  parameters: schema({ days: prop('number', 'Gün sayısı (varsayılan 30)') }),
  handler: (a) => summary(Math.max(1, Math.min(3650, num(a, 'days', 30)))),
});

registerTool({
  name: 'ledger_list', description: 'Son kayıtları listeler.',
  parameters: schema({ limit: prop('number', 'En fazla kaç kayıt (varsayılan 10)') }),
  handler: (a) => entries().slice(-Math.max(1, Math.min(100, num(a, 'limit', 10)))).reverse(),
});

registerTool({
  name: 'ledger_delete', description: 'Bir defter kaydını siler. Onay gerektirir.',
  parameters: schema({ id: prop('number', 'Kayıt numarası') }, ['id']),
  async handler(a, ctx) {
    const id = num(a, 'id', NaN);
    const list = entries();
    const hit = list.find((e) => e.id === id);
    if (!hit) return { error: `${id} numaralı kayıt yok.` };
    const ok = await ctx.confirm('Defter kaydını sil', `#${hit.id} · ${hit.kind} · ${hit.amount} · ${hit.category}`);
    if (!ok) return { error: 'Kullanıcı onaylamadı, kayıt silinmedi.' };
    save(list.filter((e) => e.id !== id));
    return `#${id} silindi.`;
  },
});
