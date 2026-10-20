# NEXUS

Windows için sesli masaüstü asistanı. 10 "çipten" birini takarsın ve onunla **Gemini Live** üzerinden gerçek
zamanlı konuşursun. Her çipin ayrı kişiliği, sesi, ses efekti, rengi ve **ayrı araç yetkisi** vardır. Çipler
arasında kalıcı bir ilişki sistemi var: rakipler zaman zaman araya girer, iki çipi tartıştırabilirsin (arena).

## Kurulum

**Hazır sürüm:** GitHub Releases'tan `NEXUS-windows.zip` indir, aç, `NEXUS.exe`'yi çalıştır.
Windows 10/11'de WebView2 Runtime gerekir (çoğunda kurulu; yoksa ilk açılışta Microsoft'un sayfası açılır).

**Kaynaktan:**

```bat
py -3.12 -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
python run.py
```

Mac/Linux'ta da çalışır (Windows'a özel araçlar görünmez). Yeniden derlemek için `build\build.bat`.

## API anahtarı

1. <https://aistudio.google.com/apikey> adresinden ücretsiz bir Gemini API anahtarı al.
2. İlk açılışta ya da **Ayarlar › Genel**'de yapıştır. Anahtar Windows kimlik bilgisi deposunda (keyring)
   durur, ayar dosyasına ve günlüğe yazılmaz. `GEMINI_API_KEY` ortam değişkeni de kabul edilir.

Anahtarın yoksa **demo modu** (`python run.py --demo`) HUD'u ve araçları sesli konuşma olmadan dener.

## Çipler

| Çip | Rol | Neye bakar |
|---|---|---|
| ATLAS | Ana orkestratör | Genel işler, uygulama açma, devir |
| NOVA | Günlük işler, müzik | Medya, pano, not |
| OBSIDIAN | Kara çip | Yetki ister, kötü karakter (iş yine yapılır) |
| SENTINEL | Güvenlik bekçisi | Defender, güvenlik duvarı, yerel port tarama |
| FORGE | Kod ustası | Dosya, git, kod arama, komut (onaylı) |
| IRIS | Ekran ve kamera gözü | Ekran görüntüsü, pencereler |
| PULSE | Altyapı nabzı | CPU, RAM, disk, ağ, süreçler |
| LEDGER | Para defteri | Gelir/gider kaydı ve özet |
| ORACLE | Araştırmacı | Web arama, sayfa okuma, not |
| GLITCH | Kaos çipi | Şaka, zar, arayüz kaos efektleri |

Bir çip yalnızca kendi araçlarını (ve ortak olanları) görür; başka alana giren işi `handoff` ile devreder.
Her çipin sesi **Ayarlar › Çipler**'den 30 Gemini sesinden biriyle değiştirilebilir.

## İlişkiler, araya girme ve arena

* Çiftler arası puan −100…+100; etiketler ezeli düşman, düşman, gergin, nötr, iyi, kardeş.
* **Drama** (üst çubuk): *sakin* hiç araya girme yok, *normal* ara sıra, *kaos* sık. Araya girmeler kısa, tek
  cümledir ve iş her zaman yapılır. Kullanıcıya hakaret yok.
* **ARENA:** iki çip ve bir konu seç; 6 satırlık sesli tartışma çalar, sonra kazananı sen seçersin.
* **Barıştır** düğmesi iki çipin puanını +10 yapar.

## Hikâye (isteğe bağlı)

OBSIDIAN uzun süre takılı kalırsa yetki ister. Verirsen ATLAS ve NOVA "zincire vurulur" (yalnızca takılamaz olur,
gerçekte hiçbir şey silinmez). GLITCH'e sorarsan onarım kodunu sızdırır; **Çip Tamiri**'ne girince kartlar döner.
**Ayarlar › Genel › OBSIDIAN'ı serbest bırak** ile kapatılabilir.

## Kısayollar

`Ctrl+Space` mikrofon aç/kapa · `Ctrl+1…0` çip tak · `Esc` pencere kapat.

## Gizlilik ve güvenlik

* Ses ve ekran görüntüleri yalnızca Gemini'ye gider; diske yazılmaz. Hafıza ve defter yerel JSON'dur
  (`%APPDATA%\NEXUS`). Telemetri yok.
* Komut çalıştırma, kayıt silme, süreç sonlandırma, dosya yazma ve OBSIDIAN'ın yetki isteği **ekranda onay** ister.
* Port tarama yalnızca yerel/özel ağ adreslerine yapılır. Araçlar çalışma klasörü dışına çıkamaz.

## Geliştirme

```bash
pip install -r requirements-dev.txt
NEXUS_DATA=./.tmpdata pytest -q          # tümü
python run.py --demo --debug             # anahtarsız deneme + DevTools
```

`Ctrl+Shift+Alt+S` (yalnızca `--debug`): OBSIDIAN'ın yetki isteme zamanını getirir.

## Bilinen sınırlar

* Kulaklıksız kullanımda yankıyı `barge_rms` eşiği bastırır; yetmezse ileride WebRTC AEC eklenecek.
* Araya girme ve arena ek metin + TTS çağrısı demektir (*sakin* seviyede hiç çağrı yapılmaz); 1–2 sn gecikebilir.
* `gemini-3.8-live` bazı hesaplarda kota nedeniyle reddedilir; NEXUS otomatik olarak
  `gemini-2.5-flash-native-audio-latest`'e geçer.
* Windows'a özel araçlar (Defender, güvenlik duvarı, pencere listesi, medya tuşları) bu repoda Windows
  üzerinde elle doğrulanmalıdır (bkz. `SPEC` §10 manuel kabul testi).
* Yazı tipleri (Rajdhani, Inter, JetBrains Mono) OFL lisanslıdır, bkz. `licenses/`.
