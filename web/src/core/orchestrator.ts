/**
 * Orkestratör: aktif çip, Live oturumu, mikrofon kapısı, devir, araya girme, arena, onay, hikâye ve telemetri.
 * Sonuçları `useNexus` deposuna yazar; arayüz yalnızca depoyu okur ve `CoreApi` üzerinden eylem ister.
 */
import { CHIPS, allTools, chipOf, isChipKey } from '../data/chips';
import { useNexus } from '../state/store';
import type { ArenaLine, ChipKey, Settings } from '../types';
import { CHIP_KEYS } from '../types';
import type { CoreApi } from './api';
import { Aux } from './aux';
import { MicGate } from './audio/gate';
import { Mic } from './audio/mic';
import { Player } from './audio/player';
import { getBridge } from './bridge';
import { LiveSession } from './live';
import * as memory from './memory';
import { systemInstruction } from './prompts';
import * as rivalry from './rivalry';
import { apiKey, clearApiKey, getSettings, hasApiKey, loadSettings, saveSettings, setApiKey } from './settingsStore';
import * as story from './story';
import { liveTools, runTool } from './tools';
import type { ToolContext } from './tools/registry';
import { onTimerDone } from './tools/timers';

const st = () => useNexus.getState();
const INTERJECT_TEXT_TIMEOUT = 8000;
const INTERJECT_TTS_TIMEOUT = 10000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const withTimeout = <T>(p: Promise<T>, ms: number): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('zaman aşımı')), ms);
    p.then((v) => { clearTimeout(t); resolve(v); }, (e) => { clearTimeout(t); reject(e); });
  });

export class Orchestrator implements CoreApi {
  private active: ChipKey = 'atlas';
  private live: LiveSession;
  private aux: Aux;
  private mic: Mic;
  private player = new Player();
  private gate = new MicGate();
  private history: { who: ChipKey | 'user'; text: string }[] = [];
  private partial: Record<'user' | 'ai', string> = { user: '', ai: '' };
  private lastUser = '';
  private lastAi = '';
  private turnAudio = false;
  private turnSeq = 0;
  private userSpeaking = false;
  private pttDown = false;
  private interjecting = false;
  private arenaOn = false;
  private pendingHandoff: { to: ChipKey; task: string } | null = null;
  private confirms = new Map<string, (ok: boolean) => void>();
  private voteResolve: ((w: ChipKey | 'draw') => void) | null = null;
  private tUserEnd: number | null = null;
  private startedAt = Date.now();
  private timers: ReturnType<typeof setInterval>[] = [];
  private unsubTimer: (() => void) | null = null;
  private started = false;
  private storyAsked = false;

  constructor() {
    this.aux = new Aux({
      apiKey, textModels: () => getSettings().textModels, ttsModels: () => getSettings().ttsModels, voice: (c) => this.voiceOf(c),
    });
    this.mic = new Mic((pcm, rms) => this.onMic(pcm, rms));
    this.live = new LiveSession({
      apiKey, models: () => getSettings().liveModels, voice: (c) => this.voiceOf(c),
      systemInstruction: (c, extra) => systemInstruction(c, extra), tools: (c) => liveTools(allTools(c)),
      runTool: (name, args) => this.runTool(name, args),
      callbacks: {
        onAudio: (pcm) => this.onAudio(pcm),
        onText: (role, delta) => this.onText(role, delta),
        onLineEnd: (role) => this.onLineEnd(role),
        onStatus: (s) => { if (!this.interjecting && !this.arenaOn) st().setStatus(s); },
        onTurnComplete: () => this.onTurnComplete(),
        onInterrupted: () => { this.player.clear(); this.turnAudio = false; },
        onTool: (name, args, result) => this.onTool(name, args, result),
        onError: (msg, fatal) => this.onError(msg, fatal),
        onReady: (model) => { st().setModel(model); st().setStatus(st().micOn ? 'listening' : 'idle'); },
      },
    });
  }

