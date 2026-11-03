import asyncio
import contextlib
import http
import io
import json
import tempfile
import threading
import unittest
from datetime import timedelta, timezone
from pathlib import Path
from unittest import mock

import websockets

import teams_graph


PAGE_PATH = "/devtools/page/teams"
PARIS_SUMMER = timezone(timedelta(hours=2))


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

    def test_accepts_the_html_subset_teams_renders(self):
        content = (
            '<h2>Titre</h2><p>a<br><b>b</b> <i>c</i> <s>d</s> <code>e</code> <a href="https://x.example/?a=1&amp;b=2">f</a> '
            '<a href="mailto:a@b.c">m</a> <span style="color:#e81123; font-weight:700;">g</span> '
            '<span style="background-color:rgb(229,241,143);color:rgb(30,83,163)">h</span></p>'
            '<table border="1" cellpadding="4"><tr><th colspan="2" style="text-align:left;padding:2px">A</th></tr></table>'
            '<ul><li>i</li></ul><ol><li>j</li></ol><pre>k</pre><blockquote>l</blockquote><hr>'
        )
        self.assertEqual(teams_graph.message_html(content, False), content)

    def test_rejects_html_that_could_preview_differently(self):
        content = (
            '<style>.x{display:none}</style><span class="x" style="display:none;color:red">a</span><img src="x">'
            '<a href="javascript:alert(1)">b</a><!-- c --><p hidden>d</p><span style="color:url(https://e.example)">e</span>'
            '<at id="0">Eric</at>'
        )
        with self.assertRaises(teams_graph.TeamsGraphError) as raised:
            teams_graph.message_html(content, False)
        self.assertEqual(str(raised.exception), "Unsupported HTML, the preview could differ from what Teams shows: " + ", ".join([
            "<style>", "class attribute on <span>", "style 'display' on <span>", "<img>", "link to 'javascript:alert(1)'",
            "HTML comment", "hidden attribute on <p>", "style value 'url(https://e.example)' on <span>", "<at>",
        ]))

    def test_rejects_documents_and_processing_instructions(self):
        for content in ("<!DOCTYPE html><p>a</p>", "<?xml version='1.0'?><p>a</p>"):
            with self.assertRaisesRegex(teams_graph.TeamsGraphError, "^Unsupported HTML"):
                teams_graph.message_html(content, False)

    def test_rejects_empty_messages(self):
        for content, plain_text in (("", False), (" \n", False), ("\n\n", True)):
            with self.assertRaisesRegex(teams_graph.TeamsGraphError, "empty"):
                teams_graph.message_html(content, plain_text)


