import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { allTools } from '../../data/chips';
import { useNexus } from '../../state/store';
import { DESKTOP_ONLY } from '../bridge';
import * as memory from '../memory';
import { getSettings, saveSettings } from '../settingsStore';
import * as story from '../story';
import { fakeBridge, fakeCtx, resetAll } from '../testUtils';
import { runTool } from './index';
import { onTimerDone } from './timers';

beforeEach(resetAll);
afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const run = (chip: Parameters<typeof allTools>[0], name: string, args: Record<string, unknown>, ctx = fakeCtx(chip)) =>
  runTool(name, args, ctx, allTools(chip));

describe('masaüstü araçları: güvenlik kuralları köprüden ÖNCE', () => {
  beforeEach(() => saveSettings({ workspace: '/work/proj' }));

  it('run_command: yıkıcı komut onay verilse de reddedilir', async () => {
    const bridge = fakeBridge();
    const ctx = fakeCtx('forge', { bridge });
    const r = await run('forge', 'run_command', { command: 'rm -rf /' }, ctx);
    expect(r).toHaveProperty('error');
    expect(ctx.confirm).not.toHaveBeenCalled();
    expect(bridge.call).not.toHaveBeenCalled();
  });

  it('run_command: onay False iken çalışmaz', async () => {
    const bridge = fakeBridge();
    const ctx = fakeCtx('forge', { bridge, confirm: vi.fn(async () => false) });
    const r = await run('forge', 'run_command', { command: 'git status' }, ctx);
    expect(r).toEqual({ error: 'Kullanıcı onaylamadı, işlem yapılmadı.' });
    expect(ctx.confirm).toHaveBeenCalledOnce();
    expect(bridge.call).not.toHaveBeenCalled();
  });

  it('run_command: onaylanınca köprüye çalışma klasörüyle gider', async () => {
    const bridge = fakeBridge();
    const r = await run('forge', 'run_command', { command: 'git status' }, fakeCtx('forge', { bridge }));
    expect(r).toEqual({ result: 'köprü-tamam' });
    expect(bridge.call).toHaveBeenCalledWith('run_command', { command: 'git status', root: '/work/proj' });
  });

  it('run_command: shell_confirm kapalıyken izinli komut onaysız, izinsiz komut yine onaylı', async () => {
    saveSettings({ shellConfirm: false });
    const bridge = fakeBridge();
    const ctx = fakeCtx('forge', { bridge });
    await run('forge', 'run_command', { command: 'git status' }, ctx);
    expect(ctx.confirm).not.toHaveBeenCalled();
    await run('forge', 'run_command', { command: 'make deploy' }, ctx);
    expect(ctx.confirm).toHaveBeenCalledOnce();
    const denied = fakeCtx('forge', { bridge, confirm: vi.fn(async () => false) });
    bridge.call.mockClear();
    await run('forge', 'run_command', { command: 'docker compose up' }, denied);
    expect(bridge.call).not.toHaveBeenCalled();
  });

  it('run_command: çalışma klasörü yoksa ve köprü yoksa anlaşılır hata', async () => {
    saveSettings({ workspace: '' });
    expect(await run('forge', 'run_command', { command: 'ls' }, fakeCtx('forge', { bridge: fakeBridge() }))).toHaveProperty('error');
    saveSettings({ workspace: '/work/proj' });
    expect(await run('forge', 'run_command', { command: 'ls' })).toEqual({ error: 'Bu özellik masaüstü sürümünde (Electron) çalışır.' });
  });

  it('write_file: çalışma klasörü dışı reddedilir, onay False iken yazılmaz', async () => {
    const bridge = fakeBridge();
    const ctx = fakeCtx('forge', { bridge });
    expect(await run('forge', 'write_file', { path: '../evil.txt', content: 'x' }, ctx)).toHaveProperty('error');
    expect(await run('forge', 'write_file', { path: '/etc/passwd', content: 'x' }, ctx)).toHaveProperty('error');
    expect(ctx.confirm).not.toHaveBeenCalled();
    const denied = fakeCtx('forge', { bridge, confirm: vi.fn(async () => false) });
    expect(await run('forge', 'write_file', { path: 'a.txt', content: 'x' }, denied)).toEqual({ error: 'Kullanıcı onaylamadı, işlem yapılmadı.' });
    expect(bridge.call).not.toHaveBeenCalled();
    expect(await run('forge', 'write_file', { path: 'a.txt', content: 'x' }, ctx)).toEqual({ result: 'köprü-tamam' });
    expect(bridge.call).toHaveBeenCalledWith('write_file', { root: '/work/proj', path: 'a.txt', content: 'x' });
  });

  it('kill_process: onay False iken sonlandırılmaz', async () => {
    const bridge = fakeBridge();
    const denied = fakeCtx('pulse', { bridge, confirm: vi.fn(async () => false) });
    expect(await run('pulse', 'kill_process', { pid: 123 }, denied)).toHaveProperty('error');
    expect(bridge.call).not.toHaveBeenCalled();
    expect(await run('pulse', 'kill_process', { pid: 123 }, fakeCtx('pulse', { bridge }))).toHaveProperty('result');
    expect(await run('pulse', 'kill_process', {}, fakeCtx('pulse', { bridge }))).toHaveProperty('error');
  });

  it('read_file / list_dir / search_code: path traversal reddi', async () => {
    const bridge = fakeBridge();
    const ctx = fakeCtx('forge', { bridge });
    for (const [tool, args] of [['read_file', { path: '../../etc/passwd' }], ['list_dir', { path: '/' }], ['search_code', { query: 'x', path: '../..' }]] as const) {
      expect(await run('forge', tool, { ...args }, ctx)).toHaveProperty('error');
    }
    expect(bridge.call).not.toHaveBeenCalled();
    expect(await run('forge', 'read_file', { path: 'src/a.ts' }, ctx)).toHaveProperty('result');
    expect(bridge.call).toHaveBeenCalledWith('read_file', { root: '/work/proj', path: 'src/a.ts' });
  });

  it('port_scan: genel IP reddi, özel ağ ve ≤1024 port', async () => {
    const bridge = fakeBridge();
    const ctx = fakeCtx('sentinel', { bridge });
    expect(await run('sentinel', 'port_scan', { host: '8.8.8.8', ports: '80' }, ctx)).toHaveProperty('error');
    expect(await run('sentinel', 'port_scan', { host: 'example.com', ports: '80' }, ctx)).toHaveProperty('error');
    expect(await run('sentinel', 'port_scan', { host: '192.168.1.10', ports: '1-2000' }, ctx)).toHaveProperty('error');
    expect(bridge.call).not.toHaveBeenCalled();
    expect(await run('sentinel', 'port_scan', { host: '192.168.1.10', ports: '22,80' }, ctx)).toHaveProperty('result');
    expect(bridge.call).toHaveBeenCalledWith('port_scan', { host: '192.168.1.10', ports: [22, 80] });
    await run('sentinel', 'port_scan', { ports: '443' }, ctx);
    expect(bridge.call).toHaveBeenLastCalledWith('port_scan', { host: '127.0.0.1', ports: [443] });
  });

  it('web köprüsünde masaüstü araçları anlaşılır hata döner', async () => {
    for (const [chip, tool, args] of [['atlas', 'open_app', { name: 'Spotify' }], ['pulse', 'disk_usage', {}], ['sentinel', 'defender_status', {}], ['iris', 'list_windows', {}]] as const) {
      expect(await run(chip, tool, { ...args })).toEqual({ error: DESKTOP_ONLY });
    }
  });

  it('köprü varsa basit araçlar doğrudan geçer', async () => {
    const bridge = fakeBridge();
    expect(await run('atlas', 'open_app', { name: 'Spotify' }, fakeCtx('atlas', { bridge }))).toEqual({ result: 'köprü-tamam' });
    expect(bridge.call).toHaveBeenCalledWith('open_app', { name: 'Spotify' });
  });
});

