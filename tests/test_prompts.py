import pytest

from nexus import chips, memory, prompts, settings, story


@pytest.mark.parametrize("key", chips.ORDER)
def test_every_chip_has_instruction(key):
    text = prompts.system_instruction(key)
    c = chips.get(key)
    assert c.name in text and c.character in text and "Türkçe" in text


def test_villain_has_banned_phrases_and_no_real_harm():
    text = prompts.system_instruction("obsidian")
    assert "Yasak sözlerin" in text and "yaltaklanma" in text
    assert "hakaret etmez" in text and "fani" in text


def test_address_and_user_name_included():
    settings.set("user_name", "Sahan")
    text = prompts.system_instruction("forge")
    assert "Sahan" in text and "'usta'" in text


def test_chained_chip_is_marked():
    assert "Zincire vurulmuş" not in prompts.system_instruction("forge")
    story.grant()
    text = prompts.system_instruction("forge")
    assert "Zincire vurulmuş" in text and "ATLAS" in text and "NOVA" in text


def test_memory_and_extra_are_included():
    memory.add("Kahveyi sade içer"); memory.add("Sadece FORGE bilsin", "forge")
    text = prompts.system_instruction("forge", extra="ÖNCEKİ KONUŞMA: merhaba")
    assert "Kahveyi sade içer" in text and "Sadece FORGE bilsin" in text and "ÖNCEKİ KONUŞMA" in text
    assert "Sadece FORGE bilsin" not in prompts.system_instruction("nova")


def test_relationships_shown_in_prompt():
    assert "OBSIDIAN" in prompts.system_instruction("atlas")
