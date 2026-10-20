/**
 * Yardımcı Gemini çağrıları (REST): TTS (rakip sesleri, arena), araya girme metni, arena metni.
 *
 * Anahtar URL'ye değil `x-goog-api-key` başlığına konur. Hata verirse çağıran sessizce atlar.
 * TTS yolu (gerçek API ile doğrulandı): Interactions API `POST /v1beta/interactions` → `steps[].content[]` içinde
 * `audio/wav` base64. `generateContent` TTS modellerinde 404 verir; yalnızca başka modeller için yedek denenir.
 */
import { CHIPS } from '../data/chips';
import type { ArenaLine, ChipKey } from '../types';
import { CHIP_KEYS } from '../types';
import { bytesFromB64 } from './live';

const BASE = 'https://generativelanguage.googleapis.com/v1beta';
export const ATTEMPT_MS = 10_000;               // model başına zaman aşımı
export const INTERJECT_MS = 8_000;              // araya girme metni için toplam üst sınır
export const TTS_RATE = 24_000;
const CACHE_SIZE = 64;
const RATE_LIMIT_SKIP_MS = 60 * 60 * 1000;      // günlük kota dolan model bir saat atlanır

export class AuxError extends Error {}

export interface AuxOptions {
  apiKey: () => string;
  textModels: () => string[];
  ttsModels: () => string[];
  voice: (chip: ChipKey) => string;
  /** İsteğe bağlı: ilişki puanı ve etiketi (araya girme/arena istemine eklenir). */
  relation?: (a: ChipKey, b: ChipKey) => { score: number; label: string };
  /** Test için. */
  fetchImpl?: typeof fetch;
}

// ------------------------------------------------------------------ saf yardımcılar
export function cleanLine(text: string, maxWords = 18): string {
  const first = (text ?? '').trim().split(/\r?\n/)[0] ?? '';
  let t = first.replace(/[*_`#>]+/g, '').trim();
  const names = CHIP_KEYS.map((k) => CHIPS[k].name).join('|');
  t = t.replace(new RegExp(`^\\s*(?:${names})\\s*[:\\-–—]\\s*`, 'i'), '').trim();
  t = t.replace(/^["'“”‘’«»\s]+|["'“”‘’«»\s]+$/g, '');
  const words = t.split(/\s+/).filter(Boolean);
  if (words.length > maxWords) t = words.slice(0, maxWords).join(' ').replace(/[,;:]+$/, '') + '…';
  return t;
}

export function parseDebate(raw: string, a: ChipKey, b: ChipKey): ArenaLine[] {
  let data: unknown;
  try {
    data = JSON.parse(raw.trim().replace(/^```(?:json)?\s*|\s*```$/g, ''));
  } catch (e) {
    throw new AuxError(`arena JSON'u çözülemedi: ${e instanceof Error ? e.message : e}`);
  }
  const lines = Array.isArray(data) ? data : (data as { lines?: unknown })?.lines;
  if (!Array.isArray(lines)) throw new AuxError('arena JSON biçimi geçersiz');
  const out: ArenaLine[] = [];
  for (const item of lines as Array<Record<string, unknown>>) {
    const who = String(item?.who ?? '').toLowerCase() as ChipKey;
    const text = cleanLine(String(item?.text ?? ''), 25);
    if ((who === a || who === b) && text) out.push({ who, text });
  }
  if (out.length < 2) throw new AuxError('arena için yeterli satır üretilemedi');
  return out.slice(0, 6);
}

/** WAV (RIFF) → mono int16 PCM ve örnekleme hızı. */
export function pcmFromWav(wav: Uint8Array): { pcm: Int16Array; rate: number } {
  const dv = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
  const tag = (o: number) => String.fromCharCode(dv.getUint8(o), dv.getUint8(o + 1), dv.getUint8(o + 2), dv.getUint8(o + 3));
  if (wav.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') throw new AuxError('WAV başlığı geçersiz');
  let ch = 1, rate = TTS_RATE, bits = 16, dataOff = -1, dataLen = 0;
  for (let o = 12; o + 8 <= wav.length;) {
    const id = tag(o);
    const size = dv.getUint32(o + 4, true);
    if (id === 'fmt ') { ch = dv.getUint16(o + 10, true); rate = dv.getUint32(o + 12, true); bits = dv.getUint16(o + 22, true); }
    if (id === 'data') { dataOff = o + 8; dataLen = Math.min(size, wav.length - dataOff); break; }
    o += 8 + size + (size & 1);
  }
  if (dataOff < 0) throw new AuxError('WAV veri parçası yok');
  if (bits !== 16) throw new AuxError('yalnızca 16 bit WAV destekleniyor');
  const n = Math.floor(dataLen / 2 / ch);
  const out = new Int16Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let c = 0; c < ch; c++) s += dv.getInt16(dataOff + (i * ch + c) * 2, true);
    out[i] = Math.round(s / ch);
  }
  return { pcm: out, rate };
}