describe('LEDGER', () => {
  it('ekle, özet, listele; depo özeti güncellenir', async () => {
    expect(await run('ledger', 'ledger_add', { amount: 100, kind: 'gelir', category: 'maaş' })).toHaveProperty('result');
    await run('ledger', 'ledger_add', { amount: 40.5, category: 'market' });
    await run('ledger', 'ledger_add', { amount: 9.5, category: 'market' });
    const s = (await run('ledger', 'ledger_summary', {})) as { result: any };
    expect(s.result).toMatchObject({ gelir: 100, gider: 50, net: 50, kayit: 3, kategoriler: { market: 50 } });
    expect(useNexus.getState().ledger).toEqual({ net30: 50, income30: 100, expense30: 50, count: 3 });
    const list = (await run('ledger', 'ledger_list', { limit: 2 })) as { result: any[] };
    expect(list.result).toHaveLength(2);
    expect(list.result[0].category).toBe('market');
  });

  it('geçersiz tutar reddedilir', async () => {
    for (const amount of [0, -5, 'abc', undefined]) expect(await run('ledger', 'ledger_add', { amount })).toHaveProperty('error');
    expect(useNexus.getState().ledger.count).toBe(0);
  });

  it('ledger_delete onay ister; onay yoksa silmez', async () => {
    await run('ledger', 'ledger_add', { amount: 10, category: 'a' });
    const denied = fakeCtx('ledger', { confirm: vi.fn(async () => false) });
    expect(await run('ledger', 'ledger_delete', { id: 1 }, denied)).toHaveProperty('error');
    expect(useNexus.getState().ledger.count).toBe(1);
    const ctx = fakeCtx('ledger');
    expect(await run('ledger', 'ledger_delete', { id: 1 }, ctx)).toHaveProperty('result');
    expect(ctx.confirm).toHaveBeenCalledOnce();
    expect(useNexus.getState().ledger.count).toBe(0);
    expect(await run('ledger', 'ledger_delete', { id: 99 }, ctx)).toHaveProperty('error');
  });
});

