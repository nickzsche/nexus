/** Test yardımcısı: jsdom'da olmayan Web Audio için asgari sahte AudioContext. Üretim koduna girmez. */
export class FakeParam {
  value = 0;
  from: unknown[] = [];
  setValueAtTime(v: number): void { this.value = v; }
}

export class FakeNode {
  connections: unknown[] = [];
  disconnected = false;
  started = false;
  stopped = false;
  onended: (() => void) | null = null;
  startedAt: number | null = null;
  constructor(public kind: string, public ctx: FakeAudioContext) {}
  connect<T>(n: T): T {
    this.connections.push(n);
    return n;
  }
  disconnect(): void { this.disconnected = true; }
  start(t = 0): void {
    this.started = true;
    this.startedAt = t;
    this.ctx.allStarted.push(this);
  }
  stop(): void {
    this.stopped = true;
  }
  // GainNode / OscillatorNode / BiquadFilter / Delay alanları
  gain = new FakeParam();
  frequency = new FakeParam();
  delayTime = new FakeParam();
  Q = new FakeParam();
  type = '';
  buffer: FakeBuffer | null = null;
  loop = false;
  curve: Float32Array | null = null;
  oversample = '';
  normalize = true;
  fftSize = 0;
  getByteTimeDomainData(a: Uint8Array): void { a.fill(128); }
}

export class FakeBuffer {
  length: number;
  duration: number;
  data: Float32Array[];
  constructor(public numberOfChannels: number, length: number, public sampleRate: number) {
    this.length = length;
    this.duration = length / sampleRate;
    this.data = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  getChannelData(c: number): Float32Array { return this.data[c]; }
}

export class FakeAudioContext {
  static instances: FakeAudioContext[] = [];
  sampleRate: number;
  currentTime = 0;
  state: 'running' | 'suspended' | 'closed' = 'suspended';
  destination = new FakeNode('destination', this);
  nodes: FakeNode[] = [];
  allStarted: FakeNode[] = [];
  constructor(o: { sampleRate?: number } = {}) {
    this.sampleRate = o.sampleRate ?? 48000;
    FakeAudioContext.instances.push(this);
  }
  private mk(kind: string): FakeNode { const n = new FakeNode(kind, this); this.nodes.push(n); return n; }
  createGain() { return this.mk('gain'); }
  createBiquadFilter() { return this.mk('biquad'); }
  createDelay() { return this.mk('delay'); }
  createConvolver() { return this.mk('convolver'); }
  createWaveShaper() { return this.mk('waveshaper'); }
  createOscillator() { return this.mk('oscillator'); }
  createBufferSource() { return this.mk('source'); }
  createAnalyser() { return this.mk('analyser'); }
  createBuffer(ch: number, len: number, rate: number) { return new FakeBuffer(ch, len, rate); }
  async resume(): Promise<void> { this.state = 'running'; }
  async close(): Promise<void> { this.state = 'closed'; }
  count(kind: string): number { return this.nodes.filter((n) => n.kind === kind).length; }
}

export const asCtx = (c: FakeAudioContext): BaseAudioContext => c as unknown as BaseAudioContext;
