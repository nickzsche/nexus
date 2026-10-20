/**
 * Mikrofon kapısı: konuşmayı algılar, ortam gürültüsünü süzer ve konuşma bitince hemen haber verir.
 * Gemini bitişi varsayılan olarak ~800 ms sessizlikle anlar; bunu beklemek yerine burada algılayıp `end`
 * ile audioStreamEnd göndeririz (hibrit VAD). Konuşma yokken Gemini'ye ses gitmez; başlangıçtan önceki kısa
 * sessizlik (preroll) eklenir, böylece ilk hece kesilmez. 16 kHz mono int16: ms = bayt / 32.
 */
export type GateAction = { type: 'audio'; data: Uint8Array } | { type: 'end' };

export interface GateOpts { startMs?: number; prerollMs?: number; hangMs?: number; minThr?: number }

const msOf = (b: Uint8Array): number => Math.floor(b.length / 32);

export class MicGate {
  private startMs: number;
  private prerollMs: number;
  private hangMs: number;
  private minThr: number;
  floor = 0.01;                                        // ortam gürültü tabanı (0–1 rms)
  private _speaking = false;
  private hotMs = 0;
  private quietMs = 0;
  private pre: Uint8Array[] = [];
  private preMs = 0;

  constructor(opts: GateOpts = {}) {
    this.startMs = opts.startMs ?? 60;
    this.prerollMs = opts.prerollMs ?? 240;
    this.hangMs = opts.hangMs ?? 350;
    this.minThr = opts.minThr ?? 0.02;
  }

  get speaking(): boolean { return this._speaking; }

  reset(): void {
    this.floor = 0.01;
    this._speaking = false;
    this.hotMs = 0;
    this.quietMs = 0;
    this.pre = [];
    this.preMs = 0;
  }

  threshold(speakerBusy: boolean, barge: number): number {
    const thr = Math.max(this.minThr, this.floor * 3.4);
    // Hoparlör çalarken yalnızca barge eşiğini belirgin aşan ses gerçek konuşma sayılır (yankı).
    return speakerBusy ? Math.max(thr * 2.4, barge) : thr;
  }

  feed(pcm: Uint8Array, rms: number, speakerBusy = false, barge = 0.06): GateAction[] {
    const ms = msOf(pcm);
    const loud = rms > this.threshold(speakerBusy, barge);
    const out: GateAction[] = [];
    if (!this._speaking) {
      this.floor = Math.min(0.08, Math.max(0.003, this.floor * 0.985 + rms * 0.015));
      this.pre.push(pcm);
      this.preMs += ms;
      while (this.preMs > this.prerollMs && this.pre.length) this.preMs -= msOf(this.pre.shift()!);
      this.hotMs = loud ? this.hotMs + ms : 0;
      if (this.hotMs >= this.startMs) {
        this._speaking = true;
        this.quietMs = 0;
        for (const c of this.pre) out.push({ type: 'audio', data: c });
        this.pre = [];
        this.preMs = 0;
      }
    } else {
      out.push({ type: 'audio', data: pcm });
      this.quietMs = loud ? 0 : this.quietMs + ms;
      if (this.quietMs >= this.hangMs) {
        this._speaking = false;
        this.hotMs = 0;
        out.push({ type: 'end' });
      }
    }
    return out;
  }
}