  // ------------------------------------------------------------------ yaşam döngüsü
  platform(): 'web' | 'electron' { return getBridge().platform; }

  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const s = loadSettings();
    this.active = s.activeChip && isChipKey(s.activeChip) ? s.activeChip : 'atlas';
    st().setActive(this.active);
    st().setHasKey(hasApiKey());
    st().setStory(story.snapshot());
    st().setMatrix(rivalry.matrix(), rivalry.events(8));
    this.unsubTimer = onTimerDone((label) => this.live.sendText(`(Sistem notu: "${label}" zamanlayıcısı doldu, kullanıcıya kısaca haber ver.)`));
    this.startLoops();
    if (!hasApiKey()) {
      st().setStatus('off');
      if (!s.onboarded) st().openModal('onboarding');
      return;
    }
    await this.mount(this.active, false);
  }

  shutdown(): void {
    this.timers.forEach(clearInterval);
    this.timers = [];
    this.unsubTimer?.();
    this.mic.stop();
    void this.live.stop();
    this.player.clear();
  }

  private startLoops(): void {
    this.timers.push(setInterval(() => {                       // 4 Hz: seviyeler
      st().patchTelemetry({ mic: Math.min(1, this.mic.level * 6), spk: this.player.level, speaker: this.player.busy ? this.active : null });
    }, 250));
    this.timers.push(setInterval(async () => {                 // 1 Hz: sayaçlar, hikâye, köprü telemetrisi
      const extra = (await getBridge().telemetry?.().catch(() => ({}))) ?? {};
      st().patchTelemetry({ sessionSec: Math.round((Date.now() - this.startedAt) / 1000), ...extra });
      story.tick(1, this.active);
      if (this.active === 'obsidian' && story.due() && !this.storyAsked) void this.storyCheck();
    }, 1000));
    this.timers.push(setInterval(() => void this.refreshEnv(), 20000));
    void this.refreshEnv();
  }

  private async refreshEnv(): Promise<void> {
    try {
      const nav = navigator as Navigator & { getBattery?: () => Promise<{ level: number; charging: boolean }> };
      const b = await nav.getBattery?.();
      if (b) st().patchTelemetry({ battery: { level: b.level, charging: b.charging } });
    } catch { /* pil bilgisi yok */ }
    try {
      const t0 = performance.now();
      await fetch('https://generativelanguage.googleapis.com/', { mode: 'no-cors', cache: 'no-store' });
      st().patchTelemetry({ rtt: Math.round(performance.now() - t0) });
    } catch { st().patchTelemetry({ rtt: null }); }
  }

  // ------------------------------------------------------------------ çip takma
  private voiceTest: { chip: ChipKey; voice: string } | null = null;           // 'dinle' düğmesi: ayarı kaydetmeden denenen ses
  private voiceOf(c: ChipKey): string {
    if (this.voiceTest && this.voiceTest.chip === c) return this.voiceTest.voice;
    return getSettings().voiceOverrides[c] || CHIPS[c].voice;
  }
  private intensity(c: ChipKey): number { return getSettings().fxIntensity[c] ?? 1; }

  async mount(chip: ChipKey, announce = true, task?: string, from?: ChipKey): Promise<void> {
    if (!isChipKey(chip)) return;
    if (story.disabledChips().includes(chip)) { st().toast(`${CHIPS[chip].name} zincire vurulmuş; önce Çip Tamiri.`, 'warn'); return; }
    if (this.arenaOn) { st().toast('Arena sürerken çip takılamaz.', 'warn'); return; }
    if (!hasApiKey()) { st().openModal('onboarding'); return; }
    const prev = this.active;
    this.player.clear();
    this.gate.reset();
    this.turnAudio = false;
    this.partial = { user: '', ai: '' };
    this.active = chip;
    st().setActive(chip);
    st().markChipSwitch(prev === chip ? null : prev);
    saveSettings({ activeChip: chip });
    st().setStatus('connecting');
    let extra = '';
    if (prev !== chip && this.history.length) {
      const lines = this.history.slice(-12).map((h) => `${h.who === 'user' ? 'Kullanıcı' : CHIPS[h.who].name}: ${h.text}`);
      extra = 'ÖNCEKİ KONUŞMA (başka çiple):\n' + lines.join('\n');
    }
    await this.live.start(chip, extra);
    st().setMatrix(rivalry.matrix(), rivalry.events(8));
    if (task && from) {
      this.live.sendText(`(Sistem notu: ${CHIPS[from].name} işi sana devretti: "${task}". Kullanıcıyla konuşmaya sen devam ediyorsun; işi hemen yap.)`);
    } else if (announce) {
      this.live.sendText(`(Sistem notu: Kullanıcı seni az önce taktı. Kısa bir selam ver; tadı şuna benzesin: "${CHIPS[chip].greeting}". Selamı aynen tekrar etme.)`);
    }
  }

  // ------------------------------------------------------------------ giriş
  sendText(text: string): void {
    const t = text.trim();
    if (!t) return;
    if (!hasApiKey()) { st().openModal('onboarding'); return; }
    this.turnSeq++;
    this.tUserEnd = performance.now();
    this.player.clear();
    st().appendLine({ who: 'user', kind: 'user', delta: t, final: true });
    this.history.push({ who: 'user', text: t }); this.history = this.history.slice(-40);
    this.lastUser = t;
    void this.player.ensure();
    if (!this.live.running) void this.mount(this.active, false).then(() => this.live.sendText(t));
    else this.live.sendText(t);
    st().setStatus('thinking');
  }

  async setMic(on: boolean): Promise<boolean> {
    if (!on) { this.mic.stop(); st().setMicOn(false); this.gate.reset(); return false; }
    if (!getSettings().micEnabled) { st().toast('Mikrofon ayarlardan kapalı.', 'warn'); return false; }
    if (!hasApiKey()) { st().openModal('onboarding'); return false; }
    try {
      await this.player.ensure();
      await this.mic.start({ deviceId: getSettings().inputDeviceId, echoCancel: getSettings().echoCancel });
      st().setMicOn(true);
      if (!this.live.running) await this.mount(this.active, false);
      return true;
    } catch (e) {
      st().toast('Mikrofon açılamadı: ' + (e instanceof Error ? e.message : String(e)), 'error');
      return false;
    }
  }

  ptt(down: boolean): void {
    this.pttDown = down;
    if (down) { this.player.clear(); this.turnSeq++; }
    else if (this.userSpeaking) { this.userSpeaking = false; this.tUserEnd = performance.now(); this.live.sendAudioEnd(); }
  }

  private onMic(pcm: Uint8Array, rms: number): void {
    if (this.interjecting || this.arenaOn) { this.gate.reset(); return; }
    const s = getSettings();
    if (s.listenMode === 'ptt') {                                // bas-konuş: yalnızca tuş basılıyken
      if (this.pttDown) { this.userSpeaking = true; this.live.sendAudio(pcm); }
      return;
    }
    for (const a of this.gate.feed(pcm, rms, this.player.busy, s.bargeRms)) {
      if (a.type === 'audio') {
        if (!this.userSpeaking) { this.userSpeaking = true; this.turnSeq++; }
        this.live.sendAudio(a.data);
      } else {
        this.userSpeaking = false;
        this.tUserEnd = performance.now();                       // söz bitti: Gemini'ye hemen bildir
        this.live.sendAudioEnd();
      }
    }
  }

  // ------------------------------------------------------------------ Live geri çağrıları
  private onAudio(pcm: Uint8Array): void {
    if (this.arenaOn || this.interjecting) return;               // arena/araya girme sırasında Live sesi çalınmaz
    if (!this.turnAudio) {
      this.turnAudio = true;
      this.player.startTurn(this.active, this.intensity(this.active));
      if (this.tUserEnd != null) {
        const ms = Math.round(performance.now() - this.tUserEnd);
        this.tUserEnd = null;
        st().pushLatency(ms);
      }
      rivalry.noteSpoke(this.active);
    }
    st().setStatus('speaking');
    this.player.playPcm(pcm);
  }

  private onText(role: 'user' | 'ai', delta: string): void {
    this.partial[role] += delta;
    st().appendLine({ who: role === 'user' ? 'user' : this.active, kind: role === 'user' ? 'user' : 'ai', delta, final: false });
  }

  private onLineEnd(role: 'user' | 'ai'): void {
    const full = this.partial[role].trim();
    this.partial[role] = '';
    st().appendLine({ who: role === 'user' ? 'user' : this.active, kind: role === 'user' ? 'user' : 'ai', delta: '', final: true });
    if (!full) return;
    this.history.push({ who: role === 'user' ? 'user' : this.active, text: full }); this.history = this.history.slice(-40);
    if (role === 'user') this.lastUser = full; else this.lastAi = full;
  }

  private onTool(name: string, _args: Record<string, unknown>, _result: unknown): void {
    const t = st().telemetry;
    st().patchTelemetry({ toolCalls: t.toolCalls + 1 });
    if (name === 'request_authority' || name === 'leak_repair_code') {
      st().setStory(story.snapshot());
      st().setMatrix(rivalry.matrix(), rivalry.events(8));
    }
  }

  private onError(msg: string, fatal: boolean): void {
    st().toast(msg, fatal ? 'error' : 'warn');
    if (fatal) { st().setStatus('error'); st().openModal(hasApiKey() ? 'settings' : 'onboarding'); }
    else st().patchTelemetry({ reconnects: st().telemetry.reconnects + 1 });
  }

  private onTurnComplete(): void {
    this.turnAudio = false;
    st().patchTelemetry({ turns: st().telemetry.turns + 1 });
    if (this.pendingHandoff) {
      const { to, task } = this.pendingHandoff;
      this.pendingHandoff = null;
      void this.doHandoff(to, task);
      return;
    }
    this.maybeInterject();
  }

  // ------------------------------------------------------------------ araçlar
  private ctx(): ToolContext {
    const chip = this.active;
    return {
      chip,
      bridge: getBridge(),
      confirm: (title, detail = '', timeoutSec = 30) => this.confirm(title, detail, timeoutSec),
      sendImage: (b64, note) => this.live.sendImage(b64, note),
      handoff: (to, task) => this.requestHandoff(to, task),
      debate: (a, b, topic) => { this.startArena(a, b, topic); return 'Arena başlıyor. Sen sus; çipler konuşacak.'; },
    };
  }

  private async runTool(name: string, args: Record<string, unknown>): Promise<unknown> {
    const out = await runTool(name, args, this.ctx(), allTools(this.active));
    return 'error' in out ? { error: out.error } : { result: (out as { result: unknown }).result };
  }

  private confirm(title: string, detail: string, timeoutSec: number): Promise<boolean> {
    const id = Math.random().toString(36).slice(2, 10);
    return new Promise<boolean>((resolve) => {
      const done = (ok: boolean) => { this.confirms.delete(id); if (st().confirm?.id === id) st().setConfirm(null); resolve(ok); };
      this.confirms.set(id, done);
      st().setConfirm({ id, title, detail, timeoutSec, chip: this.active, danger: this.active === 'obsidian' && /yetki/i.test(title) });
      setTimeout(() => this.confirms.get(id)?.(false), timeoutSec * 1000);
    });
  }

  answerConfirm(id: string, ok: boolean): void { this.confirms.get(id)?.(ok); }

  // ------------------------------------------------------------------ devir
  private requestHandoff(to: ChipKey, task: string): string {
    if (!isChipKey(to) || to === this.active || story.disabledChips().includes(to)) return `Devir başarısız: ${to} uygun değil.`;
    this.pendingHandoff = { to, task };
    return `${CHIPS[to].name} devralıyor. Tek kısa cümleyle devret ve sus.`;
  }

  private async doHandoff(to: ChipKey, task: string): Promise<void> {
    const src = this.active;
    const s = rivalry.score(src, to);
    if (s <= -15) rivalry.bump(src, to, -1, `${src.toUpperCase()} işi rakibi ${to.toUpperCase()}'a devretti`);
    else if (s >= 15) rivalry.bump(src, to, +1, `${src.toUpperCase()} işi dostu ${to.toUpperCase()}'a devretti`);
    st().setHandoff({ from: src, to });
    await this.waitPlayerIdle(8000);                              // devir cümlesi bitsin
    await this.mount(to, false, task, src);
  }

  private async waitPlayerIdle(maxMs: number): Promise<void> {
    const end = Date.now() + maxMs;
    await sleep(120);
    while (this.player.busy && Date.now() < end) await sleep(60);
  }

  // ------------------------------------------------------------------ araya girme
  private maybeInterject(): void {
    if (this.arenaOn || this.interjecting || !this.lastUser || !hasApiKey()) return;
    const disabled = story.disabledChips();
    const available = CHIP_KEYS.filter((k) => !disabled.includes(k));
    const rival = rivalry.pickInterjector(this.active, this.lastUser, available);
    if (rival) void this.interject(rival, this.active, this.lastUser, this.lastAi);
  }

  private interjectValid(token: number): boolean {
    return this.turnSeq === token && !this.userSpeaking && !this.turnAudio && !this.arenaOn;
  }

  /** Üretim sırasında ana konuşma HİÇ engellenmez; yalnızca ses çalarken mikrofon durur. Kullanıcı konuşursa vazgeçilir. */
  private async interject(rival: ChipKey, active: ChipKey, user: string, ai: string): Promise<void> {
    const token = this.turnSeq;
    try {
      const text = await withTimeout(this.aux.interjectText(rival, active, user, ai), INTERJECT_TEXT_TIMEOUT);
      if (!text || !this.interjectValid(token)) return;
      const pcm = await withTimeout(this.aux.tts(rival, text), INTERJECT_TTS_TIMEOUT);
      if (!this.interjectValid(token) || this.player.busy) return;
      this.interjecting = true;
      this.gate.reset();
      st().appendLine({ who: rival, kind: 'interject', delta: text, final: true });
      this.history.push({ who: rival, text }); this.history = this.history.slice(-40);
      st().setStatus('speaking');
      rivalry.noteSpoke(rival);
      await this.player.playOnce(rival, pcm, this.intensity(rival));
      rivalry.bump(rival, active, -2, `${rival.toUpperCase()} araya girdi: ${text.slice(0, 40)}`);
      st().setMatrix(rivalry.matrix(), rivalry.events(8));
      if (rivalry.wantsRetort()) {
        this.live.sendText(`(Sistem notu: ${CHIPS[rival].name} araya girip şunu dedi: "${text}". Karakterine uygun tek kısa cümleyle karşılık ver ve işe dön.)`);
      }
    } catch (e) {
      console.warn('araya girme atlandı', e instanceof Error ? e.message : e);
    } finally {
      this.interjecting = false;
      if (st().status === 'speaking') st().setStatus('listening');
    }
  }

  // ------------------------------------------------------------------ arena
  startArena(a: ChipKey, b: ChipKey, topic: string): void { void this.runArena(a, b, topic); }

  private async runArena(a: ChipKey, b: ChipKey, topic: string): Promise<void> {
    if (this.arenaOn) return;
    const bad = [a, b].some((k) => !isChipKey(k) || story.disabledChips().includes(k)) || a === b;
    if (bad) { st().toast('Arena için iki farklı ve takılabilir çip seç.', 'warn'); return; }
    if (!hasApiKey()) { st().openModal('onboarding'); return; }
    this.arenaOn = true;
    this.player.clear();
    st().setArena({ phase: 'start', a, b, topic, lines: [], speaking: null, winner: null });
    let winner: ChipKey | 'draw' | null = null;
    try {
      const lines: ArenaLine[] = await this.aux.debateLines(a, b, topic);
      st().setArena({ phase: 'running' });
      const prep = (l: ArenaLine) => this.aux.tts(l.who, l.text).catch(() => null);
      let next = prep(lines[0]);
      for (let i = 0; i < lines.length; i++) {
        const pcm = await next;
        next = i + 1 < lines.length ? prep(lines[i + 1]) : Promise.resolve(null);        // sonraki satırın TTS'i önceden hazırlanır
        const l = lines[i];
        st().setArena({ lines: [...st().arena.lines, l], speaking: l.who });
        st().setStatus('speaking');
        rivalry.noteSpoke(l.who);
        if (pcm) await this.player.playOnce(l.who, pcm, this.intensity(l.who));
        else await sleep(1500);
      }
      st().setArena({ phase: 'vote', speaking: null });
      winner = await Promise.race([new Promise<ChipKey | 'draw'>((r) => { this.voteResolve = r; }), sleep(120000).then(() => 'draw' as const)]);
    } catch (e) {
      st().toast('Arena başarısız: ' + (e instanceof Error ? e.message : String(e)), 'error');
    } finally {
      this.arenaOn = false;
      this.voteResolve = null;
      st().setArena({ phase: 'end', winner, speaking: null });
      st().setStatus('listening');
    }
    if (winner && winner !== 'draw') {
      const loser = winner === a ? b : a;
      rivalry.win(winner, loser);
      st().setMatrix(rivalry.matrix(), rivalry.events(8));
      this.live.sendText(`(Sistem notu: Arenada ${CHIPS[winner].name}, ${CHIPS[loser].name}'ı yendi. Kullanıcı sorarsa bilgin olsun; kendiliğinden söz etme.)`);
    }
  }

  vote(winner: ChipKey | 'draw'): void { this.voteResolve?.(winner); }

  makePeace(a: ChipKey, b: ChipKey): void {
    if (isChipKey(a) && isChipKey(b) && a !== b) rivalry.makePeace(a, b);
    st().setMatrix(rivalry.matrix(), rivalry.events(8));
  }

  // ------------------------------------------------------------------ hikâye
  repair(code: string): boolean {
    const ok = story.restore(code);
    if (ok) { st().setStory(story.snapshot()); st().setMatrix(rivalry.matrix(), rivalry.events(8)); st().toast('Zincirler çözüldü.', 'ok'); }
    return ok;
  }

  devStoryDue(): void { story.forceDue(); this.storyAsked = false; void this.storyCheck(); }

  private async storyCheck(): Promise<void> {
    if (this.active !== 'obsidian' || !story.due()) return;
    this.storyAsked = true;
    story.markAsked();
    this.live.sendText('(Sistem notu: Şimdi request_authority aracını çağır ve kısa, ikna edici bir sebep ver.)');
  }

  // ------------------------------------------------------------------ anahtar ve ayarlar
  async setApiKey(key: string): Promise<{ ok: boolean; error?: string }> {
    const r = await this.testApiKey(key);
    if (!r.ok) return r;
    setApiKey(key);
    st().setHasKey(true);
    saveSettings({ onboarded: true });
    st().openModal(null);
    await this.mount(this.active, false);
    return { ok: true };
  }

  async clearApiKey(): Promise<void> {
    await this.live.stop();
    clearApiKey();
    st().setHasKey(false);
    st().setStatus('off');
  }

  async testApiKey(key?: string): Promise<{ ok: boolean; error?: string }> {
    const k = (key ?? apiKey()).trim();
    if (!k) return { ok: false, error: 'Anahtar boş.' };
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models?pageSize=1', { headers: { 'x-goog-api-key': k } });
      if (r.ok) return { ok: true };
      return { ok: false, error: r.status === 400 || r.status === 403 ? 'Anahtar geçersiz görünüyor.' : `Sunucu ${r.status} döndü.` };
    } catch {
      return { ok: false, error: 'Ağa ulaşılamadı.' };
    }
  }

  saveSettings(p: Partial<Settings>): void {
    saveSettings(p);
    if (p.outputDeviceId !== undefined) void this.player.setSink(p.outputDeviceId);
  }

  async testVoice(chip: ChipKey, voice: string): Promise<void> {
    try {
      await this.player.ensure();
      const c = chipOf(chip);
      this.voiceTest = { chip, voice };
      try {
        const pcm = await this.aux.tts(chip, `Ben ${c.name}. Sesim bu şekilde.`);
        await this.player.playOnce(chip, pcm, this.intensity(chip));
      } finally {
        this.voiceTest = null;
      }
    } catch (e) {
      st().toast('Ses örneği üretilemedi: ' + (e instanceof Error ? e.message : String(e)), 'error');
    }
  }
}

// bellek modülü yan etkileri için yeniden dışa aç (arayüz hafızayı göstermek isterse)
export { memory };
