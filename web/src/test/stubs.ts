/** jsdom'da olmayan tarayıcı API'leri için sahte tanımlar (ui testleri bunu içe aktarır). */
import { vi } from 'vitest';

HTMLCanvasElement.prototype.getContext = (() => null) as never;
if (!window.matchMedia) {
  window.matchMedia = ((q: string) => ({ matches: false, media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null })) as never;
}
if (!('ResizeObserver' in window)) {
  (window as unknown as Record<string, unknown>).ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}
Element.prototype.scrollIntoView = vi.fn();
