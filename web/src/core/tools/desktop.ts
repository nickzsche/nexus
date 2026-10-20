/**
 * Masaüstü köprüsü gerektiren araçlar. GÜVENLİK KURALLARI köprü çağrısından ÖNCE burada uygulanır (Electron
 * ana süreci aynı safety.ts ile yeniden doğrular). Köprü yoksa anlaşılır bir "masaüstü sürümü" hatası döner.
 */
import { DESKTOP_ONLY } from '../bridge';
import { getSettings } from '../settingsStore';
import { isAllowlisted, isDestructive, insideWorkspace, isPrivateHost, parsePorts } from './safety';
import { num, prop, registerTool, schema, str, type ToolContext } from './registry';

const NO_CONFIRM = 'Kullanıcı onaylamadı, işlem yapılmadı.';

function workspace(): string | { error: string } {
  const w = getSettings().workspace.trim();
  return w || { error: 'Çalışma klasörü ayarlanmamış (Ayarlar › Gelişmiş).' };
}

/** Çalışma klasörü içinde kalan yol; değilse hata. */
function safePath(args: Record<string, unknown>, key = 'path'): { root: string; path: string } | { error: string } {
  const root = workspace();
  if (typeof root !== 'string') return root;
  const path = str(args, key) || '.';
  if (!insideWorkspace(root, path)) return { error: 'Yol çalışma klasörünün dışında; erişim reddedildi.' };
  return { root, path };
}

const pass = (name: string, args: Record<string, unknown>, ctx: ToolContext): Promise<unknown> | { error: string } =>
  ctx.bridge.has(name) ? ctx.bridge.call(name, args) : { error: DESKTOP_ONLY };

function simple(name: string, description: string, params: Record<string, unknown> = schema({})): void {
  registerTool({ name, description, parameters: params, handler: (a, ctx) => pass(name, a, ctx) });
}

simple('open_app', 'Bilgisayarda bir uygulamayı adıyla açar.', schema({ name: prop('string', 'Uygulama adı') }, ['name']));
simple('close_app', 'Bir uygulamayı adıyla kapatır.', schema({ name: prop('string', 'Uygulama adı') }, ['name']));
simple('list_apps', 'Kurulu ya da çalışan uygulamaları listeler.');
simple('media_control', 'Müzik/video oynatmayı denetler (oynat-duraklat, sonraki, önceki, ses).',
  schema({ action: prop('string', 'play_pause, next, previous, volume_up, volume_down, mute') }, ['action']));
simple('list_processes', 'Çalışan süreçleri CPU/bellek kullanımıyla listeler.', schema({ limit: prop('number', 'En fazla kaç süreç') }));
simple('disk_usage', 'Disk doluluk bilgisi.');
simple('network_stats', 'Ağ hızı ve trafik istatistikleri.');
simple('defender_status', 'Windows Defender durumu.');
simple('firewall_status', 'Güvenlik duvarı durumu.');
simple('network_connections', 'Açık ağ bağlantıları ve dinleyen portlar.');
simple('list_windows', 'Açık pencereleri listeler.');

registerTool({
  name: 'kill_process', description: 'Bir süreci sonlandırır. Her çağrıda onay gerektirir.',
  parameters: schema({ pid: prop('number', 'Süreç numarası'), name: prop('string', 'Süreç adı') }),
  async handler(a, ctx) {
    if (!num(a, 'pid') && !str(a, 'name')) return { error: 'pid ya da süreç adı ver.' };
    if (!ctx.bridge.has('kill_process')) return { error: DESKTOP_ONLY };
    if (!(await ctx.confirm('Süreci sonlandır', `${str(a, 'name') || 'pid ' + num(a, 'pid')}`))) return { error: NO_CONFIRM };
    return ctx.bridge.call('kill_process', a);
  },
});

registerTool({
  name: 'port_scan', description: 'Yerel ya da özel ağdaki bir makinenin açık portlarını tarar (genel IP yasak).',
  parameters: schema({ host: prop('string', 'Adres (varsayılan 127.0.0.1)'), ports: prop('string', 'Örn. "22,80,443" ya da "1-1024"') }, ['ports']),
  handler(a, ctx) {
    const host = str(a, 'host') || '127.0.0.1';
    if (!isPrivateHost(host)) return { error: 'Yalnızca yerel ve özel ağ adresleri taranabilir; genel IP reddedildi.' };
    const ports = parsePorts(a.ports);
    if ('error' in ports) return ports;
    return pass('port_scan', { host, ports }, ctx);
  },
});

