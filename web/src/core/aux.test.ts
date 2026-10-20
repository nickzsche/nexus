import { describe, expect, it, vi } from 'vitest';
import { Aux, AuxError, cleanLine, parseDebate, pcmFromWav, resample, type AuxOptions } from './aux';
import { b64FromBytes } from './live';

/** Basit WAV üretici (16 bit PCM). */
function wav(samples: Int16Array, rate = 24000, ch = 1): Uint8Array {
  const data = new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength);
  const out = new Uint8Array(44 + data.length);
  const dv = new DataView(out.buffer);
  const w = (o: number, s: string) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); dv.setUint32(4, 36 + data.length, true); w(8, 'WAVE'); w(12, 'fmt ');
  dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, ch, true); dv.setUint32(24, rate, true);
  dv.setUint32(28, rate * ch * 2, true); dv.setUint16(32, ch * 2, true); dv.setUint16(34, 16, true);
  w(36, 'data'); dv.setUint32(40, data.length, true); out.set(data, 44);
  return out;
}

const ramp = (n: number) => Int16Array.from({ length: n }, (_, i) => (i * 7) % 3000);
const json = (status: number, body: unknown) => Promise.resolve({ status, json: async () => body } as Response);
const interactionsOk = (pcm: Int16Array, rate = 24000) => json(200, { steps: [{ type: 'model_output', content: [{ type: 'audio', mime_type: 'audio/wav', data: b64FromBytes(wav(pcm, rate)) }] }] });
const textOk = (text: string) => json(200, { candidates: [{ content: { parts: [{ text }] } }] });

function make(fetchImpl: (url: string, init: RequestInit) => Promise<Response>, over: Partial<AuxOptions> = {}) {
  const f = vi.fn(fetchImpl as any);
  const aux = new Aux({
    apiKey: () => 'SECRET-KEY', textModels: () => ['t1', 't2'], ttsModels: () => ['tts-a', 'tts-b'], voice: (c) => `V-${c}`,
    relation: () => ({ score: -40, label: 'düşman' }), fetchImpl: f as unknown as typeof fetch, ...over,
  });
  return { aux, f };
}

describe('cleanLine', () => {
  it('tırnak, markdown ve isim önekini temizler; ilk satırı alır', () => {
    expect(cleanLine('**SENTINEL:** "Deploy mu dedin?"\nikinci satır')).toBe('Deploy mu dedin?');
    expect(cleanLine('  forge - tamam usta  ')).toBe('tamam usta');
    expect(cleanLine('“Merhaba”')).toBe('Merhaba');
    expect(cleanLine('')).toBe('');
  });
  it('kelime sınırını uygular ve … ekler', () => {
    const t = cleanLine(Array.from({ length: 30 }, (_, i) => `k${i}`).join(' '), 18);
    expect(t.split(' ')).toHaveLength(18);
    expect(t.endsWith('…')).toBe(true);
    expect(cleanLine('a b c', 18)).toBe('a b c');
  });
});

describe('parseDebate', () => {
  const six = ['sentinel', 'forge', 'sentinel', 'forge', 'sentinel', 'forge'].map((who, i) => ({ who, text: `satır ${i}` }));
  it('JSON (kod çiti dahil) → 6 satır', () => {
    expect(parseDebate('```json\n' + JSON.stringify({ lines: six }) + '\n```', 'sentinel', 'forge')).toHaveLength(6);
    expect(parseDebate(JSON.stringify(six), 'sentinel', 'forge')).toHaveLength(6);
  });
  it('yabancı çipi, boş metni eler; 6\'dan fazlayı keser; 25 kelimeye sınırlar', () => {
    const long = Array.from({ length: 40 }, (_, i) => `w${i}`).join(' ');
    const r = parseDebate(JSON.stringify({ lines: [...six, { who: 'sentinel', text: 'fazla' }, { who: 'atlas', text: 'yabancı' }, { who: 'forge', text: '' }, { who: 'forge', text: long }] }), 'sentinel', 'forge');
    expect(r).toHaveLength(6);
    const r2 = parseDebate(JSON.stringify({ lines: [{ who: 'forge', text: long }, { who: 'sentinel', text: 'x' }] }), 'sentinel', 'forge');
    expect(r2[0].text.split(' ')).toHaveLength(25);
  });
  it('geçersiz JSON ya da <2 satır AuxError', () => {
    expect(() => parseDebate('bozuk', 'sentinel', 'forge')).toThrow(AuxError);
    expect(() => parseDebate(JSON.stringify({ lines: [{ who: 'forge', text: 'tek' }] }), 'sentinel', 'forge')).toThrow(AuxError);
    expect(() => parseDebate('{"x":1}', 'sentinel', 'forge')).toThrow(AuxError);
  });
});

