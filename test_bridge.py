"""Offline contract tests. No sockets, public requests, config writes, or audio files.

Run: .venv\\Scripts\\python.exe -B -m unittest -v test_bridge
"""
from __future__ import annotations

import asyncio
import base64
import json
from pathlib import Path
import unittest
from unittest.mock import AsyncMock, patch

from aiohttp import web
from aiohttp.test_utils import make_mocked_request

import server

TOKEN = "test-only-credential"
EXTENSION = "chrome-extension://" + "a" * 32
HOST = {"Host": "127.0.0.1:18765"}
AUTH = {"Authorization": "Bearer " + TOKEN, "Content-Type": "application/json"}


def word_chunk(text, offset=0, duration=2_500_000):
    return {"type": "WordBoundary", "text": text, "offset": offset, "duration": duration}


def fake_communicate(chunks, *, instances=None, closed=None):
    class FakeCommunicate:
        def __init__(self, *args, **kwargs):
            self.args, self.kwargs = args, kwargs
            if instances is not None:
                instances.append(self)

        async def stream(self):
            try:
                for chunk in chunks:
                    yield chunk
            finally:
                if closed is not None:
                    closed.append(True)
    return FakeCommunicate


class BoundaryTests(unittest.TestCase):
    def test_entities_chinese_emoji_and_utf16_exclusive_offsets(self):
        text = "😀你好 & <甲> 😀你好"
        words = ["😀", "你好", "&amp;", "&lt;甲&gt;", "😀", "你好"]
        chunks = [word_chunk(word, 12_345_678 + i * 30_000_000) for i, word in enumerate(words)]
        boundaries, skipped = server.convert_boundaries(text, chunks)
        self.assertEqual(skipped, 0)
        self.assertEqual([(b["startChar"], b["endChar"], b["text"]) for b in boundaries], [
            (0, 2, "😀"), (2, 4, "你好"), (5, 6, "&"), (7, 10, "<甲>"),
            (11, 13, "😀"), (13, 15, "你好"),
        ])
        self.assertEqual([b["start"] for b in boundaries], [chunk["offset"] / 10_000_000 for chunk in chunks])
        self.assertEqual([b["duration"] for b in boundaries], [0.25] * len(words))
        # Decode JavaScript's UTF-16 slices independently from Python codepoints.
        encoded = text.encode("utf-16-le")
        for boundary in boundaries:
            self.assertEqual(encoded[boundary["startChar"] * 2:boundary["endChar"] * 2].decode("utf-16-le"), boundary["text"])

    def test_normalized_whitespace_uses_first_phrase_before_later_exact_match(self):
        text = "one \t\r\ntwo / one two / one\u00a0two"
        boundaries, skipped = server.convert_boundaries(text, [word_chunk("one two") for _ in range(3)])
        self.assertEqual(skipped, 0)
        self.assertEqual([b["text"] for b in boundaries], ["one \t\r\ntwo", "one two", "one\u00a0two"])
        self.assertEqual([b["startChar"] for b in boundaries], [0, 13, 23])
        # Metadata whitespace can also differ from the literal source spelling.
        boundaries, skipped = server.convert_boundaries("a b", [word_chunk("a\n\tb")])
        self.assertEqual(skipped, 0)
        self.assertEqual(boundaries[0]["text"], "a b")

    def test_missing_words_do_not_guess_or_rewind_repeated_words(self):
        chunks = [word_chunk(word) for word in ("red", "absent", "red", "red", "blue", "red")]
        boundaries, skipped = server.convert_boundaries("red red blue", chunks)
        self.assertEqual(skipped, 3)
        self.assertEqual([(b["startChar"], b["text"]) for b in boundaries], [(0, "red"), (4, "red"), (8, "blue")])
        boundaries, skipped = server.convert_boundaries("Café", [word_chunk("Cafe")])
        self.assertEqual((boundaries, skipped), ([], 1))

    def test_invalid_metadata_is_counted_and_later_valid_word_is_preserved(self):
        chunks = [word_chunk(""), word_chunk(None), word_chunk("ok", -1), word_chunk("ok", float("nan")),
                  word_chunk("ok", duration=float("inf")), word_chunk("ok", True), {"text": "ok"}, word_chunk("ok")]
        boundaries, skipped = server.convert_boundaries("ok", chunks)
        self.assertEqual(skipped, 7)
        self.assertEqual([b["text"] for b in boundaries], ["ok"])


class BridgeTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.app = server.create_app()
        self.app.freeze()
        # Mock config reads; never create or inspect a real config.json.
        self.config_read = patch.object(Path, "read_text", return_value=json.dumps({"token": TOKEN}))
        self.config_read.start()
        self.addCleanup(self.config_read.stop)

    async def request(self, method="POST", path="/api/tts", *, headers=None, payload=None, json_error=None):
        request = make_mocked_request(method, path, headers={**HOST, **(headers or {})}, app=self.app)
        request.json = AsyncMock(return_value={"text": "你好，世界。"} if payload is None else payload)
        if json_error is not None:
            request.json.side_effect = json_error
        match = await self.app.router.resolve(request)
        return await server.security(request, match.handler)

    def body(self, response):
        return json.loads(response.body)

    def assert_error(self, response, status):
        self.assertEqual(response.status, status)
        self.assertEqual(set(self.body(response)), {"error"})
        self.assertIsInstance(self.body(response)["error"], str)
        self.assertNotIn(TOKEN, response.text)
        self.assertNotIn("Access-Control-Allow-Credentials", response.headers)

    async def test_health_is_public_and_has_no_sensitive_data(self):
        response = await self.request("GET", "/health")
        self.assertEqual(self.body(response), {"ok": True, "voice": "zh-CN-" + "XiaoxiaoNeural"})
        self.assertNotIn(TOKEN, response.text)

    async def test_reader_is_served_from_fixed_file(self):
        response = await self.request("GET", "/")
        self.assertIsInstance(response, web.FileResponse)
        self.assertEqual(response._path, server.BASE_DIR / "reader.html")

    async def test_config_no_origin_and_local_origin_only(self):
        for origin in (None, server.LOCAL_ORIGIN):
            headers = {} if origin is None else {"Origin": origin}
            response = await self.request("GET", "/api/config", headers=headers)
            self.assertEqual(response.status, 200)
            self.assertEqual(self.body(response)["token"], TOKEN)
            self.assertEqual(response.headers["Cache-Control"], "no-store")
        for origin in (EXTENSION, "https://evil.example", "null", "http://localhost:18765", server.LOCAL_ORIGIN + ".evil.example"):
            with self.subTest(origin=origin):
                response = await self.request("GET", "/api/config", headers={"Origin": origin})
                self.assert_error(response, 403)
                self.assertNotIn("Access-Control-Allow-Origin", response.headers)
        self.assert_error(await self.request("GET", "/api/config", headers={"Host": "evil.example:18765"}), 403)

    async def test_config_missing_invalid_or_empty(self):
        for side_effect, result in ((FileNotFoundError(), None), (None, "not json"), (None, "[]"), (None, '{"token":""}'), (None, '{"token":123}'), (None, '{"token":"\\ud800"}')):
            with patch.object(Path, "read_text", side_effect=side_effect, return_value=result):
                self.assert_error(await self.request("GET", "/api/config"), 503)
                self.assert_error(await self.request(headers=AUTH), 503)

    async def test_auth_rejects_missing_wrong_query_and_non_ascii(self):
        for headers, path in (({}, "/api/tts"), ({"Authorization": "Bearer wrong"}, "/api/tts"), ({"Authorization": "Basic " + TOKEN}, "/api/tts"), ({"X-Reader-Token": "无效"}, "/api/tts"), ({}, "/api/tts?token=" + TOKEN)):
            with self.subTest(headers=list(headers), path=path.split("?")[0]):
                self.assert_error(await self.request(headers=headers, path=path), 401)

    async def test_both_auth_headers_and_default_settings(self):
        for headers in (AUTH, {"X-Reader-Token": TOKEN, "Content-Type": "application/json"}, {**AUTH, "Authorization": "bearer " + TOKEN}):
            with patch.object(server, "synthesize", new_callable=AsyncMock, return_value=b"ID3offline") as synth:
                response = await self.request(headers=headers)
                self.assertEqual(response.status, 200)
                self.assertEqual(response.content_type, "audio/mpeg")
                self.assertEqual(response.body, b"ID3offline")
                synth.assert_awaited_once_with("你好，世界。", server.DEFAULT_VOICE, "+0%")

    async def test_content_type_and_malformed_json(self):
        for content_type in ("text/plain", "text/json", "application/x-www-form-urlencoded"):
            self.assert_error(await self.request(headers={**AUTH, "Content-Type": content_type}), 415)
        self.assert_error(await self.request(headers=AUTH, json_error=ValueError("bad JSON")), 400)
        self.assert_error(await self.request(headers=AUTH, json_error=UnicodeError("bad encoding")), 400)
        with patch.object(server, "synthesize", new_callable=AsyncMock, return_value=b"audio"):
            self.assertEqual((await self.request(headers={**AUTH, "Content-Type": "application/json; charset=utf-8"})).status, 200)

    async def test_input_validation_does_not_call_upstream(self):
        invalid = [[], "text", {}, {"text": ""}, {"text": " \n\t"}, {"text": 1}, {"text": "好" * 4001}, {"text": "ok", "voice": "en-US-AriaNeural"}, {"text": "ok", "voice": []}]
        invalid += [{"text": "ok", "rate": value} for value in ("-51%", "+101%", "1.5%", "fast", "+1000%", "１%", 0, None, [], True)]
        with patch.object(server, "synthesize", new_callable=AsyncMock) as synth:
            for payload in invalid:
                with self.subTest(payload_type=type(payload).__name__):
                    self.assert_error(await self.request(headers=AUTH, payload=payload), 400)
            synth.assert_not_awaited()

    async def test_text_and_rate_boundaries_and_alternate_voice(self):
        for rate, expected in (("-50%", "-50%"), ("+100%", "+100%"), ("0%", "+0%")):
            with patch.object(server, "synthesize", new_callable=AsyncMock, return_value=b"mp3") as synth:
                text = "好" * 4000
                response = await self.request(headers=AUTH, payload={"text": text, "voice": "zh-CN-YunxiNeural", "rate": rate})
                self.assertEqual(response.status, 200)
                synth.assert_awaited_once_with(text, "zh-CN-YunxiNeural", expected)

    async def test_body_too_large_is_json_413(self):
        exc = web.HTTPRequestEntityTooLarge(max_size=server.MAX_BODY, actual_size=server.MAX_BODY + 1)
        self.assert_error(await self.request(headers=AUTH, json_error=exc), 413)

    async def test_cors_allowed_origins_and_preflight(self):
        for origin in (EXTENSION, server.LOCAL_ORIGIN):
            response = await self.request("OPTIONS", headers={"Origin": origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, content-type, x-reader-token"})
            self.assertEqual(response.status, 204)
            self.assertEqual(response.headers["Access-Control-Allow-Origin"], origin)
            self.assertNotIn("Access-Control-Allow-Credentials", response.headers)
            self.assertEqual(response.headers["Vary"], "Origin")
            self.assertIn("Authorization", response.headers["Access-Control-Allow-Headers"])
            with patch.object(server, "synthesize", new_callable=AsyncMock, return_value=b"mp3"):
                post = await self.request(headers={**AUTH, "Origin": origin})
                self.assertEqual(post.headers["Access-Control-Allow-Origin"], origin)
        unauthenticated = await self.request(headers={"Origin": EXTENSION})
        self.assert_error(unauthenticated, 401)
        self.assertEqual(unauthenticated.headers["Access-Control-Allow-Origin"], EXTENSION)

    async def test_cors_rejects_external_spoofed_and_opaque_origins(self):
        origins = ["https://evil.example", "null", "file://", "chrome-extension://" + "a" * 32 + ".evil.example", EXTENSION + "/", "http://127.0.0.1:18766", "http://127.0.0.1:18765.evil.example"]
        with patch.object(server, "synthesize", new_callable=AsyncMock) as synth:
            for origin in origins:
                for method in ("POST", "OPTIONS"):
                    response = await self.request(method, headers={**AUTH, "Origin": origin})
                    self.assert_error(response, 403)
                    self.assertNotIn("Access-Control-Allow-Origin", response.headers)
            synth.assert_not_awaited()
        self.assert_error(await self.request("OPTIONS", headers={"Origin": EXTENSION, "Access-Control-Request-Headers": "X-Evil"}), 403)
        self.assert_error(await self.request("OPTIONS", headers={"Origin": EXTENSION, "Access-Control-Request-Method": "DELETE"}), 405)

    async def test_upstream_errors_timeout_and_details_are_hidden(self):
        for exc in (RuntimeError("upstream secret " + TOKEN), TimeoutError(), ValueError("private detail " + TOKEN)):
            with patch.object(server, "synthesize", new_callable=AsyncMock, side_effect=exc):
                response = await self.request(headers=AUTH)
                self.assert_error(response, 502)
                self.assertNotIn("private detail", response.text)
        async def slow(*args):
            await asyncio.Event().wait()
        with patch.object(server, "synthesize", slow), patch.object(server, "REQUEST_TIMEOUT", 0.01):
            response = await self.request(headers=AUTH)
            self.assert_error(response, 502)
            self.assertIn("超时", self.body(response)["error"])

    async def test_audio_chunks_metadata_new_instances_and_timeouts(self):
        class FakeCommunicate:
            def __init__(self, *args, **kwargs):
                self.kwargs = kwargs
            async def stream(self):
                yield {"type": "SentenceBoundary", "text": "metadata"}
                yield {"type": "audio", "data": b"ID3"}
                yield {"type": "audio", "data": b"audio"}
        instances = []
        def factory(*args, **kwargs):
            item = FakeCommunicate(*args, **kwargs)
            instances.append(item)
            return item
        with patch.object(server.edge_tts, "Communicate", side_effect=factory):
            for _ in range(2):
                self.assertEqual(await server.synthesize("hello", server.DEFAULT_VOICE, "+0%"), b"ID3audio")
        self.assertEqual(len(instances), 2)
        for item in instances:
            self.assertEqual(item.kwargs["connect_timeout"], 15)
            self.assertEqual(item.kwargs["receive_timeout"], 45)
            self.assertEqual(item.session_timeout.connect, 15)
            self.assertEqual(item.session_timeout.total, 45)

    async def test_empty_audio_and_output_size_limit(self):
        for chunks, expected in (([], 502), ([b"a" * 3, b"b" * 3], 502), ([b"a" * 3, b"b" * 2], 200)):
            closed = []
            class FakeCommunicate:
                def __init__(self, *args, **kwargs):
                    pass
                async def stream(self):
                    try:
                        for chunk in chunks:
                            yield {"type": "audio", "data": chunk}
                    finally:
                        closed.append(True)
            with patch.object(server.edge_tts, "Communicate", FakeCommunicate), patch.object(server, "MAX_AUDIO", 5):
                response = await self.request(headers=AUTH)
                if expected == 502:
                    self.assert_error(response, 502)
                else:
                    self.assertEqual(response.status, 200)
                    self.assertEqual(len(response.body), 5)
                self.assertEqual(closed, [True])

    async def test_speech_real_chunk_shape_base64_and_old_tts_regression(self):
        text = "😀你好 & 你好"
        chunks = [
            {"type": "audio", "data": b"ID3"},
            {"type": "SentenceBoundary", "text": "ignored"},
            word_chunk("你好", 12_345_678),
            word_chunk("&amp;", 45_000_000, 1_000_000),
            word_chunk("not in source", 50_000_000),
            {"type": "audio", "data": b"offline"},
            # Already cumulative offset from a subsequent Edge SSML segment.
            word_chunk("你好", 81_000_000, 3_000_000),
        ]
        instances, closed = [], []
        with patch.object(server.edge_tts, "Communicate", fake_communicate(chunks, instances=instances, closed=closed)):
            response = await self.request(path="/api/speech", headers={**AUTH, "Origin": EXTENSION}, payload={"text": text})
            self.assertEqual(response.status, 200)
            self.assertEqual(response.content_type, "application/json")
            self.assertEqual(response.headers["Access-Control-Allow-Origin"], EXTENSION)
            self.assertEqual(response.headers["Cache-Control"], "no-store")
            result = self.body(response)
            self.assertEqual(base64.b64decode(result["audio"], validate=True), b"ID3offline")
            self.assertEqual(result["mime"], "audio/mpeg")
            self.assertEqual(result["warning"], {"skippedBoundaries": 1})
            self.assertEqual(result["boundaries"], [
                {"start": 1.2345678, "duration": 0.25, "startChar": 2, "endChar": 4, "text": "你好"},
                {"start": 4.5, "duration": 0.1, "startChar": 5, "endChar": 6, "text": "&"},
                {"start": 8.1, "duration": 0.3, "startChar": 7, "endChar": 9, "text": "你好"},
            ])
            legacy = await self.request(headers=AUTH, payload={"text": text})
            self.assertEqual(legacy.status, 200)
            self.assertEqual(legacy.content_type, "audio/mpeg")
            self.assertEqual(legacy.body, b"ID3offline")
            self.assertEqual(legacy.headers["Content-Disposition"], 'inline; filename="reader.mp3"')
        self.assertEqual(len(instances), 2)
        self.assertEqual(closed, [True, True])
        for instance in instances:
            self.assertEqual(instance.kwargs["boundary"], "WordBoundary")
            self.assertEqual(instance.kwargs["connect_timeout"], 15)
            self.assertEqual(instance.kwargs["receive_timeout"], 45)
            self.assertEqual(instance.session_timeout.total, 45)

    async def test_speech_auth_validation_and_cors_share_existing_contract(self):
        path = "/api/speech"
        with patch.object(server, "synthesize_speech", new_callable=AsyncMock) as synth:
            for headers in ({}, {**AUTH, "Authorization": "Bearer wrong"}, {"X-Reader-Token": "无效"}):
                self.assert_error(await self.request(path=path, headers=headers), 401)
            self.assert_error(await self.request(path=path + "?token=" + TOKEN), 401)
            self.assert_error(await self.request(path=path, headers={**AUTH, "Content-Type": "text/plain"}), 415)
            for payload in ([], {"text": ""}, {"text": "好" * 4001}, {"text": "ok", "rate": "+101%"}, {"text": "ok", "voice": "en-US-AriaNeural"}):
                self.assert_error(await self.request(path=path, headers=AUTH, payload=payload), 400)
            self.assert_error(await self.request(path=path, headers=AUTH, json_error=ValueError("bad json")), 400)
            oversized = web.HTTPRequestEntityTooLarge(max_size=server.MAX_BODY, actual_size=server.MAX_BODY + 1)
            self.assert_error(await self.request(path=path, headers=AUTH, json_error=oversized), 413)
            for method in ("POST", "OPTIONS"):
                response = await self.request(method, path, headers={**AUTH, "Origin": "https://evil.example"})
                self.assert_error(response, 403)
                self.assertNotIn("Access-Control-Allow-Origin", response.headers)
            with patch.object(Path, "read_text", side_effect=FileNotFoundError()):
                self.assert_error(await self.request(path=path, headers=AUTH), 503)
            synth.assert_not_awaited()
        for origin in (EXTENSION, server.LOCAL_ORIGIN):
            response = await self.request("OPTIONS", path, headers={"Origin": origin, "Access-Control-Request-Method": "POST", "Access-Control-Request-Headers": "authorization, content-type, x-reader-token"})
            self.assertEqual(response.status, 204)
            self.assertEqual(response.headers["Access-Control-Allow-Origin"], origin)
            self.assertIn("X-Reader-Token", response.headers["Access-Control-Allow-Headers"])
        self.assert_error(await self.request("OPTIONS", path, headers={"Access-Control-Request-Headers": "X-Evil"}), 403)
        self.assert_error(await self.request("OPTIONS", path, headers={"Access-Control-Request-Method": "DELETE"}), 405)
        self.assert_error(await self.request("GET", path), 405)

    async def test_speech_both_auth_headers_defaults_and_empty_metadata(self):
        chunks = [{"type": "audio", "data": b"mp3"}]
        for headers in (AUTH, {"X-Reader-Token": TOKEN, "Content-Type": "application/json"}):
            instances = []
            with patch.object(server.edge_tts, "Communicate", fake_communicate(chunks, instances=instances)):
                response = await self.request(path="/api/speech", headers=headers, payload={"text": "你好", "rate": "0%"})
            self.assertEqual(self.body(response), {"audio": "bXAz", "mime": "audio/mpeg", "boundaries": [], "warning": {"skippedBoundaries": 0}})
            self.assertEqual(instances[0].args, ("你好", server.DEFAULT_VOICE))
            self.assertEqual(instances[0].kwargs["rate"], "+0%")

    async def test_speech_audio_limit_stream_cleanup_and_upstream_failure(self):
        for data, status in (([], 502), ([b"aaa", b"bbb"], 502), ([b"aaa", b"bb"], 200)):
            chunks = [{"type": "audio", "data": chunk} for chunk in data]
            closed = []
            with patch.object(server.edge_tts, "Communicate", fake_communicate(chunks, closed=closed)), patch.object(server, "MAX_AUDIO", 5):
                response = await self.request(path="/api/speech", headers=AUTH)
            self.assertEqual(closed, [True])
            if status == 502:
                self.assert_error(response, status)
            else:
                self.assertEqual(len(base64.b64decode(self.body(response)["audio"])), 5)
        for exc in (TimeoutError(), RuntimeError("private detail " + TOKEN), ValueError("private detail " + TOKEN)):
            with patch.object(server, "synthesize_speech", new_callable=AsyncMock, side_effect=exc):
                response = await self.request(path="/api/speech", headers=AUTH)
            self.assert_error(response, 502)
            self.assertNotIn("private detail", response.text)

    async def test_speech_request_and_outer_timeouts_cancel_and_close_stream(self):
        closed = []
        class SlowCommunicate:
            def __init__(self, *args, **kwargs):
                pass
            async def stream(self):
                try:
                    yield {"type": "audio", "data": b"mp3"}
                    await asyncio.Event().wait()
                finally:
                    closed.append(True)
        for request_timeout, outer_timeout in ((0.01, 1), (1, 0.01)):
            with patch.object(server.edge_tts, "Communicate", SlowCommunicate), patch.object(server, "REQUEST_TIMEOUT", request_timeout), patch.object(server, "OUTER_TIMEOUT", outer_timeout):
                response = await self.request(path="/api/speech", headers=AUTH)
            self.assert_error(response, 502)
            self.assertIn("超时", self.body(response)["error"])
        self.assertEqual(closed, [True, True])

    async def test_demo_fixed_path_missing_and_available(self):
        with patch.object(Path, "is_file", return_value=False):
            self.assert_error(await self.request("GET", "/demo.mp3"), 404)
        with patch.object(Path, "is_file", return_value=True):
            response = await self.request("GET", "/demo.mp3")
            self.assertIsInstance(response, web.FileResponse)
            self.assertEqual(response._path, server.BASE_DIR / "sample-xiaoxiao.mp3")
            self.assertEqual(response.content_type, "audio/mpeg")

    async def test_unknown_route_and_wrong_method_are_json(self):
        self.assert_error(await self.request("GET", "/missing"), 404)
        self.assert_error(await self.request("GET", "/api/tts"), 405)


if __name__ == "__main__":
    unittest.main(verbosity=2)
