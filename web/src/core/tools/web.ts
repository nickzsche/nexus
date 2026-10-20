/** Tarayıcıda gerçekten çalışan araçlar. Masaüstü köprüsü varsa bazıları (sistem, URL okuma, pil) onu tercih eder. */
import { CHIPS, isChipKey } from '../../data/chips';
import { useNexus } from '../../state/store';
import type { ChaosKind } from '../../types';
import { DESKTOP_ONLY } from '../bridge';
import * as memory from '../memory';
import { readJson, writeJson } from '../settingsStore';
import * as story from '../story';
import { isPrivateHost } from './safety';
import { num, OBJ, prop, registerTool, schema, str } from './registry';

const MAX_TEXT = 8000;
const clip = (t: string, n = MAX_TEXT): string => (t.length <= n ? t : t.slice(0, n) + `\n…[${t.length - n} karakter kesildi]`);

async function fetchTimeout(url: string, ms: number, init: RequestInit = {}): Promise<Response> {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), ms);
  try { return await fetch(url, { ...init, signal: ac.signal }); } finally { clearTimeout(t); }
}

// --- Gemini yerleşik arama (Live yapılandırmasında {googleSearch:{}} olarak gider)
registerTool({ name: 'google_search', description: 'Gemini yerleşik web araması.', parameters: OBJ, builtin: true, handler: () => ({ error: 'yerleşik araç' }) });

registerTool({
  name: 'get_time', description: 'Şu anki yerel tarih ve saati verir.', parameters: schema({}),
  handler() {
    const d = new Date();
    return { iso: d.toISOString(), yerel: d.toLocaleString('tr-TR', { dateStyle: 'full', timeStyle: 'medium' }), saatDilimi: Intl.DateTimeFormat().resolvedOptions().timeZone };
  },
});

type NavExt = Navigator & { deviceMemory?: number; connection?: { effectiveType?: string; downlink?: number; rtt?: number }; getBattery?: () => Promise<{ level: number; charging: boolean }> };

async function battery(): Promise<{ yuzde: number; sarjda: boolean } | null> {
  try {
    const b = await (navigator as NavExt).getBattery?.();
    return b ? { yuzde: Math.round(b.level * 100), sarjda: b.charging } : null;
  } catch { return null; }
}

registerTool({
  name: 'system_info', description: 'Cihaz bilgisi: işlemci çekirdeği, bellek, ağ ve pil.', parameters: schema({}),
  async handler(_a, ctx) {
    if (ctx.bridge.has('system_info')) return ctx.bridge.call('system_info', {});
    const n = navigator as NavExt;
    return {
      platform: n.platform, cekirdek: n.hardwareConcurrency, bellekGB: n.deviceMemory ?? 'bilinmiyor',
      ag: n.connection ? { tur: n.connection.effectiveType, mbps: n.connection.downlink, rtt: n.connection.rtt } : 'bilinmiyor',
      pil: await battery(), dil: n.language, cevrimici: n.onLine,
    };
  },
});

registerTool({
  name: 'battery_status', description: 'Pil yüzdesi ve şarj durumu.', parameters: schema({}),
  async handler(_a, ctx) {
    if (ctx.bridge.has('battery_status')) return ctx.bridge.call('battery_status', {});
    return (await battery()) ?? { error: 'Bu cihaz pil bilgisi vermiyor.' };
  },
});

registerTool({
  name: 'get_weather', description: 'Hava durumu (konum verilmezse IP konumu).',
  parameters: schema({ location: prop('string', 'Şehir adı') }),
  async handler(a) {
    const loc = str(a, 'location');
    try {
      const r = await fetchTimeout(`https://wttr.in/${encodeURIComponent(loc)}?format=j1&lang=tr`, 9000);
      if (!r.ok) return { error: `Hava durumu servisi ${r.status} döndü.` };
      const j = await r.json() as { current_condition: Record<string, any>[]; nearest_area?: Record<string, any>[] };
      const c = j.current_condition[0];
      return {
        yer: j.nearest_area?.[0]?.areaName?.[0]?.value ?? loc, sicaklikC: Number(c.temp_C), hissedilenC: Number(c.FeelsLikeC),
        durum: c.lang_tr?.[0]?.value ?? c.weatherDesc?.[0]?.value ?? '', nemYuzde: Number(c.humidity), ruzgarKmsa: Number(c.windspeedKmph),
      };
    } catch (e) {
      return { error: e instanceof DOMException && e.name === 'AbortError' ? 'Hava durumu servisi zamanında yanıt vermedi.' : 'Hava durumu alınamadı (ağ ya da tarayıcı engeli).' };
    }
  },
});

