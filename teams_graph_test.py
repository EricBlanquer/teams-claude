import asyncio
import contextlib
import http
import io
import json
import tempfile
import threading
import unittest
from pathlib import Path
from unittest import mock

import websockets

import teams_graph


PAGE_PATH = "/devtools/page/teams"


class FakeDevTools:
    def __init__(self, targets, answer):
        self.targets = targets
        self.answer = answer
        self.expressions = []
        self.ready = threading.Event()
        self.loop = asyncio.new_event_loop()
        self.thread = threading.Thread(target=self.loop.run_forever, daemon=True)

    async def handle(self, websocket, path):
        request = json.loads(await websocket.recv())
        self.expressions.append(request["params"]["expression"])
        await websocket.send(json.dumps({"method": "Runtime.consoleAPICalled", "params": {}}))
        await websocket.send(json.dumps({"id": request["id"], "result": self.answer}))

    async def list_targets(self, path, headers):
        if path == "/json/list":
            body = json.dumps([
                {**target, "webSocketDebuggerUrl": target["webSocketDebuggerUrl"].replace("PORT", str(self.port))}
                for target in self.targets
            ]).encode()
            return http.HTTPStatus.OK, [("Content-Type", "application/json"), ("Content-Length", str(len(body)))], body
        return None

    async def start(self):
        return await websockets.serve(self.handle, "127.0.0.1", 0, process_request=self.list_targets)

    def __enter__(self):
        self.thread.start()
        self.server = asyncio.run_coroutine_threadsafe(self.start(), self.loop).result(5)
        self.port = self.server.sockets[0].getsockname()[1]
        return self

    def __exit__(self, *exc):
        self.server.close()
        asyncio.run_coroutine_threadsafe(self.server.wait_closed(), self.loop).result(5)
        self.loop.call_soon_threadsafe(self.loop.stop)
        self.thread.join(5)
        self.loop.close()

    @property
    def url(self):
        return f"http://127.0.0.1:{self.port}"


def page_target(url="https://teams.cloud.microsoft/", target_type="page"):
    return {"type": target_type, "url": url, "webSocketDebuggerUrl": f"ws://127.0.0.1:PORT{PAGE_PATH}"}


def value_answer(value):
    return {"result": {"type": "object", "value": value}}


class TeamsPageTest(unittest.TestCase):
    def test_selects_the_single_teams_page(self):
        targets = [
            page_target("file:///app/incomingCallToast.html"),
            page_target("https://teams.cloud.microsoft/v2/worker/web-worker.js", "worker"),
            page_target("https://outlook.office.com/hosted/calendar", "iframe"),
            {**page_target("https://teams.cloud.microsoft/"), "webSocketDebuggerUrl": "ws://teams"},
        ]
        self.assertEqual(teams_graph.teams_page(targets), "ws://teams")

    def test_rejects_missing_or_ambiguous_pages(self):
        with self.assertRaisesRegex(teams_graph.TeamsGraphError, "found 0"):
            teams_graph.teams_page([page_target("https://teams.cloud.microsoft.evil.example/")])
        with self.assertRaisesRegex(teams_graph.TeamsGraphError, "found 2"):
            teams_graph.teams_page([page_target(), page_target("https://teams.microsoft.com/v2/")])


class MessageHtmlTest(unittest.TestCase):
    def test_keeps_html_unchanged(self):
        self.assertEqual(teams_graph.message_html("<b>a</b>\n<i>b</i>\n", False), "<b>a</b>\n<i>b</i>\n")

    def test_escapes_plain_text_and_keeps_line_breaks(self):
        self.assertEqual(
            teams_graph.message_html('a <id> & "b"\r\nsecond\n\n', True),
            'a &lt;id&gt; &amp; "b"<br>second',
        )

    def test_rejects_empty_messages(self):
        for content, plain_text in (("", False), (" \n", False), ("\n\n", True)):
            with self.assertRaisesRegex(teams_graph.TeamsGraphError, "empty"):
                teams_graph.message_html(content, plain_text)


