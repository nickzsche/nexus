import random

import pytest

from nexus import chips, rivalry, settings

ALL = list(chips.ORDER)


def pick_many(active, text="", n=300, seed=7):
    rng = random.Random(seed)
    got = set()
    for i in range(n):
        rivalry.reset_runtime()                      # bekleme süresi testi bozmasın
        k = rivalry.pick_interjector(active, text, ALL, rng=rng, now=1_000_000 + i * 1000)
        if k:
            got.add(k)
    return got


def test_calm_never_interjects():
    settings.set("drama", "sakin")
    assert pick_many("forge", "deploy kod git") == set()


def test_chaos_picks_enemies_never_friends():
    settings.set("drama", "kaos")
    got = pick_many("forge", "deploy ettim")
    assert got and "sentinel" in got
    for k in got:
        assert rivalry.score("forge", k) <= rivalry.INTERJECT_THRESHOLD
    for friend in ("atlas", "iris", "oracle", "nova"):       # forge'un dostları/nötrleri
        assert friend not in got


def test_nobody_interjects_when_no_enemy():
    settings.set("drama", "kaos")
    for k in ALL:
        if k != "atlas":
            rivalry.bump("atlas", k, +100)                   # herkes kardeş
    assert pick_many("atlas", "plan") == set()


def test_domain_keyword_boosts_weight():
    settings.set("drama", "kaos")
    rng, hits = random.Random(3), {"sentinel": 0, "other": 0}
    for i in range(600):
        rivalry.reset_runtime()
        k = rivalry.pick_interjector("forge", "deploy", ALL, rng=rng, now=10 ** 6 + i * 1000)
        if k == "sentinel":
            hits["sentinel"] += 1
        elif k:
            hits["other"] += 1
    assert hits["sentinel"] > 0 and hits["sentinel"] > hits["other"] / 3        # konu kelimesi ağırlığı artırır


def test_cooldown_blocks_second_interjection():
    settings.set("drama", "normal")
    rng = random.Random(0)
    first = None
    for i in range(50):                                      # olasılık tutana kadar dene
        first = rivalry.pick_interjector("forge", "deploy", ALL, rng=rng, now=1000.0)
        if first:
            break
    assert first
    assert rivalry.pick_interjector("forge", "deploy", ALL, rng=rng, now=1010.0) is None      # 90 sn dolmadı


def test_bump_clamps_and_logs():
    assert rivalry.bump("nova", "glitch", +500) == 100
    assert rivalry.bump("nova", "glitch", -500) == -100
    assert rivalry.score("glitch", "nova") == -100                       # çift sırası önemsiz
    assert rivalry.bump("nova", "nova", -5) == 100


def test_labels():
    assert [rivalry.label(s) for s in (-80, -50, -20, 0, 30, 70)] == [
        "ezeli düşman", "düşman", "gergin", "nötr", "iyi", "kardeş"]


def test_win_peace_combo():
    before = rivalry.score("forge", "sentinel")
    rivalry.win("sentinel", "forge")
    assert rivalry.score("forge", "sentinel") == before - 6
    rivalry.make_peace("forge", "sentinel")
    assert rivalry.score("forge", "sentinel") == before + 4
    rivalry.bump("atlas", "nova", +40)
    assert rivalry.combo("atlas", "nova") and not rivalry.combo("atlas", "obsidian")


def test_persistence_in_file():
    from nexus import store
    rivalry.bump("iris", "oracle", -77, "deneme")
    expected = rivalry.BASE["iris|oracle"] - 77
    assert store.load("rivalry.json", {})["scores"]["iris|oracle"] == expected      # diske yazıldı
    assert rivalry.score("oracle", "iris") == expected and rivalry.events(1)[0]["reason"] == "deneme"


def test_matrix_shape_and_prompt_block():
    m = rivalry.matrix()
    assert set(m) == set(ALL) and all(set(r) == set(ALL) for r in m.values()) and m["atlas"]["atlas"] == 100
    block = rivalry.prompt_block("atlas")
    assert "OBSIDIAN" in block and "ezeli düşman" in block


def test_wants_retort_respects_drama():
    settings.set("drama", "sakin")
    assert not any(rivalry.wants_retort(random.Random(i)) for i in range(50))
    settings.set("drama", "kaos")
    assert sum(rivalry.wants_retort(random.Random(i)) for i in range(200)) > 140
