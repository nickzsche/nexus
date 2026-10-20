import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { b64FromBytes, bytesFromB64, LIVE_URL, LiveSession, resetBadModels, type LiveCallbacks, type LiveOptions } from './live';

class FakeWS {
  static all: FakeWS[] = [];
  readyState = 0;
  sent: any[] = [];
  closedWith: [number, string] | null = null;
  onopen: any = null; onmessage: any = null; onclose: any = null; onerror: any = null;
  constructor(public url: string) { FakeWS.all.push(this); }
  send(s: string) { this.sent.push(JSON.parse(s)); }
  close(code = 1000, reason = '') { this.closedWith = [code, reason]; this.readyState = 3; }
  // --- test yardımcıları
  open() { this.readyState = 1; this.onopen?.(); }
  msg(o: unknown) { this.onmessage?.({ data: JSON.stringify(o) }); }
  ready() { this.open(); this.msg({ setupComplete: {} }); }
  drop(code: number, reason = '') { this.readyState = 3; this.onclose?.({ code, reason }); }
}
const last = () => FakeWS.all[FakeWS.all.length - 1];

function make(over: Partial<LiveOptions> = {}, cbOver: Partial<LiveCallbacks> = {}) {
  const ev: Record<string, any[]> = { audio: [], text: [], lineEnd: [], status: [], turn: [], intr: [], tool: [], err: [], ready: [], goaway: [] };
  const callbacks: LiveCallbacks = {
    onAudio: (b) => ev.audio.push(b),
    onText: (r, d) => ev.text.push([r, d]),
    onLineEnd: (r) => ev.lineEnd.push(r),
    onStatus: (s) => ev.status.push(s),
    onTurnComplete: () => ev.turn.push(1),
    onInterrupted: () => ev.intr.push(1),
    onTool: (n, a, r) => ev.tool.push([n, a, r]),
    onError: (m, f) => ev.err.push([m, f]),
    onReady: (m) => ev.ready.push(m),
    onGoAway: () => ev.goaway.push(1),
    ...cbOver,
  };
  const opts: LiveOptions = {
    apiKey: () => 'KEY/1', models: () => ['gemini-2.5-flash-native-audio-latest'], voice: (c) => `V-${c}`,
    systemInstruction: (c, e) => `SYS ${c} ${e ?? ''}`.trim(), tools: () => [{ functionDeclarations: [{ name: 'get_time' }] }],
    runTool: async (n) => ({ result: `${n}-ok` }), callbacks, wsFactory: (u) => new FakeWS(u) as unknown as WebSocket, ...over,
  };
  return { s: new LiveSession(opts), ev };
}

