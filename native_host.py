"""Chrome Native Messaging host: start only this project's loopback TTS service."""
from __future__ import annotations

import json
import os
from pathlib import Path
import struct
import subprocess
import sys
import time
from typing import BinaryIO
import urllib.error
import urllib.request

BASE_DIR = Path(__file__).resolve().parent
# Accept any of the known extension ids so a re-load keeps working even if
# Chrome regenerates the id (path-based) or an older id is still installed.
EXTENSION_IDS = frozenset((
    "bniddmggmkjihhheddfjnjeggfhojmgo",
    "dalmdgpohkfpclknkcfpeifdminlijic",
    "bogojjhkpeiabadplnpfchgafbnekogd",
))
ALLOWED_ORIGINS = frozenset(f"chrome-extension://{i}/" for i in EXTENSION_IDS)
HEALTH_URL = "http://127.0.0.1:18765/health"
MAX_MESSAGE_BYTES = 4096
START_TIMEOUT = 8.0


def read_exact(stream: BinaryIO, size: int) -> bytes:
    chunks = bytearray()
    while len(chunks) < size:
        piece = stream.read(size - len(chunks))
        if not piece:
            raise ValueError("本机启动消息不完整。")
        chunks.extend(piece)
    return bytes(chunks)


def read_message(stream: BinaryIO) -> dict:
    length = struct.unpack("<I", read_exact(stream, 4))[0]
    if not 0 < length <= MAX_MESSAGE_BYTES:
        raise ValueError("本机启动消息大小无效。")
    try:
        message = json.loads(read_exact(stream, length).decode("utf-8"))
    except (UnicodeError, json.JSONDecodeError) as exc:
        raise ValueError("本机启动消息格式无效。") from exc
    if not isinstance(message, dict):
        raise ValueError("本机启动消息格式无效。")
    return message


def write_message(stream: BinaryIO, message: dict) -> None:
    payload = json.dumps(message, ensure_ascii=False).encode("utf-8")
    stream.write(struct.pack("<I", len(payload)))
    stream.write(payload)
    stream.flush()


def service_is_ready() -> bool:
    # Never send loopback probes through a system proxy.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    try:
        with opener.open(HEALTH_URL, timeout=0.5) as response:
            if response.status != 200:
                return False
            payload = response.read(2049)
            if len(payload) > 2048:
                return False
            data = json.loads(payload)
            return isinstance(data, dict) and data.get("ok") is True and data.get("voice") == "zh-CN-XiaoxiaoNeural"
    except (OSError, ValueError, urllib.error.URLError):
        return False


def start_service(base_dir: Path = BASE_DIR) -> dict:
    if service_is_ready():
        return {"ok": True, "alreadyRunning": True}
    if os.name != "nt":
        return {"ok": False, "error": "本机启动功能目前支持 Windows Chrome。"}
    python = base_dir / ".venv" / "Scripts" / "pythonw.exe"
    server = base_dir / "server.py"
    if not python.is_file() or not server.is_file():
        return {"ok": False, "error": "本机服务文件不完整，请重新运行 install-native-host.cmd。"}
    # Keep startup diagnostics with the workspace's other debugging artifacts.
    log_path = base_dir.parent.parent / "archive" / "dumps" / "chrome-xiaoxiao-service.log"
    try:
        log_path.parent.mkdir(parents=True, exist_ok=True)
        with log_path.open("ab") as log:
            # The host exits after replying. Require an independent process so
            # Chrome closing the native host cannot terminate the TTS service.
            flags = (subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
                     | subprocess.CREATE_BREAKAWAY_FROM_JOB)
            process = subprocess.Popen(
                [str(python), str(server)], cwd=str(base_dir),
                stdin=subprocess.DEVNULL, stdout=log, stderr=log,
                close_fds=True, creationflags=flags,
            )
        deadline = time.monotonic() + START_TIMEOUT
        while time.monotonic() < deadline:
            if service_is_ready():
                return {"ok": True, "alreadyRunning": False}
            if process.poll() is not None:
                return {"ok": False, "error": f"语音服务启动后退出。启动记录：{log_path}"}
            time.sleep(0.15)
    except OSError as exc:
        if getattr(exc, "winerror", None) == 5:
            return {"ok": False, "error": "系统拒绝启动独立后台服务。请使用桌面启动入口，并检查 Chrome 或系统的进程限制。"}
        return {"ok": False, "error": "无法启动本机服务，请重新运行 install-native-host.cmd 并检查 Python 环境。"}
    return {"ok": False, "error": f"服务启动等待超时。请稍后重试；启动记录：{log_path}"}


def handle_message(message: dict) -> dict:
    if message != {"action": "start"}:
        return {"ok": False, "error": "不支持的本机操作。"}
    return start_service()


def serve(origin: str, source: BinaryIO, destination: BinaryIO) -> None:
    if origin not in ALLOWED_ORIGINS:
        write_message(destination, {"ok": False, "error": "不允许此扩展调用本机启动程序。"})
        return
    try:
        result = handle_message(read_message(source))
    except ValueError as exc:
        result = {"ok": False, "error": str(exc)}
    except Exception:
        # Do not expose tokens, command lines, request contents or tracebacks.
        result = {"ok": False, "error": "本机启动程序异常，请重新运行 install-native-host.cmd。"}
    write_message(destination, result)


if __name__ == "__main__":
    if sys.argv[1:] == ["--start-service"]:
        # Used only by the one-time local installer, without Native Messaging.
        print(json.dumps(start_service(), ensure_ascii=True))
    else:
        # Chrome uses byte counts: Windows text-mode newline conversion must be off.
        if os.name == "nt":
            import msvcrt
            msvcrt.setmode(sys.stdin.fileno(), os.O_BINARY)
            msvcrt.setmode(sys.stdout.fileno(), os.O_BINARY)
        serve(sys.argv[1] if len(sys.argv) > 1 else "", sys.stdin.buffer, sys.stdout.buffer)