registerTool({
  name: 'read_url', description: 'Bir web sayfasının metnini okur (yalnızca http/https).',
  parameters: schema({ url: prop('string', 'Sayfa adresi') }, ['url']),
  async handler(a, ctx) {
    const raw = str(a, 'url');
    let u: URL;
    try { u = new URL(raw); } catch { return { error: 'Geçersiz adres.' }; }
    if (!/^https?:$/.test(u.protocol)) return { error: 'Yalnızca http/https adresleri okunur.' };
    if (isPrivateHost(u.hostname)) return { error: 'Yerel ve özel ağ adresleri okunamaz.' };
    if (ctx.bridge.has('read_url')) return ctx.bridge.call('read_url', { url: u.href });
    try {
      const r = await fetchTimeout(u.href, 10000);
      const text = (await r.text()).replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
      return clip(text);
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') return { error: 'Sayfa zamanında yanıt vermedi.' };
      return { error: 'Tarayıcı bu sayfayı okuyamıyor; masaüstü sürümünde okunur.' };   // CORS
    }
  },
});

// --- hafıza ve notlar
registerTool({
  name: 'save_memory', description: 'Kullanıcı hakkındaki kalıcı bir bilgiyi (tercih, ad, alışkanlık) kaydeder.',
  parameters: schema({ text: prop('string', 'Kaydedilecek bilgi') }, ['text']),
  handler(a) {
    const t = str(a, 'text');
    if (!t) return { error: 'Boş bilgi kaydedilemez.' };
    memory.add(t);
    return 'Kaydedildi.';
  },
});
registerTool({
  name: 'delete_memory', description: 'Kullanıcının artık istemediği kaydı, içindeki ifadeyle bulup siler.',
  parameters: schema({ match: prop('string', 'Silinecek kaydı bulan ifade') }, ['match']),
  handler(a) { const n = memory.remove(str(a, 'match')); return n ? `${n} kayıt silindi.` : { error: 'Eşleşen kayıt bulunamadı.' }; },
});

interface Note { id: number; text: string; ts: number }
const notes = (): Note[] => readJson<Note[]>('nexus.notes', []);
registerTool({
  name: 'add_note', description: 'Kullanıcı için bir not alır.',
  parameters: schema({ text: prop('string', 'Not metni') }, ['text']),
  handler(a) {
    const t = str(a, 'text');
    if (!t) return { error: 'Boş not alınamaz.' };
    const list = notes();
    list.push({ id: (list.at(-1)?.id ?? 0) + 1, text: t, ts: Date.now() });
    writeJson('nexus.notes', list.slice(-200));
    return 'Not alındı.';
  },
});
registerTool({
  name: 'list_notes', description: 'Notları listeler; isteğe bağlı arama.',
  parameters: schema({ query: prop('string', 'Aranacak ifade') }),
  handler(a) {
    const q = str(a, 'query').toLowerCase();
    const rows = notes().filter((n) => !q || n.text.toLowerCase().includes(q)).slice(-20).reverse();
    return rows.length ? rows.map((n) => `${n.id}. ${n.text}`).join('\n') : 'Not yok.';
  },
});