class HtmlToTextTest(unittest.TestCase):
    def test_renders_teams_html_as_readable_text(self):
        content = (
            '<p>Bonjour <at id="0">Marie</at>,</p>\n<ul>\n<li>un</li><li>deux <b>gras</b><ul><li>sous</li></ul></li></ul>'
            '<ol><li>a</li><li>b</li></ol><table border="1">\n<tbody>\n<tr>\n<th>A</th>\n<th>B</th>\n</tr>\n'
            '<tr>\n<td>1</td>\n<td>2</td>\n</tr>\n</tbody>\n</table>'
            '<codeblock class="">x = 1\n  y = 2</codeblock><blockquote>citation</blockquote>'
            '<p>ligne   1<br>\nligne 2 &lt;id&gt; &amp; é</p>'
        )
        self.assertEqual(teams_graph.html_to_text(content), "\n".join([
            "Bonjour @Marie,", "", "- un", "- deux gras", "  - sous", "", "1. a", "2. b", "", "A | B", "1 | 2", "",
            "x = 1", "  y = 2", "", "> citation", "", "ligne 1", "ligne 2 <id> & é",
        ]))

    def test_keeps_plain_text_messages(self):
        self.assertEqual(teams_graph.html_to_text("a &lt; b<br>second"), "a < b\nsecond")

    def test_renders_teams_mentions_emojis_and_images(self):
        content = (
            '<p><span itemtype="http://schema.skype.com/Mention" itemscope="" itemid="0">Marie</span>'
            '<span itemtype="http://schema.skype.com/Mention" itemid="0"> Boudet</span> et '
            '<span itemtype="http://schema.skype.com/Mention" itemid="1">Paul</span>, '
            '<span title="Sourire"><img itemtype="http://schema.skype.com/Emoji" alt="🙂" src="x"></span>'
            '<img itemtype="http://schema.skype.com/Emoji" src="y"></p>'
            '<p><img itemtype="http://schema.skype.com/AMSImage" alt="image" src="z"></p>'
        )
        self.assertEqual(teams_graph.html_to_text(content), "@Marie Boudet et @Paul, 🙂\n\n[image]")

    def test_collects_the_sources_of_shown_images_only(self):
        content = (
            '<p><img itemtype="http://schema.skype.com/Emoji" alt="🙂" src="emoji"></p>'
            '<p><img itemtype="http://schema.skype.com/AMSImage" src="first"><img alt="no source"></p>'
        )
        renderer = teams_graph.rendered_html(content)
        self.assertEqual((renderer.text(), renderer.images), ("🙂\n\n[image][image]", ["first", ""]))

    def test_prefixes_every_quoted_line(self):
        content = (
            '<blockquote itemtype="http://schema.skype.com/Reply"><strong>Anton</strong><span></span>'
            '<p>first<br>second</p></blockquote><p>answer</p>'
        )
        self.assertEqual(teams_graph.html_to_text(content), "> Anton\n> first\n> second\n\nanswer")


