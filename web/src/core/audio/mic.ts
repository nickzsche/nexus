/** Mikrofon: tarayıcı yankı engelleme + gürültü bastırma, 16 kHz int16 20 ms parçalar. */
import { MIC_WORKLET } from './worklets';

export interface MicStartOptions { deviceId?: string | null; echoCancel?: boolean }

export class Mic {
  private onChunk: (pcm16k: Uint8Array, rms: number) => void;
  private ctx: AudioContext | null = null;
  private stream: MediaStream | null = null;
  private node: AudioWorkletNode | null = null;
  private _level = 0;
  private _active = false;

  constructor(onChunk: (pcm16k: Uint8Array, rms: number) => void) {
    this.onChunk = onChunk;
  }

  get level(): number { return this._level; }
  get active(): boolean { return this._active; }

  async start(o: MicStartOptions = {}): Promise<void> {
    if (this._active) return;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: o.deviceId ? { exact: o.deviceId } : undefined,
        channelCount: 1,
        echoCancellation: o.echoCancel ?? true,
        noiseSuppression: true,
        autoGainControl: true,
      },
    });
    try {
      const ctx = new AudioContext({ sampleRate: 16000, latencyHint: 'interactive' });
      const url = URL.createObjectURL(new Blob([MIC_WORKLET], { type: 'application/javascript' }));
      try { await ctx.audioWorklet.addModule(url); } finally { URL.revokeObjectURL(url); }
      const node = new AudioWorkletNode(ctx, 'nexus-mic', { numberOfInputs: 1, numberOfOutputs: 1, channelCount: 1 });
      node.port.onmessage = (e: MessageEvent<{ pcm: ArrayBuffer; rms: number }>) => {
        this._level = e.data.rms;
        this.onChunk(new Uint8Array(e.data.pcm), e.data.rms);
      };
      ctx.createMediaStreamSource(stream).connect(node);
      const mute = ctx.createGain();                          // worklet çalışsın diye sessiz bir çıkışa bağla
      mute.gain.value = 0;
      node.connect(mute).connect(ctx.destination);
      await ctx.resume();
      this.ctx = ctx; this.node = node; this.stream = stream; this._active = true;
    } catch (e) {
      stream.getTracks().forEach((t) => t.stop());
      throw e;
    }
  }

  stop(): void {
    this._active = false;
    this._level = 0;
    try { this.node?.disconnect(); } catch { /* yok say */ }
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close().catch(() => undefined);
    this.node = null; this.stream = null; this.ctx = null;
  }
}
