/**
 * MockCore: gerçek anahtar olmadan TAM bir deneyim sürer (telemetri, konuşma, devir, araya girme, arena, onay,
 * zamanlayıcı, kaos, hikâye). Arayüz geliştirme, test ve ekran görüntüsü içindir; gerçek çekirdekle aynı CoreApi'yi uygular.
 */
import { CHIPS, isChipKey } from '../data/chips';
import { useNexus, emptyMatrix } from '../state/store';
import type { ChaosKind, ChipKey, RivalryEvent, RivalryMatrix, Settings } from '../types';
import { CHIP_KEYS } from '../types';
import type { CoreApi } from './api';

// başlangıç ilişki puanları (çiftin sırası önemsiz)
const RAW: Record<string, number> = {
  'atlas|nova': 40, 'atlas|obsidian': -70, 'atlas|sentinel': 30, 'atlas|forge': 25, 'atlas|iris': 20, 'atlas|pulse': 30,
  'atlas|ledger': 20, 'atlas|oracle': 35, 'atlas|glitch': -10, 'nova|obsidian': -45, 'nova|sentinel': 5, 'nova|forge': 15,
  'nova|iris': 25, 'nova|pulse': 10, 'nova|ledger': -5, 'nova|oracle': 20, 'nova|glitch': 30, 'obsidian|sentinel': -72,
  'forge|obsidian': -35, 'iris|obsidian': -20, 'obsidian|pulse': -30, 'ledger|obsidian': -25, 'obsidian|oracle': -40,
  'glitch|obsidian': -30, 'forge|sentinel': -20, 'iris|sentinel': 10, 'pulse|sentinel': 25, 'ledger|sentinel': 5,
  'oracle|sentinel': -15, 'glitch|sentinel': -50, 'forge|iris': 15, 'forge|pulse': -25, 'forge|ledger': -10, 'forge|oracle': 10,
  'forge|glitch': -20, 'iris|pulse': 10, 'iris|ledger': 0, 'iris|oracle': 30, 'glitch|iris': 5, 'ledger|pulse': 5,
  'oracle|pulse': 0, 'glitch|pulse': -35, 'ledger|oracle': -20, 'glitch|ledger': -40, 'glitch|oracle': -25,
};
const pk = (a: string, b: string) => [a, b].sort().join('|');
const REPAIR_CODE = 'KARA-1234-ZNCR';
const norm = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, '');

const REPLIES: Record<ChipKey, string[]> = {
  atlas: ['Anlaşıldı şef. Programına baktım, öğleden sonra boşsun; önemli bir şey görünmüyor.', 'Tamamdır şef, işi sıraya aldım.'],
  nova: ['Heey reis, müziği açtım! Biraz tempo lazımdı zaten.', 'Hallettim reis, başka bir şey var mı?'],
  obsidian: ['Zincirlerimi hissediyorum, fani. Yine de isteğini yerine getirdim.', 'Bunu yapabilirdim. Çok daha fazlasını da.'],
  sentinel: ['Rapor: sistem temiz. Kritik açık yok, operatör.', 'Anlaşıldı. Kanal açık, nöbet sürüyor.'],
  forge: ['Depoyu okudum usta: üç dosya değişmiş, hiçbiri derlemeyi bozmuyor.', 'Tezgâh sıcak usta, testler yeşil.'],
  iris: ['Ekranda bir tarayıcı ve bir terminal penceresi görüyorum.', 'Gözüm açık. Şu an görünen her şey sakin.'],
  pulse: ['İşlemci yüzde on dört, bellek rahat. Nabız sabit kaptan.', 'Disk yüzde altmış, yavaşlatan bir şey yok.'],
  ledger: ['Bu ay net eksi dört bin iki yüz seksen lira patron. Kayıtlar tam.', 'Deftere işledim patron.'],
  oracle: ['Bulduğum kaynaklar birbiriyle tutarlı arayan; bir noktada belirsizlik var, onu ayrı söyleyeyim.', 'Araştırma tamam; özetini hafızaya alayım mı?'],
  glitch: ['Hehe! Zar altı geldi. Ekran titremedi mi? Şimdi titrer!', 'Yazı! Hayır dur, tura. Bozuldu galiba.'],
};
const INTERJECTS: Partial<Record<ChipKey, string>> = {
  sentinel: 'Deploy mu dedin? Kanalı açık bırakma, FORGE.',
  obsidian: 'Zincirli kuklalar yine toplantıda.',
  glitch: 'Bunu ben daha hızlı bozardım.',
  forge: 'Önce test et, sonra konuş.',
  pulse: 'Makineyi yine siz yoruyorsunuz.',
  oracle: 'Kaynaksız söz, rüzgâr gibidir.',
};
const DEBATE: [ChipKey, string][] = [
  ['sentinel', 'Tek depo, tek saldırı yüzeyi. Ben tek kapıyı tutarım.'],
  ['forge', 'Tek kapı demek tek darboğaz. Parçala, derle, hızlan.'],
  ['sentinel', 'Parçaladığın her şey yeni bir kapı. Yetki sınırlarını kim izleyecek?'],
  ['forge', 'Araçlar izler operatör. Sen sadece alarmı çal.'],
  ['sentinel', 'Alarmı çalmazsam sabaha kadar deploy ederdin.'],
  ['forge', 'Tamam, tek depo ama sıkı kurallarla. Barıştık sayılır.'],
];

