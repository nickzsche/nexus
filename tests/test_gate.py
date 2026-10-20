from nexus.audio.gate import MicGate

CH = b"\x01\x00" * 320        # 20 ms


def run(g, pattern, busy=False):
    """pattern: her 20 ms için rms listesi → (gönderilen ses parçası sayısı, bitiş sayısı)."""
    audio = ends = 0
    for rms in pattern:
        for a in g.feed(CH, rms, busy):
            audio += a[0] == "audio"
            ends += a[0] == "end"
    return audio, ends


def test_silence_and_noise_send_nothing():
    g = MicGate()
    assert run(g, [0.004] * 200) == (0, 0)                  # sessiz oda
    assert run(g, [0.004, 0.2, 0.004, 0.004, 0.2, 0.004]) == (0, 0)   # tek seferlik tıkırtılar


def test_speech_sends_preroll_then_ends_after_hang():
    g = MicGate()
    run(g, [0.004] * 30)
    audio, ends = run(g, [0.2] * 10 + [0.004] * 30)
    assert ends == 1
    assert audio >= 10 + 12                                  # konuşma + 240 ms önden ekleme (ilk hece kesilmesin)
    assert not g.speaking


def test_end_fires_after_about_350ms_not_800():
    g = MicGate()
    run(g, [0.2] * 10)
    n = 0
    while True:
        n += 1
        if any(a[0] == "end" for a in g.feed(CH, 0.004)):
            break
    assert 15 <= n <= 20                                     # ~350 ms (20 ms'lik parçalar)


def test_speaker_echo_is_ignored_but_loud_barge_in_passes():
    g = MicGate()
    assert run(g, [0.05] * 40, busy=True) == (0, 0)          # hoparlör yankısı eşiğin altında
    audio, _ = run(g, [0.6] * 10, busy=True)                 # kullanıcı bağırarak araya girdi
    assert audio > 0


def test_adapts_to_noisy_room():
    g = MicGate()
    run(g, [0.03] * 300)                                     # sürekli fon gürültüsü: tabanı yükseltir
    assert g.floor > .02
    assert run(g, [0.03] * 20) == (0, 0)
