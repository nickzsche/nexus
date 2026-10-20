/** Ayarlar ve API anahtarı. Anahtar yalnızca SecretStore'da durur; store'a yalnızca `hasKey` boolean'ı yazılır. */
import { DEFAULT_SETTINGS, useNexus } from '../state/store';
import type { Settings } from '../types';

export function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = globalThis.localStorage?.getItem(key);
    return raw == null ? fallback : (JSON.parse(raw) as T);
  } catch {
    return fallback;                                  // bozuk kayıt uygulamayı düşürmez
  }
}

export function writeJson(key: string, value: unknown): void {
  try {
    globalThis.localStorage?.setItem(key, JSON.stringify(value));
  } catch { /* kota/gizli mod: sessizce geç */ }
}

/** Anahtar deposu. Web'de localStorage; Electron'da işletim sistemi anahtar zinciri (safeStorage) ile değiştirilir. */
export interface SecretStore {
  get(): string;
  set(key: string): void;
  clear(): void;
}

const KEY_NAME = 'nexus.key';
const localSecret: SecretStore = {
  get: () => { try { return globalThis.localStorage?.getItem(KEY_NAME) ?? ''; } catch { return ''; } },
  set: (k) => { try { globalThis.localStorage?.setItem(KEY_NAME, k); } catch { /* yoksay */ } },
  clear: () => { try { globalThis.localStorage?.removeItem(KEY_NAME); } catch { /* yoksay */ } },
};
let secret: SecretStore = localSecret;

export function setSecretStore(s: SecretStore): void {
  secret = s;
  useNexus.getState().setHasKey(hasApiKey());
}

export const apiKey = (): string => secret.get().trim();
export const hasApiKey = (): boolean => apiKey().length > 0;

export function setApiKey(k: string): void {
  secret.set(k.trim());
  useNexus.getState().setHasKey(hasApiKey());
}

export function clearApiKey(): void {
  secret.clear();
  useNexus.getState().setHasKey(false);
}

export function loadSettings(): Settings {
  const saved = readJson<Partial<Settings>>('nexus.settings', {});
  const merged: Settings = { ...DEFAULT_SETTINGS, ...saved };
  // Boş ya da bozuk model listeleri varsayılana döner (Live: yalnızca kullanıcının seçtiği model).
  for (const k of ['liveModels', 'textModels', 'ttsModels'] as const) {
    if (!Array.isArray(merged[k]) || merged[k].length === 0) merged[k] = DEFAULT_SETTINGS[k];
  }
  const st = useNexus.getState();
  st.patchSettings(merged);
  st.setHasKey(hasApiKey());
  return merged;
}

export const getSettings = (): Settings => useNexus.getState().settings;

export function saveSettings(p: Partial<Settings>): void {
  useNexus.getState().patchSettings(p);
  writeJson('nexus.settings', getSettings());
}
