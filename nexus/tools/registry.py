"""Araç kaydı. Bir araç bir kez tanımlanır; çipe göre izin süzgeci `allowed` ile uygulanır.

Araç hatası modele {"error": ...} olarak döner, uygulamayı düşürmez (§1 kural 7).
"""
from __future__ import annotations

import sys
from dataclasses import dataclass, field
from typing import Any, Callable, Protocol

from ..log import log

Handler = Callable[[dict[str, Any], "Context"], Any]


class Context(Protocol):
    """Araçların orkestratörle konuştuğu yüzey (core.py uygular)."""

    chip: Any                                   # chips.Chip

    def emit(self, event: str, payload: dict | None = None) -> None: ...
    def confirm(self, title: str, detail: str = "", timeout: float = 30.0) -> bool: ...
    def send_image(self, jpeg: bytes, note: str = "") -> None: ...
    def handoff(self, to: str, task: str) -> str: ...
    def debate(self, a: str, b: str, topic: str) -> str: ...


@dataclass
class ToolSpec:
    name: str
    description: str
    parameters: dict[str, Any]
    fn: Handler
    platforms: tuple[str, ...] = ()
    builtin: bool = False                       # Gemini yerleşik aracı (google_search)

    def available(self) -> bool:
        return not self.platforms or sys.platform in self.platforms


TOOLS: dict[str, ToolSpec] = {}
OBJ = {"type": "object", "properties": {}}


def tool(name: str, description: str, params: dict[str, Any] | None = None, *,
         platforms: tuple[str, ...] = ()) -> Callable[[Handler], Handler]:
    """`params` JSON Schema `properties` sözlüğü ya da tam şema olabilir."""
    schema = params or OBJ
    if "type" not in schema:
        schema = {"type": "object", "properties": schema,
                  "required": [k for k, v in schema.items() if isinstance(v, dict) and v.pop("required", False)]}

    def deco(fn: Handler) -> Handler:
        TOOLS[name] = ToolSpec(name, description, schema, fn, platforms)
        return fn
    return deco


TOOLS["google_search"] = ToolSpec("google_search", "Gemini yerleşik web araması.", OBJ,
                                  lambda a, c: {"error": "yerleşik araç"}, builtin=True)


def declarations(names: tuple[str, ...] | list[str]) -> list[Any]:
    """Live yapılandırması için `types.Tool` listesi: yerleşik arama + işlev bildirimleri."""
    from google.genai import types

    out: list[Any] = []
    funcs = []
    for n in names:
        spec = TOOLS.get(n)
        if spec is None or not spec.available():
            continue
        if spec.builtin:
            out.append(types.Tool(google_search=types.GoogleSearch()))
        else:
            funcs.append(types.FunctionDeclaration(
                name=spec.name, description=spec.description, parameters_json_schema=spec.parameters))
    if funcs:
        out.append(types.Tool(function_declarations=funcs))
    return out


def run(name: str, args: dict[str, Any] | None, ctx: Context, allowed: tuple[str, ...] | list[str]) -> dict[str, Any]:
    """Aracı çalıştırır. Yetkisiz, bilinmeyen ya da hatalı çağrı {"error": ...} döner."""
    if name not in allowed:
        return {"error": f"'{name}' aracı bu çipin yetkisinde değil."}
    spec = TOOLS.get(name)
    if spec is None or not spec.available() or spec.builtin:
        return {"error": f"'{name}' aracı bu sistemde kullanılamıyor."}
    try:
        result = spec.fn(dict(args or {}), ctx)
    except Exception as exc:                    # araç hatası döngüyü kırmaz
        log("araç hatası", name, repr(exc))
        return {"error": f"{name} başarısız: {exc}"}
    if isinstance(result, dict) and ("error" in result or "result" in result):
        return result
    return {"result": result}


def arg_str(args: dict[str, Any], key: str, default: str = "") -> str:
    v = args.get(key, default)
    return v.strip() if isinstance(v, str) else str(v)