/** Doğrusal ara değerlemeyle yeniden örnekleme (konuşma için yeterli). */
export function resample(pcm: Int16Array, from: number, to = TTS_RATE): Int16Array {
  if (from === to || !pcm.length) return pcm;
  const n = Math.max(1, Math.round((pcm.length * to) / from));
  const out = new Int16Array(n);
  const k = from / to;
  for (let i = 0; i < n; i++) {
    const pos = i * k, i0 = Math.floor(pos), f = pos - i0;
    const a = pcm[Math.min(i0, pcm.length - 1)], b = pcm[Math.min(i0 + 1, pcm.length - 1)];
    out[i] = Math.round(a + (b - a) * f);
  }
  return out;
}

const toBytes = (p: Int16Array): Uint8Array => new Uint8Array(p.buffer, p.byteOffset, p.byteLength);

function mimeRate(mime: string | undefined): number | null {
  const m = /rate=(\d+)/i.exec(mime ?? '');
  return m ? Number(m[1]) : null;
}

// ------------------------------------------------------------------ Aux
export class Aux {
  private o: AuxOptions;
  private cache = new Map<string, Uint8Array>();
  private goodText: string | null = null;
  private skipUntil = new Map<string, number>();

  constructor(o: AuxOptions) {
    this.o = o;
  }

  private f(): typeof fetch {
    return this.o.fetchImpl ?? globalThis.fetch.bind(globalThis);
  }

  private key(): string {
    const k = this.o.apiKey();
    if (!k) throw new AuxError('API anahtarı yok');
    return k;
  }