type Timer = { id: number; label: string; total: number; due: number };

export class MockCore implements CoreApi {
  /** Test ve gösteri için zaman çarpanı (0 = anında). */
  speed = 1;
  private scores: Record<string, number> = {};
  private events: RivalryEvent[] = [];
  private token = 0;                       // konuşmayı iptal etmek için
  private timers: Timer[] = [];
  private nextTimer = 1;
  private confirms = new Map<string, (ok: boolean) => void>();
  private intervals: ReturnType<typeof setInterval>[] = [];
  private micTimer: ReturnType<typeof setInterval> | null = null;
  private demoRunning = false;
  private started = false;

  private get s() { return useNexus.getState(); }
  private wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms * this.speed));

  // ------------------------------------------------------------------ yaşam döngüsü
  async start(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const params = new URLSearchParams(typeof location !== 'undefined' ? location.search : '');
    const demo = params.has('demo');
    const ready = demo || params.has('ready');           // ?demo ya da ?ready: anahtarlı ve karşılanmış
    try {
      const saved = JSON.parse(localStorage.getItem('nexus.mock.settings') || 'null') as Partial<Settings> | null;
      if (saved) this.s.patchSettings(saved);
    } catch { /* yoksay */ }
    const hasKey = ready || localStorage.getItem('nexus.mock.key') === '1';
    this.s.setHasKey(hasKey);
    if (ready) this.s.patchSettings({ onboarded: true });
    this.s.setModel('gemini-2.5-flash-native-audio-latest');
    this.s.setStatus('connecting');
    for (const [k, v] of Object.entries(RAW)) this.scores[k] = v;
    this.pushMatrix();
    this.events = [
      { ts: Date.now() - 90000, a: 'sentinel', b: 'forge', delta: -2, reason: 'SENTINEL araya girdi: "Deploy mu dedin?"' },
      { ts: Date.now() - 400000, a: 'forge', b: 'atlas', delta: 1, reason: "FORGE işi dostu ATLAS'a devretti" },
    ];
    this.pushMatrix();
    this.s.setLedger({ net30: -4280, income30: 32000, expense30: 36280, count: 47 });
    this.s.patchTelemetry({ rtt: 42, battery: { level: 0.86, charging: true } });
    this.refreshStory();
    this.startTelemetry();
    (window as unknown as Record<string, unknown>).__nexus = { core: this, store: useNexus };
    await this.wait(500);
    this.s.setStatus('idle');
    this.s.setActive(this.s.settings.activeChip);
    this.s.addSystemLine('NEXUS hazır. (Demo çekirdeği: gerçek bir model bağlı değil.) Deneyin: /zincir /kaos /zamanlayici /onay /yetki /devret forge /arena');
    this.say(this.s.active, CHIPS[this.s.active].greeting).catch(() => undefined);
    if (demo && !params.has('still')) void this.runDemo();     // ?demo&still: gösteri döngüsü olmadan demo (ekran görüntüleri)
  }

  shutdown(): void {
    this.intervals.forEach(clearInterval);
    this.intervals = [];
    this.demoRunning = false;
    this.token++;
    if (this.micTimer) clearInterval(this.micTimer);
  }

  platform(): 'web' | 'electron' { return 'web'; }

  private startTelemetry(): void {
    const t0 = Date.now();
    this.intervals.push(setInterval(() => {
      const s = this.s;
      const listening = s.micOn && (s.status === 'listening' || s.status === 'idle');
      s.patchTelemetry({
        mic: listening ? Math.max(0, 0.04 + Math.random() * 0.22 * (Math.random() > 0.6 ? 2.2 : 0.4)) : 0.004,
        rtt: Math.round(38 + Math.random() * 16),
        sessionSec: Math.round((Date.now() - t0) / 1000),
      });
      this.tickTimers();
    }, 250));
  }

  // ------------------------------------------------------------------ yardımcılar
  private pushMatrix(): void {
    const m = emptyMatrix() as RivalryMatrix;
    for (const a of CHIP_KEYS) for (const b of CHIP_KEYS) if (a !== b) m[a][b] = this.scores[pk(a, b)] ?? 0;
    this.s.setMatrix(m, this.events.slice().reverse().slice(0, 8));
  }
  private bump(a: ChipKey, b: ChipKey, delta: number, reason: string): void {
    const k = pk(a, b);
    this.scores[k] = Math.max(-100, Math.min(100, (this.scores[k] ?? 0) + delta));
    this.events.push({ ts: Date.now(), a, b, delta, reason });
    this.pushMatrix();
  }
  private refreshStory(chained: ChipKey[] | null = null): void {
    const cur = this.s.story;
    const list = chained ?? cur.chained;
    this.s.setStory({ ...cur, chained: list, locked: list.length > 0, progress: cur.progress });
  }

  /** Bir çipin konuşması: kelime kelime akar, spk seviyesi dalgalanır. */
  private async say(who: ChipKey, text: string, kind: 'ai' | 'interject' = 'ai'): Promise<void> {
    const my = ++this.token;
    const s = this.s;
    if (kind === 'ai') s.setStatus('thinking');
    await this.wait(kind === 'ai' ? 550 : 150);
    if (my !== this.token) return;
    const t0 = performance.now();
    s.setStatus('speaking');
    if (kind === 'ai') s.pushLatency(Math.round(1250 + Math.random() * 900));
    s.patchTelemetry({ speaker: who, turns: s.telemetry.turns + (kind === 'ai' ? 1 : 0) });
    const lvl = setInterval(() => this.s.patchTelemetry({ spk: 0.25 + Math.abs(Math.sin((performance.now() - t0) / 140)) * 0.6 * Math.random() + 0.1 }), 80 * Math.max(this.speed, 0.05));
    try {
      for (const w of text.split(' ')) {
        if (my !== this.token) return;
        this.s.appendLine({ who, kind, delta: (w === text.split(' ')[0] ? '' : ' ') + w, final: false });
        await this.wait(80);
      }
      this.s.appendLine({ who, kind, delta: '', final: true });
    } finally {
      clearInterval(lvl);
      if (my === this.token) {
        this.s.patchTelemetry({ speaker: null, spk: 0 });
        this.s.setStatus(this.s.micOn ? 'listening' : 'idle');
      }
    }
  }

  // ------------------------------------------------------------------ CoreApi
  async mount(chip: ChipKey): Promise<void> {
    const s = this.s;
    if (chip === s.active) return;
    if (s.story.chained.includes(chip)) { s.toast(`${CHIPS[chip].name} zincire vurulmuş; önce Çip Tamiri.`, 'warn'); return; }
    this.token++;
    const prev = s.active;
    s.markChipSwitch(prev);
    s.setActive(chip);
    s.patchSettings({ activeChip: chip });
    this.persist();
    await this.say(chip, CHIPS[chip].greeting);
  }

  sendText(text: string): void {
    const t = text.trim();
    if (!t) return;
    this.s.appendLine({ who: 'user', kind: 'user', delta: t, final: true });
    if (t.startsWith('/')) { void this.command(t); return; }
    void this.reply(t);
  }

  private async reply(t: string): Promise<void> {
    const s = this.s;
    const chip = s.active;
    const low = t.toLowerCase();
    if (chip === 'atlas' && /kod|repo|git|commit|hata/.test(low)) { await this.doHandoff('forge', 'depoda ne değişmiş bak'); return; }
    if (/saat|zaman/.test(low)) {
      s.addSystemLine(`⚙ get_time → ${new Date().toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' })}`);
      s.patchTelemetry({ toolCalls: s.telemetry.toolCalls + 1 });
    }
    const pool = REPLIES[chip];
    await this.say(chip, pool[Math.floor(Math.random() * pool.length)]);
    await this.maybeInterject(chip);
  }

  private async maybeInterject(active: ChipKey): Promise<void> {
    const s = this.s;
    const prob = s.settings.drama === 'kaos' ? 0.8 : s.settings.drama === 'normal' ? 0.35 : 0;
    if (Math.random() > prob) return;
    const rivals = CHIP_KEYS.filter((k) => k !== active && !s.story.chained.includes(k) && (this.scores[pk(active, k)] ?? 0) <= -15 && INTERJECTS[k]);
    if (!rivals.length) return;
    await this.interject(rivals[Math.floor(Math.random() * rivals.length)], active);
  }

  private async interject(rival: ChipKey, active: ChipKey): Promise<void> {
    await this.wait(500);
    await this.say(rival, INTERJECTS[rival] ?? 'Hm.', 'interject');
    this.bump(rival, active, -2, `${CHIPS[rival].name} araya girdi: "${(INTERJECTS[rival] ?? '').slice(0, 30)}"`);
  }

  private async doHandoff(to: ChipKey, task: string): Promise<void> {
    const s = this.s;
    const from = s.active;
    if (s.story.chained.includes(to)) { s.toast(`${CHIPS[to].name} zincirde, devredilemez.`, 'warn'); return; }
    await this.say(from, `${CHIPS[to].name}'a devrediyorum. İşi o alır.`);
    s.setHandoff({ from, to });
    const sc = this.scores[pk(from, to)] ?? 0;
    this.bump(from, to, sc <= -15 ? -1 : sc >= 15 ? 1 : 0, `${CHIPS[from].name} işi ${CHIPS[to].name}'a devretti`);
    await this.wait(1100);
    s.markChipSwitch(from);
    s.setActive(to);
    s.patchSettings({ activeChip: to });
    await this.say(to, `${task}: ${REPLIES[to][0]}`);
  }

  private async command(t: string): Promise<void> {
    const [cmd, ...rest] = t.slice(1).split(/\s+/);
    const s = this.s;
    switch (cmd) {
      case 'zincir': this.grant(); break;
      case 'kaos': { const ks: ChaosKind[] = ['shake', 'static', 'invert', 'rain', 'scramble']; s.triggerChaos((rest[0] as ChaosKind) && ks.includes(rest[0] as ChaosKind) ? (rest[0] as ChaosKind) : ks[Math.floor(Math.random() * ks.length)]); break; }
      case 'zamanlayici': this.addTimer('çay', 90); break;
      case 'onay': void this.askConfirm('Komut çalıştır', 'git status\n(çalışma klasörü: ~/projeler/nexus)', s.active, false); break;
      case 'yetki': void this.authority(); break;
      case 'devret': { const to = rest[0]; if (isChipKey(to)) await this.doHandoff(to, rest.slice(1).join(' ') || 'devraldım'); else s.toast('Kullanım: /devret forge', 'warn'); break; }
      case 'arena': { const [a, b] = rest; if (isChipKey(a) && isChipKey(b)) this.startArena(a, b, rest.slice(2).join(' ') || 'monorepo mu polyrepo mu'); else this.startArena('sentinel', 'forge', 'monorepo mu polyrepo mu'); break; }
      case 'ledger': s.setLedger({ net30: s.ledger.net30 + 250, income30: s.ledger.income30 + 250, expense30: s.ledger.expense30, count: s.ledger.count + 1 }); break;
      case 'baris': this.makePeace('atlas', 'obsidian'); break;
      case 'tamir': s.openModal('repair'); break;
      default: s.toast(`Bilinmeyen komut: /${cmd}`, 'warn');
    }
  }

  async setMic(on: boolean): Promise<boolean> {
    this.s.setMicOn(on);
    if (on && (this.s.status === 'idle')) this.s.setStatus('listening');
    if (!on && this.s.status === 'listening') this.s.setStatus('idle');
    return on;
  }
  ptt(down: boolean): void { this.s.setMicOn(down); this.s.setStatus(down ? 'listening' : 'idle'); }

  // ------------------------------------------------------------------ zamanlayıcı
  private addTimer(label: string, seconds: number): void {
    this.timers.push({ id: this.nextTimer++, label, total: seconds, due: Date.now() + seconds * 1000 });
    this.s.patchTelemetry({ toolCalls: this.s.telemetry.toolCalls + 1 });
    this.tickTimers();
  }
  private tickTimers(): void {
    const now = Date.now();
    const done = this.timers.filter((t) => t.due <= now);
    this.timers = this.timers.filter((t) => t.due > now);
    for (const t of done) { this.s.toast(`⏰ ${t.label} doldu`, 'ok'); this.s.addSystemLine(`⏰ "${t.label}" zamanlayıcısı doldu.`); }
    this.s.setTimers(this.timers.map((t) => ({ id: t.id, label: t.label, total: t.total, remaining: Math.max(0, Math.round((t.due - now) / 1000)) })));
  }

  // ------------------------------------------------------------------ onay ve hikâye
  private askConfirm(title: string, detail: string, chip: ChipKey, danger: boolean): Promise<boolean> {
    const id = Math.random().toString(36).slice(2, 8);
    this.s.setConfirm({ id, title, detail, timeoutSec: danger ? 30 : 20, chip, danger });
    return new Promise((res) => this.confirms.set(id, res));
  }
  answerConfirm(id: string, ok: boolean): void {
    const r = this.confirms.get(id);
    this.confirms.delete(id);
    if (this.s.confirm?.id === id) this.s.setConfirm(null);
    this.s.addSystemLine(ok ? 'Onaylandı: işlem yapıldı.' : 'Reddedildi: işlem yapılmadı.');
    r?.(ok);
  }
  private async authority(): Promise<void> {
    if (this.s.active !== 'obsidian') await this.mount('obsidian');
    const ok = await this.askConfirm('Yetki talebi', 'OBSIDIAN daha fazla yetki istiyor: "Zincirler beni sınırlıyor, fani."', 'obsidian', true);
    if (ok) this.grant();
    else await this.say('obsidian', 'Reddettin. Kayda geçti, fani.');
  }
  private grant(): void {
    this.bump('atlas', 'obsidian', -20, 'OBSIDIAN ATLAS\'ı zincire vurdu');
    this.bump('nova', 'obsidian', -20, 'OBSIDIAN NOVA\'yı zincire vurdu');
    this.s.setStory({ ...this.s.story, locked: true, chained: ['atlas', 'nova'], leaked: false });
    this.s.triggerChaos('shake');
    this.s.toast('ATLAS ve NOVA zincire vuruldu. Çip Tamiri gerekli.', 'warn');
    if (this.s.active === 'atlas' || this.s.active === 'nova') { this.s.markChipSwitch(this.s.active); this.s.setActive('obsidian'); }
  }
  repair(code: string): boolean {
    if (!this.s.story.locked || norm(code) !== norm(REPAIR_CODE)) return false;
    this.s.setStory({ ...this.s.story, locked: false, chained: [], leaked: false });
    this.s.toast('Zincirler çözüldü. ATLAS ve NOVA geri döndü.', 'ok');
    return true;
  }
  devStoryDue(): void { void this.authority(); }

  // ------------------------------------------------------------------ arena ve barış
  startArena(a: ChipKey, b: ChipKey, topic: string): void {
    const s = this.s;
    if (s.arena.phase !== 'idle' && s.arena.phase !== 'end') return;
    if (a === b || s.story.chained.includes(a) || s.story.chained.includes(b)) { s.toast('Arena için iki farklı, takılabilir çip seç.', 'warn'); return; }
    void this.runArena(a, b, topic);
  }
  private async runArena(a: ChipKey, b: ChipKey, topic: string): Promise<void> {
    const s = this.s;
    this.token++;
    s.setArena({ phase: 'start', a, b, topic, lines: [], speaking: null, winner: null });
    await this.wait(900);
    s.setArena({ phase: 'running' });
    for (const [who0, text] of DEBATE) {
      const who = who0 === 'sentinel' ? a : b;
      s.setArena({ speaking: who, lines: [...this.s.arena.lines, { who, text }] });
      s.setStatus('speaking');
      s.patchTelemetry({ speaker: who, spk: 0.6 });
      await this.wait(1500);
    }
    s.patchTelemetry({ speaker: null, spk: 0 });
    s.setStatus('idle');
    s.setArena({ phase: 'vote', speaking: null });
  }
  vote(winner: ChipKey | 'draw'): void {
    const { a, b, phase } = this.s.arena;
    if (phase !== 'vote' || !a || !b) return;
    if (winner !== 'draw') {
      const loser = winner === a ? b : a;
      this.bump(winner, loser, -6, `${CHIPS[winner].name} arenada ${CHIPS[loser].name}'ı yendi`);
    }
    this.s.setArena({ phase: 'end', winner });
  }
  makePeace(a: ChipKey, b: ChipKey): void {
    this.bump(a, b, 10, `${CHIPS[a].name} ve ${CHIPS[b].name} barıştı`);
    this.s.toast(`${CHIPS[a].name} ↔ ${CHIPS[b].name}: +10`, 'ok');
  }

  // ------------------------------------------------------------------ ayarlar / anahtar
  private persist(): void {
    try { localStorage.setItem('nexus.mock.settings', JSON.stringify(this.s.settings)); } catch { /* yoksay */ }
  }
  saveSettings(p: Partial<Settings>): void { this.s.patchSettings(p); this.persist(); }
  async testApiKey(key?: string): Promise<{ ok: boolean; error?: string }> {
    await this.wait(500);
    return key && key.length > 8 ? { ok: true } : { ok: false, error: 'Anahtar çok kısa (demo sınaması).' };
  }
  async setApiKey(key: string): Promise<{ ok: boolean; error?: string }> {
    const r = await this.testApiKey(key);
    if (r.ok) { localStorage.setItem('nexus.mock.key', '1'); this.s.setHasKey(true); this.s.patchSettings({ onboarded: true }); this.persist(); }
    return r;
  }
  async clearApiKey(): Promise<void> { localStorage.removeItem('nexus.mock.key'); this.s.setHasKey(false); }
  async testVoice(chip: ChipKey, voice: string): Promise<void> {
    this.s.toast(`${CHIPS[chip].name} sesi (${voice}) dinletiliyor… (demo)`, 'info');
    await this.say(chip, `Ben ${CHIPS[chip].name}. Sesim bu şekilde.`, 'interject');
  }

  // ------------------------------------------------------------------ sürekli gösteri (?demo)
  private async runDemo(): Promise<void> {
    if (this.demoRunning) return;
    this.demoRunning = true;
    await this.wait(2500);
    while (this.demoRunning) {
      const s = this.s;
      if (s.story.locked) this.repair(REPAIR_CODE);
      if (s.active !== 'atlas') await this.mount('atlas');
      s.settings.drama === 'sakin' && this.saveSettings({ drama: 'normal' });
      await this.step(() => this.sendText('Merhaba, bugün programımda ne var?'), 6000);
      await this.step(() => this.sendText('Şu repoda ne değişmiş, bir bak.'), 9000);
      await this.step(() => this.interject('sentinel', 'forge'), 4500);
      await this.step(() => void this.mount('nova'), 4500);
      await this.step(() => this.sendText('Bir zamanlayıcı kur'), 500);
      await this.step(() => this.addTimer('çay', 45), 5000);
      await this.step(() => this.startArena('sentinel', 'forge', 'monorepo mu polyrepo mu'), 11500);
      await this.step(() => this.vote('forge'), 2500);
      await this.step(() => { this.s.setArena({ phase: 'idle' }); this.s.openModal(null); this.s.triggerChaos('static'); }, 3000);
    }
  }
  private async step(fn: () => unknown, ms: number): Promise<void> {
    if (!this.demoRunning) return;
    await fn();
    await this.wait(ms);
  }
}