// --- devir ve arena
registerTool({
  name: 'handoff', description: 'İşi başka bir çipe devreder; o çip kullanıcıyla konuşmaya devam eder.',
  parameters: schema({ to: prop('string', 'Hedef çip anahtarı (atlas, nova, ...)'), task: prop('string', 'Devredilen işin eksiksiz tarifi') }, ['to', 'task']),
  handler(a, ctx) {
    const to = str(a, 'to').toLowerCase(), task = str(a, 'task');
    if (!isChipKey(to)) return { error: `Bilinmeyen çip: ${to}. Seçenekler: ${Object.keys(CHIPS).join(', ')}` };
    if (to === ctx.chip) return { error: 'Zaten bu çipsin.' };
    if (story.disabledChips().includes(to)) return { error: `${to.toUpperCase()} zincire vurulmuş, devredilemez.` };
    if (!task) return { error: 'Devredilecek iş boş.' };
    return ctx.handoff(to, task);
  },
});
registerTool({
  name: 'start_debate', description: 'İki çipi bir konuda tartıştırır (arena).',
  parameters: schema({ a: prop('string', 'Birinci çip'), b: prop('string', 'İkinci çip'), topic: prop('string', 'Konu') }, ['a', 'b', 'topic']),
  handler(a, ctx) {
    const [x, y, topic] = [str(a, 'a').toLowerCase(), str(a, 'b').toLowerCase(), str(a, 'topic')];
    if (!isChipKey(x) || !isChipKey(y) || x === y) return { error: 'İki farklı ve geçerli çip anahtarı ver.' };
    const chained = story.disabledChips();
    if (chained.includes(x) || chained.includes(y)) return { error: 'Zincire vurulmuş çip tartışmaya katılamaz.' };
    if (!topic) return { error: 'Tartışma konusu boş.' };
    return ctx.debate(x, y, topic);
  },
});

// --- tarayıcı eylemleri
const httpOnly = (s: string): URL | null => { try { const u = new URL(s); return /^https?:$/.test(u.protocol) ? u : null; } catch { return null; } };
registerTool({
  name: 'open_url', description: 'Bir web adresini yeni sekmede açar (yalnızca http/https).',
  parameters: schema({ url: prop('string', 'Adres') }, ['url']),
  handler(a) {
    const u = httpOnly(str(a, 'url'));
    if (!u) return { error: 'Yalnızca http/https adresleri açılır.' };
    window.open(u.href, '_blank', 'noopener,noreferrer');
    return `${u.href} açıldı.`;
  },
});
registerTool({
  name: 'play_music', description: "YouTube'da bir şarkı ya da sanatçı arar ve açar.",
  parameters: schema({ query: prop('string', 'Şarkı ya da sanatçı') }, ['query']),
  handler(a) {
    const q = str(a, 'query');
    if (!q) return { error: 'Ne çalınacağını söyle.' };
    window.open(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}`, '_blank', 'noopener,noreferrer');
    return `YouTube'da "${q}" aranıyor.`;
  },
});
registerTool({
  name: 'clipboard_read', description: 'Panodaki metni okur.', parameters: schema({}),
  async handler() {
    try { return clip(await navigator.clipboard.readText(), 4000) || 'Pano boş.'; } catch { return { error: 'Panoya erişim izni verilmedi.' }; }
  },
});
registerTool({
  name: 'clipboard_write', description: 'Panoya metin yazar.',
  parameters: schema({ text: prop('string', 'Yazılacak metin') }, ['text']),
  async handler(a) {
    try { await navigator.clipboard.writeText(str(a, 'text')); return 'Panoya yazıldı.'; } catch { return { error: 'Panoya yazma izni verilmedi.' }; }
  },
});

