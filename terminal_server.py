#!/usr/bin/env python3

import argparse
import asyncio
import codecs
import fcntl
import hashlib
import http
import json
import os
import pty
import signal
import struct
import termios
from pathlib import Path

import websockets


ORIGIN = "https://teams.cloud.microsoft"
MAX_MESSAGE_SIZE = 1024 * 1024
MAX_COMMAND_SIZE = 16384
HEALTH_RESPONSE = b"ready " + hashlib.sha256(Path(__file__).read_bytes()).hexdigest().encode() + b"\n"


def terminal_size(message):
    cols = message.get("cols")
    rows = message.get("rows")
    if type(cols) is not int or type(rows) is not int:
        raise ValueError("Invalid terminal size")
    if not 1 <= cols <= 1000 or not 1 <= rows <= 1000:
        raise ValueError("Invalid terminal size")
    return cols, rows


def resize_terminal(fd, cols, rows):
    fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", rows, cols, 0, 0))


async def write_terminal(fd, data):
    loop = asyncio.get_running_loop()
    remaining = memoryview(data)
    while remaining:
        try:
            written = os.write(fd, remaining)
            remaining = remaining[written:]
        except BlockingIOError:
            writable = loop.create_future()
            loop.add_writer(fd, writable.set_result, None)
            try:
                await writable
            finally:
                loop.remove_writer(fd)


async def relay_output(websocket, fd):
    loop = asyncio.get_running_loop()
    output = asyncio.Queue(maxsize=64)
    decoder = codecs.getincrementaldecoder("utf-8")("replace")
    paused = False

    def read_terminal():
        nonlocal paused
        try:
            data = os.read(fd, 16384)
        except BlockingIOError:
            return
        except OSError:
            data = b""
        if not data:
            loop.remove_reader(fd)
            output.put_nowait(None)
            return
        output.put_nowait(data)
        if output.full():
            loop.remove_reader(fd)
            paused = True

    loop.add_reader(fd, read_terminal)
    try:
        while True:
            data = await output.get()
            if data is None:
                tail = decoder.decode(b"", final=True)
                if tail:
                    await websocket.send(json.dumps({"type": "output", "data": tail}))
                return
            text = decoder.decode(data)
            if text:
                await websocket.send(json.dumps({"type": "output", "data": text}))
            if paused and output.qsize() < 32:
                loop.add_reader(fd, read_terminal)
                paused = False
    finally:
        loop.remove_reader(fd)


async def relay_input(websocket, fd):
    async for raw in websocket:
        try:
            message = json.loads(raw)
            if message.get("type") == "input":
                data = message.get("data")
                if not isinstance(data, str):
                    raise ValueError("Invalid input")
                await write_terminal(fd, data.encode("utf-8"))
            elif message.get("type") == "resize":
                resize_terminal(fd, *terminal_size(message))
            else:
                raise ValueError("Invalid message type")
        except (TypeError, ValueError, AttributeError):
            await websocket.close(code=1008, reason="Invalid terminal message")
            return


async def stop_terminal(pid):
    try:
        os.killpg(pid, signal.SIGTERM)
    except ProcessLookupError:
        pass
    for _ in range(20):
        try:
            reaped, _ = os.waitpid(pid, os.WNOHANG)
        except ChildProcessError:
            return
        if reaped:
            return
        await asyncio.sleep(0.05)
    try:
        os.killpg(pid, signal.SIGKILL)
    except ProcessLookupError:
        pass
    try:
        os.waitpid(pid, 0)
    except ChildProcessError:
        pass


async def handle_terminal(websocket, path):
    if path != "/shell":
        await websocket.close(code=1008, reason="Invalid endpoint")
        return
    try:
        deadline = asyncio.get_running_loop().time() + 10
        for _ in range(10):
            raw = await asyncio.wait_for(websocket.recv(), deadline - asyncio.get_running_loop().time())
            message = json.loads(raw)
            if message.get("type") == "init":
                break
            if message.get("type") != "resize":
                raise ValueError("Expected init")
            terminal_size(message)
        else:
            raise ValueError("Expected init")
        cols, rows = terminal_size(message)
        command = message.get("initialCommand")
        project_path = message.get("projectPath")
        if not isinstance(command, str) or not 0 < len(command) <= MAX_COMMAND_SIZE:
            raise ValueError("Invalid command")
        if not isinstance(project_path, str) or not os.path.isdir(project_path):
            raise ValueError("Invalid project path")
    except (asyncio.TimeoutError, TypeError, ValueError, AttributeError, websockets.ConnectionClosed):
        await websocket.close(code=1008, reason="Invalid terminal initialization")
        return
    pid, fd = pty.fork()
    if pid == 0:
        try:
            os.chdir(project_path)
            os.environ["TERM"] = "xterm-256color"
            os.environ["COLORTERM"] = "truecolor"
            os.environ.pop("NO_COLOR", None)
            os.execv("/bin/bash", ["bash", "-lc", command])
        except OSError:
            os._exit(127)
    os.set_blocking(fd, False)
    resize_terminal(fd, cols, rows)
    tasks = [asyncio.create_task(relay_output(websocket, fd)), asyncio.create_task(relay_input(websocket, fd))]
    try:
        done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        for task in pending:
            task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        for task in done:
            if task.exception() is not None:
                raise task.exception()
    finally:
        os.close(fd)
        await stop_terminal(pid)
        await websocket.close()


async def health(path, headers):
    if path == "/health":
        return http.HTTPStatus.OK, [("Content-Type", "text/plain"), ("Content-Length", str(len(HEALTH_RESPONSE)))], HEALTH_RESPONSE
    return None


async def main(port):
    stop = asyncio.Event()
    asyncio.get_running_loop().add_signal_handler(signal.SIGTERM, stop.set)
    async with websockets.serve(
        handle_terminal,
        "127.0.0.1",
        port,
        origins=[ORIGIN],
        process_request=health,
        max_size=MAX_MESSAGE_SIZE,
    ) as server:
        await stop.wait()
        await asyncio.gather(*(websocket.close(code=1001) for websocket in tuple(server.websockets)))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, default=3001)
    args = parser.parse_args()
    asyncio.run(main(args.port))