class ReadableOutputTest(unittest.TestCase):
    def test_formats_times_in_the_local_timezone(self):
        self.assertEqual(teams_graph.local_time("2026-10-21T07:12:44.096Z", PARIS_SUMMER), "2026-10-21 09:12")
        self.assertIsNone(teams_graph.local_time(None))

    def test_renders_message_text_and_times(self):
        conversation = {"title": "Projet", "messages": [
            {"id": "1", "time": "2026-10-21T07:00:00.000Z", "html": "<p>a<br>b</p>"},
            {"id": "2", "time": "2026-10-21T07:01:00.000Z", "text": "a <b>"},
            {"id": "3", "time": None, "deleted": True},
        ]}
        self.assertEqual(teams_graph.readable_messages(conversation, PARIS_SUMMER), {"notice": teams_graph.UNTRUSTED_NOTICE, "title": "Projet", "messages": [
            {"id": "1", "time": "2026-10-21 09:00", "text": "a\nb"},
            {"id": "2", "time": "2026-10-21 09:01", "text": "a <b>"},
            {"id": "3", "time": None, "deleted": True},
        ]})

    def test_saves_the_images_of_each_message(self):
        conversation = {"messages": [
            {"id": "1", "time": None, "html": '<p><img src="a"><img src="b"></p>'},
            {"id": "2", "time": None, "html": "<p>no image</p>"},
            {"id": "../3", "time": None, "html": '<img src="c">'},
        ]}
        downloads = [
            {"contentType": "image/jpeg", "data": "AAEC"},
            {"error": "Not a Teams image: b"},
            {"contentType": "image/x-unknown", "data": "/w=="},
        ]
        with tempfile.TemporaryDirectory() as root, mock.patch.object(teams_graph, "run", return_value=downloads) as run:
            directory = Path(root) / "images"
            result = teams_graph.readable_messages(conversation, image_directory=directory)
            run.assert_called_once_with({"action": "images", "urls": ["a", "b", "c"]})
            self.assertEqual([message.get("images") for message in result["messages"]], [
                [{"file": str(directory / "1-1.jpg")}, {"error": "Not a Teams image: b"}],
                None,
                [{"file": str(directory / "___3-1.img")}],
            ])
            self.assertEqual((directory / "1-1.jpg").read_bytes(), bytes([0, 1, 2]))
            self.assertEqual((directory / "___3-1.img").read_bytes(), bytes([255]))
            self.assertEqual(sorted(path.name for path in directory.iterdir()), ["1-1.jpg", "___3-1.img"])

    def test_downloads_nothing_without_an_image_directory_or_images(self):
        with mock.patch.object(teams_graph, "run") as run, tempfile.TemporaryDirectory() as root:
            plain = teams_graph.readable_messages({"messages": [{"id": "1", "time": None, "html": '<img src="a">'}]})
            text_only = teams_graph.readable_messages({"messages": [{"id": "1", "time": None, "text": "a"}]}, image_directory=Path(root) / "new")
            self.assertFalse((Path(root) / "new").exists())
        run.assert_not_called()
        self.assertEqual([plain["messages"], text_only["messages"]], [[{"id": "1", "time": None, "text": "[image]"}], [{"id": "1", "time": None, "text": "a"}]])

    def test_rejects_inconsistent_image_answers(self):
        conversation = {"messages": [{"id": "1", "time": None, "html": '<img src="a">'}]}
        for answer, error in (([], "Unexpected image answer"), ([{"contentType": "image/png", "data": "not base64!"}], "undecodable image")):
            with self.subTest(answer=answer), tempfile.TemporaryDirectory() as root, mock.patch.object(teams_graph, "run", return_value=answer):
                with self.assertRaisesRegex(teams_graph.TeamsGraphError, error):
                    teams_graph.readable_messages(json.loads(json.dumps(conversation)), image_directory=Path(root))

    def test_lists_attached_file_names_without_a_file_directory(self):
        conversation = {"messages": [{"id": "1", "time": None, "text": "a", "files": [{"name": "a.txt", "driveId": "b!d", "itemId": "I1"}, {"name": "b.log"}]}]}
        with mock.patch.object(teams_graph, "run") as run:
            result = teams_graph.readable_messages(conversation)
        run.assert_not_called()
        self.assertEqual(result["messages"], [{"id": "1", "time": None, "text": "a", "files": ["a.txt", "b.log"]}])

    def test_saves_the_attached_files_of_each_message(self):
        conversation = {"messages": [
            {"id": "1", "time": None, "text": "a", "files": [
                {"name": "ICP-1_labqa.log", "driveId": "b!d", "itemId": "I1"},
                {"name": "../secret report.txt", "driveId": "b!d", "itemId": "I2"},
            ]},
            {"id": "2", "time": None, "text": "no file"},
            {"id": "../3", "time": None, "text": "c", "files": [{"name": "c.txt"}]},
        ]}
        downloads = [{"data": "AAEC"}, {"error": "Teams file download failed with HTTP 404"}, {"data": "/w=="}]
        with tempfile.TemporaryDirectory() as root, mock.patch.object(teams_graph, "run", return_value=downloads) as run:
            directory = Path(root) / "files"
            result = teams_graph.readable_messages(conversation, file_directory=directory)
            run.assert_called_once_with({"action": "files", "files": [
                {"driveId": "b!d", "itemId": "I1"}, {"driveId": "b!d", "itemId": "I2"}, {"driveId": None, "itemId": None},
            ]})
            self.assertEqual([message.get("files") for message in result["messages"]], [
                [
                    {"name": "ICP-1_labqa.log", "file": str(directory / "1-ICP-1_labqa.log")},
                    {"name": "../secret report.txt", "error": "Teams file download failed with HTTP 404"},
                ],
                None,
                [{"name": "c.txt", "file": str(directory / "___3-c.txt")}],
            ])
            self.assertEqual((directory / "1-ICP-1_labqa.log").read_bytes(), bytes([0, 1, 2]))
            self.assertEqual((directory / "___3-c.txt").read_bytes(), bytes([255]))
            self.assertEqual(sorted(path.name for path in directory.iterdir()), ["1-ICP-1_labqa.log", "___3-c.txt"])

    def test_keeps_attached_file_names_inside_the_directory(self):
        conversation = {"messages": [{"id": "1", "time": None, "text": "a", "files": [{"name": "../../etc/x y.txt", "driveId": "b!d", "itemId": "I1"}]}]}
        with tempfile.TemporaryDirectory() as root, mock.patch.object(teams_graph, "run", return_value=[{"data": "AA=="}]):
            directory = Path(root) / "files"
            result = teams_graph.readable_messages(conversation, file_directory=directory)
            saved = Path(result["messages"][0]["files"][0]["file"])
            self.assertEqual((saved.parent, saved.name), (directory.resolve(), "1-.._.._etc_x_y.txt"))

    def test_downloads_nothing_without_attached_files(self):
        with mock.patch.object(teams_graph, "run") as run, tempfile.TemporaryDirectory() as root:
            result = teams_graph.readable_messages({"messages": [{"id": "1", "time": None, "text": "a"}]}, file_directory=Path(root) / "new")
            self.assertFalse((Path(root) / "new").exists())
        run.assert_not_called()
        self.assertEqual(result["messages"], [{"id": "1", "time": None, "text": "a"}])

    def test_rejects_inconsistent_file_answers(self):
        conversation = {"messages": [{"id": "1", "time": None, "text": "a", "files": [{"name": "a.txt", "driveId": "b!d", "itemId": "I1"}]}]}
        for answer, error in (([], "Unexpected file answer"), ([{"data": "not base64!"}], "undecodable file")):
            with self.subTest(answer=answer), tempfile.TemporaryDirectory() as root, mock.patch.object(teams_graph, "run", return_value=answer):
                with self.assertRaisesRegex(teams_graph.TeamsGraphError, error):
                    teams_graph.readable_messages(json.loads(json.dumps(conversation)), file_directory=Path(root))

    def test_renders_last_activity_times(self):
        conversations = [{"title": "A", "lastActivity": "2026-10-20T22:30:00.000Z"}, {"title": "B", "lastActivity": None}]
        self.assertEqual(teams_graph.readable_conversations(conversations, PARIS_SUMMER), [
            {"title": "A", "lastActivity": "2026-10-21 00:30"}, {"title": "B", "lastActivity": None},
        ])