describe('WAV ve yeniden örnekleme', () => {
  it('mono WAV çözülür', () => {
    const { pcm, rate } = pcmFromWav(wav(ramp(100), 16000));
    expect(rate).toBe(16000);
    expect(Array.from(pcm)).toEqual(Array.from(ramp(100)));
  });
  it('stereo mono\'ya indirilir; geçersiz başlık hata verir', () => {
    const st = new Int16Array([100, 300, 200, 400]);
    expect(Array.from(pcmFromWav(wav(st, 24000, 2)).pcm)).toEqual([200, 300]);
    expect(() => pcmFromWav(new Uint8Array(20))).toThrow(AuxError);
  });
  it('16 kHz → 24 kHz uzunluğu 1.5 katına çıkar; aynı hızda aynen döner', () => {
    expect(resample(ramp(160), 16000, 24000)).toHaveLength(240);
    const x = ramp(10);
    expect(resample(x, 24000, 24000)).toBe(x);
  });
});

describe('Aux.tts', () => {
  it('Interactions API: anahtar BAŞLIKTA (URL\'de değil), WAV 24 kHz PCM olur', async () => {
    const { aux, f } = make(() => interactionsOk(ramp(2400)));
    const pcm = await aux.tts('sentinel', 'Merhaba');
    expect(pcm).toBeInstanceOf(Uint8Array);
    expect(pcm.byteLength).toBe(2400 * 2);
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://generativelanguage.googleapis.com/v1beta/interactions');
    expect(url).not.toContain('SECRET');
    expect((init.headers as Record<string, string>)['x-goog-api-key']).toBe('SECRET-KEY');
    const body = JSON.parse(init.body as string);
    expect(body.model).toBe('tts-a');
    expect(body.generation_config.speech_config).toEqual([{ voice: 'V-sentinel' }]);
    expect(body.input[0].content[0].annotations[0]).toEqual({ type: 'speech_metadata', style: 'terse, radio report' });
    expect(body.response_format).toEqual({ type: 'audio' });
  });

  it('24 kHz olmayan WAV yeniden örneklenir', async () => {
    const { aux } = make(() => interactionsOk(ramp(1600), 16000));
    expect((await aux.tts('atlas', 'x')).byteLength).toBe(2400 * 2);
  });

  it('LRU: aynı metin+ses ikinci kez ağa gitmez; 64\'ten fazlası eskiyi atar', async () => {
    const { aux, f } = make(() => interactionsOk(ramp(100)));
    await aux.tts('atlas', 'aynı');
    await aux.tts('atlas', 'aynı');
    expect(f).toHaveBeenCalledTimes(1);
    await aux.tts('forge', 'aynı');                          // farklı ses = farklı anahtar
    expect(f).toHaveBeenCalledTimes(2);
    for (let i = 0; i < 70; i++) await aux.tts('atlas', `m${i}`);
    f.mockClear();
    await aux.tts('atlas', 'aynı');                          // atılmıştı: yeniden istek
    expect(f).toHaveBeenCalledTimes(1);
  });

  it('429 (günlük kota): model bir saat atlanır, sıradaki model denenir', async () => {
    let call = 0;
    const { aux, f } = make((url, init) => {
      const body = JSON.parse(init.body as string);
      call++;
      return body.model === 'tts-a' ? json(429, { error: { message: 'Rate limit exceeded' } }) : interactionsOk(ramp(100));
    });
    await aux.tts('atlas', 'bir');
    expect(f.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).model)).toEqual(['tts-a', 'tts-b']);
    f.mockClear();
    await aux.tts('atlas', 'iki');
    expect(f.mock.calls.map((c) => JSON.parse((c[1] as RequestInit).body as string).model)).toEqual(['tts-b']);   // tts-a atlandı
    expect(call).toBe(3);
  });

  it('interactions 404 → aynı model için generateContent yedeği (ham PCM)', async () => {
    const raw = new Uint8Array(new Int16Array(ramp(500)).buffer);
    const { aux, f } = make((url) => url.endsWith('/interactions')
      ? json(404, {})
      : json(200, { candidates: [{ content: { parts: [{ inlineData: { data: b64FromBytes(raw), mimeType: 'audio/L16;rate=24000' } }] } }] }));
    const pcm = await aux.tts('atlas', 'yedek');
    expect(pcm.byteLength).toBe(1000);
    expect(String(f.mock.calls[1][0])).toBe('https://generativelanguage.googleapis.com/v1beta/models/tts-a:generateContent');
  });

  it('hepsi başarısızsa AuxError; anahtar yoksa AuxError', async () => {
    const { aux } = make(() => json(500, {}));
    await expect(aux.tts('atlas', 'x')).rejects.toThrow(AuxError);
    const { aux: noKey } = make(() => interactionsOk(ramp(10)), { apiKey: () => '' });
    await expect(noKey.tts('atlas', 'x')).rejects.toThrow(/anahtar/i);
  });
});