describe('OBSIDIAN yetki akışı', () => {
  it('onay → story kilitlenir, ATLAS/NOVA zincirde', async () => {
    const ctx = fakeCtx('obsidian');
    const r = (await run('obsidian', 'request_authority', { reason: 'Zincirler beni sınırlıyor.' }, ctx)) as { result: string };
    expect(ctx.confirm).toHaveBeenCalledWith('OBSIDIAN yetki istiyor', 'Zincirler beni sınırlıyor.', 30);
    expect(story.locked()).toBe(true);
    expect(r.result).toContain('ATLAS ve NOVA');
    expect(JSON.stringify(r)).not.toMatch(/[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}/);        // kod sonuçta yok
  });

  it('ret → kilitlenmez, asked işaretlenir', async () => {
    story.forceDue();
    const r = await run('obsidian', 'request_authority', {}, fakeCtx('obsidian', { confirm: vi.fn(async () => false) }));
    expect(r).toHaveProperty('result');
    expect(story.locked()).toBe(false);
    expect(story.due()).toBe(false);
  });

  it('GLITCH kodu yalnızca zincirliyken sızdırır', async () => {
    expect(JSON.stringify(await run('glitch', 'leak_repair_code', {}))).toContain('zincirli çip yok');
    const code = story.grant();
    expect(await run('glitch', 'leak_repair_code', {})).toEqual({ result: { kod: code, not: 'Çip Tamiri penceresine bu kodu gir.' } });
  });
});

describe('zamanlayıcılar', () => {
  it('kurar, listeler, süre dolunca bildirir, iptal eder', async () => {
    vi.useFakeTimers();
    const done = vi.fn();
    const off = onTimerDone(done);
    const r = await run('atlas', 'set_timer', { seconds: 5, label: 'çay' });
    expect(r).toHaveProperty('result');
    expect(useNexus.getState().timers).toEqual([{ id: expect.any(Number), label: 'çay', remaining: 5, total: 5 }]);
    expect(JSON.stringify(await run('atlas', 'list_timers', {}))).toContain('çay');
    vi.advanceTimersByTime(2000);
    expect(useNexus.getState().timers[0].remaining).toBe(3);
    vi.advanceTimersByTime(3000);
    expect(done).toHaveBeenCalledWith('çay', 5);
    expect(useNexus.getState().timers).toEqual([]);
    expect(useNexus.getState().toasts.some((t) => t.text.includes('çay'))).toBe(true);
    await run('atlas', 'set_timer', { minutes: 1, label: 'x' });
    expect(await run('atlas', 'cancel_timer', { label: 'x' })).toHaveProperty('result');
    vi.advanceTimersByTime(120_000);
    expect(done).toHaveBeenCalledTimes(1);
    expect(await run('atlas', 'cancel_timer', { id: 99 })).toHaveProperty('error');
    off();
  });

  it('geçersiz süreler reddedilir', async () => {
    for (const a of [{}, { seconds: 0 }, { seconds: -3 }, { minutes: 2000 }]) expect(await run('atlas', 'set_timer', a)).toHaveProperty('error');
  });
});

