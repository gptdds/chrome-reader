"""Offline Native Messaging tests; no processes, sockets or real configuration writes.

Run: .venv\\Scripts\\python.exe -B test_native_host.py
"""
from contextlib import ExitStack
import io
import json
from pathlib import Path
import struct
import sys
import unittest
from unittest.mock import Mock, mock_open, patch

sys.path.insert(0, str(Path(__file__).resolve().parent))
import native_host as host


def frame(value):
    payload = json.dumps(value, ensure_ascii=False).encode("utf-8")
    return struct.pack("<I", len(payload)) + payload


def decode_reply(data):
    size = struct.unpack("<I", data[:4])[0]
    assert len(data) == size + 4
    return json.loads(data[4:].decode("utf-8"))


class NativeProtocolTests(unittest.TestCase):
    def test_utf8_response_uses_byte_length(self):
        output = io.BytesIO()
        host.write_message(output, {"ok": False, "error": "启动失败"})
        self.assertEqual(decode_reply(output.getvalue()), {"ok": False, "error": "启动失败"})

    def test_read_handles_partial_pipe_reads(self):
        class Fragmented(io.BytesIO):
            def read(self, size=-1):
                return super().read(min(size, 2))
        self.assertEqual(host.read_message(Fragmented(frame({"action": "start"}))), {"action": "start"})

    def test_malformed_frames_are_bounded(self):
        frames = [b"", bytes([1]), struct.pack("<I", 0),
                  struct.pack("<I", host.MAX_MESSAGE_BYTES + 1),
                  struct.pack("<I", 3) + b"{}", struct.pack("<I", 1) + bytes([255]),
                  frame([]), frame("start")]
        for data in frames:
            with self.subTest(data=data), self.assertRaises(ValueError):
                host.read_message(io.BytesIO(data))

    def test_only_fixed_extension_origin_can_launch(self):
        origins = ["", "https://example.com", host.ALLOWED_ORIGIN + "evil", host.ALLOWED_ORIGIN.rstrip("/")]
        for origin in origins:
            with self.subTest(origin=origin), patch.object(host, "start_service") as start:
                output = io.BytesIO()
                host.serve(origin, io.BytesIO(frame({"action": "start"})), output)
                self.assertFalse(decode_reply(output.getvalue())["ok"])
                start.assert_not_called()

    def test_only_fixed_start_action_is_accepted(self):
        for message in ({}, {"action": "stop"}, {"action": "start", "command": "other.exe"}):
            with self.subTest(message=message), patch.object(host, "start_service") as start:
                self.assertFalse(host.handle_message(message)["ok"])
                start.assert_not_called()

    def test_valid_request_and_invalid_frame_return_one_reply(self):
        with patch.object(host, "start_service", return_value={"ok": True, "alreadyRunning": False}) as start:
            output = io.BytesIO()
            host.serve(host.ALLOWED_ORIGIN, io.BytesIO(frame({"action": "start"})), output)
            self.assertEqual(decode_reply(output.getvalue()), {"ok": True, "alreadyRunning": False})
            start.assert_called_once_with()
        output = io.BytesIO()
        host.serve(host.ALLOWED_ORIGIN, io.BytesIO(b""), output)
        self.assertFalse(decode_reply(output.getvalue())["ok"])

    def test_internal_error_does_not_expose_details(self):
        output = io.BytesIO()
        with patch.object(host, "start_service", side_effect=RuntimeError("private-details")):
            host.serve(host.ALLOWED_ORIGIN, io.BytesIO(frame({"action": "start"})), output)
        self.assertNotIn("private-details", output.getvalue().decode("utf-8", errors="ignore"))
        self.assertFalse(decode_reply(output.getvalue())["ok"])


class StartupTests(unittest.TestCase):
    def test_running_service_does_not_create_process(self):
        with patch.object(host, "service_is_ready", return_value=True), patch.object(host.subprocess, "Popen") as launch:
            self.assertEqual(host.start_service(), {"ok": True, "alreadyRunning": True})
            launch.assert_not_called()

    def windows_start(self, readiness, process=None, launch_errors=None):
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(host.os, "name", "nt"))
        for name, value in (("DETACHED_PROCESS", 8), ("CREATE_NEW_PROCESS_GROUP", 512), ("CREATE_BREAKAWAY_FROM_JOB", 16777216)):
            stack.enter_context(patch.object(host.subprocess, name, value, create=True))
        stack.enter_context(patch.object(Path, "is_file", return_value=True))
        stack.enter_context(patch.object(Path, "mkdir"))
        stack.enter_context(patch.object(Path, "open", mock_open()))
        stack.enter_context(patch.object(host, "service_is_ready", side_effect=readiness))
        stack.enter_context(patch.object(host.time, "monotonic", return_value=0))
        return stack.enter_context(patch.object(host.subprocess, "Popen", return_value=process or Mock(), side_effect=launch_errors))

    def test_start_uses_only_fixed_project_executable_and_script(self):
        launch = self.windows_start([False, True])
        self.assertEqual(host.start_service(), {"ok": True, "alreadyRunning": False})
        args, kwargs = launch.call_args
        self.assertEqual(args[0], [str(host.BASE_DIR / ".venv" / "Scripts" / "pythonw.exe"), str(host.BASE_DIR / "server.py")])
        self.assertEqual(kwargs["cwd"], str(host.BASE_DIR))
        self.assertEqual(kwargs["stdin"], host.subprocess.DEVNULL)
        self.assertTrue(kwargs["close_fds"])
        self.assertNotIn("shell", kwargs)
        self.assertEqual(kwargs["creationflags"], 8 | 512 | 16777216)

    def test_exited_process_returns_clear_failure(self):
        self.windows_start([False, False], Mock(poll=Mock(return_value=1)))
        result = host.start_service()
        self.assertFalse(result["ok"])
        self.assertIn("启动后退出", result["error"])

    def test_access_denied_does_not_claim_a_temporary_child_is_independent(self):
        denied = OSError("job does not permit breakaway")
        denied.winerror = 5
        launch = self.windows_start([False], launch_errors=denied)
        result = host.start_service()
        self.assertFalse(result["ok"])
        self.assertIn("独立后台服务", result["error"])
        self.assertEqual(launch.call_count, 1)

    def test_startup_deadline_returns_without_an_unbounded_wait(self):
        process = Mock(poll=Mock(return_value=None))
        launch = self.windows_start([False, False], process)
        with patch.object(host.time, "monotonic", side_effect=[0, 1, 9]), patch.object(host.time, "sleep") as sleep:
            result = host.start_service()
        self.assertFalse(result["ok"])
        self.assertIn("等待超时", result["error"])
        sleep.assert_called_once_with(0.15)
        launch.assert_called_once()

    def test_other_launch_errors_do_not_retry(self):
        failure = OSError("private-process-details")
        failure.winerror = 2
        launch = self.windows_start([False], launch_errors=failure)
        result = host.start_service()
        self.assertFalse(result["ok"])
        self.assertNotIn("private-process-details", result["error"])
        self.assertEqual(launch.call_count, 1)


if __name__ == "__main__":
    unittest.main(verbosity=2)