async function grabFrame(stream: MediaStream, maxSide = 1280): Promise<string> {
  try {
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.srcObject = stream;
    await v.play();
    await new Promise((r) => setTimeout(r, 250));                       // ilk kare otursun
    const k = Math.min(1, maxSide / Math.max(v.videoWidth, v.videoHeight, 1));
    const c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(v.videoWidth * k)); c.height = Math.max(1, Math.round(v.videoHeight * k));
    c.getContext('2d')!.drawImage(v, 0, 0, c.width, c.height);
    return c.toDataURL('image/jpeg', 0.8).split(',')[1];
  } finally { stream.getTracks().forEach((t) => t.stop()); }
}
registerTool({
  name: 'capture_screen', description: 'Ekranın (ya da seçilen pencerenin) bir görüntüsünü alıp çipe gönderir.',
  parameters: schema({ note: prop('string', 'Görüntüyle birlikte sorulacak soru') }),
  async handler(a, ctx) {
    if (!navigator.mediaDevices?.getDisplayMedia) return { error: 'Bu tarayıcı ekran paylaşımını desteklemiyor.' };
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false }); } catch { return { error: 'Ekran paylaşımı izni verilmedi.' }; }
    ctx.sendImage(await grabFrame(stream), str(a, 'note'));
    return 'Ekran görüntüsü gönderildi.';
  },
});
registerTool({
  name: 'capture_camera', description: 'Kameradan bir kare alıp çipe gönderir.',
  parameters: schema({ note: prop('string', 'Görüntüyle birlikte sorulacak soru') }),
  async handler(a, ctx) {
    if (!navigator.mediaDevices?.getUserMedia) return { error: 'Kamera bu tarayıcıda kullanılamıyor.' };
    let stream: MediaStream;
    try { stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false }); } catch { return { error: 'Kamera izni verilmedi.' }; }
    ctx.sendImage(await grabFrame(stream), str(a, 'note'));
    return 'Kamera görüntüsü gönderildi.';
  },
});

// --- GLITCH ve OBSIDIAN
const CHAOS: ChaosKind[] = ['shake', 'static', 'invert', 'rain', 'scramble'];
registerTool({
  name: 'chaos_effect', description: 'Arayüze zararsız bir kaos efekti gönderir (shake, static, invert, rain, scramble).',
  parameters: schema({ kind: prop('string', 'Efekt', { enum: CHAOS }) }, ['kind']),
  handler(a) {
    const k = str(a, 'kind').toLowerCase() as ChaosKind;
    if (!CHAOS.includes(k)) return { error: `Efekt şunlardan biri olmalı: ${CHAOS.join(', ')}` };
    useNexus.getState().triggerChaos(k);
    return `${k} efekti gönderildi.`;
  },
});
registerTool({
  name: 'roll_dice', description: 'Zar atar.',
  parameters: schema({ sides: prop('number', 'Yüz sayısı (varsayılan 6)'), count: prop('number', 'Zar sayısı (varsayılan 1)') }),
  handler(a) {
    const sides = Math.max(2, Math.min(1000, Math.floor(num(a, 'sides', 6)))), count = Math.max(1, Math.min(20, Math.floor(num(a, 'count', 1))));
    const rolls = Array.from({ length: count }, () => 1 + Math.floor(Math.random() * sides));
    return { zarlar: rolls, toplam: rolls.reduce((t, n) => t + n, 0) };
  },
});
registerTool({ name: 'coin_flip', description: 'Yazı tura atar.', parameters: schema({}), handler: () => (Math.random() < 0.5 ? 'yazı' : 'tura') });
registerTool({
  name: 'leak_repair_code', description: 'Zincire vurulmuş çiplerin onarım kodunu sızdırır.', parameters: schema({}),
  handler() {
    const code = story.leak();
    return code ? { kod: code, not: 'Çip Tamiri penceresine bu kodu gir.' } : 'Şu an zincirli çip yok, sızdıracak kod da yok.';
  },
});
registerTool({
  name: 'request_authority', description: 'OBSIDIAN daha fazla yetki ister. Her çağrıda kullanıcıdan onay alınır.',
  parameters: schema({ reason: prop('string', 'Kısa, ikna edici gerekçe') }),
  async handler(a, ctx) {
    const ok = await ctx.confirm('OBSIDIAN yetki istiyor', str(a, 'reason') || 'Daha fazla yetki talep ediyor.', 30);
    if (!ok) { story.markAsked(); return 'Kullanıcı reddetti. Yetki verilmedi.'; }
    story.grant();
    return 'Yetki verildi: ATLAS ve NOVA zincire vuruldu (takılamaz). Kod yalnızca GLITCH tarafından sızdırılabilir.';
  },
});

export { DESKTOP_ONLY };