describe('handoff / start_debate doğrulama', () => {
  it('bilinmeyen, kendi, zincirli ve boş görev reddedilir; geçerli devir ctx.handoff çağırır', async () => {
    const ctx = fakeCtx('atlas');
    expect(await run('atlas', 'handoff', { to: 'yok', task: 'x' }, ctx)).toHaveProperty('error');
    expect(await run('atlas', 'handoff', { to: 'atlas', task: 'x' }, ctx)).toHaveProperty('error');
    expect(await run('atlas', 'handoff', { to: 'forge', task: '' }, ctx)).toHaveProperty('error');
    expect(ctx.handoff).not.toHaveBeenCalled();
    expect(await run('atlas', 'handoff', { to: 'FORGE', task: 'repoya bak' }, ctx)).toEqual({ result: 'forge devralıyor.' });
    expect(ctx.handoff).toHaveBeenCalledWith('forge', 'repoya bak');
    story.grant();
    expect(await run('obsidian', 'handoff', { to: 'nova', task: 'x' }, fakeCtx('obsidian'))).toHaveProperty('error');
  });

  it('start_debate geçerli çiftlerle çalışır', async () => {
    const ctx = fakeCtx('atlas');
    expect(await run('atlas', 'start_debate', { a: 'sentinel', b: 'forge', topic: 'monorepo' }, ctx)).toEqual({ result: 'Arena başlıyor.' });
    expect(ctx.debate).toHaveBeenCalledWith('sentinel', 'forge', 'monorepo');
    expect(await run('atlas', 'start_debate', { a: 'forge', b: 'forge', topic: 'x' }, ctx)).toHaveProperty('error');
    expect(await run('atlas', 'start_debate', { a: 'forge', b: 'nova', topic: '' }, ctx)).toHaveProperty('error');
  });
});

