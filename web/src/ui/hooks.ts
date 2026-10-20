import { useEffect, useRef, useState } from 'react';
import { core } from '../core/api';
import { CHIP_KEYS } from '../types';
import { useNexus } from '../state/store';
import { sfx } from './sfx';

/** Saat (dakika çözünürlüklü). */
export function useClock(): string {
  const fmt = () => new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
  const [t, setT] = useState(fmt);
  useEffect(() => { const i = setInterval(() => setT(fmt()), 1000); return () => clearInterval(i); }, []);
  return t;
}

/** Aktif çipin renklerini kök CSS değişkenlerine yazar (geçişi CSS @property yapar). */
export function applyTheme(colors: { main: string; accent: string; deep: string; ink: string }): void {
  const r = document.documentElement.style;
  r.setProperty('--main', colors.main);
  r.setProperty('--accent', colors.accent);
  r.setProperty('--deep', colors.deep);
  r.setProperty('--ink', colors.ink);
  const h = colors.main.replace('#', '');
  r.setProperty('--main-rgb', `${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)}`);
}

/** Küresel kısayollar: Ctrl+Space mikrofon, Ctrl+1…0 çip, Esc modal, bas-konuş Boşluk, Ctrl+Shift+Alt+S geliştirici. */
export function useShortcuts(): void {
  useEffect(() => {
    const typing = () => /INPUT|TEXTAREA|SELECT/.test(document.activeElement?.tagName ?? '');
    const down = (e: KeyboardEvent) => {
      const st = useNexus.getState();
      if (e.ctrlKey && e.code === 'Space') { e.preventDefault(); void core().setMic(!st.micOn); sfx.click(); return; }
      if (e.ctrlKey && /^Digit\d$/.test(e.code)) {
        const n = Number(e.code.slice(5));
        const k = CHIP_KEYS[n === 0 ? 9 : n - 1];
        if (k) { e.preventDefault(); void core().mount(k); }
        return;
      }
      if (e.ctrlKey && e.shiftKey && e.altKey && e.code === 'KeyS' && import.meta.env.DEV) { core().devStoryDue(); return; }
      if (e.code === 'Space' && st.settings.listenMode === 'ptt' && !typing() && !e.repeat && !st.modal) { e.preventDefault(); core().ptt(true); document.body.classList.add('ptt'); }
    };
    const up = (e: KeyboardEvent) => {
      if (e.code === 'Space' && document.body.classList.contains('ptt')) { core().ptt(false); document.body.classList.remove('ptt'); }
    };
    addEventListener('keydown', down);
    addEventListener('keyup', up);
    return () => { removeEventListener('keydown', down); removeEventListener('keyup', up); };
  }, []);
}

/** Basit odak tuzağı + Esc: modal kökü için. */
export function useFocusTrap(onClose: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const root = ref.current;
    const prev = document.activeElement as HTMLElement | null;
    const focusables = () => Array.from(root?.querySelectorAll<HTMLElement>('button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea,[tabindex]:not([tabindex="-1"]),a[href]') ?? []).filter((e) => e.offsetParent !== null);
    (focusables().find((e) => !e.hasAttribute('data-close')) ?? focusables()[0])?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { e.stopPropagation(); onClose(); return; }
      if (e.key !== 'Tab') return;
      const f = focusables();
      if (!f.length) return;
      const first = f[0];
      const last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    root?.addEventListener('keydown', key);
    return () => { root?.removeEventListener('keydown', key); prev?.focus?.(); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return ref;
}

export const fmtDur = (s: number): string => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const ss = s % 60;
  return (h ? `${h}:${String(m).padStart(2, '0')}` : String(m).padStart(2, '0')) + ':' + String(ss).padStart(2, '0');
};
export const signed = (n: number): string => (n < 0 ? '−' + Math.abs(n) : n > 0 ? '+' + n : '0');
export const scoreLabel = (s: number): string =>
  s <= -70 ? 'ezeli düşman' : s <= -40 ? 'düşman' : s <= -15 ? 'gergin' : s < 15 ? 'nötr' : s < 50 ? 'iyi' : 'kardeş';
