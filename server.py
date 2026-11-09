"""Loopback-only Edge TTS bridge. Requires Python 3.11 or newer."""
from __future__ import annotations

import asyncio
import base64
from contextlib import aclosing
import hmac
import html
import json
import math
from pathlib import Path
import re
from typing import Any

import aiohttp
from aiohttp import web
import edge_tts

BASE_DIR = Path(__file__).resolve().parent
LOCAL_ORIGIN = "http://127.0.0.1:18765"
DEFAULT_VOICE = "zh-CN-XiaoxiaoNeural"
VOICES = frozenset((DEFAULT_VOICE, "zh-CN-YunxiNeural"))
MAX_TEXT = 4000
MAX_AUDIO = 5_000_000
MAX_BODY = 64 * 1024
REQUEST_TIMEOUT = 45
OUTER_TIMEOUT = 50
CONFIG_PATH = web.AppKey("config_path", Path)
READER_PATH = web.AppKey("reader_path", Path)
DEMO_PATH = web.AppKey("demo_path", Path)
EXTENSION_ORIGIN = re.compile(r"chrome-extension://[a-p]{32}\Z")


def error(message: str, status: int) -> web.Response:
    return web.json_response({"error": message}, status=status)


def allowed_origin(origin: str | None) -> bool:
    return origin is None or origin == LOCAL_ORIGIN or bool(EXTENSION_ORIGIN.fullmatch(origin))


def read_token(app: web.Application) -> str:
    """Read on each request so an atomic config replacement takes effect immediately."""
    try:
        value = json.loads(app[CONFIG_PATH].read_text(encoding="utf-8-sig"))
        token = value.get("token") if isinstance(value, dict) else None
        if not isinstance(token, str) or not token.strip():
            raise ValueError("missing token")
        token.encode("utf-8")
        return token
    except (OSError, ValueError, UnicodeError) as exc:
        # Never include config contents or exception details in HTTP output/logs.
        raise RuntimeError("本地服务尚未配置有效 token，请检查 config.json。") from exc


@web.middleware
async def security(request: web.Request, handler: Any) -> web.StreamResponse:
    origin = request.headers.get("Origin")
    if not allowed_origin(origin):
        response = error("不允许此来源访问本地朗读服务。", 403)
    elif request.path == "/api/config" and origin not in (None, LOCAL_ORIGIN):
        response = error("只有本地朗读页面可以读取配置。", 403)
    elif request.path == "/api/config" and request.host != "127.0.0.1:18765":
        response = error("配置仅可从本地服务地址读取。", 403)
    elif request.method == "OPTIONS":
        if request.path not in ("/api/tts", "/api/speech", "/api/config", "/health", "/", "/demo.mp3"):
            response = error("接口不存在。", 404)
        elif request.headers.get("Access-Control-Request-Method", "GET") not in ("GET", "POST", "HEAD"):
            response = error("不允许此请求方法。", 405)
        else:
            requested = {part.strip().lower() for part in request.headers.get("Access-Control-Request-Headers", "").split(",") if part.strip()}
            if not requested <= {"authorization", "x-reader-token", "content-type"}:
                response = error("不允许此请求头。", 403)
            else:
                response = web.Response(status=204)
                response.headers["Access-Control-Allow-Methods"] = "GET, POST, HEAD, OPTIONS"
                response.headers["Access-Control-Allow-Headers"] = "Authorization, X-Reader-Token, Content-Type"
                response.headers["Access-Control-Max-Age"] = "600"
    else:
        try:
            response = await handler(request)
        except web.HTTPException as exc:
            response = error("请求体超过限制。" if exc.status == 413 else "请求的资源或方法不可用。", exc.status)
    response.headers["Cache-Control"] = "no-store"
    response.headers["X-Content-Type-Options"] = "nosniff"
    response.headers["Referrer-Policy"] = "no-referrer"
    response.headers["Vary"] = "Origin"
    if origin and allowed_origin(origin) and not (request.path == "/api/config" and origin != LOCAL_ORIGIN):
        response.headers["Access-Control-Allow-Origin"] = origin
    # Deliberately no Access-Control-Allow-Credentials header.
    return response


