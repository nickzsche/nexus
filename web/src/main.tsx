import { createRoot } from 'react-dom/client';
import App from './App';
import { setCore } from './core/api';
import { MockCore } from './core/mock';
import { Orchestrator } from './core/orchestrator';
import { apiKey, hasApiKey, saveSettings, setApiKey } from './core/settingsStore';
import './ui/styles.css';

const params = new URLSearchParams(location.search);

// Geliştirme kolaylığı: yalnızca `npm run dev` iken, git'e girmeyen web/.env.local içindeki anahtar bir kez yüklenir.
// Üretim derlemesinde bu dal tamamen çıkar; anahtar hiçbir zaman kaynak koda yazılmaz.
if (import.meta.env.DEV && !params.has('demo') && !hasApiKey()) {
  const devKey = String(import.meta.env.VITE_DEV_GEMINI_KEY ?? '').trim();
  if (devKey) { setApiKey(devKey); saveSettings({ onboarded: true }); }
}

// ?demo → sahte çekirdek (anahtarsız gösteri); aksi hâlde gerçek orkestratör (Gemini Live doğrudan tarayıcıdan).
const impl = params.has('demo') ? new MockCore() : new Orchestrator();
if (impl instanceof MockCore && params.has('fast')) impl.speed = 0.15;
setCore(impl);
if (import.meta.env.DEV) (window as unknown as { __nexus: unknown }).__nexus = { impl, hasKey: () => !!apiKey() };
createRoot(document.getElementById('root')!).render(<App />);
void impl.start();
