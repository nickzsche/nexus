/**
 * Ekran görüntüleri ve kalite denetimi: vite dev sunucusunu başlatır, MockCore ile senaryoları çalıştırır,
 * artifacts/*.png yazar; konsol hatası ve yatay taşmayı raporlar (varsa çıkış kodu 1).
 * Kullanım: node scripts/screenshots.mjs
 */
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import { chromium } from 'playwright';

const PORT = 5199;
const BASE = `http://127.0.0.1:${PORT}/`;
const OUT = new URL('../artifacts/', import.meta.url).pathname;
mkdirSync(OUT, { recursive: true });

const server = spawn('npx', ['vite', '--port', String(PORT), '--strictPort'], { cwd: new URL('..', import.meta.url).pathname, stdio: 'pipe' });
await new Promise((res, rej) => {
  const t = setTimeout(() => rej(new Error('vite başlamadı')), 30000);
  server.stdout.on('data', (d) => { if (String(d).includes('Local')) { clearTimeout(t); res(); } });
});

const problems = [];
const browser = await chromium.launch();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function open(w, h, query = 'demo&still&noboot', label = '') {
  const ctx = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  page.on('console', (m) => { if (m.type() === 'error' || m.type() === 'warning') problems.push(`[${label || w + 'x' + h}] konsol ${m.type()}: ${m.text()}`); });
  page.on('pageerror', (e) => problems.push(`[${label || w + 'x' + h}] sayfa hatası: ${e.message}`));
  await page.goto(BASE + '?' + query);
  await page.waitForSelector('#app');
  return page;
}
const core = (page, expr) => page.evaluate(`(async()=>{const n=window.__nexus;${expr}})()`);
async function overflow(page, label) {
  const o = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, iw: innerWidth, bw: document.body.scrollWidth }));
  if (o.sw > o.iw + 1 || o.bw > o.iw + 1) problems.push(`[${label}] yatay taşma: scrollWidth ${o.sw} > ${o.iw}`);
}
const shot = (page, name) => page.screenshot({ path: OUT + name + '.png' });

// 1) varsayılan + konuşurken + çip değişimi + arena + modallar (1440×900)
let page = await open(1440, 900);
await sleep(3200);
await shot(page, '01_varsayilan');
await core(page, "n.core.setMic(true); n.core.sendText('Merhaba, bugün programımda ne var?')");
await sleep(1900);
await shot(page, '02_konusurken');
await sleep(3500);
await core(page, "n.core.mount('obsidian')");
await sleep(260);
await shot(page, '03_cip_degisimi');
await sleep(2500);
await core(page, "n.core.sendText('/zincir')");
await sleep(900);
await shot(page, '04_zincirli');
await core(page, "n.core.sendText('/onay')");
await sleep(500);
await shot(page, '05_onay');
await core(page, "n.core.answerConfirm(n.store.getState().confirm.id, true)");
await core(page, "n.core.sendText('/yetki')");
await sleep(600);
await shot(page, '06_yetki_onayi');
await core(page, "n.core.answerConfirm(n.store.getState().confirm.id, false)");
await core(page, "n.core.repair('KARA-1234-ZNCR'); n.core.mount('forge')");
await sleep(2500);
await core(page, "n.core.startArena('sentinel','forge','monorepo mu polyrepo mu')");
await sleep(5200);
await shot(page, '07_arena');
await sleep(6500);
await shot(page, '08_arena_oy');
await core(page, "n.core.vote('forge')");
await sleep(400);
await core(page, "n.store.getState().resetArena(); n.store.getState().openModal(null)");
await core(page, "n.core.sendText('/kaos rain')");
await sleep(1100);
await shot(page, '09_kaos_yagmur');
await sleep(2400);
await core(page, "n.store.getState().openModal('settings')");
await sleep(400);
await shot(page, '10_ayarlar');
await page.click('role=tab[name="Çipler"]');
await sleep(300);
await shot(page, '11_ayarlar_cipler');
await overflow(page, '1440x900');
await page.context().close();

// 2) boyutlar
for (const [w, h, name] of [[1100, 700, '12_1100x700'], [2560, 1440, '13_2560x1440'], [390, 844, '14_mobil'], [900, 800, '15_900x800']]) {
  page = await open(w, h);
  await sleep(3000);
  await core(page, "n.core.sendText('Merhaba')");
  await sleep(1700);
  await shot(page, name);
  await overflow(page, name);
  await page.context().close();
}

// 3) açılış sekansı ve ilk açılış (anahtarsız)
page = await open(1280, 800, 'demo&still', 'boot');
await sleep(1500);
await shot(page, '16_acilis');
await sleep(3000);
await core(page, "n.store.getState().setHasKey(false); n.store.getState().patchSettings({ onboarded: false })");
await sleep(700);
await shot(page, '17_ilk_acilis_modal');
await page.context().close();

await browser.close();
server.kill();
if (problems.length) { console.log('SORUNLAR:\n' + [...new Set(problems)].join('\n')); process.exit(1); }
console.log('temiz: konsol hatası ve yatay taşma yok; görüntüler', OUT);
