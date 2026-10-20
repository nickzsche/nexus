/**
 * Gemini Live oturumu (tarayıcı, WebSocket): ses-sese konuşma, araç çağrıları, kesinti, yeniden bağlanma.
 *
 * Çip değişince yeni oturum açılır (ses ve sistem talimatı oturum ortasında değişmez). Aynı çip için kopuşta
 * oturum sürdürme tutamacı (handle) ile yeniden bağlanılır. Model listesi ayarlardan gelir; varsayılan YALNIZCA
 * gemini-2.5-flash-native-audio-latest'tir (kullanıcının seçtiği model).
 */
import type { ChipKey } from '../types';

export const LIVE_URL = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent';
export const BACKOFF_MS = [1000, 2000, 4000, 8000, 15000];
export const BAD_MODEL_TTL_MS = 10 * 60 * 1000;

const FATAL_KEY = /api key not valid|api_key_invalid|invalid api key|api key expired|unauthenticated|\b401\b/i;
const MODEL_REJECT = /not found|not supported|unsupported|permission|quota|billing|does not exist|invalid model|\b404\b|\b403\b|\b429\b|\b1011\b/i;

export interface LiveCallbacks {
  onAudio(pcm: Uint8Array): void;
  /** Transkripsiyon DELTA (birikmiş değil). */
  onText(role: 'user' | 'ai', delta: string): void;
  /** Tur sonu ya da kesintide açık satırı kapat. */
  onLineEnd(role: 'user' | 'ai'): void;
  onStatus(s: 'connecting' | 'listening' | 'thinking' | 'speaking' | 'error'): void;
  onTurnComplete(): void;
  onInterrupted(): void;
  onTool(name: string, args: Record<string, unknown>, result: unknown): void;
  onError(msg: string, fatal: boolean): void;
  onReady(model: string): void;
  onGoAway?(): void;
}

export interface LiveOptions {
  apiKey: () => string;
  models: () => string[];
  voice: (chip: ChipKey) => string;
  systemInstruction: (chip: ChipKey, extra?: string) => string;
  tools: (chip: ChipKey) => object[];
  runTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
  callbacks: LiveCallbacks;
  wsFactory?: (url: string) => WebSocket;
  /** Yazılı mesaj yolu. Varsayılan 'clientContent' (güvenilir, tur garantili). 'realtime' = realtimeInput.text (ölçümde daha hızlı ama takılma görüldü). */
  textMode?: 'clientContent' | 'realtime';
}

/** Reddedilen (kota/yok) modeller bir süre atlanır; her çip değişiminde yeniden denenmesin. */
const badModels = new Map<string, number>();
export const resetBadModels = (): void => badModels.clear();

export function b64FromBytes(u8: Uint8Array): string {
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < u8.length; i += CH) s += String.fromCharCode(...u8.subarray(i, i + CH));
  return btoa(s);
}

