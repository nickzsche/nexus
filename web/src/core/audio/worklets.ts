/**
 * AudioWorklet kaynakları (Blob URL ile yüklenir). Metin olarak tutulur ki testte sahte bir worklet ortamında
 * çalıştırılabilsin.
 *
 * nexus-mic: giriş hızı ne olursa olsun 16 kHz mono int16'ya indirger (Firefox/Safari bağlam hızını zorlamaz) ve
 * 20 ms'lik (320 örnek) parçalar yollar: { pcm: ArrayBuffer(640), rms: 0–1 }.
 */
export const MIC_FRAME = 320;
export const MIC_RATE = 16000;

export const MIC_WORKLET = `
class NexusMic extends AudioWorkletProcessor {
  constructor() {
    super();
    this.step = sampleRate / ${MIC_RATE};      // giriş örneği / çıkış örneği
    this.pos = 0;                              // giriş tamponundaki kesirli okuma konumu
    this.buf = new Float32Array(0);
    this.out = new Int16Array(${MIC_FRAME});
    this.n = 0;
    this.sum = 0;
  }
  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    const merged = new Float32Array(this.buf.length + ch.length);
    merged.set(this.buf); merged.set(ch, this.buf.length);
    this.buf = merged;
    while (this.pos + 1 < this.buf.length) {
      const i = Math.floor(this.pos), f = this.pos - i;
      const v = Math.max(-1, Math.min(1, this.buf[i] * (1 - f) + this.buf[i + 1] * f));
      this.out[this.n++] = v < 0 ? v * 32768 : v * 32767;
      this.sum += v * v;
      this.pos += this.step;
      if (this.n === ${MIC_FRAME}) {
        const pcm = this.out.slice(0).buffer;
        this.port.postMessage({ pcm, rms: Math.sqrt(this.sum / ${MIC_FRAME}) }, [pcm]);
        this.n = 0; this.sum = 0;
      }
    }
    const drop = Math.floor(this.pos);
    this.buf = this.buf.slice(drop);
    this.pos -= drop;
    return true;
  }
}
registerProcessor('nexus-mic', NexusMic);
`;
