"""Yardımcı Gemini çağrıları: TTS (rakip sesleri, arena), araya girme metni, arena metni.

Hepsi `asyncio.to_thread` ile çalışır, 20 sn zaman aşımı vardır. Hata verirse çağıran sessizce atlar (§4.1).
"""
from __future__ import annotations

import asyncio
import base64
import json
import re
from collections import OrderedDict
from typing import Any

from .. import chips, rivalry, settings
from ..audio import io as aio
from ..log import log

TIMEOUT = 30.0
TEXT_FALLBACKS = ("gemini-3-flash-preview", "gemini-3.5-flash", "gemini-3.7-flash", "gemini-3.1-flash-lite", "gemini-flash-lite-latest")
ATTEMPT_MS = 10000                  # model başına zaman aşımı; yoğun modelde takılmadan sıradakine geç
CACHE_SIZE = 64


class AuxError(RuntimeError):
    pass


def clean_line(text: str, who: str | None = None, max_words: int = 18) -> str:
    """Model çıktısını temizler: tırnaklar, 'İSİM:' önekleri, markdown; kelime sınırı uygular."""
    t = (text or "").strip().splitlines()[0] if (text or "").strip() else ""
    t = re.sub(r"[*_`#>]+", "", t).strip()
    names = "|".join(re.escape(c.name) for c in chips.CHIPS.values())
    t = re.sub(rf"^\s*(?:{names})\s*[:\-–—]\s*", "", t, flags=re.I).strip()
    t = t.strip("\"'“”‘’«» ")
    words = t.split()
    if len(words) > max_words:
        t = " ".join(words[:max_words]).rstrip(",;:") + "…"
    return t


def voice_for(chip_key: str) -> str:
    return (settings.get("voice_overrides") or {}).get(chip_key) or chips.get(chip_key).voice