registerTool({
  name: 'file_hash', description: 'Çalışma klasöründeki bir dosyanın SHA-256 özetini verir.',
  parameters: schema({ path: prop('string', 'Dosya yolu') }, ['path']),
  handler(a, ctx) { const p = safePath(a); return 'error' in p ? p : pass('file_hash', p, ctx); },
});
registerTool({
  name: 'read_file', description: 'Çalışma klasöründeki bir dosyanın metnini okur.',
  parameters: schema({ path: prop('string', 'Dosya yolu') }, ['path']),
  handler(a, ctx) { const p = safePath(a); return 'error' in p ? p : pass('read_file', p, ctx); },
});
registerTool({
  name: 'list_dir', description: 'Çalışma klasöründeki bir dizinin içeriğini listeler.',
  parameters: schema({ path: prop('string', 'Dizin yolu (varsayılan çalışma klasörü)') }),
  handler(a, ctx) { const p = safePath(a); return 'error' in p ? p : pass('list_dir', p, ctx); },
});
registerTool({
  name: 'search_code', description: 'Çalışma klasöründe metin arar.',
  parameters: schema({ query: prop('string', 'Aranacak metin'), path: prop('string', 'Alt dizin') }, ['query']),
  handler(a, ctx) {
    if (!str(a, 'query')) return { error: 'Aranacak metin boş.' };
    const p = safePath(a);
    return 'error' in p ? p : pass('search_code', { ...p, query: str(a, 'query') }, ctx);
  },
});

for (const name of ['git_status', 'git_diff', 'git_log'] as const) {
  registerTool({
    name, description: { git_status: 'Çalışma klasöründeki deponun git durumu.', git_diff: 'Deponun değişiklik farkı.', git_log: 'Deponun son commit geçmişi.' }[name],
    parameters: schema({ path: prop('string', 'Depo dizini (varsayılan çalışma klasörü)'), limit: prop('number', 'git_log için commit sayısı') }),
    handler(a, ctx) { const p = safePath(a); return 'error' in p ? p : pass(name, { ...p, limit: num(a, 'limit', 10) }, ctx); },
  });
}

registerTool({
  name: 'write_file', description: 'Çalışma klasörüne dosya yazar. Her çağrıda onay gerektirir.',
  parameters: schema({ path: prop('string', 'Dosya yolu'), content: prop('string', 'Dosya içeriği') }, ['path', 'content']),
  async handler(a, ctx) {
    const p = safePath(a);
    if ('error' in p) return p;
    if (typeof a.content !== 'string') return { error: 'İçerik metin olmalı.' };
    if (!ctx.bridge.has('write_file')) return { error: DESKTOP_ONLY };
    if (!(await ctx.confirm('Dosya yaz', `${p.path} (${a.content.length} karakter)`))) return { error: NO_CONFIRM };
    return ctx.bridge.call('write_file', { ...p, content: a.content });
  },
});

registerTool({
  name: 'run_command', description: 'Çalışma klasöründe bir kabuk komutu çalıştırır. Onay gerektirir; yıkıcı komutlar reddedilir.',
  parameters: schema({ command: prop('string', 'Komut') }, ['command']),
  async handler(a, ctx) {
    const cmd = str(a, 'command');
    if (!cmd) return { error: 'Komut boş.' };
    if (isDestructive(cmd)) return { error: 'Bu komut yıkıcı olduğu için reddedildi (onay verilse de çalışmaz).' };
    const root = workspace();
    if (typeof root !== 'string') return root;
    if (!ctx.bridge.has('run_command')) return { error: DESKTOP_ONLY };
    // Onay: ayar açıkken her komutta; kapalıyken yalnızca izinli listede olmayan komutlarda.
    if ((getSettings().shellConfirm || !isAllowlisted(cmd)) && !(await ctx.confirm('Komut çalıştır', cmd))) return { error: NO_CONFIRM };
    return ctx.bridge.call('run_command', { command: cmd, root });
  },
});