async def health(request: web.Request) -> web.Response:
    return web.json_response({"ok": True, "voice": DEFAULT_VOICE})


async def reader(request: web.Request) -> web.StreamResponse:
    return web.FileResponse(request.app[READER_PATH])


async def config(request: web.Request) -> web.Response:
    try:
        token = read_token(request.app)
    except RuntimeError as exc:
        return error(str(exc), 503)
    return web.json_response({"token": token, "voice": DEFAULT_VOICE})


async def demo(request: web.Request) -> web.StreamResponse:
    path = request.app[DEMO_PATH]
    if not path.is_file():
        return error("示例音频尚未生成。", 404)
    return web.FileResponse(path, headers={"Content-Type": "audio/mpeg"})


def validate_payload(payload: Any) -> tuple[str, str, str]:
    if not isinstance(payload, dict):
        raise ValueError("请求 JSON 必须是对象。")
    text = payload.get("text")
    if not isinstance(text, str) or not text.strip():
        raise ValueError("请输入要朗读的文本。")
    if len(text) > MAX_TEXT:
        raise ValueError("文本最多为 4000 个字符。")
    voice = payload.get("voice", DEFAULT_VOICE)
    if not isinstance(voice, str) or voice not in VOICES:
        raise ValueError("仅支持 zh-CN-XiaoxiaoNeural 和 zh-CN-YunxiNeural。")
    rate = payload.get("rate", "+0%")
    if not isinstance(rate, str) or not re.fullmatch(r"[+-]?\d{1,3}%", rate, flags=re.ASCII):
        raise ValueError("语速必须为 -50% 到 +100% 的整数百分比。")
    numeric_rate = int(rate[:-1])
    if not -50 <= numeric_rate <= 100:
        raise ValueError("语速必须为 -50% 到 +100%。")
    return text, voice, f"{numeric_rate:+d}%"


def convert_boundaries(text: str, chunks: list[dict[str, Any]]) -> tuple[list[dict[str, Any]], int]:
    """Map ordered Edge words to original text; only whitespace may differ.

    UTF-16 offsets address JavaScript strings, with an exclusive endChar. Unmatched
    or invalid metadata is skipped, never assigned an invented character range.
    """
    utf16 = [0]
    for char in text:
        utf16.append(utf16[-1] + (2 if ord(char) > 0xFFFF else 1))
    boundaries = []
    cursor = 0
    skipped = 0
    for chunk in chunks:
        word = chunk.get("text")
        offset, duration = chunk.get("offset"), chunk.get("duration")
        if not isinstance(word, str) or not word or not all(
            isinstance(value, (int, float)) and not isinstance(value, bool)
            and math.isfinite(value) and value >= 0 for value in (offset, duration)
        ):
            skipped += 1
            continue
        word = html.unescape(word)
        if not word:
            skipped += 1
            continue
        start = text.find(word, cursor)
        end = start + len(word)
        if any(char.isspace() for char in word):
            # Prefer the earliest equivalent occurrence, even when a later exact
            # match exists. This keeps repeated phrases aligned across newlines.
            pattern = "".join(r"\s+" if part.isspace() else re.escape(part)
                              for part in re.split(r"(\s+)", word))
            match = re.compile(pattern).search(text, cursor)
            if match is not None and (start < 0 or match.start() < start):
                start, end = match.span()
        if start < 0:
            skipped += 1
            continue
        boundaries.append({
            # Edge already accumulates offsets across its internal SSML chunks.
            "start": offset / 10_000_000,
            "duration": duration / 10_000_000,
            "startChar": utf16[start],
            "endChar": utf16[end],
            "text": text[start:end],
        })
        cursor = end
    return boundaries, skipped