class Aux:
    def __init__(self, client: Any | None = None) -> None:
        self._client = client
        self._cache: OrderedDict[tuple, bytes] = OrderedDict()
        self._good_text: str | None = None

    @property
    def client(self):
        if self._client is None:
            key = settings.api_key()
            if not key:
                raise AuxError("API anahtarı yok")
            from google import genai
            self._client = genai.Client(api_key=key)
        return self._client

    # ------------------------------------------------------------------ TTS
    def _tts_sync(self, text: str, voice: str, style: str) -> bytes:
        errors: list[str] = []
        for model in settings.get("tts_models"):
            try:                                                  # birincil: Interactions API
                it = self.client.interactions.create(
                    model=model,
                    input=[{"type": "user_input", "content": [{"type": "text", "text": text,
                            "annotations": [{"type": "speech_metadata", "style": style}]}]}],
                    response_format={"type": "audio"},
                    generation_config={"speech_config": [{"voice": voice}]},
                )
                pcm, rate = aio.pcm_from_wav(base64.b64decode(it.output_audio.data))
                return aio.resample(pcm, rate)
            except Exception as exc:
                errors.append(f"{model}/interactions: {exc}")
            try:                                                  # yedek: generate_content
                from google.genai import types
                r = self.client.models.generate_content(
                    model=model, contents=text,
                    config=types.GenerateContentConfig(
                        response_modalities=["AUDIO"],
                        speech_config=types.SpeechConfig(voice_config=types.VoiceConfig(
                            prebuilt_voice_config=types.PrebuiltVoiceConfig(voice_name=voice)))))
                return r.candidates[0].content.parts[0].inline_data.data       # ham 24 kHz PCM
            except Exception as exc:
                errors.append(f"{model}/generate: {exc}")
        raise AuxError("TTS başarısız: " + " | ".join(e[:120] for e in errors))

    async def tts(self, chip_key: str, text: str) -> bytes:
        """Çipin sesiyle 24 kHz int16 PCM üretir (FX uygulanmadan). Önbellekli."""
        voice, style = voice_for(chip_key), chips.get(chip_key).style
        key = (text, voice, style)
        if key in self._cache:
            self._cache.move_to_end(key)
            return self._cache[key]
        pcm = await asyncio.wait_for(asyncio.to_thread(self._tts_sync, text, voice, style), TIMEOUT)
        self._cache[key] = pcm
        while len(self._cache) > CACHE_SIZE:
            self._cache.popitem(last=False)
        return pcm

    # ------------------------------------------------------------------ metin
    def _generate_sync(self, system: str, prompt: str, *, json_mode: bool = False, temperature: float = 1.0) -> str:
        from google.genai import types
        cfg = types.GenerateContentConfig(system_instruction=system, temperature=temperature,
                                          response_mime_type="application/json" if json_mode else None,
                                          http_options=types.HttpOptions(timeout=ATTEMPT_MS))
        errors = []
        order = [self._good_text, settings.get("text_model"), *TEXT_FALLBACKS]
        for model in dict.fromkeys(m for m in order if m):    # yoğunluk/kota hatasında sıradaki model; çalışan hatırlanır
            try:
                out = self.client.models.generate_content(model=model, contents=prompt, config=cfg).text or ""
                self._good_text = model
                return out
            except Exception as exc:
                errors.append(f"{model}: {str(exc)[:80]}")
        raise AuxError("metin üretilemedi: " + " | ".join(errors))

    async def interject_text(self, rival: str, active: str, user_text: str, ai_text: str) -> str | None:
        """Rakibin tek kısa cümlelik araya girmesi; üretilemezse None."""
        rv, ac = chips.get(rival), chips.get(active)
        s = rivalry.score(active, rival)
        system = (f"{rv.character}\n\nŞu an {ac.name} ile konuşan kullanıcıya yardım ediyor. "
                  f"{ac.name} ile ilişkin: {rivalry.label(s)} ({s:+d}).")
        prompt = ("Son konuşma:\n"
                  f"Kullanıcı: {user_text[:300]}\n{ac.name}: {ai_text[:300]}\n\n"
                  "Bu konuşmaya araya giren TEK kısa cümle yaz (en fazla 18 kelime), karakterine uygun, "
                  f"kullanıcıya değil {ac.name}'a yönelik. Hakaret ve küfür yok. Yalnızca cümleyi yaz.")
        try:
            raw = await asyncio.wait_for(asyncio.to_thread(self._generate_sync, system, prompt), TIMEOUT)
        except Exception as exc:
            log("araya girme metni üretilemedi", repr(exc)[:160])
            return None
        line = clean_line(raw, rival)
        return line or None

    async def debate_lines(self, a: str, b: str, topic: str) -> list[dict[str, str]]:
        """Arena için JSON: 6 satır, sırayla a, b, a, b, a, b."""
        ca, cb = chips.get(a), chips.get(b)
        s = rivalry.score(a, b)
        system = ("Bir sesli tartışma yazıyorsun. İki çip konu hakkında karakterlerine uygun tartışıyor.\n\n"
                  f"{ca.name}: {ca.character}\n\n{cb.name}: {cb.character}\n\n"
                  f"Aralarındaki ilişki: {rivalry.label(s)} ({s:+d}).")
        prompt = (f"Konu: {topic}\n\n"
                  f'JSON üret: {{"lines":[{{"who":"{a}","text":"..."}}, ...]}}. Tam 6 satır, sırayla {a}, {b}, {a}, {b}, {a}, {b} '
                  "(her çipten 3). Satır başına en fazla 25 kelime. Son satırlar bir sonuca yaklaşsın. "
                  "Küfür ve kullanıcıya hakaret yok, kavga zekice olsun.")
        raw = await asyncio.wait_for(asyncio.to_thread(self._generate_sync, system, prompt, json_mode=True), TIMEOUT)
        return parse_debate(raw, a, b)


def parse_debate(raw: str, a: str, b: str) -> list[dict[str, str]]:
    try:
        data = json.loads(raw)
        lines = data["lines"] if isinstance(data, dict) else data
    except (ValueError, KeyError, TypeError) as exc:
        raise AuxError(f"arena JSON'u çözülemedi: {exc}") from exc
    out: list[dict[str, str]] = []
    for item in lines:
        who = str(item.get("who", "")).lower()
        text = clean_line(str(item.get("text", "")), who, max_words=25)
        if who in (a, b) and text:
            out.append({"who": who, "text": text})
    if len(out) < 2:
        raise AuxError("arena için yeterli satır üretilemedi")
    return out[:6]
