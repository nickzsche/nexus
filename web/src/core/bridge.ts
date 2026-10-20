/** Sistem köprüsü: web'de sınırlı, Electron'da tam. Araçlar işletim sistemi işini buradan ister. */
import type { SystemBridge } from '../types';

export const DESKTOP_ONLY = 'Bu özellik masaüstü sürümünde (Electron) çalışır.';

export const webBridge: SystemBridge = {
  platform: 'web',
  has: () => false,
  call: async () => ({ error: DESKTOP_ONLY }),
};

export let bridge: SystemBridge = webBridge;
export const getBridge = (): SystemBridge => bridge;
export function setBridge(b: SystemBridge): void {
  bridge = b;
}
