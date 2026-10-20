import '../test/stubs';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import App from '../App';
import { setCore } from '../core/api';
import { MockCore } from '../core/mock';
import { useNexus } from '../state/store';

const S = () => useNexus.getState();
let mock: MockCore;

beforeEach(async () => {
  localStorage.clear();
  history.replaceState(null, '', '/?ready&noboot');
  S().clearLines();
  S().resetArena();
  S().setConfirm(null);
  S().openModal(null);
  S().setStory({ enabled: true, locked: false, chained: [], progress: 0, leaked: false });
  S().patchSettings({ activeChip: 'atlas', drama: 'normal', onboarded: true });
  S().setActive('atlas');
  S().setMicOn(false);
  S().setHasKey(true);
  mock = new MockCore();
  mock.speed = 0;
  setCore(mock);
  render(<App />);
  await act(async () => { await mock.start(); });
});
afterEach(() => { mock.shutdown(); cleanup(); });

describe('arayüz', () => {
  it('10 çip düğmesi erişilebilir adlarla gelir ve tıklayınca çip takılır', async () => {
    const group = screen.getByRole('group', { name: 'Çipler' });
    const btns = group.querySelectorAll('button.node-btn');
    expect(btns).toHaveLength(10);
    expect(btns[0].getAttribute('aria-label')).toContain('ATLAS');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /^FORGE, Kod ustası/ })); });
    await waitFor(() => expect(S().active).toBe('forge'));
  });

  it('tema renkleri aktif çipe göre kök CSS değişkenlerine yazılır', async () => {
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--main')).toBe('#5ED8FF'));
    await act(async () => { await mock.mount('obsidian'); });
    await waitFor(() => expect(document.documentElement.style.getPropertyValue('--main')).toBe('#FF3B3B'));
  });

  it('drama seçici ayarı değiştirir', async () => {
    await act(async () => { fireEvent.click(screen.getByRole('radio', { name: 'KAOS' })); });
    expect(S().settings.drama).toBe('kaos');
    expect(screen.getByRole('radio', { name: 'KAOS' }).getAttribute('aria-checked')).toBe('true');
  });

  it('Ctrl+3 OBSIDIAN\'ı takar; Ctrl+Boşluk mikrofonu açar', async () => {
    await act(async () => { fireEvent.keyDown(window, { key: '3', code: 'Digit3', ctrlKey: true }); });
    await waitFor(() => expect(S().active).toBe('obsidian'));
    await act(async () => { fireEvent.keyDown(window, { key: ' ', code: 'Space', ctrlKey: true }); });
    await waitFor(() => expect(S().micOn).toBe(true));
  });

  it('yazı kutusu mesajı gönderir ve kutuyu temizler', async () => {
    const input = screen.getByLabelText('Mesaj') as HTMLInputElement;
    await act(async () => { fireEvent.change(input, { target: { value: 'Merhaba nexus' } }); });
    await act(async () => { fireEvent.submit(input.closest('form')!); });
    expect(input.value).toBe('');
    await waitFor(() => expect(screen.getByText('Merhaba nexus')).toBeTruthy());
  });

  it('ayarlar modalı açılır, sekmeleri vardır, Esc ile kapanır ve odak geri döner', async () => {
    const gear = screen.getByRole('button', { name: 'Ayarlar' });
    await act(async () => { fireEvent.click(gear); });
    const dlg = await screen.findByRole('dialog', { name: 'AYARLAR' });
    expect(dlg.getAttribute('aria-modal')).toBe('true');
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['Genel', 'Ses', 'Çipler', 'Gelişmiş']);
    await act(async () => { fireEvent.click(screen.getByRole('tab', { name: 'Çipler' })); });
    expect(screen.getByLabelText('SENTINEL sesi')).toBeTruthy();
    await act(async () => { fireEvent.keyDown(dlg, { key: 'Escape' }); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('onay isteği modal olarak çıkar; Onayla cevabı iletir', async () => {
    await act(async () => { mock.sendText('/onay'); });
    const dlg = await screen.findByRole('dialog', { name: 'ONAY GEREKİYOR' });
    expect(dlg.textContent).toContain('git status');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Onayla' })); });
    await waitFor(() => expect(S().confirm).toBeNull());
  });

  it('zincirli çip varken üst çubukta Çip Tamiri düğmesi çıkar ve kod girilebilir', async () => {
    await act(async () => { mock.sendText('/zincir'); });
    const fix = await screen.findByRole('button', { name: /Çip Tamiri/ });
    await act(async () => { fireEvent.click(fix); });
    const dlg = await screen.findByRole('dialog', { name: 'ÇİP TAMİRİ' });
    expect(dlg.querySelectorAll('input')).toHaveLength(3);
    const [a, b, c] = Array.from(dlg.querySelectorAll('input'));
    await act(async () => { fireEvent.change(a, { target: { value: 'KARA' } }); });
    await act(async () => { fireEvent.change(b, { target: { value: '1234' } }); });
    await act(async () => { fireEvent.change(c, { target: { value: 'ZNCR' } }); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Onar' })); });
    await waitFor(() => expect(S().story.locked).toBe(false));
  });

  it('ilişki matrisi hücresi okunabilir etiket taşır; barıştır puanı artırır', async () => {
    const cell = screen.getByRole('gridcell', { name: /ATLAS ile OBSIDIAN: −70 ezeli düşman/ });
    await act(async () => { fireEvent.click(cell); });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /Barıştır/ })); });
    expect(S().matrix.atlas.obsidian).toBe(-60);
  });

  it('arena: kurulum modalı → düello paneli → oylama', async () => {
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: /ARENA/ })); });
    await screen.findByRole('dialog', { name: 'ARENA' });
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Başlat' })); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(S().arena.phase).toBe('vote'), { timeout: 6000 });
    expect(await screen.findByText('KAZANAN?')).toBeTruthy();
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Berabere' })); });
    await waitFor(() => expect(S().arena.phase).toBe('end'));
    expect(screen.getByText('Berabere.')).toBeTruthy();
  });

  it('telemetri paneli gecikmeyi ve web etiketini gösterir; masaüstü alanları varsa göstergeler çıkar', async () => {
    await waitFor(() => expect(S().status).toBe('idle'));      // mock'un açılış selamı bitsin (o da gecikme yazar)
    expect(screen.getByText('web')).toBeTruthy();
    await act(async () => { S().pushLatency(1840); });
    expect(screen.getByText('1840')).toBeTruthy();
    await act(async () => { S().patchTelemetry({ cpu: 41, ram: 63, disk: 28, netDown: 120, netUp: 12 }); });
    expect(screen.getByText('masaüstü')).toBeTruthy();
    expect(screen.getByTitle('CPU %41')).toBeTruthy();
  });

  it('anahtar yok ve karşılanmamışsa ilk açılış modalı çıkar; "Demo ile dene" kapatır', async () => {
    cleanup();
    S().setHasKey(false);
    S().patchSettings({ onboarded: false });
    S().openModal(null);
    render(<App />);
    const dlg = await screen.findByRole('dialog', { name: "NEXUS'A HOŞ GELDİN" });
    expect(dlg.textContent).toContain('aistudio.google.com/apikey');
    await act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Demo ile dene' })); });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(S().settings.onboarded).toBe(true);
  });

  it('kaos "scramble" harfleri karıştırır ve sonunda eski metni geri koyar', async () => {
    const el = screen.getByText('Çalışan zamanlayıcı yok.');
    await act(async () => { S().triggerChaos('scramble'); });
    await new Promise((r) => setTimeout(r, 300));
    expect(el.textContent).not.toBe('Çalışan zamanlayıcı yok.');
    await new Promise((r) => setTimeout(r, 900));
    expect(el.textContent).toBe('Çalışan zamanlayıcı yok.');
  });
});
