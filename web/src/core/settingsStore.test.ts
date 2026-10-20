import { beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_SETTINGS, useNexus } from '../state/store';
import {
  apiKey, clearApiKey, getSettings, hasApiKey, loadSettings, saveSettings, setApiKey, setSecretStore,
} from './settingsStore';
import { resetAll } from './testUtils';

beforeEach(resetAll);

describe('settingsStore', () => {
  it('varsayılan Live modeli yalnızca gemini-2.5-flash-native-audio-latest', () => {
    expect(DEFAULT_SETTINGS.liveModels).toEqual(['gemini-2.5-flash-native-audio-latest']);
    expect(loadSettings().liveModels).toEqual(['gemini-2.5-flash-native-audio-latest']);
    expect(getSettings().liveModels).toHaveLength(1);
  });

  it('kayıtlı ayarlar birleşir; boş model listesi varsayılana döner', () => {
    localStorage.setItem('nexus.settings', JSON.stringify({ drama: 'kaos', userName: 'Sahan', liveModels: [] }));
    const s = loadSettings();
    expect(s.drama).toBe('kaos');
    expect(s.userName).toBe('Sahan');
    expect(s.liveModels).toEqual(DEFAULT_SETTINGS.liveModels);
    expect(s.shellConfirm).toBe(true);
  });

  it('bozuk kayıt uygulamayı düşürmez', () => {
    localStorage.setItem('nexus.settings', '{bozuk');
    expect(loadSettings().drama).toBe('normal');
  });

  it('saveSettings depoyu ve localStorage\'ı günceller', () => {
    saveSettings({ drama: 'sakin' });
    expect(useNexus.getState().settings.drama).toBe('sakin');
    expect(JSON.parse(localStorage.getItem('nexus.settings')!).drama).toBe('sakin');
  });

  it('API anahtarı store\'a ve ayar dosyasına sızmaz; yalnızca hasKey', () => {
    const KEY = 'AIzaSyFAKE_KEY_FOR_TEST_1234567890abcdef';
    expect(hasApiKey()).toBe(false);
    setApiKey(`  ${KEY}  `);
    expect(apiKey()).toBe(KEY);
    expect(hasApiKey()).toBe(true);
    expect(useNexus.getState().hasKey).toBe(true);
    expect(JSON.stringify(useNexus.getState())).not.toContain(KEY);
    saveSettings({ userName: 'x' });
    expect(localStorage.getItem('nexus.settings')).not.toContain(KEY);
    clearApiKey();
    expect(hasApiKey()).toBe(false);
    expect(useNexus.getState().hasKey).toBe(false);
  });

  it('SecretStore değiştirilebilir (Electron anahtar zinciri)', () => {
    let mem = 'kasa-anahtar';
    setSecretStore({ get: () => mem, set: (k) => { mem = k; }, clear: () => { mem = ''; } });
    expect(apiKey()).toBe('kasa-anahtar');
    expect(useNexus.getState().hasKey).toBe(true);
    setApiKey('yeni');
    expect(mem).toBe('yeni');
    expect(localStorage.getItem('nexus.key')).toBeNull();
    setSecretStore({ get: () => localStorage.getItem('nexus.key') ?? '', set: (k) => localStorage.setItem('nexus.key', k), clear: () => localStorage.removeItem('nexus.key') });
  });
});