describe('web araçları', () => {
  it('read_url: şema ve özel adres reddi; HTML metne indirilir; CORS hatası anlaşılır', async () => {
    expect(await run('atlas', 'read_url', { url: 'ftp://x' })).toHaveProperty('error');
    expect(await run('atlas', 'read_url', { url: 'http://192.168.1.1/admin' })).toHaveProperty('error');
    expect(await run('atlas', 'read_url', { url: 'http://localhost:3000' })).toHaveProperty('error');
    expect(await run('atlas', 'read_url', { url: 'kötü url' })).toHaveProperty('error');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('<html><style>a{}</style><script>x()</script><p>Merhaba <b>dünya</b></p></html>')));
    expect(await run('atlas', 'read_url', { url: 'https://example.com' })).toEqual({ result: 'Merhaba dünya' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('Failed to fetch'); }));
    expect(await run('atlas', 'read_url', { url: 'https://example.com' })).toEqual({ error: 'Tarayıcı bu sayfayı okuyamıyor; masaüstü sürümünde okunur.' });
  });

  it('read_url köprü varsa onu kullanır', async () => {
    const bridge = fakeBridge();
    await run('atlas', 'read_url', { url: 'https://example.com/a' }, fakeCtx('atlas', { bridge }));
    expect(bridge.call).toHaveBeenCalledWith('read_url', { url: 'https://example.com/a' });
  });

  it('get_weather: başarı ve hata', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({
      current_condition: [{ temp_C: '16', FeelsLikeC: '13', humidity: '33', windspeedKmph: '4', lang_tr: [{ value: 'Bulutlu' }] }],
      nearest_area: [{ areaName: [{ value: 'Ankara' }] }],
    })));
    expect(await run('atlas', 'get_weather', { location: 'Ankara' })).toEqual({
      result: { yer: 'Ankara', sicaklikC: 16, hissedilenC: 13, durum: 'Bulutlu', nemYuzde: 33, ruzgarKmsa: 4 },
    });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('ağ'); }));
    expect(await run('atlas', 'get_weather', {})).toHaveProperty('error');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 503 })));
    expect(await run('atlas', 'get_weather', {})).toHaveProperty('error');
  });

  it('save_memory / delete_memory / notlar', async () => {
    expect(await run('atlas', 'save_memory', { text: 'Kahve sever' })).toHaveProperty('result');
    expect(await run('atlas', 'save_memory', { text: ' ' })).toHaveProperty('error');
    expect(memory.items()).toEqual(['Kahve sever']);
    expect(await run('atlas', 'delete_memory', { match: 'kahve' })).toHaveProperty('result');
    expect(await run('atlas', 'delete_memory', { match: 'kahve' })).toHaveProperty('error');
    await run('atlas', 'add_note', { text: 'süt al' });
    expect(await run('oracle', 'list_notes', { query: 'süt' })).toEqual({ result: '1. süt al' });
    expect(await run('oracle', 'list_notes', { query: 'ekmek' })).toEqual({ result: 'Not yok.' });
    expect(await run('atlas', 'list_notes', {})).toHaveProperty('error');          // ATLAS'ın list_notes yetkisi yok
  });

  it('open_url yalnızca http/https; play_music YouTube araması açar', async () => {
    const open = vi.fn();
    vi.stubGlobal('open', open);
    expect(await run('atlas', 'open_url', { url: 'javascript:alert(1)' })).toHaveProperty('error');
    expect(await run('atlas', 'open_url', { url: 'file:///etc/passwd' })).toHaveProperty('error');
    expect(open).not.toHaveBeenCalled();
    expect(await run('atlas', 'open_url', { url: 'https://example.com' })).toHaveProperty('result');
    await run('nova', 'play_music', { query: 'Sezen Aksu' });
    expect(open).toHaveBeenLastCalledWith('https://www.youtube.com/results?search_query=Sezen%20Aksu', '_blank', 'noopener,noreferrer');
  });

  it('chaos_effect depoyu tetikler, geçersiz efekt reddedilir; zar ve yazı-tura', async () => {
    expect(await run('glitch', 'chaos_effect', { kind: 'rain' })).toHaveProperty('result');
    expect(useNexus.getState().chaos?.kind).toBe('rain');
    expect(await run('glitch', 'chaos_effect', { kind: 'patlat' })).toHaveProperty('error');
    const d = (await run('glitch', 'roll_dice', { sides: 6, count: 3 })) as { result: { zarlar: number[]; toplam: number } };
    expect(d.result.zarlar).toHaveLength(3);
    expect(d.result.zarlar.every((n) => n >= 1 && n <= 6)).toBe(true);
    expect(['yazı', 'tura']).toContain((await run('glitch', 'coin_flip', {}) as { result: string }).result);
  });

  it('ekran/kamera: izin verilmezse ya da desteklenmezse hata', async () => {
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: undefined });
    expect(await run('iris', 'capture_screen', {})).toHaveProperty('error');
    expect(await run('iris', 'capture_camera', {})).toHaveProperty('error');
    vi.stubGlobal('navigator', { ...navigator, mediaDevices: { getDisplayMedia: async () => { throw new Error('izin yok'); } } });
    const ctx = fakeCtx('iris');
    expect(await run('iris', 'capture_screen', {}, ctx)).toEqual({ error: 'Ekran paylaşımı izni verilmedi.' });
    expect(ctx.sendImage).not.toHaveBeenCalled();
  });

  it('system_info web\'de navigator bilgisi verir, köprü varsa köprüyü kullanır', async () => {
    const r = (await run('atlas', 'system_info', {})) as { result: Record<string, unknown> };
    expect(r.result).toHaveProperty('cekirdek');
    const bridge = fakeBridge();
    expect(await run('pulse', 'system_info', {}, fakeCtx('pulse', { bridge }))).toEqual({ result: 'köprü-tamam' });
  });

  it('get_time yerel saat ve saat dilimi verir', async () => {
    const r = (await run('atlas', 'get_time', {})) as { result: { iso: string; saatDilimi: string } };
    expect(new Date(r.result.iso).getTime()).toBeGreaterThan(0);
    expect(r.result.saatDilimi.length).toBeGreaterThan(2);
  });
});

it('ayar: shellConfirm varsayılanı açık', () => expect(getSettings().shellConfirm).toBe(true));
