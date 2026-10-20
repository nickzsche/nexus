// @vitest-environment node
/**
 * Gerçek API entegrasyon testi (varsayılan olarak atlanır). Çalıştırmak için:
 *   set -a; . "$HOME/Library/Application Support/Jarvis/.env"; set +a; NEXUS_LIVE=1 npx vitest run src/core/live.integration.test.ts
 * Anahtar yalnızca ortamdan okunur; hiçbir yere yazılmaz.
 */
import { describe, expect, it } from 'vitest';
import { Aux } from './aux';
import { LiveSession } from './live';

const env: Record<string, string | undefined> = (globalThis as { process?: { env: Record<string, string | undefined> } }).process?.env ?? {};
const KEY = env.GEMINI_API_KEY ?? '';
const RUN = env.NEXUS_LIVE === '1' && !!KEY;

describe.skipIf(!RUN)('gerçek Gemini (NEXUS_LIVE=1)', () => {
  it('LiveSession: yazıyla gönder → ses + transkript + tur sonu', async () => {
    const audio: number[] = [];
    let ai = '';
    let done: () => void = () => undefined;
    const turn = new Promise<void>((r) => { done = r; });
    const t0 = Date.now();
    let first = 0;
    const s = new LiveSession({
      apiKey: () => KEY, models: () => ['gemini-2.5-flash-native-audio-latest'], voice: () => 'Aoede',
      systemInstruction: () => 'Sen NOVA\'sın. Kısa, sıcak Türkçe konuş.', tools: () => [], runTool: async () => ({ result: 'ok' }),
      callbacks: {
        onAudio: (b) => { if (!first) first = Date.now() - t0; audio.push(b.length); },
        onText: (r, d) => { if (r === 'ai') ai += d; },
        onLineEnd: () => undefined, onStatus: () => undefined, onInterrupted: () => undefined, onTool: () => undefined,
        onError: (m) => { throw new Error(m); }, onReady: () => undefined, onTurnComplete: () => done(),
      },
    });
    await s.start('nova');
    s.sendText('Merhaba, nasılsın?');
    await Promise.race([turn, new Promise((_, rej) => setTimeout(() => rej(new Error('tur zaman aşımı')), 25000))]);
    await s.stop();
    expect(audio.reduce((a, b) => a + b, 0)).toBeGreaterThan(5000);
    expect(ai.trim().length).toBeGreaterThan(0);
    console.log(`ilk ses ${first} ms`);
  }, 40000);

  it('Aux: TTS (24 kHz PCM) ve araya girme metni', async () => {
    const aux = new Aux({
      apiKey: () => KEY, voice: () => 'Alnilam', textModels: () => ['gemini-flash-latest', 'gemini-3-flash-preview'],
      ttsModels: () => ['gemini-3.8-flash-tts', 'gemini-3.8-flash-lite-tts'],
    });
    const pcm = await aux.tts('sentinel', 'Operatör, kanal açık.');
    expect(pcm.byteLength).toBeGreaterThan(20000);
    const line = await aux.interjectText('sentinel', 'forge', 'deploy ettim', 'Tamam usta.');
    expect(line === null || line.split(' ').length <= 19).toBe(true);
  }, 60000);
});
