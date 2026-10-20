/** Zamanlayıcılar: set_timer / list_timers / cancel_timer. Süre dolunca orkestratör `onTimerDone` ile haberdar olur. */
import { useNexus } from '../../state/store';
import type { TimerInfo } from '../../types';
import { num, prop, registerTool, schema, str } from './registry';

interface T { id: number; label: string; total: number; due: number; handle: ReturnType<typeof setTimeout> }
const timers = new Map<number, T>();
let nextId = 1;
let ticker: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<(label: string, seconds: number) => void>();

export const onTimerDone = (cb: (label: string, seconds: number) => void): (() => void) => {
  listeners.add(cb);
  return () => { listeners.delete(cb); };
};

function snapshot(): TimerInfo[] {
  const now = Date.now();
  return [...timers.values()].sort((a, b) => a.id - b.id)
    .map((t) => ({ id: t.id, label: t.label, remaining: Math.max(0, Math.round((t.due - now) / 1000)), total: t.total }));
}

function publish(): void {
  useNexus.getState().setTimers(snapshot());
  if (timers.size && !ticker) ticker = setInterval(publish, 1000);
  if (!timers.size && ticker) { clearInterval(ticker); ticker = null; }
}

export function clearTimers(): void {
  for (const t of timers.values()) clearTimeout(t.handle);
  timers.clear();
  publish();
}

function fire(id: number): void {
  const t = timers.get(id);
  if (!t) return;
  timers.delete(id);
  publish();
  useNexus.getState().toast(`⏰ ${t.label} doldu`, 'ok');
  for (const cb of [...listeners]) {
    try { cb(t.label, t.total); } catch { /* dinleyici hatası zamanlayıcıyı bozmaz */ }
  }
}

registerTool({
  name: 'set_timer', description: 'Geri sayım zamanlayıcısı kurar.',
  parameters: schema({ seconds: prop('number', 'Saniye'), minutes: prop('number', 'Dakika'), label: prop('string', 'Ad') }),
  handler(a) {
    const secs = num(a, 'seconds') + 60 * num(a, 'minutes');
    if (!(secs > 0)) return { error: 'Süre sıfırdan büyük olmalı.' };
    if (secs > 86400) return { error: 'En fazla 24 saatlik zamanlayıcı kurulabilir.' };
    const id = nextId++;
    const label = str(a, 'label') || `Zamanlayıcı ${id}`;
    timers.set(id, { id, label, total: secs, due: Date.now() + secs * 1000, handle: setTimeout(() => fire(id), secs * 1000) });
    publish();
    return `${label}: ${Math.round(secs)} saniye sonra çalacak.`;
  },
});

registerTool({
  name: 'list_timers', description: 'Çalışan zamanlayıcıları listeler.', parameters: schema({}),
  handler: () => (snapshot().length ? snapshot().map((t) => `${t.id}. ${t.label}: ${t.remaining} sn kaldı`).join('\n') : 'Çalışan zamanlayıcı yok.'),
});

registerTool({
  name: 'cancel_timer', description: 'Zamanlayıcıyı iptal eder (numara ya da ad ile).',
  parameters: schema({ id: prop('number', 'Zamanlayıcı numarası'), label: prop('string', 'Ad (kısmi eşleşme)') }),
  handler(a) {
    const id = num(a, 'id'), label = str(a, 'label').toLowerCase();
    const hit = [...timers.values()].filter((t) => (id && t.id === id) || (label && t.label.toLowerCase().includes(label)));
    if (!hit.length) return { error: 'Eşleşen zamanlayıcı yok.' };
    for (const t of hit) { clearTimeout(t.handle); timers.delete(t.id); }
    publish();
    return `${hit.length} zamanlayıcı iptal edildi.`;
  },
});