class RunTest(unittest.TestCase):
    def test_evaluates_the_page_script_with_the_request(self):
        result = {"kind": "chat", "messageId": "1"}
        with FakeDevTools([page_target()], value_answer({"ok": True, "result": result})) as devtools:
            request = {"action": "send", "conversationId": "19:a@thread.v2", "teamId": None, "html": "<b>é</b>"}
            self.assertEqual(teams_graph.run(request, devtools.url), result)
        script = teams_graph.PAGE_SCRIPT.read_text(encoding="utf-8").strip()
        self.assertEqual(devtools.expressions, [f"({script})({json.dumps(request)})"])

    def test_reports_page_errors(self):
        with FakeDevTools([page_target()], value_answer({"ok": False, "error": "Graph failed"})) as devtools:
            with self.assertRaisesRegex(teams_graph.TeamsGraphError, "^Graph failed$"):
                teams_graph.run({"action": "current"}, devtools.url)

    def test_reports_script_exceptions(self):
        answer = {"result": {"type": "object"}, "exceptionDetails": {"exception": {"description": "SyntaxError: boom"}}}
        with FakeDevTools([page_target()], answer) as devtools:
            with self.assertRaisesRegex(teams_graph.TeamsGraphError, "SyntaxError: boom"):
                teams_graph.run({"action": "current"}, devtools.url)

    def test_reports_an_unreachable_endpoint(self):
        with FakeDevTools([], {}) as devtools:
            url = devtools.url
        with self.assertRaisesRegex(teams_graph.TeamsGraphError, "endpoint at .* failed"):
            teams_graph.run({"action": "current"}, url)


class MainTest(unittest.TestCase):
    def run_main(self, argv, stdin="", answer=None):
        stdout, stderr = io.StringIO(), io.StringIO()
        fake_stdin = io.StringIO(stdin)
        fake_stdin.isatty = lambda: False
        with mock.patch.object(teams_graph, "run", return_value=answer) as run, \
                mock.patch("sys.stdin", fake_stdin), \
                contextlib.redirect_stdout(stdout), contextlib.redirect_stderr(stderr):
            code = teams_graph.main(argv)
        return code, stdout.getvalue(), stderr.getvalue(), run

    def test_sends_stdin_as_html(self):
        code, stdout, _, run = self.run_main(["send", "19:a@thread.v2"], "<b>é</b>", {"messageId": "1"})
        self.assertEqual(code, 0)
        run.assert_called_once_with({"action": "send", "conversationId": "19:a@thread.v2", "teamId": None, "html": "<b>é</b>"})
        self.assertEqual(json.loads(stdout), {"messageId": "1"})

    def test_sends_a_plain_text_file_to_a_channel_team(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "message.txt"
        path.write_text("x < y\n", encoding="utf-8")
        code, _, _, run = self.run_main(["send", "19:c@thread.tacv2", "--team", "t", "--file", str(path), "--text"], answer={})
        self.assertEqual(code, 0)
        run.assert_called_once_with({"action": "send", "conversationId": "19:c@thread.tacv2", "teamId": "t", "html": "x &lt; y"})

    def test_prints_the_displayed_conversation(self):
        code, stdout, _, run = self.run_main(["current"], answer={"title": "Alice"})
        self.assertEqual(code, 0)
        run.assert_called_once_with({"action": "current"})
        self.assertEqual(json.loads(stdout), {"title": "Alice"})

    def test_fails_without_calling_teams_for_an_empty_message(self):
        code, stdout, stderr, run = self.run_main(["send", "19:a@thread.v2"], "  ")
        self.assertEqual((code, stdout), (1, ""))
        self.assertEqual(stderr, "teams_graph: The message is empty\n")
        run.assert_not_called()

    def test_reports_a_missing_file(self):
        code, _, stderr, run = self.run_main(["send", "19:a@thread.v2", "--file", "/nonexistent/message.html"])
        self.assertEqual(code, 1)
        self.assertIn("/nonexistent/message.html", stderr)
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
