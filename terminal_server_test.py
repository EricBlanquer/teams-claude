import asyncio
import hashlib
import json
import os
import socket
import subprocess
import sys
import time
import unittest
import urllib.request
from pathlib import Path

import websockets


SERVER = Path(__file__).with_name("terminal_server.py")
ORIGIN = "https://teams.cloud.microsoft"


def start_server():
    with socket.socket() as reserved:
        reserved.bind(("127.0.0.1", 0))
        port = reserved.getsockname()[1]
    process = subprocess.Popen(
        [sys.executable, str(SERVER), "--port", str(port)],
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        env={**os.environ, "NO_COLOR": "1"},
    )
    for _ in range(50):
        try:
            with urllib.request.urlopen(f"http://127.0.0.1:{port}/health", timeout=0.2) as response:
                if response.read() == b"ready " + hashlib.sha256(SERVER.read_bytes()).hexdigest().encode() + b"\n":
                    return process, port
        except OSError:
            if process.poll() is not None:
                raise RuntimeError(process.stderr.read().decode())
            time.sleep(0.05)
    process.kill()
    process.wait(timeout=5)
    raise RuntimeError("Terminal server did not start")


class TerminalServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.process, cls.port = start_server()

    @classmethod
    def tearDownClass(cls):
        cls.process.terminate()
        cls.process.communicate(timeout=5)

    def test_input_output_and_resize(self):
        async def exercise():
            uri = f"ws://127.0.0.1:{self.port}/shell"
            async with websockets.connect(uri, origin=ORIGIN) as websocket:
                await websocket.send(json.dumps({"type": "resize", "cols": 80, "rows": 24}))
                await websocket.send(json.dumps({
                    "type": "init", "projectPath": str(SERVER.parent),
                    "cols": 80, "rows": 24,
                    "initialCommand": "stty size; IFS= read -r line; stty size; printf 'RESULT:%s\\n' \"$line\"",
                }))
                first = ""
                while "24 80" not in first:
                    first += json.loads(await asyncio.wait_for(websocket.recv(), 5))["data"]
                await websocket.send(json.dumps({"type": "resize", "cols": 100, "rows": 40}))
                await websocket.send(json.dumps({"type": "input", "data": "hello\n"}))
                output = ""
                while "RESULT:hello" not in output:
                    output += json.loads(await asyncio.wait_for(websocket.recv(), 5))["data"]
                self.assertIn("40 100", output)
        asyncio.run(exercise())

    def test_websocket_origin_and_endpoint_are_restricted(self):
        async def exercise():
            uri = f"ws://127.0.0.1:{self.port}/shell"
            with self.assertRaises(websockets.exceptions.InvalidStatusCode):
                async with websockets.connect(uri):
                    pass
            with self.assertRaises(websockets.exceptions.InvalidStatusCode):
                async with websockets.connect(uri, origin="https://example.com"):
                    pass
            async with websockets.connect(f"ws://127.0.0.1:{self.port}/other", origin=ORIGIN) as websocket:
                with self.assertRaises(websockets.exceptions.ConnectionClosedError) as closed:
                    await websocket.recv()
                self.assertEqual(1008, closed.exception.code)
        asyncio.run(exercise())

    def test_invalid_initialization_is_rejected(self):
        async def exercise():
            async with websockets.connect(f"ws://127.0.0.1:{self.port}/shell", origin=ORIGIN) as websocket:
                await websocket.send(json.dumps({
                    "type": "init", "projectPath": str(SERVER.parent),
                    "cols": 0, "rows": 24, "initialCommand": "echo invalid",
                }))
                with self.assertRaises(websockets.exceptions.ConnectionClosedError) as closed:
                    await websocket.recv()
                self.assertEqual(1008, closed.exception.code)
        asyncio.run(exercise())

    def test_child_terminal_has_color_environment(self):
        async def exercise():
            async with websockets.connect(f"ws://127.0.0.1:{self.port}/shell", origin=ORIGIN) as websocket:
                await websocket.send(json.dumps({
                    "type": "init", "projectPath": str(SERVER.parent),
                    "cols": 80, "rows": 24,
                    "initialCommand": "printf 'COLOR:%s:%s:%s\\n' \"${NO_COLOR-unset}\" \"$TERM\" \"$COLORTERM\"",
                }))
                output = ""
                while "COLOR:unset:xterm-256color:truecolor" not in output:
                    output += json.loads(await asyncio.wait_for(websocket.recv(), 5))["data"]
                self.assertIn("COLOR:unset:xterm-256color:truecolor", output)
        asyncio.run(exercise())

    def test_shutdown_reaps_active_terminal(self):
        process, port = start_server()
        try:
            async def exercise():
                async with websockets.connect(f"ws://127.0.0.1:{port}/shell", origin=ORIGIN) as websocket:
                    await websocket.send(json.dumps({
                        "type": "init", "projectPath": str(SERVER.parent),
                        "cols": 80, "rows": 24,
                        "initialCommand": "printf 'PID:%s\\n' \"$$\"; exec sleep 60",
                    }))
                    output = ""
                    while "\r\n" not in output:
                        output += json.loads(await asyncio.wait_for(websocket.recv(), 5))["data"]
                    child = int(output.split("PID:", 1)[1].split("\r\n", 1)[0])
                    process.terminate()
                    await asyncio.wait_for(websocket.wait_closed(), 5)
                    return child
            child = asyncio.run(exercise())
            process.wait(timeout=5)
            with self.assertRaises(ProcessLookupError):
                os.kill(child, 0)
        finally:
            if process.poll() is None:
                process.kill()
            process.communicate(timeout=5)


if __name__ == "__main__":
    unittest.main()
