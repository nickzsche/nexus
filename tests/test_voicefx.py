import time

import numpy as np
import pytest

from nexus import voicefx

SR = voicefx.SR


def _speechlike(seconds=3.0, seed=0):
    rng = np.random.default_rng(seed)
    t = np.arange(int(SR * seconds)) / SR
    env = (np.sin(2 * np.pi * 3 * t) > -.2).astype(np.float32)
    x = .3 * np.sin(2 * np.pi * 180 * t) + .15 * np.sin(2 * np.pi * 900 * t) + .03 * rng.standard_normal(len(t))
    return (np.clip(x * env, -1, 1) * 32767).astype(np.int16)


def _chunked(profile, pcm, chunk=960):          # 40 ms
    ch = voicefx.for_profile(profile)
    return np.concatenate([ch.process(pcm[i:i + chunk]) for i in range(0, len(pcm), chunk)])


@pytest.mark.parametrize("profile", [p for p in voicefx.PROFILES if p != "none"])
def test_no_overflow_and_chunk_consistency(profile):
    pcm = _speechlike()
    whole = voicefx.for_profile(profile).process(pcm)
    parts = _chunked(profile, pcm)
    assert whole.dtype == np.int16 and len(whole) == len(pcm)
    assert np.max(np.abs(whole.astype(np.int32))) <= 32767
    diff = np.max(np.abs(whole.astype(np.float32) - parts.astype(np.float32))) / 32768
    assert diff < 1e-3, f"{profile}: parça sınırında fark {diff}"


@pytest.mark.parametrize("profile", [p for p in voicefx.PROFILES if p != "none"])
def test_realtime_factor(profile):
    pcm = _speechlike()
    ch = voicefx.for_profile(profile)
    t0 = time.perf_counter()
    for i in range(0, len(pcm), 960):
        ch.process(pcm[i:i + 960])
    factor = (time.perf_counter() - t0) / (len(pcm) / SR)
    assert factor < .1, f"{profile}: gerçek zaman faktörü {factor:.3f}"


def test_radio_has_intro_and_unknown_profile_raises():
    assert len(voicefx.for_profile("radio").intro()) > 0
    assert voicefx.for_profile("hall").intro() == b""
    with pytest.raises(KeyError):
        voicefx.for_profile("yok")


def test_render_returns_bytes_and_reset_is_repeatable():
    pcm = _speechlike(1.0)
    a = voicefx.render(pcm, "obsidian")
    assert isinstance(a, bytes) and len(a) == len(pcm) * 2
    ch = voicefx.for_profile("cathedral")
    first = ch.process(pcm)
    ch.reset()
    assert np.array_equal(first, ch.process(pcm))