  private async post(path: string, body: unknown, timeoutMs: number): Promise<{ status: number; json: any }> {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    try {
      const res = await this.f()(`${BASE}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-goog-api-key': this.key() },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });
      let json: any = null;
      try { json = await res.json(); } catch { /* boş gövde */ }
      return { status: res.status, json };
    } finally {
      clearTimeout(timer);
    }
  }

  // ------------------------------------------------------------------ TTS
  private async ttsOnce(model: string, text: string, voice: string, style: string): Promise<Uint8Array> {
    // Birincil: Interactions API
    const r = await this.post('/interactions', {
      model,
      input: [{ type: 'user_input', content: [{ type: 'text', text, annotations: [{ type: 'speech_metadata', style }] }] }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice }] },
    }, ATTEMPT_MS * 2);
    if (r.status === 429) {
      this.skipUntil.set(model, Date.now() + RATE_LIMIT_SKIP_MS);
      throw new AuxError(`${model}: kota doldu`);
    }
    if (r.status === 200) {
      const content = (r.json?.steps ?? []).flatMap((s: any) => s?.content ?? []);
      const audio = content.find((c: any) => c?.type === 'audio' && c?.data);
      if (audio) {
        const bytes = bytesFromB64(audio.data);
        const mime: string = audio.mime_type ?? audio.mimeType ?? 'audio/wav';
        if (/wav|wave/i.test(mime) || String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF') {
          const { pcm, rate } = pcmFromWav(bytes);
          return toBytes(resample(pcm, rate));
        }
        const rate = mimeRate(mime) ?? TTS_RATE;
        return toBytes(resample(new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.byteLength & ~1))), rate));
      }
    }
    // Yedek: generateContent (yalnızca onu destekleyen modeller için işe yarar)
    const g = await this.post(`/models/${model}:generateContent`, {
      contents: [{ parts: [{ text }] }],
      generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
    }, ATTEMPT_MS * 2);
    const part = g.json?.candidates?.[0]?.content?.parts?.[0];
    const inline = part?.inlineData ?? part?.inline_data;
    if (g.status === 200 && inline?.data) {
      const bytes = bytesFromB64(inline.data);
      const rate = mimeRate(inline.mimeType ?? inline.mime_type) ?? TTS_RATE;
      return toBytes(resample(new Int16Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + (bytes.byteLength & ~1))), rate));
    }
    throw new AuxError(`${model}: TTS başarısız (interactions ${r.status}, generateContent ${g.status})`);
  }

  /** Çipin sesiyle 24 kHz mono int16 PCM (FX uygulanmadan). LRU önbellekli. */
  async tts(chip: ChipKey, text: string): Promise<Uint8Array> {
    const voice = this.o.voice(chip);
    const style = CHIPS[chip].style;
    const ck = `${voice}|${style}|${text}`;
    const hit = this.cache.get(ck);
    if (hit) { this.cache.delete(ck); this.cache.set(ck, hit); return hit; }
    const errors: string[] = [];
    const now = Date.now();
    const models = this.o.ttsModels();
    const usable = models.filter((m) => (this.skipUntil.get(m) ?? 0) < now);
    for (const model of usable.length ? usable : models) {
      try {
        const pcm = await this.ttsOnce(model, text, voice, style);
        this.cache.set(ck, pcm);
        while (this.cache.size > CACHE_SIZE) this.cache.delete(this.cache.keys().next().value as string);
        return pcm;
      } catch (e) {
        errors.push(e instanceof Error ? e.message : String(e));
      }
    }
    throw new AuxError('TTS başarısız: ' + errors.map((e) => e.slice(0, 120)).join(' | '));
  }

  // ------------------------------------------------------------------ metin
  /** Model zinciri + model başına 10 sn; çalışan model hatırlanır. `deadlineMs` toplam üst sınırdır. */
  async text(system: string, prompt: string, o: { json?: boolean; deadlineMs?: number } = {}): Promise<string> {
    const end = o.deadlineMs ? Date.now() + o.deadlineMs : Infinity;
    const order = [this.goodText, ...this.o.textModels()].filter((m): m is string => !!m);
    const errors: string[] = [];
    for (const model of [...new Set(order)]) {
      const left = end - Date.now();
      if (left <= 0) break;
      try {
        const r = await this.post(`/models/${model}:generateContent`, {
          systemInstruction: { parts: [{ text: system }] },
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 1.0, ...(o.json ? { responseMimeType: 'application/json' } : {}) },
        }, Math.min(ATTEMPT_MS, left));
        const parts = r.json?.candidates?.[0]?.content?.parts as Array<{ text?: string }> | undefined;
        const out = (parts ?? []).map((p) => p.text ?? '').join('');
        if (r.status === 200 && out) { this.goodText = model; return out; }
        errors.push(`${model}: ${r.status}`);
      } catch (e) {
        errors.push(`${model}: ${e instanceof Error ? e.name : e}`);
      }
    }
    throw new AuxError('metin üretilemedi: ' + errors.join(' | '));
  }

  private rel(a: ChipKey, b: ChipKey): string {
    const r = this.o.relation?.(a, b);
    return r ? `${r.label} (${r.score >= 0 ? '+' : ''}${r.score})` : 'gergin';
  }

  /** Rakibin tek kısa cümlelik araya girmesi; üretilemezse null. */
  async interjectText(rival: ChipKey, active: ChipKey, userText: string, aiText: string): Promise<string | null> {
    const rv = CHIPS[rival], ac = CHIPS[active];
    const system = `${rv.character}\n\nŞu an ${ac.name} ile konuşan kullanıcıya yardım ediyor. ${ac.name} ile ilişkin: ${this.rel(active, rival)}.`;
    const prompt = `Son konuşma:\nKullanıcı: ${userText.slice(0, 300)}\n${ac.name}: ${aiText.slice(0, 300)}\n\n` +
      `Bu konuşmaya araya giren TEK kısa cümle yaz (en fazla 18 kelime), karakterine uygun, kullanıcıya değil ${ac.name}'a yönelik. ` +
      'Hakaret ve küfür yok. Yalnızca cümleyi yaz.';
    try {
      const raw = await this.text(system, prompt, { deadlineMs: INTERJECT_MS });
      return cleanLine(raw, 18) || null;
    } catch {
      return null;                                           // araya girme asla akışı bozmaz
    }
  }

  /** Arena: 6 satır, sırayla a, b, a, b, a, b. */
  async debateLines(a: ChipKey, b: ChipKey, topic: string): Promise<ArenaLine[]> {
    const ca = CHIPS[a], cb = CHIPS[b];
    const system = `Bir sesli tartışma yazıyorsun. İki çip konu hakkında karakterlerine uygun tartışıyor.\n\n${ca.name}: ${ca.character}\n\n` +
      `${cb.name}: ${cb.character}\n\nAralarındaki ilişki: ${this.rel(a, b)}.`;
    const prompt = `Konu: ${topic}\n\nJSON üret: {"lines":[{"who":"${a}","text":"..."}, ...]}. Tam 6 satır, sırayla ${a}, ${b}, ${a}, ${b}, ${a}, ${b} ` +
      '(her çipten 3). Satır başına en fazla 25 kelime. Son satırlar bir sonuca yaklaşsın. Küfür ve kullanıcıya hakaret yok, kavga zekice olsun.';
    return parseDebate(await this.text(system, prompt, { json: true }), a, b);
  }
}
