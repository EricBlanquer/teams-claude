#!/usr/bin/env python3

import argparse
import asyncio
import html
import json
import sys
import urllib.request
from pathlib import Path
from urllib.parse import urlparse

import websockets


CDP_URL = "http://127.0.0.1:9333"
TEAMS_HOSTS = {"teams.cloud.microsoft", "teams.microsoft.com"}
PAGE_SCRIPT = Path(__file__).with_name("teams_graph.js")
TIMEOUT_SECONDS = 60
EVALUATE_ID = 1


class TeamsGraphError(Exception):
    pass


def teams_page(targets):
    pages = [
        target for target in targets
        if target.get("type") == "page" and urlparse(target.get("url", "")).hostname in TEAMS_HOSTS
    ]
    if len(pages) != 1:
        raise TeamsGraphError(f"Expected one Teams page on the DevTools endpoint, found {len(pages)}")
    return pages[0]["webSocketDebuggerUrl"]


def message_html(content, plain_text):
    if plain_text:
        content = html.escape(content.replace("\r\n", "\n").rstrip("\n"), quote=False).replace("\n", "<br>")
    if not content.strip():
        raise TeamsGraphError("The message is empty")
    return content


def page_expression(request):
    return f"({PAGE_SCRIPT.read_text(encoding='utf-8').strip()})({json.dumps(request)})"


async def evaluate(websocket_url, expression):
    async with websockets.connect(websocket_url, max_size=None) as websocket:
        await websocket.send(json.dumps({
            "id": EVALUATE_ID,
            "method": "Runtime.evaluate",
            "params": {"expression": expression, "awaitPromise": True, "returnByValue": True},
        }))
        while True:
            message = json.loads(await websocket.recv())
            if message.get("id") == EVALUATE_ID:
                break
    if "error" in message:
        raise TeamsGraphError(f"DevTools error: {message['error'].get('message')}")
    result = message["result"]
    if "exceptionDetails" in result:
        details = result["exceptionDetails"]
        raise TeamsGraphError(f"Teams page error: {details.get('exception', {}).get('description', details.get('text'))}")
    return result["result"].get("value")


def run(request, cdp_url=CDP_URL):
    try:
        with urllib.request.urlopen(f"{cdp_url}/json/list", timeout=5) as response:
            targets = json.load(response)
        outcome = asyncio.run(asyncio.wait_for(evaluate(teams_page(targets), page_expression(request)), TIMEOUT_SECONDS))
    except asyncio.TimeoutError as ex:
        raise TeamsGraphError(f"Teams did not answer within {TIMEOUT_SECONDS} s") from ex
    except (OSError, ValueError, websockets.WebSocketException) as ex:
        raise TeamsGraphError(f"Teams DevTools endpoint at {cdp_url} failed: {ex}") from ex
    if not isinstance(outcome, dict):
        raise TeamsGraphError("Unexpected answer from the Teams page")
    if not outcome.get("ok"):
        raise TeamsGraphError(outcome.get("error") or "Unknown Teams page error")
    return outcome["result"]


def read_message(path):
    if path:
        return path.read_text(encoding="utf-8")
    if sys.stdin.isatty():
        raise TeamsGraphError("Provide the message on stdin or with --file")
    return sys.stdin.read()


def main(argv=None):
    parser = argparse.ArgumentParser(description="Post Teams messages through Microsoft Graph with the signed-in Teams session")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("current", help="print the conversation displayed in Teams")
    send = commands.add_parser("send", help="post an HTML message read from stdin or --file")
    send.add_argument("conversation_id", help="chat id, or channel id (@thread.tacv2 / @thread.skype)")
    send.add_argument("--team", help="team id of the channel, resolved from the joined teams when omitted")
    send.add_argument("--file", type=Path, help="file containing the message")
    send.add_argument("--text", action="store_true", help="treat the message as plain text instead of HTML")
    args = parser.parse_args(argv)
    try:
        if args.command == "current":
            request = {"action": "current"}
        else:
            request = {
                "action": "send",
                "conversationId": args.conversation_id,
                "teamId": args.team,
                "html": message_html(read_message(args.file), args.text),
            }
        print(json.dumps(run(request), ensure_ascii=False, indent=2))
    except (TeamsGraphError, OSError) as ex:
        print(f"teams_graph: {ex}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