async def _synthesize(text: str, voice: str, rate: str, *, include_boundaries: bool) -> tuple[bytes, list[dict[str, Any]]]:
    # A new Communicate instance is required for each synthesis: streams are single-use.
    communicate = edge_tts.Communicate(text, voice, rate=rate, boundary="WordBoundary", connect_timeout=15, receive_timeout=45)
    # edge-tts creates its own ClientSession using this public timeout attribute.
    communicate.session_timeout = aiohttp.ClientTimeout(connect=15, total=45, sock_connect=15, sock_read=45)
    audio = bytearray()
    chunks = []
    async with aclosing(communicate.stream()) as stream:
        async for chunk in stream:
            if chunk["type"] == "audio":
                data = chunk["data"]
                if len(audio) + len(data) > MAX_AUDIO:
                    raise ValueError("音频超过 5 MB 限制，请缩短文本。")
                audio.extend(data)
            elif include_boundaries and chunk["type"] == "WordBoundary":
                chunks.append(chunk)
    if not audio:
        raise ValueError("语音服务未返回音频，请稍后重试。")
    return bytes(audio), chunks


async def synthesize(text: str, voice: str, rate: str) -> bytes:
    audio, _ = await _synthesize(text, voice, rate, include_boundaries=False)
    return audio


async def synthesize_speech(text: str, voice: str, rate: str) -> dict[str, Any]:
    audio, chunks = await _synthesize(text, voice, rate, include_boundaries=True)
    boundaries, skipped = convert_boundaries(text, chunks)
    return {
        "audio": base64.b64encode(audio).decode("ascii"),
        "mime": "audio/mpeg",
        "boundaries": boundaries,
        "warning": {"skippedBoundaries": skipped},
    }


async def tts(request: web.Request, *, include_boundaries: bool = False) -> web.Response:
    try:
        token = read_token(request.app)
    except RuntimeError as exc:
        return error(str(exc), 503)
    auth = request.headers.get("Authorization", "")
    parts = auth.split(" ", 1)
    bearer = parts[1] if len(parts) == 2 and parts[0].lower() == "bearer" else ""
    header_token = request.headers.get("X-Reader-Token", "")
    # Compare bytes so even malformed non-ASCII credentials produce a clean 401.
    if not any(hmac.compare_digest(candidate.encode("utf-8"), token.encode("utf-8")) for candidate in (bearer, header_token)):
        return error("认证失败，请重新打开本地朗读页面或检查扩展配置。", 401)
    if request.content_type != "application/json":
        return error("Content-Type 必须为 application/json。", 415)
    try:
        payload = await request.json()
    except (ValueError, UnicodeError):
        return error("请求体不是有效的 JSON。", 400)
    try:
        text, voice, rate = validate_payload(payload)
    except ValueError as exc:
        return error(str(exc), 400)
    try:
        async with asyncio.timeout(OUTER_TIMEOUT):
            operation = synthesize_speech if include_boundaries else synthesize
            result = await asyncio.wait_for(operation(text, voice, rate), timeout=REQUEST_TIMEOUT)
    except TimeoutError:
        return error("语音合成超时（45 秒），请缩短文本或稍后重试。", 502)
    except ValueError as exc:
        # Only our own bounded, non-sensitive output validation messages are exposed.
        if str(exc) in ("音频超过 5 MB 限制，请缩短文本。", "语音服务未返回音频，请稍后重试。"):
            return error(str(exc), 502)
        return error("语音合成失败，请检查网络连接并稍后重试。", 502)
    except Exception:
        return error("语音合成失败，请检查网络连接并稍后重试。", 502)
    if include_boundaries:
        return web.json_response(result)
    return web.Response(body=result, content_type="audio/mpeg", headers={"Content-Disposition": 'inline; filename="reader.mp3"'})


async def speech(request: web.Request) -> web.Response:
    return await tts(request, include_boundaries=True)


def create_app(base_dir: Path | None = None) -> web.Application:
    directory = BASE_DIR if base_dir is None else Path(base_dir)
    app = web.Application(middlewares=[security], client_max_size=MAX_BODY)
    app[CONFIG_PATH] = directory / "config.json"
    app[READER_PATH] = directory / "reader.html"
    app[DEMO_PATH] = directory / "sample-xiaoxiao.mp3"
    app.router.add_get("/health", health)
    app.router.add_get("/", reader)
    app.router.add_get("/api/config", config)
    app.router.add_get("/demo.mp3", demo)
    app.router.add_post("/api/tts", tts)
    app.router.add_post("/api/speech", speech)
    return app


if __name__ == "__main__":
    web.run_app(create_app(), host="127.0.0.1", port=18765, access_log=None, print=None)
