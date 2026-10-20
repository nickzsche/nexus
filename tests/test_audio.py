import io
import wave

import numpy as np

from nexus.audio import io as aio


def _wav(rate=16000, secs=.5, ch=1):
    t = np.arange(int(rate * secs)) / rate
    a = (np.sin(2 * np.pi * 440 * t) * 12000).astype("<i2")
    if ch == 2:
        a = np.repeat(a, 2)
    b = io.BytesIO()
    with wave.open(b, "wb") as w:
        w.setnchannels(ch); w.setsampwidth(2); w.setframerate(rate); w.writeframes(a.tobytes())
    return b.getvalue()


def test_wav_roundtrip_and_resample():
    pcm, rate = aio.pcm_from_wav(_wav(16000, .5))
    assert rate == 16000 and len(pcm) == 16000
    up = aio.resample(pcm, rate, 24000)
    assert abs(len(up) - 24000) <= 4
    assert aio.resample(pcm, 24000, 24000) == pcm


def test_stereo_is_mixed_down():
    pcm, rate = aio.pcm_from_wav(_wav(24000, .1, ch=2))
    assert len(pcm) == 2400 * 2


def test_speaker_queue_labels_clear_and_busy():
    s = aio.Speaker(null=True)
    assert not s.busy
    s.feed("atlas", b"\x10\x10" * 4800)
    s.feed("sentinel", b"\x10\x10" * 4800)
    assert s.busy
    s.clear("sentinel")
    assert [i[0] for i in s._q] == ["atlas"]
    s.clear()
    assert not s._q


def test_speaker_null_loop_drains_in_realtime():
    s = aio.Speaker(null=True)
    s.start()
    s.feed("atlas", (b"\x40\x1f" * 2400))      # 100 ms, hissedilir seviye
    assert s.busy and s.who == "atlas"
    assert s.wait_idle(3)
    s.close()