class RunTest(unittest.TestCase):
    def test_evaluates_the_page_script_with_the_request(self):
        result = {"kind": "chat", "messageId": "1"}
        with FakeDevTools([page_target()], value_answer({"ok": True, "result": result})) as devtools:
            request = {"action": "send", "conversationId": "19:a@thread.v2", "replyTo": None, "html": "<b>é</b>"}
            self.assertEqual(teams_graph.run(request, devtools.url), result)
        script = teams_graph.PAGE_SCRIPT.read_text(encoding="utf-8").strip()
        self.assertEqual(devtools.expressions, [f"({script})({json.dumps(request)})"])

    def test_waits_for_the_confirmation_dialog_on_top_of_the_usual_timeout(self):
        self.assertEqual(teams_graph.request_timeout({"action": "current"}), teams_graph.TIMEOUT_SECONDS)
        self.assertEqual(
            teams_graph.request_timeout({"action": "send", "confirmationTimeoutSeconds": 300}), teams_graph.TIMEOUT_SECONDS + 300,
        )

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
        code, stdout, _, run = self.run_main(["send", "19:a@thread.v2", "--approval", "abc"], "<b>é</b>", {"messageId": "1"})
        self.assertEqual(code, 0)
        run.assert_called_once_with({
            "action": "send", "conversationId": "19:a@thread.v2", "replyTo": None, "html": "<b>é</b>", "mentions": [],
            "approval": "abc", "confirmationTimeoutSeconds": teams_graph.CONFIRMATION_TIMEOUT_SECONDS,
            "htmlRules": teams_graph.HTML_RULES,
        })
        self.assertEqual(json.loads(stdout), {"messageId": "1"})

    def test_sends_a_plain_text_reply_to_a_channel_post(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        path = Path(directory.name) / "message.txt"
        path.write_text("x < y\n", encoding="utf-8")
        code, _, _, run = self.run_main(
            ["send", "19:c@thread.tacv2", "--reply-to", "123", "--file", str(path), "--text", "--approval", "abc"], answer={},
        )
        self.assertEqual(code, 0)
        run.assert_called_once_with({
            "action": "send", "conversationId": "19:c@thread.tacv2", "replyTo": "123", "html": "x &lt; y", "mentions": [],
            "approval": "abc", "confirmationTimeoutSeconds": teams_graph.CONFIRMATION_TIMEOUT_SECONDS,
            "htmlRules": teams_graph.HTML_RULES,
        })

    def test_passes_every_mention(self):
        code, _, _, run = self.run_main(
            ["preview", "19:a@thread.v2", "--mention", "Marie Boudet", "--mention", "Paul"], "@Marie Boudet @Paul", {"html": ""},
        )
        self.assertEqual(code, 0)
        self.assertEqual(run.call_args.args[0]["mentions"], ["Marie Boudet", "Paul"])

    def test_previews_with_a_readable_text_rendering(self):
        code, stdout, _, run = self.run_main(
            ["preview", "48:notes", "--mention", "Eric"], "<p>Hi @Eric</p>", {"html": '<p>Hi <at id="0">Eric</at></p>', "approval": "abc"},
        )
        self.assertEqual(code, 0)
        run.assert_called_once_with({"action": "preview", "conversationId": "48:notes", "replyTo": None, "html": "<p>Hi @Eric</p>", "mentions": ["Eric"]})
        self.assertEqual(json.loads(stdout), {"html": '<p>Hi <at id="0">Eric</at></p>', "approval": "abc", "preview": "Hi @Eric"})

    def test_requires_an_approval_code_to_send(self):
        stderr = io.StringIO()
        with mock.patch.object(teams_graph, "run") as run, contextlib.redirect_stderr(stderr), \
                self.assertRaises(SystemExit) as raised:
            teams_graph.main(["send", "19:a@thread.v2"])
        self.assertEqual(raised.exception.code, 2)
        self.assertIn("--approval", stderr.getvalue())
        run.assert_not_called()

    def test_prints_the_conversation_of_the_request(self):
        code, stdout, _, run = self.run_main(["current"], answer={"title": "Alice"})
        self.assertEqual(code, 0)
        run.assert_called_once_with({"action": "current"})
        self.assertEqual(json.loads(stdout), {"title": "Alice"})

    def test_lists_conversations_with_a_query(self):
        answer = [{"title": "Marie Boudet", "lastActivity": None}]
        code, stdout, _, run = self.run_main(["chats", "--query", "marie b", "--limit", "5"], answer=answer)
        self.assertEqual(code, 0)
        run.assert_called_once_with({"action": "chats", "query": "marie b", "limit": 5})
        self.assertEqual(json.loads(stdout), answer)

    def test_lists_recent_conversations_by_default(self):
        _, _, _, run = self.run_main(["chats"], answer=[])
        run.assert_called_once_with({"action": "chats", "query": "", "limit": 20})

    def test_reads_messages_as_text(self):
        answer = {"title": "Projet", "messages": [{"id": "1", "time": None, "html": "<p>a &amp; b</p>"}]}
        code, stdout, _, run = self.run_main(["read", "19:c@thread.tacv2", "--thread", "1", "--limit", "3"], answer=answer)
        self.assertEqual(code, 0)
        run.assert_called_once_with({"action": "read", "conversationId": "19:c@thread.tacv2", "threadId": "1", "limit": 3})
        self.assertEqual(json.loads(stdout), {
            "notice": teams_graph.UNTRUSTED_NOTICE, "title": "Projet", "messages": [{"id": "1", "time": None, "text": "a & b"}],
        })

    def test_reads_messages_with_their_attached_files(self):
        answer = {"messages": [{"id": "1", "time": None, "text": "logs", "files": [{"name": "run.log", "driveId": "b!d", "itemId": "I1"}]}]}
        stdout = io.StringIO()
        with tempfile.TemporaryDirectory() as root, \
                mock.patch.object(teams_graph, "run", side_effect=[answer, [{"data": "aGk="}]]) as run, \
                contextlib.redirect_stdout(stdout):
            self.assertEqual(teams_graph.main(["read", "48:notes", "--files", root]), 0)
            self.assertEqual(run.call_args_list, [
                mock.call({"action": "read", "conversationId": "48:notes", "threadId": None, "limit": 30}),
                mock.call({"action": "files", "files": [{"driveId": "b!d", "itemId": "I1"}]}),
            ])
            saved = Path(root).resolve() / "1-run.log"
            self.assertEqual(json.loads(stdout.getvalue())["messages"], [
                {"id": "1", "time": None, "text": "logs", "files": [{"name": "run.log", "file": str(saved)}]},
            ])
            self.assertEqual(saved.read_bytes(), b"hi")

    def test_reads_messages_with_their_images(self):
        answer = {"messages": [{"id": "1", "time": None, "html": '<p><img src="a"></p>'}]}
        stdout = io.StringIO()
        with tempfile.TemporaryDirectory() as root, \
                mock.patch.object(teams_graph, "run", side_effect=[answer, [{"contentType": "image/png", "data": "iVBORw=="}]]) as run, \
                contextlib.redirect_stdout(stdout):
            self.assertEqual(teams_graph.main(["read", "48:notes", "--images", root]), 0)
            self.assertEqual(run.call_args_list, [
                mock.call({"action": "read", "conversationId": "48:notes", "threadId": None, "limit": 30}),
                mock.call({"action": "images", "urls": ["a"]}),
            ])
            image = Path(root).resolve() / "1-1.png"
            self.assertEqual(json.loads(stdout.getvalue())["messages"], [{"id": "1", "time": None, "text": "[image]", "images": [{"file": str(image)}]}])
            self.assertEqual(image.read_bytes(), b"\x89PNG")

    def test_reads_the_default_number_of_messages(self):
        _, _, _, run = self.run_main(["read", "48:notes"], answer={"messages": []})
        run.assert_called_once_with({"action": "read", "conversationId": "48:notes", "threadId": None, "limit": 30})

    def test_rejects_a_non_positive_limit(self):
        for value in ("0", "-1", "x"):
            stderr = io.StringIO()
            with mock.patch.object(teams_graph, "run") as run, contextlib.redirect_stderr(stderr), \
                    self.assertRaises(SystemExit) as raised:
                teams_graph.main(["read", "48:notes", "--limit", value])
            self.assertEqual(raised.exception.code, 2)
            self.assertIn("--limit", stderr.getvalue())
            run.assert_not_called()

    def test_fails_without_calling_teams_for_an_empty_message(self):
        code, stdout, stderr, run = self.run_main(["send", "19:a@thread.v2", "--approval", "abc"], "  ")
        self.assertEqual((code, stdout), (1, ""))
        self.assertEqual(stderr, "teams_graph: The message is empty\n")
        run.assert_not_called()

    def test_reports_a_missing_file(self):
        code, _, stderr, run = self.run_main(["preview", "19:a@thread.v2", "--file", "/nonexistent/message.html"])
        self.assertEqual(code, 1)
        self.assertIn("/nonexistent/message.html", stderr)
        run.assert_not_called()


if __name__ == "__main__":
    unittest.main()