beforeEach(() => { FakeWS.all = []; resetBadModels(); vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('LiveSession: kurulum', () => {
  it('doğru URL ve setup mesajı; yalnızca varsayılan model', async () => {
    const { s } = make();
    await s.start('nova', 'EKSTRA');
    const ws = last();
    expect(ws.url).toBe(`${LIVE_URL}?key=${encodeURIComponent('KEY/1')}`);
    ws.open();
    const setup = ws.sent[0].setup;
    expect(setup.model).toBe('models/gemini-2.5-flash-native-audio-latest');
    expect(setup.generationConfig.responseModalities).toEqual(['AUDIO']);
    expect(setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('V-nova');
    expect(setup.systemInstruction.parts[0].text).toBe('SYS nova EKSTRA');
    expect(setup.tools).toEqual([{ functionDeclarations: [{ name: 'get_time' }] }]);
    expect(setup.inputAudioTranscription).toEqual({});
    expect(setup.outputAudioTranscription).toEqual({});
    expect(setup.contextWindowCompression).toEqual({ slidingWindow: {} });
    expect(setup.sessionResumption).toEqual({});
    expect(setup.realtimeInputConfig.automaticActivityDetection).toEqual({ startOfSpeechSensitivity: 'START_SENSITIVITY_LOW', silenceDurationMs: 500 });
    expect(s.model).toBe('gemini-2.5-flash-native-audio-latest');
    expect(s.running).toBe(true);
  });

  it('araç yoksa setup.tools hiç gönderilmez', async () => {
    const { s } = make({ tools: () => [] });
    await s.start('atlas');
    last().open();
    expect(last().sent[0].setup.tools).toBeUndefined();
  });

  it('API anahtarı yoksa fatal hata, bağlanmaz', async () => {
    const { s, ev } = make({ apiKey: () => '' });
    await s.start('atlas');
    expect(FakeWS.all).toHaveLength(0);
    expect(ev.err[0]).toEqual(['API anahtarı yok.', true]);
    expect(s.running).toBe(false);
  });

  it('setupComplete öncesi metin kuyruğa alınır (sırayla gider), ses atılır', async () => {
    const { s, ev } = make();
    await s.start('atlas');
    const ws = last();
    ws.open();
    s.sendAudio(new Uint8Array(10));
    s.sendText('bir');
    s.sendText('iki');
    expect(ws.sent).toHaveLength(1);                         // yalnızca setup
    ws.msg({ setupComplete: {} });
    expect(ws.sent.slice(1).map((m) => m.clientContent.turns[0].parts[0].text)).toEqual(['bir', 'iki']);
    expect(ws.sent.some((m) => m.realtimeInput?.audio)).toBe(false);
    expect(ev.ready).toEqual(['gemini-2.5-flash-native-audio-latest']);
    expect(ev.status).toContain('listening');
  });
});

describe('LiveSession: gönderme', () => {
  it('sendText=clientContent+turnComplete, sendAudio base64+mime, sendAudioEnd, sendImage', async () => {
    const { s } = make();
    await s.start('atlas');
    last().ready();
    s.sendText('selam');
    s.sendAudio(new Uint8Array([1, 2, 3, 4]));
    s.sendAudioEnd();
    s.sendImage('JPEGDATA', 'ekranda ne var?');
    const [, text, audio, end, img, note] = last().sent;
    expect(text).toEqual({ clientContent: { turns: [{ role: 'user', parts: [{ text: 'selam' }] }], turnComplete: true } });
    expect(audio.realtimeInput.audio).toEqual({ data: b64FromBytes(new Uint8Array([1, 2, 3, 4])), mimeType: 'audio/pcm;rate=16000' });
    expect(end).toEqual({ realtimeInput: { audioStreamEnd: true } });
    expect(img).toEqual({ realtimeInput: { video: { data: 'JPEGDATA', mimeType: 'image/jpeg' } } });
    expect(note.clientContent.turns[0].parts[0].text).toBe('ekranda ne var?');
  });

  it("textMode:'realtime' yazıyı realtimeInput.text olarak gönderir (isteğe bağlı)", async () => {
    const { s } = make({ textMode: 'realtime' });
    await s.start('atlas');
    last().ready();
    s.sendText('selam');
    expect(last().sent[1]).toEqual({ realtimeInput: { text: 'selam' } });
  });

  it('base64 yardımcıları büyük veride gidiş-dönüş yapar', () => {
    const big = new Uint8Array(100_000).map((_, i) => i % 251);
    expect(bytesFromB64(b64FromBytes(big))).toEqual(big);
  });
});

describe('LiveSession: alma', () => {
  it('ses, transkript delta, durumlar ve tur sonu', async () => {
    const { s, ev } = make();
    await s.start('atlas');
    const ws = last();
    ws.ready();
    ws.msg({ serverContent: { inputTranscription: { text: 'merhaba ' } } });
    ws.msg({ serverContent: { inputTranscription: { text: 'nexus' } } });
    ws.msg({ serverContent: { modelTurn: { parts: [{ inlineData: { data: b64FromBytes(new Uint8Array([9, 8, 7])), mimeType: 'audio/pcm;rate=24000' } }] } } });
    ws.msg({ serverContent: { modelTurn: { parts: [{ inlineData: { data: b64FromBytes(new Uint8Array([6])), mimeType: 'audio/pcm;rate=24000' } }] } } });
    ws.msg({ serverContent: { outputTranscription: { text: 'selam' } } });
    ws.msg({ serverContent: { turnComplete: true } });
    expect(ev.text).toEqual([['user', 'merhaba '], ['user', 'nexus'], ['ai', 'selam']]);      // DELTA, birikmiş değil
    expect(ev.audio).toEqual([new Uint8Array([9, 8, 7]), new Uint8Array([6])]);
    expect(ev.status.filter((x) => x === 'thinking')).toHaveLength(1);
    expect(ev.status.filter((x) => x === 'speaking')).toHaveLength(1);
    expect(ev.lineEnd.sort()).toEqual(['ai', 'user']);
    expect(ev.turn).toHaveLength(1);
    expect(ev.status.at(-1)).toBe('listening');
  });

  it('kesinti: onInterrupted ve açık ai satırı kapanır; sonraki tur yeniden "speaking" der', async () => {
    const { s, ev } = make();
    await s.start('atlas');
    const ws = last();
    ws.ready();
    const audio = { serverContent: { modelTurn: { parts: [{ inlineData: { data: 'AAA=', mimeType: 'audio/pcm' } }] } } };
    ws.msg(audio);
    ws.msg({ serverContent: { outputTranscription: { text: 'yarım' } } });
    ws.msg({ serverContent: { interrupted: true } });
    expect(ev.intr).toHaveLength(1);
    expect(ev.lineEnd).toEqual(['ai']);
    ws.msg(audio);
    expect(ev.status.filter((x) => x === 'speaking')).toHaveLength(2);
  });

  it('Blob olmayan ikili mesajlar (ArrayBuffer) da çözülür; bozuk JSON yok sayılır', async () => {
    const { s, ev } = make();
    await s.start('atlas');
    const ws = last();
    ws.ready();
    ws.onmessage({ data: new TextEncoder().encode(JSON.stringify({ serverContent: { outputTranscription: { text: 'x' } } })).buffer });
    ws.onmessage({ data: '{bozuk' });
    await vi.advanceTimersByTimeAsync(0);
    expect(ev.text).toEqual([['ai', 'x']]);
  });
});

describe('LiveSession: araçlar', () => {
  it('toolCall → runTool → toolResponse; paralel çalışır; {error} olduğu gibi geçer', async () => {
    const order: string[] = [];
    const { s, ev } = make({
      runTool: async (n) => { order.push('start-' + n); await new Promise((r) => setTimeout(r, n === 'a' ? 20 : 5)); order.push('end-' + n); return n === 'b' ? { error: 'kötü' } : { result: n + '!' }; },
    });
    await s.start('atlas');
    const ws = last();
    ws.ready();
    ws.msg({ toolCall: { functionCalls: [{ id: '1', name: 'a', args: { x: 1 } }, { id: '2', name: 'b' }, { id: '3', name: 'c' }] } });
    await vi.advanceTimersByTimeAsync(50);
    expect(order.slice(0, 3)).toEqual(['start-a', 'start-b', 'start-c']);       // paralel başladı
    const resp = ws.sent.find((m) => m.toolResponse).toolResponse.functionResponses;
    expect(resp).toEqual([
      { id: '1', name: 'a', response: { result: 'a!' } },
      { id: '2', name: 'b', response: { error: 'kötü' } },
      { id: '3', name: 'c', response: { result: 'c!' } },
    ]);
    expect(ev.tool.map((t) => t[0]).sort()).toEqual(['a', 'b', 'c']);
    expect(ev.tool[0][1]).toBeDefined();
    expect(ev.status).toContain('thinking');
  });

  it('düz değer dönen araç { result } içine sarılır; fırlatan araç { error } olur', async () => {
    const { s } = make({ runTool: async (n) => { if (n === 'x') throw new Error('patladı'); return 42; } });
    await s.start('atlas');
    const ws = last();
    ws.ready();
    ws.msg({ toolCall: { functionCalls: [{ id: '1', name: 'y' }, { id: '2', name: 'x' }] } });
    await vi.advanceTimersByTimeAsync(0);
    const resp = ws.sent.find((m) => m.toolResponse).toolResponse.functionResponses;
    expect(resp).toEqual([{ id: '1', name: 'y', response: { result: 42 } }, { id: '2', name: 'x', response: { error: 'patladı' } }]);
  });

  it('toolCallCancellation: iptal edilen çağrının yanıtı atılır', async () => {
    const { s, ev } = make({ runTool: async () => { await new Promise((r) => setTimeout(r, 10)); return { result: 'geç' }; } });
    await s.start('atlas');
    const ws = last();
    ws.ready();
    ws.msg({ toolCall: { functionCalls: [{ id: 'c1', name: 'a' }, { id: 'c2', name: 'b' }] } });
    ws.msg({ toolCallCancellation: { ids: ['c1'] } });
    await vi.advanceTimersByTimeAsync(20);
    const resp = ws.sent.find((m) => m.toolResponse).toolResponse.functionResponses;
    expect(resp.map((r: any) => r.id)).toEqual(['c2']);
    expect(ev.tool).toHaveLength(2);                          // araç yine de çalıştı, yalnızca yanıt atıldı
  });

  it('tüm çağrılar iptal edilirse toolResponse hiç gitmez', async () => {
    const { s } = make();
    await s.start('atlas');
    const ws = last();
    ws.ready();
    ws.msg({ toolCallCancellation: { ids: ['c1'] } });
    ws.msg({ toolCall: { functionCalls: [{ id: 'c1', name: 'a' }] } });
    await vi.advanceTimersByTimeAsync(0);
    expect(ws.sent.some((m) => m.toolResponse)).toBe(false);
  });
});

describe('LiveSession: yeniden bağlanma', () => {
  it('GoAway: aynı handle ile hemen yeniden bağlanır', async () => {
    const { s, ev } = make();
    await s.start('atlas');
    const a = last();
    a.ready();
    a.msg({ sessionResumptionUpdate: { resumable: true, newHandle: 'H1' } });
    a.msg({ goAway: { timeLeft: '5s' } });
    await vi.advanceTimersByTimeAsync(0);
    expect(ev.goaway).toHaveLength(1);
    expect(FakeWS.all).toHaveLength(2);
    expect(a.closedWith?.[0]).toBe(1000);
    const b = last();
    b.open();
    expect(b.sent[0].setup.sessionResumption).toEqual({ handle: 'H1' });
  });

  it('kopuş: üstel bekleme 1s → 2s → 4s; başarılı kurulumda sayaç sıfırlanır', async () => {
    const { s, ev } = make();
    await s.start('atlas');
    last().drop(1006);
    expect(FakeWS.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(FakeWS.all).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWS.all).toHaveLength(2);
    last().drop(1006);
    await vi.advanceTimersByTimeAsync(1999);
    expect(FakeWS.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(FakeWS.all).toHaveLength(3);
    last().drop(1006);
    await vi.advanceTimersByTimeAsync(4000);
    expect(FakeWS.all).toHaveLength(4);
    expect(ev.err.every(([, fatal]) => fatal === false)).toBe(true);
    last().ready();
    last().drop(1006);
    await vi.advanceTimersByTimeAsync(1000);                     // sayaç sıfırlandı: yine 1 sn
    expect(FakeWS.all).toHaveLength(5);
  });

  it('geçersiz API anahtarı: fatal hata, yeniden bağlanma yok', async () => {
    const { s, ev } = make();
    await s.start('atlas');
    last().drop(1007, 'API key not valid. Please pass a valid API key.');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(FakeWS.all).toHaveLength(1);
    expect(ev.err.at(-1)).toEqual(['API anahtarı geçersiz.', true]);
    expect(ev.status.at(-1)).toBe('error');
    expect(s.running).toBe(false);
  });

  it('stop sonrası yeniden bağlanma olmaz ve soket kapanır', async () => {
    const { s } = make();
    await s.start('atlas');
    const ws = last();
    ws.ready();
    await s.stop();
    expect(ws.closedWith?.[0]).toBe(1000);
    ws.onclose?.({ code: 1006, reason: '' });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(FakeWS.all).toHaveLength(1);
    expect(s.running).toBe(false);
  });

  it('çip değişince yeni oturum açılır ve handle sıfırlanır', async () => {
    const { s } = make();
    await s.start('atlas');
    last().ready();
    last().msg({ sessionResumptionUpdate: { resumable: true, newHandle: 'H1' } });
    await s.start('forge');
    expect(FakeWS.all).toHaveLength(2);
    last().open();
    expect(last().sent[0].setup.sessionResumption).toEqual({});
    expect(last().sent[0].setup.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe('V-forge');
  });
});

describe('LiveSession: model reddi', () => {
  it('kota diyen model 10 dk atlanır; sıradaki hemen denenir, sonraki oturumda baştan denenmez', async () => {
    const { s, ev } = make({ models: () => ['m-one', 'm-two'] });
    await s.start('atlas');
    expect(s.model).toBe('m-one');
    last().drop(1011, 'You exceeded your current quota');
    await vi.advanceTimersByTimeAsync(0);
    expect(s.model).toBe('m-two');
    expect(FakeWS.all).toHaveLength(2);
    last().ready();
    await s.start('forge');                                      // yeni çip: m-one tekrar denenmemeli
    expect(s.model).toBe('m-two');
    expect(ev.err.some(([, f]) => f)).toBe(false);
    vi.advanceTimersByTime(10 * 60 * 1000 + 1);
    await s.start('nova');
    expect(s.model).toBe('m-one');                               // süre doldu: tekrar denenir
  });

  it('tek model reddedilirse fatal değil: bilgi verir ve geri çekilmeyle tekrar dener', async () => {
    const { s, ev } = make();
    await s.start('atlas');
    last().drop(1011, 'quota exceeded');
    await vi.advanceTimersByTimeAsync(0);
    expect(ev.err.at(-1)![1]).toBe(false);
    expect(String(ev.err.at(-1)![0])).toContain('Model reddedildi');
    await vi.advanceTimersByTimeAsync(1000);
    expect(FakeWS.all).toHaveLength(2);
  });
});
