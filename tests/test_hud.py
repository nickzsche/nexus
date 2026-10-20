"""HUD'u mock köprüyle gerçek tarayıcıda açar (Playwright). Chromium yoksa atlanır."""
import pathlib

import pytest

pytest.importorskip("playwright")
from playwright.sync_api import sync_playwright  # noqa: E402

ROOT = pathlib.Path(__file__).resolve().parent.parent
INDEX = (ROOT / "nexus" / "hud" / "web" / "index.html").as_uri()
ART = ROOT / "artifacts"


@pytest.fixture(scope="module")
def page():
    with sync_playwright() as p:
        try:
            browser = p.chromium.launch()
        except Exception as exc:                        # chromium kurulu değil
            pytest.skip(f"chromium yok: {exc}")
        pg = browser.new_page(viewport={"width": 1440, "height": 900})
        pg.errors = []
        pg.on("console", lambda m: m.type == "error" and pg.errors.append(m.text))
        pg.on("pageerror", lambda e: pg.errors.append(str(e)))
        pg.goto(INDEX)
        pg.wait_for_selector(".chip-card", timeout=5000)
        yield pg
        browser.close()


def main_color(pg):
    return pg.evaluate("getComputedStyle(document.documentElement).getPropertyValue('--main').trim()")


def test_ten_cards_and_default_theme(page):
    assert page.locator(".chip-card").count() == 10
    assert page.locator(".chip-card.active").count() == 1
    assert page.evaluate("NX.state.active") == "atlas"


def test_clicking_chip_changes_main_color(page):
    page.wait_for_timeout(300)
    before = page.evaluate("NX.state.by.atlas.colors.main")
    page.click('.chip-card[data-key="nova"]')
    page.wait_for_function("NX.state.active === 'nova'", timeout=4000)
    page.wait_for_timeout(900)                          # 600 ms'lik renk geçişi
    now = main_color(page)
    assert now.replace(" ", "") in ("rgb(255,122,217)", "#ff7ad9")      # @property renk olarak döner
    assert before.lower() == "#5ed8ff"
    ART.mkdir(exist_ok=True)
    page.screenshot(path=str(ART / "hud.png"))


def test_settings_modal_opens_with_tabs(page):
    page.click("#btn-settings")
    page.wait_for_selector("#m-settings:not([hidden])")
    assert page.locator("#voice-list .vrow").count() == 10
    page.keyboard.press("Escape")
    assert page.locator("#m-settings").is_hidden()


def test_confirm_flow_and_story_icon(page):
    page.evaluate("NX.on('confirm', {id:'t1', title:'Komut', detail:'ls', timeout:5})")
    page.wait_for_selector("#m-confirm:not([hidden])")
    page.click("#mc-no")
    assert page.locator("#m-confirm").is_hidden()
    assert page.locator("#btn-repair").is_hidden()
    page.evaluate("NX.on('story', {locked:true, chained:['atlas','nova']})")
    assert page.locator("#btn-repair").is_visible()
    assert page.locator(".chip-card.chained").count() == 2
    page.evaluate("NX.on('story', {locked:false, chained:[]})")


def test_partial_lines_merge(page):
    page.evaluate("NX.on('line', {who:'nova', kind:'ai', text:'Mer', final:false}); NX.on('line', {who:'nova', kind:'ai', text:'haba', final:true})")
    assert page.locator(".line .txt", has_text="Merhaba").count() >= 1


def test_no_console_errors(page):
    assert page.errors == []