describe('Aux.text ve üretimler', () => {
  it('model zinciri: yoğun (503) modelden sıradakine geçer, çalışan hatırlanır', async () => {
    const { aux, f } = make((url) => (url.includes('/t1:') ? json(503, {}) : textOk('merhaba')));
    expect(await aux.text('sys', 'p')).toBe('merhaba');
    expect(f.mock.calls.map((c) => String(c[0]).split('/models/')[1].split(':')[0])).toEqual(['t1', 't2']);
    f.mockClear();
    await aux.text('sys', 'p');
    expect(String(f.mock.calls[0][0])).toContain('/t2:generateContent');         // önce çalışan model
  });

  it('json=true responseMimeType gönderir; istek gövdesi sistem + kullanıcı içerir; URL\'de anahtar yok', async () => {
    const { aux, f } = make(() => textOk('{}'));
    await aux.text('SİSTEM', 'İSTEM', { json: true });
    const [url, init] = f.mock.calls[0] as [string, RequestInit];
    const b = JSON.parse(init.body as string);
    expect(b.generationConfig.responseMimeType).toBe('application/json');
    expect(b.systemInstruction.parts[0].text).toBe('SİSTEM');
    expect(b.contents[0].parts[0].text).toBe('İSTEM');
    expect(url).not.toContain('SECRET');
  });

  it('zaman aşımı: takılan modelde deadlineMs içinde AuxError (iptal sinyaliyle)', async () => {
    const hang = (_: string, init: RequestInit) => new Promise<Response>((_, rej) => init.signal!.addEventListener('abort', () => rej(new DOMException('abort', 'AbortError'))));
    const { aux } = make(hang);
    const t0 = Date.now();
    await expect(aux.text('s', 'p', { deadlineMs: 60 })).rejects.toThrow(AuxError);
    expect(Date.now() - t0).toBeLessThan(1000);
  });

  it('interjectText: temizlenmiş tek cümle; ilişki istemde; hata/zaman aşımında null', async () => {
    const { aux, f } = make(() => textOk('**SENTINEL:** "Deploy mu dedin? Kanal açık bırakma, usta, hemen."'));
    const r = await aux.interjectText('sentinel', 'forge', 'deploy ettim', 'tamam usta');
    expect(r).toBe('Deploy mu dedin? Kanal açık bırakma, usta, hemen.');
    const body = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(body.systemInstruction.parts[0].text).toContain('düşman (-40)');
    expect(body.systemInstruction.parts[0].text).toContain('SENTINEL');
    expect(body.contents[0].parts[0].text).toContain('deploy ettim');
    const bad = make(() => json(500, {})).aux;
    expect(await bad.interjectText('sentinel', 'forge', 'x', 'y')).toBeNull();
  });

  it('debateLines: JSON modu ve 6 satır', async () => {
    const six = ['sentinel', 'forge', 'sentinel', 'forge', 'sentinel', 'forge'].map((who, i) => ({ who, text: `s${i}` }));
    const { aux, f } = make(() => textOk(JSON.stringify({ lines: six })));
    const lines = await aux.debateLines('sentinel', 'forge', 'monorepo mu polyrepo mu');
    expect(lines).toHaveLength(6);
    expect(lines.map((l) => l.who)).toEqual(six.map((l) => l.who));
    const body = JSON.parse((f.mock.calls[0][1] as RequestInit).body as string);
    expect(body.generationConfig.responseMimeType).toBe('application/json');
    expect(body.contents[0].parts[0].text).toContain('monorepo mu polyrepo mu');
  });
});
