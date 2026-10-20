from nexus import rivalry, settings, story


def test_grant_lock_wrong_and_right_code():
    assert not story.locked() and story.disabled_chips() == set()
    code = story.grant()
    assert story.locked() and story.disabled_chips() == {"atlas", "nova"}
    assert len(code.split("-")) == 3
    assert story.restore("YANLIS-KOD-XXXX") is False and story.locked()
    # ayraç, boşluk ve büyük/küçük harf farkına dayanıklı
    assert story.restore(code.lower().replace("-", " ")) is True
    assert not story.locked() and story.disabled_chips() == set()


def test_restore_without_lock_is_false():
    assert story.restore("AAAA-BBBB-CCCC") is False


def test_chain_lowers_relationships_and_leak_is_recorded():
    before = rivalry.score("atlas", "obsidian")
    story.grant()
    assert rivalry.score("atlas", "obsidian") == before - 20
    story.leak()
    assert any("sızdırdı" in e["reason"] for e in rivalry.events())


def test_time_counts_only_while_obsidian_mounted():
    story.tick(300, "atlas")
    assert story.snapshot()["progress"] == 0
    story.tick(300, "obsidian"); story.tick(100, "forge")
    assert 0.49 < story.snapshot()["progress"] < 0.51        # durur, sıfırlanmaz
    story.tick(400, "obsidian")
    assert story.due()
    story.mark_asked()
    assert not story.due()


def test_disabled_story_never_due():
    story.force_due()
    assert story.due()
    settings.set("story_enabled", False)
    assert not story.due()


def test_snapshot_never_contains_code():
    code = story.grant()
    assert code not in str(story.snapshot()) and story.snapshot()["locked"]