export function bytesFromB64(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

interface FunctionCall { id: string; name: string; args?: Record<string, unknown> }
type Msg = Record<string, any>;

export class LiveSession {
  private o: LiveOptions;
  private chip: ChipKey = 'atlas';
  private extra = '';
  private handle: string | null = null;
  private ws: WebSocket | null = null;
  private ready = false;
  private closed = true;
  private gotSetup = false;
  private opened = 0;
  private attempt = 0;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private queue: Msg[] = [];
  private cancelled = new Set<string>();
  private open = { user: false, ai: false };
  private firstAudio = true;
  private thinkingSent = false;
  private _model = '';
  private triedThisRound = new Set<string>();

  constructor(o: LiveOptions) {
    this.o = o;
  }

  get model(): string { return this._model; }
  get running(): boolean { return !this.closed; }

  async start(chip: ChipKey, extra = ''): Promise<void> {
    await this.stop();
    this.chip = chip;
    this.extra = extra;
    this.handle = null;                       // yeni çip = yeni oturum
    this.closed = false;
    this.attempt = 0;
    this.queue = [];
    this.cancelled.clear();
    this.open = { user: false, ai: false };
    this.triedThisRound.clear();
    this.connect();
  }

  async stop(): Promise<void> {
    this.closed = true;
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    const ws = this.ws;
    this.ws = null;
    this.ready = false;
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null;
      try { ws.close(1000, 'bye'); } catch { /* zaten kapalı */ }
    }
  }

  // ------------------------------------------------------------------ gönderme
  sendAudio(pcm16k: Uint8Array): void {
    if (!this.ready || !this.ws || this.ws.readyState !== 1) return;          // ses kuyruğa alınmaz, atılır
    this.ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64FromBytes(pcm16k), mimeType: 'audio/pcm;rate=16000' } } }));
  }

  /** Konuşma bitti: sunucu olağan sessizlik beklemesini atlayıp hemen cevaplar. */
  sendAudioEnd(): void {
    if (!this.ready || !this.ws || this.ws.readyState !== 1) return;
    this.ws.send(JSON.stringify({ realtimeInput: { audioStreamEnd: true } }));
  }

  /** Varsayılan: clientContent + turnComplete (turu kesin başlatır). `textMode:'realtime'` ile realtimeInput.text. */
  sendText(text: string): void {
    this.send(this.o.textMode === 'realtime'
      ? { realtimeInput: { text } }
      : { clientContent: { turns: [{ role: 'user', parts: [{ text }] }], turnComplete: true } });
  }

  sendImage(jpegBase64: string, note = ''): void {
    this.send({ realtimeInput: { video: { data: jpegBase64, mimeType: 'image/jpeg' } } });
    if (note) this.sendText(note);
  }

  private send(obj: Msg): void {
    if (!this.ready || !this.ws || this.ws.readyState !== 1) {
      this.queue.push(obj);                                                      // setupComplete'ten önce kuyrukla
      return;
    }
    this.ws.send(JSON.stringify(obj));
  }

  // ------------------------------------------------------------------ bağlantı
  private pickModel(): string | null {
    const all = this.o.models().filter(Boolean);
    const now = Date.now();
    const fresh = all.filter((m) => (badModels.get(m) ?? 0) < now);
    const pool = fresh.length ? fresh : all;                                    // hepsi kötüyse hepsini dene
    return pool.find((m) => !this.triedThisRound.has(m)) ?? pool[0] ?? null;
  }

  private setup(model: string): Msg {
    const tools = this.o.tools(this.chip);
    const setup: Msg = {
      model: model.startsWith('models/') ? model : `models/${model}`,
      generationConfig: {
        responseModalities: ['AUDIO'],
        speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: this.o.voice(this.chip) } } },
      },
      systemInstruction: { parts: [{ text: this.o.systemInstruction(this.chip, this.extra) }] },
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      contextWindowCompression: { slidingWindow: {} },
      sessionResumption: this.handle ? { handle: this.handle } : {},
      // Bitişi mikrofon kapısı bildirir (audioStreamEnd); sunucu VAD'i yalnızca yedek ve gürültüye az duyarlı.
      realtimeInputConfig: { automaticActivityDetection: { startOfSpeechSensitivity: 'START_SENSITIVITY_LOW', silenceDurationMs: 500 } },
    };
    if (tools.length) setup.tools = tools;
    return { setup };
  }

  private connect(): void {
    if (this.closed) return;
    const key = this.o.apiKey();
    if (!key) {
      this.closed = true;
      this.o.callbacks.onError('API anahtarı yok.', true);
      this.o.callbacks.onStatus('error');
      return;
    }
    const model = this.pickModel();
    if (!model) {
      this.closed = true;
      this.o.callbacks.onError('Kullanılabilir Live modeli yok.', true);
      this.o.callbacks.onStatus('error');
      return;
    }
    this._model = model;
    this.ready = false;
    this.gotSetup = false;
    this.opened = Date.now();
    this.thinkingSent = false;
    this.firstAudio = true;
    this.o.callbacks.onStatus('connecting');
    const url = `${LIVE_URL}?key=${encodeURIComponent(key)}`;
    const ws = this.o.wsFactory ? this.o.wsFactory(url) : new WebSocket(url);
    this.ws = ws;
    ws.onopen = () => { if (this.ws === ws) ws.send(JSON.stringify(this.setup(model))); };
    ws.onmessage = (ev: MessageEvent) => { if (this.ws === ws) void this.onRaw(ev.data); };
    ws.onerror = () => { /* kapanış olayı arkasından gelir */ };
    ws.onclose = (ev: CloseEvent) => { if (this.ws === ws) this.onClose(ev.code, ev.reason || ''); };
  }

  private onClose(code: number, reason: string): void {
    this.ws = null;
    this.ready = false;
    if (this.closed) return;
    const text = `${code} ${reason}`;
    this.closeLines();
    if (FATAL_KEY.test(text)) {
      this.closed = true;
      this.o.callbacks.onError('API anahtarı geçersiz.', true);
      this.o.callbacks.onStatus('error');
      return;
    }
    const early = !this.gotSetup && Date.now() - this.opened < 8000;
    if (early && !this.handle && (MODEL_REJECT.test(text) || code === 1011 || code === 1008 || code === 1007)) {
      badModels.set(this._model, Date.now() + BAD_MODEL_TTL_MS);
      this.triedThisRound.add(this._model);
      const alt = this.o.models().filter(Boolean).find((m) => !this.triedThisRound.has(m) && (badModels.get(m) ?? 0) < Date.now());
      if (alt) { this.schedule(0); return; }                                   // başka model varsa hemen dene
      this.triedThisRound.clear();
      this.o.callbacks.onError(`Model reddedildi (${this._model}): ${reason || code}`, false);
    } else if (code !== 1000) {
      this.o.callbacks.onError(`Bağlantı koptu (${code}${reason ? ': ' + reason : ''}), yeniden denenecek.`, false);
    }
    // Temiz kapanış ve GoAway'de hemen, diğerlerinde üstel bekleme.
    const immediate = code === 1000 && this.gotSetup;
    this.schedule(immediate ? 0 : BACKOFF_MS[Math.min(this.attempt++, BACKOFF_MS.length - 1)]);
  }

  private schedule(ms: number): void {
    if (this.closed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.connect(); }, ms);
  }

  // ------------------------------------------------------------------ alma
  private async onRaw(data: unknown): Promise<void> {
    let text: string;
    const tag = Object.prototype.toString.call(data);          // instanceof farklı bağlamlarda (iframe, test) yanılır
    if (typeof data === 'string') text = data;
    else if (tag === '[object Blob]') text = await (data as Blob).text();
    else if (tag === '[object ArrayBuffer]') text = new TextDecoder().decode(data as ArrayBuffer);
    else if (ArrayBuffer.isView(data)) text = new TextDecoder().decode(data as ArrayBufferView);
    else return;
    let msg: Msg;
    try { msg = JSON.parse(text); } catch { return; }
    this.handleMsg(msg);
  }

  private closeLines(): void {
    for (const role of ['user', 'ai'] as const) {
      if (this.open[role]) { this.open[role] = false; this.o.callbacks.onLineEnd(role); }
    }
  }

  private handleMsg(m: Msg): void {
    const cb = this.o.callbacks;
    if (m.setupComplete !== undefined) {
      this.ready = true;
      this.gotSetup = true;
      this.attempt = 0;
      this.triedThisRound.clear();
      cb.onReady(this._model);
      cb.onStatus('listening');
      const q = this.queue;
      this.queue = [];
      for (const x of q) this.send(x);
      return;
    }
    if (m.error) cb.onError(`Sunucu: ${m.error.message ?? JSON.stringify(m.error)}`, false);
    const upd = m.sessionResumptionUpdate;
    if (upd && upd.resumable && upd.newHandle) this.handle = upd.newHandle;
    if (m.goAway !== undefined) {
      cb.onGoAway?.();
      // Aynı handle ile hemen yeniden bağlan (eski soket sessizce bırakılır).
      const old = this.ws;
      this.ws = null;
      this.ready = false;
      if (old) { old.onopen = old.onmessage = old.onclose = old.onerror = null; try { old.close(1000, 'goaway'); } catch { /* yok say */ } }
      this.schedule(0);
      return;
    }
    const sc = m.serverContent;
    if (sc) {
      if (sc.interrupted) {
        this.firstAudio = true;
        if (this.open.ai) { this.open.ai = false; cb.onLineEnd('ai'); }
        cb.onInterrupted();
      }
      const parts: Msg[] = sc.modelTurn?.parts ?? [];
      for (const p of parts) {
        const d = p.inlineData ?? p.inline_data;
        const data: string | undefined = d?.data;
        if (data && /audio|pcm/.test(d.mimeType ?? d.mime_type ?? 'audio')) {
          if (this.firstAudio) { this.firstAudio = false; cb.onStatus('speaking'); }
          cb.onAudio(bytesFromB64(data));
        }
      }
      const it = sc.inputTranscription?.text;
      if (it) {
        this.open.user = true;
        cb.onText('user', it);
        if (!this.thinkingSent) { this.thinkingSent = true; cb.onStatus('thinking'); }
      }
      const ot = sc.outputTranscription?.text;
      if (ot) { this.open.ai = true; cb.onText('ai', ot); }
      if (sc.turnComplete) {
        this.closeLines();
        this.firstAudio = true;
        this.thinkingSent = false;
        cb.onStatus('listening');
        cb.onTurnComplete();
      }
    }
    const tc = m.toolCall;
    if (tc?.functionCalls?.length) {
      cb.onStatus('thinking');
      void this.runCalls(tc.functionCalls as FunctionCall[]);
    }
    const canc = m.toolCallCancellation;
    if (canc?.ids) for (const id of canc.ids as string[]) this.cancelled.add(id);
  }

  private async runCalls(calls: FunctionCall[]): Promise<void> {
    const ws = this.ws;
    const done = await Promise.all(calls.map(async (c) => {
      const args = c.args ?? {};
      let result: unknown;
      try { result = await this.o.runTool(c.name, args); } catch (e) { result = { error: e instanceof Error ? e.message : String(e) }; }
      this.o.callbacks.onTool(c.name, args, result);
      if (this.cancelled.delete(c.id)) return null;                             // iptal edilen çağrının sonucu atılır
      const response = isObj(result) && ('result' in result || 'error' in result) ? result : { result };
      return { id: c.id, name: c.name, response };
    }));
    const responses = done.filter((x): x is NonNullable<typeof x> => x !== null);
    if (!responses.length || this.ws !== ws || !ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify({ toolResponse: { functionResponses: responses } }));
  }
}
