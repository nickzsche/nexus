/**
 * Paylaşılan güvenlik kuralları: saf, test edilebilir fonksiyonlar. Web araç katmanı çağrıdan ÖNCE uygular;
 * Electron ana süreci de aynı modülü kullanarak köprü isteklerini yeniden doğrular.
 */

const norm = (s: string): string => s.replace(/\s+/g, ' ').trim();

const DESTRUCTIVE: RegExp[] = [
  /\brm\s+(?:-\S+\s+)*-\S*[rR]\S*\s+(?:-\S+\s+)*(?:\/\*?|~\/?\*?|\*|\$HOME(?:\/\*?)?|\.{1,2}\/?\*?)(?:\s|$)/,   // rm -rf / /* ~ * . ..
  /\brm\s+(?:-\S+\s+)*--no-preserve-root\b/,
  /\bmkfs(?:\.\w+)?\b/,
  /\bdd\s+[^|;&]*\bof=\/dev\//,
  />\s*\/dev\/(?:sd|nvme|disk|hd)\w*/,
  /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/,                                         // fork bomb
  /\bformat\s+[a-z]:/i,
  /\bdel\s+[^|;&]*\/[sq]\b/i,
  /\b(?:rd|rmdir)\s+[^|;&]*\/s\b/i,
  /\bshutdown\b/i,
  /\b(?:reboot|halt|poweroff)\b/i,
  /\bchmod\s+-R\s+0?777\s+\//,
  /\bchown\s+-R\s+\S+\s+\//,
  /\b(?:curl|wget)\b[^|;&]*\|\s*(?:sudo\s+)?(?:ba|z|da)?sh\b/i,                       // indir-ve-çalıştır
  /\bRemove-Item\b[^|;&]*-Recurse\b[^|;&]*(?:[A-Za-z]:\\\s*$|\\\*|\s\/\s*$)/i,
  /\bdiskpart\b/i,
  /\bbcdedit\b/i,
  /\breg\s+delete\b/i,
];

/** Yıkıcı komut kalıpları: onay verilse bile HER koşulda reddedilir. */
export function isDestructive(cmd: string): boolean {
  const c = norm(cmd);
  return DESTRUCTIVE.some((re) => re.test(c));
}

const ALLOWED_BIN = new Set([
  'git', 'python', 'python3', 'pytest', 'npm', 'npx', 'node', 'pnpm', 'yarn', 'tsc', 'ls', 'dir', 'cat', 'type',
  'echo', 'pwd', 'whoami', 'which', 'where', 'head', 'tail', 'wc', 'grep', 'rg', 'cargo', 'go',
]);
const SHELL_META = /[;&|<>`$(){}\n\r]/;

/** Kabuk üst-karakteri içermeyen ve bilinen güvenli bir programla başlayan komutlar. */
export function isAllowlisted(cmd: string): boolean {
  const c = norm(cmd);
  if (!c || SHELL_META.test(c)) return false;
  const [bin, ...rest] = c.split(' ');
  if (!ALLOWED_BIN.has(bin.toLowerCase())) return false;
  if (bin === 'git' && /^(?:push|reset\s+--hard|clean|rm|checkout\s+--|branch\s+-D)\b/.test(rest.join(' '))) return false;
  if (bin === 'npm' && /^(?:publish|unpublish|login|adduser)\b/.test(rest.join(' '))) return false;
  return true;
}

function ipv4(host: string): number[] | null {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (!m) return null;
  const p = m.slice(1).map(Number);
  return p.every((n) => n >= 0 && n <= 255) ? p : null;
}

/** Yerel/özel adres mi: loopback, RFC1918, link-local, .local/.internal/.lan ve IPv6 yerelleri. */
export function isPrivateHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!h) return false;
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || h.endsWith('.lan')) return true;
  const v4 = ipv4(h);
  if (v4) {
    const [a, b] = v4;
    return a === 127 || a === 10 || a === 0 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (h === '::1' || h === '::') return true;
  if (/^f[cd][0-9a-f]{2}:/.test(h) || /^fe[89ab][0-9a-f]:/.test(h)) return true;      // ULA, link-local
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(h);
  return mapped ? isPrivateHost(mapped[1]) : false;
}

/** Port listesini doğrular: en çok 1024 port, hepsi 1–65535. Aralık "20-80" ya da dizi olabilir. */
export function parsePorts(input: unknown): number[] | { error: string } {
  const out: number[] = [];
  const parts = Array.isArray(input) ? input.map(String) : String(input ?? '').split(/[,\s]+/).filter(Boolean);
  for (const p of parts) {
    const r = /^(\d+)-(\d+)$/.exec(p);
    if (r) {
      const [lo, hi] = [Number(r[1]), Number(r[2])];
      if (hi < lo || hi - lo + 1 > 1024) return { error: 'En fazla 1024 port taranabilir.' };
      for (let i = lo; i <= hi; i++) out.push(i);
    } else if (/^\d+$/.test(p)) out.push(Number(p));
    else return { error: `Geçersiz port: ${p}` };
    if (out.length > 1024) return { error: 'En fazla 1024 port taranabilir.' };
  }
  if (!out.length) return { error: 'Taranacak port yok.' };
  if (out.some((n) => n < 1 || n > 65535)) return { error: 'Portlar 1-65535 arasında olmalı.' };
  return out;
}

function segments(p: string): string[] {
  return p.replace(/\\/g, '/').split('/').filter((s) => s !== '' && s !== '.');
}

/** Yolu çalışma klasörüne göre çözer; klasörün DIŞINA çıkıyorsa (.., mutlak yol, boş kök) false döner. */
export function insideWorkspace(root: string, path: string): boolean {
  if (!root || !root.trim() || !path || path.includes('\0')) return false;
  const r = root.replace(/\\/g, '/');
  const rootDrive = /^[a-zA-Z]:/.exec(r)?.[0].toLowerCase() ?? '';
  const rootSegs = segments(r.replace(/^[a-zA-Z]:/, ''));
  if (rootSegs.length === 0 && !rootDrive) return false;                               // kök dizin çalışma klasörü olamaz
  const p = path.replace(/\\/g, '/');
  const pDrive = /^[a-zA-Z]:/.exec(p)?.[0].toLowerCase() ?? '';
  const absolute = p.startsWith('/') || !!pDrive;
  if (absolute && pDrive !== rootDrive) return false;
  const stack: string[] = absolute ? [] : [...rootSegs];
  for (const s of segments(p.replace(/^[a-zA-Z]:/, ''))) {
    if (s === '..') { if (!stack.length) return false; stack.pop(); } else stack.push(s);
  }
  const cs = (s: string, i: number) => s.toLowerCase() === (rootSegs[i] ?? '').toLowerCase();
  return stack.length >= rootSegs.length && rootSegs.every((_, i) => (rootDrive ? cs(stack[i], i) : stack[i] === rootSegs[i]));
}
