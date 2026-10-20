from nexus import memory


def test_add_search_delete_and_dedupe():
    memory.add("Adı Sahan"); memory.add("adı sahan")                    # aynı bilgi iki kez yazılmaz
    memory.add("Gece kahve içmez", "nova")
    assert memory.items() == ["Adı Sahan"] and memory.items("nova") == ["Gece kahve içmez"]
    assert memory.delete("kahve") == 1 and memory.items("nova") == []
    assert memory.delete("   ") == 0


def test_empty_text_rejected():
    import pytest
    with pytest.raises(ValueError):
        memory.add("  ")


def test_prompt_block_scopes():
    memory.add("Ortak bilgi"); memory.add("Özel not", "forge")
    assert "Ortak bilgi" in memory.prompt_block("nova") and "Özel not" not in memory.prompt_block("nova")
    assert "Özel not" in memory.prompt_block("forge")
    assert memory.prompt_block("atlas").count("Ortak bilgi") == 1


def test_limit_keeps_latest():
    for i in range(memory.MAX_ITEMS + 10):
        memory.add(f"kayıt {i}")
    assert len(memory.items()) == memory.MAX_ITEMS and memory.items()[-1] == f"kayıt {memory.MAX_ITEMS + 9}"
