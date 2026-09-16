#!/bin/bash
# teams-claude.sh — Launch Teams for Linux with embedded assistant terminals.
#
# Prerequisites:
#   1. Teams for Linux (deb or flatpak): https://github.com/IsmaelMartinez/teams-for-linux?tab=readme-ov-file#installation
#   2. Claude Code UI (backend): https://github.com/siteboon/claudecodeui?tab=readme-ov-file#quick-start
#   3. Codex CLI available on PATH
#
# Usage:
#   ./teams-claude.sh                              # Normal mode
#   CLAUDECODEUI_PORT=4000 ./teams-claude.sh       # Custom port
#
# Keyboard shortcuts (in Teams):
#   Ctrl+`  — Toggle terminal panel
#   Ctrl+V  — Paste (supports images from clipboard)

DEBUG_PORT=9333
export CLAUDECODEUI_PORT=${CLAUDECODEUI_PORT:-3001}
CLAUDECODEUI_STARTUP_TIMEOUT_SECONDS=60
FLATPAK_APP="com.github.IsmaelMartinez.teams_for_linux"

# Detect Teams for Linux installation (deb or flatpak)
if [ -x "/opt/teams-for-linux/teams-for-linux" ]; then
    TEAMS_CMD="/opt/teams-for-linux/teams-for-linux --ozone-platform=x11 --remote-debugging-port=$DEBUG_PORT"
elif flatpak info "$FLATPAK_APP" &>/dev/null; then
    TEAMS_CMD="flatpak run $FLATPAK_APP --remote-debugging-port=$DEBUG_PORT"
else
    echo "ERROR: Teams for Linux not found (neither deb nor flatpak)"
    echo "Install it from: https://github.com/IsmaelMartinez/teams-for-linux?tab=readme-ov-file#installation"
    echo "Opening installation page..."
    xdg-open "https://github.com/IsmaelMartinez/teams-for-linux?tab=readme-ov-file#installation" 2>/dev/null || \
        open "https://github.com/IsmaelMartinez/teams-for-linux?tab=readme-ov-file#installation" 2>/dev/null
    exit 1
fi

# Wait for claudecodeui before launching Teams
CLAUDECODEUI_READY=false
for ((elapsed = 0; elapsed < CLAUDECODEUI_STARTUP_TIMEOUT_SECONDS; elapsed++)); do
    if curl -fsS "http://127.0.0.1:${CLAUDECODEUI_PORT}/" >/dev/null 2>&1; then
        CLAUDECODEUI_READY=true
        break
    fi
    sleep 1
done

if [ "$CLAUDECODEUI_READY" != true ]; then
    echo "ERROR: claudecodeui not running on port $CLAUDECODEUI_PORT"
    echo "The terminal requires Claude Code UI (https://github.com/siteboon/claudecodeui)"
    exit 1
fi

# Gracefully close Teams via window close (saves position/size)
if pgrep -x teams-for-linux >/dev/null 2>&1; then
    # Try closing via DevTools Protocol (triggers Electron window close event)
    if curl -s "http://127.0.0.1:${DEBUG_PORT}/json/version" >/dev/null 2>&1; then
        BROWSER_WS=$(curl -s "http://127.0.0.1:${DEBUG_PORT}/json/version" | python3 -c "import json,sys; print(json.load(sys.stdin).get('webSocketDebuggerUrl',''))" 2>/dev/null)
        if [ -n "$BROWSER_WS" ]; then
            python3 -c "
import asyncio, websockets, json
async def close():
    async with websockets.connect('$BROWSER_WS') as ws:
        await ws.send(json.dumps({'id':1,'method':'Browser.close'}))
asyncio.run(close())
" 2>/dev/null
        fi
    else
        # No debug port, use xdotool to send close event
        xdotool search --name "Microsoft Teams" windowclose 2>/dev/null || killall -TERM teams-for-linux 2>/dev/null
    fi
    # Wait for Teams to exit (up to 5s)
    for i in $(seq 1 10); do
        pgrep -x teams-for-linux >/dev/null 2>&1 || break
        sleep 0.5
    done
    # Force kill only if still running
    killall -9 teams-for-linux 2>/dev/null
    sleep 0.5
fi

# Launch Teams with remote debugging
$TEAMS_CMD &>/dev/null &
TEAMS_PID=$!
echo "Teams launched (PID $TEAMS_PID), injection will happen in background..."

# Prepare the Codex prompt and launcher used inside the PTY. Inline configuration
# overrides the user's regular Chrome MCP so this session controls Teams on port 9333.
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cp "$SCRIPT_DIR/teams-codex.md" /tmp/teams-codex-prompt.md
cat > /tmp/teams-codex << CODEXEOF
#!/bin/bash
(while [ -d /proc/\$\$ ]; do
    readlink /proc/\$\$/cwd > /tmp/teams-codex-cwd
    sleep 2
done) &
exec codex \
    -c 'mcp_servers.chrome-devtools.command="npx"' \
    -c 'mcp_servers.chrome-devtools.args=["-y", "chrome-devtools-mcp@latest", "--browserUrl", "http://127.0.0.1:$DEBUG_PORT"]' \
    -c "developer_instructions=\$(cat /tmp/teams-codex-prompt.md)" \
    "\$@"
CODEXEOF
chmod 700 /tmp/teams-codex

cat > /tmp/teams-claude-mcp.json << MCPEOF
{"mcpServers":{"chrome-devtools":{"command":"npx","args":["-y","chrome-devtools-mcp@latest","--browserUrl","http://127.0.0.1:$DEBUG_PORT"]}}}
MCPEOF
cat > /tmp/teams-claude-agent << 'CLAUDEEOF'
#!/bin/bash
(while [ -d /proc/$$ ]; do
    readlink /proc/$$/cwd > /tmp/teams-claude-cwd
    sleep 2
done) &
exec claude \
    --mcp-config /tmp/teams-claude-mcp.json \
    --append-system-prompt "$(cat /tmp/teams-codex-prompt.md)" \
    "$@"
CLAUDEEOF
chmod 700 /tmp/teams-claude-agent

# Write Teams-specific bashrc for manual Codex relaunches after Ctrl+C
for assistant in codex claude; do
cat > "/tmp/teams-$assistant-bashrc" << BASHEOF
[ -f ~/.bashrc ] && source ~/.bashrc
cd "\$(cat /tmp/teams-$assistant-cwd 2>/dev/null)" 2>/dev/null || cd "$SCRIPT_DIR"
PROMPT_COMMAND='printf "%s" "\$PWD" > /tmp/teams-$assistant-cwd'
alias codex='/tmp/teams-codex'
alias claude='/tmp/teams-claude-agent'
BASHEOF
done

# Wait for Teams and inject in background so Teams is not blocked
(
# Wait for remote debugging to become available (up to 60s)
for i in $(seq 1 60); do
    curl -s "http://127.0.0.1:${DEBUG_PORT}/json/version" >/dev/null 2>&1 && break
    [ "$i" -eq 60 ] && { echo "ERROR: Teams remote debugging not responding after 60s"; exit 1; }
    sleep 1
done

# Wait for the Teams page to appear (up to 60s)
for i in $(seq 1 60); do
    curl -s "http://127.0.0.1:${DEBUG_PORT}/json" 2>/dev/null | grep -q "teams.cloud.microsoft" && break
    [ "$i" -eq 60 ] && { echo "ERROR: Teams page not found after 60s"; exit 1; }
    sleep 1
done

# Wait for Teams UI layout to be fully rendered
sleep 5

# Find the Teams main page (not the call toast or workers)
PAGE_WS=$(curl -s "http://127.0.0.1:${DEBUG_PORT}/json" | python3 -c "
import json, sys
for p in json.load(sys.stdin):
    url = p.get('url', '')
    if 'teams.cloud.microsoft' in url and 'worker' not in url and url.count('/') < 5:
        print(p['webSocketDebuggerUrl'])
        break
")

if [ -z "$PAGE_WS" ]; then
    echo "ERROR: Could not find Teams page WebSocket URL"
    exit 1
fi

echo "Injecting terminal panel..."

# Inject via Chrome DevTools Protocol
# Strategy: load xterm.js and fit addon via Runtime.evaluate (bypasses CSP),
# then inject the terminal UI code.
python3 - "$PAGE_WS" "$SCRIPT_DIR" << 'PYEOF'
import json
import asyncio
import sys
import os
import urllib.request

try:
    import websockets
except ImportError:
    import subprocess
    subprocess.check_call([sys.executable, "-m", "pip", "install", "websockets", "-q"])
    import websockets

PAGE_WS = sys.argv[1]
TEAMS_DIR = sys.argv[2] if len(sys.argv) > 2 else os.path.expanduser("~")

XTERM_JS_URL = "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"
XTERM_CSS_URL = "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css"
FIT_ADDON_URL = "https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"
WEB_LINKS_ADDON_URL = "https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11.0/lib/addon-web-links.min.js"

def download(url):
    with urllib.request.urlopen(url) as r:
        return r.read().decode("utf-8")

print("Downloading xterm.js...")
xterm_js = download(XTERM_JS_URL)
xterm_css = download(XTERM_CSS_URL)
fit_js = download(FIT_ADDON_URL)
web_links_js = download(WEB_LINKS_ADDON_URL)
print("Downloaded xterm.js + addons + CSS")

with open(os.path.join(TEAMS_DIR, "terminal.js"), encoding="utf-8") as terminal_file:
    TERMINAL_JS = terminal_file.read()

CLIPBOARD_FIX_JS = r"""
(function installTeamsClipboardFix() {
  if (window.__teamsClipboardFixHandler) {
    document.removeEventListener("copy", window.__teamsClipboardFixHandler, true);
    console.log("[clipboard-fix] previous handler removed");
  }

  function blobToPng(blob) {
    if (blob.type === "image/png") return Promise.resolve(blob);
    return new Promise((resolve, reject) => {
      const img = new Image();
      const objUrl = URL.createObjectURL(blob);
      img.onload = () => {
        const canvas = document.createElement("canvas");
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        canvas.getContext("2d").drawImage(img, 0, 0);
        canvas.toBlob((b) => {
          URL.revokeObjectURL(objUrl);
          b ? resolve(b) : reject(new Error("canvas.toBlob returned null"));
        }, "image/png");
      };
      img.onerror = () => {
        URL.revokeObjectURL(objUrl);
        reject(new Error("image decode failed"));
      };
      img.src = objUrl;
    });
  }

  function blobToDataUri(blob) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.onerror = () => reject(new Error("FileReader failed"));
      reader.readAsDataURL(blob);
    });
  }

  async function imgToDataUri(imgEl) {
    const src = imgEl.src || imgEl.getAttribute("src");
    if (!src) return null;
    if (src.startsWith("data:")) return { png: null, dataUri: src, viaCanvas: false };

    try {
      const response = await fetch(src);
      if (!response.ok) throw new Error("fetch HTTP " + response.status);
      const raw = await response.blob();
      const png = await blobToPng(raw);
      const dataUri = await blobToDataUri(png);
      return { png, dataUri, viaCanvas: false };
    } catch (fetchErr) {
      try {
        if (!imgEl.complete || !imgEl.naturalWidth) {
          throw new Error("image not loaded in DOM (naturalWidth=" + imgEl.naturalWidth + ")");
        }
        const canvas = document.createElement("canvas");
        canvas.width = imgEl.naturalWidth;
        canvas.height = imgEl.naturalHeight;
        canvas.getContext("2d").drawImage(imgEl, 0, 0);
        const dataUri = canvas.toDataURL("image/png");
        const png = await new Promise((res, rej) =>
          canvas.toBlob((b) => (b ? res(b) : rej(new Error("toBlob null"))), "image/png")
        );
        return { png, dataUri, viaCanvas: true };
      } catch (canvasErr) {
        const composite = new Error(
          "fetch failed (" + fetchErr.message + "), canvas fallback failed (" + canvasErr.message + ")"
        );
        composite.canvasErr = canvasErr;
        composite.fetchErr = fetchErr;
        throw composite;
      }
    }
  }

  function isScreenReaderOnly(el) {
    if (!el || el.nodeType !== 1) return false;
    const st = getComputedStyle(el);
    if (st.position !== "absolute" && st.position !== "fixed") return false;
    const clipZero = /^rect\(0px,\s*0px,\s*0px,\s*0px\)$/.test(st.clip || "");
    const pathHidden = st.clipPath === "inset(50%)" || st.clipPath === "inset(100%)";
    if (!clipZero && !pathHidden) return false;
    if ((parseFloat(st.width) || 0) > 1 || (parseFloat(st.height) || 0) > 1) return false;
    if (el.matches("a[href], button, input, select, textarea, [tabindex]")) return false;
    if (el.querySelector("a[href], button, input, select, textarea, [tabindex]")) return false;
    return true;
  }

  // Teams renders a screen-reader-only node (Fluent VisuallyHidden clip recipe)
  // for every message summary, reaction and system announcement. These stay in
  // the layout tree, so the browser serializes them into the selection, doubling
  // the text on paste - including middle-click paste (X11 PRIMARY), which never
  // fires a 'copy' event and so cannot be intercepted in JS. The only lever that
  // removes them from PRIMARY is taking them out of layout (display:none). A
  // persistent, body-scoped observer tags every sr-only node so one stylesheet
  // rule hides them; the copy handler reuses the same attribute to drop them from
  // its rich-HTML payload. Keyed on the computed clip recipe (not volatile
  // roles/classes) so it covers every current and future announcement, and it
  // skips the injected terminal subtree whose xterm rows churn every frame.
  (function installSrOnlyStripper() {
    const HIDE_ATTR = "data-cc-sronly";
    const STYLE_ID = "cc-sronly-style";
    const TERMINAL_SEL = "#codex-terminal-panel, #claude-terminal-panel";

    if (window.__teamsSrOnlyObserver) window.__teamsSrOnlyObserver.disconnect();

    if (!document.getElementById(STYLE_ID)) {
      const style = document.createElement("style");
      style.id = STYLE_ID;
      style.textContent = "[" + HIDE_ATTR + "]{display:none !important;}";
      (document.head || document.documentElement).appendChild(style);
    }

    const seen = new WeakSet();
    function tag(el) {
      if (seen.has(el)) return;
      seen.add(el);
      if (isScreenReaderOnly(el)) el.setAttribute(HIDE_ATTR, "1");
    }
    function scan(root) {
      if (root.nodeType !== 1) return;
      if (root.hasAttribute("data-cc-clone") || root.closest(TERMINAL_SEL)) return;
      tag(root);
      const els = root.querySelectorAll("*");
      for (let i = 0; i < els.length; i++) tag(els[i]);
    }

    const observer = new MutationObserver((records) => {
      for (let i = 0; i < records.length; i++) {
        const target = records[i].target;
        if (target && target.nodeType === 1 && target.closest && target.closest(TERMINAL_SEL)) {
          continue;
        }
        const added = records[i].addedNodes;
        for (let j = 0; j < added.length; j++) {
          if (added[j].nodeType === 1) scan(added[j]);
        }
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });
    window.__teamsSrOnlyObserver = observer;

    scan(document.body);
    console.log("[clipboard-fix] sr-only stripper installed (clip-recipe signature, observer)");
  })();

  const handler = (event) => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;

    const range = sel.getRangeAt(0);

    // The sr-only stripper persistently tags every hidden announcement node
    // (summaries, reactions, system notes) with data-cc-sronly on the live DOM.
    // cloneContents copies that attribute, so removing it here drops all sr-only
    // doubling from both the text/plain and text/html payloads.
    const container = document.createElement("div");
    container.setAttribute("data-cc-clone", "1");
    container.appendChild(range.cloneContents());
    container.querySelectorAll("[data-cc-sronly]").forEach((n) => n.remove());

    const imgEls = Array.from(container.querySelectorAll("img"));

    // Clean plain text via offscreen innerText (respects line breaks, excludes removed nodes),
    // then trim every line and drop blank lines for a compact, gap-free transcript.
    container.style.position = "absolute";
    container.style.left = "-99999px";
    container.style.top = "0";
    document.body.appendChild(container);
    const cleanText = container.innerText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .join("\n");

    // Synchronous clipboard payload: clean text + html, no doubling, no async race
    event.preventDefault();
    event.clipboardData.setData("text/plain", cleanText);
    event.clipboardData.setData("text/html", container.innerHTML);

    if (imgEls.length === 0) {
      container.remove();
      console.log("[clipboard-fix] v5 clean text copied (no images), " + cleanText.length + " chars");
      return;
    }

    const isRichMix = cleanText.length > 1;
    const liveImgs = Array.from(document.querySelectorAll("img"));

    // Async enrichment: embed images as data URIs and overwrite the clipboard
    (async () => {
      try {
        const resolved = [];
        let failedCount = 0;
        for (const clonedImg of imgEls) {
          const clonedSrc = clonedImg.src || clonedImg.getAttribute("src");
          if (!clonedSrc || clonedSrc.startsWith("data:")) continue;
          const liveImg =
            liveImgs.find((el) => (el.src || el.getAttribute("src")) === clonedSrc) || clonedImg;
          try {
            const r = await imgToDataUri(liveImg);
            if (r && r.dataUri) {
              clonedImg.src = r.dataUri;
              resolved.push(r);
              console.log(
                "[clipboard-fix]   img OK " +
                  (r.viaCanvas ? "(canvas)" : "(fetch)") +
                  " src=" +
                  (clonedSrc || "").slice(0, 60)
              );
            }
          } catch (e) {
            failedCount++;
            console.warn(
              "[clipboard-fix]   img FAIL src=" + (clonedSrc || "").slice(0, 60) + " :",
              e.message
            );
          }
        }

        if (resolved.length === 0) {
          console.warn("[clipboard-fix] no images embedded, keeping sync remote-src html");
          return;
        }

        const enrichedHtml = container.innerHTML;
        const firstPng = resolved.find((r) => r.png && r.png.size)?.png;

        const itemPayload = {
          "text/html": new Blob([enrichedHtml], { type: "text/html" }),
          "text/plain": new Blob([cleanText], { type: "text/plain" }),
        };
        if (!isRichMix && firstPng) {
          itemPayload["image/png"] = firstPng;
        }

        await navigator.clipboard.write([new ClipboardItem(itemPayload)]);
        console.log(
          "[clipboard-fix] v5 enriched: mode=" +
            (isRichMix ? "RICH(no image/png)" : "IMAGE(with image/png)") +
            ", " +
            resolved.length +
            "/" +
            imgEls.length +
            " img embedded, " +
            failedCount +
            " failed, html=" +
            enrichedHtml.length +
            " chars"
        );
      } catch (err) {
        console.error("[clipboard-fix] enrich failed:", err);
      } finally {
        container.remove();
      }
    })();
  };

  window.__teamsClipboardFixHandler = handler;
  document.addEventListener("copy", handler, true);
  console.log("[clipboard-fix] v6 installed (persistent sr-only stripper for PRIMARY + copy, async image embed)");
})();
"""

async def inject():
    msg_id = 0

    async def send_cmd(ws, method, params=None):
        nonlocal msg_id
        msg_id += 1
        my_id = msg_id
        await ws.send(json.dumps({"id": my_id, "method": method, "params": params or {}}))
        # Read until the matching response arrives, ignoring async CDP events
        # (Page.* notifications) that may be interleaved on the same socket.
        while True:
            resp = json.loads(await ws.recv())
            if resp.get("id") == my_id:
                return resp

    async def evaluate(ws, code):
        return await send_cmd(ws, "Runtime.evaluate",
                              {"expression": code, "awaitPromise": False, "returnByValue": False})

    async def inject_all(ws):
        # 1. Inject xterm.js via Runtime.evaluate (bypasses CSP)
        print("Injecting xterm.js...")
        result = await evaluate(ws, xterm_js)
        if "exceptionDetails" in result.get("result", {}):
            print("xterm.js injection failed:", result["result"]["exceptionDetails"].get("text"))
            return

        # 2. Inject fit addon
        print("Injecting fit addon...")
        result = await evaluate(ws, fit_js)
        if "exceptionDetails" in result.get("result", {}):
            print("fit addon injection failed:", result["result"]["exceptionDetails"].get("text"))
            return

        # 2b. Inject extra addons
        for addon_name, addon_js in [("web-links", web_links_js)]:
            print(f"Injecting {addon_name} addon...")
            result = await evaluate(ws, addon_js)
            if "exceptionDetails" in result.get("result", {}):
                print(f"{addon_name} addon injection failed:", result["result"]["exceptionDetails"].get("text"))
                if addon_name in ("web-links",):
                    return

        # 3. Inject CSS as a <style> tag
        print("Injecting xterm CSS...")
        css_escaped = json.dumps(xterm_css)
        await evaluate(ws, f"(function(){{ var s=document.createElement('style'); s.textContent={css_escaped}; (document.head||document.documentElement).appendChild(s); }})()")

        # 4. Inject terminal UI
        print("Injecting terminal UI...")
        final_js = TERMINAL_JS.replace("__TEAMS_DIR__", TEAMS_DIR)
        final_js = final_js.replace("__USER_HOME__", os.path.expanduser("~"))
        final_js = final_js.replace("__CCUI_PORT__", os.environ.get("CLAUDECODEUI_PORT", "3001"))
        result = await evaluate(ws, final_js)
        if "exceptionDetails" in result.get("result", {}):
            desc = result["result"]["exceptionDetails"].get("exception", {}).get("description", "unknown")
            print("Terminal injection failed:", desc)
        else:
            print("Injection successful!")

        # 5. Inject clipboard fix (text+image copy enrichment for paste into other apps)
        print("Injecting clipboard fix...")
        result = await evaluate(ws, CLIPBOARD_FIX_JS)
        if "exceptionDetails" in result.get("result", {}):
            desc = result["result"]["exceptionDetails"].get("exception", {}).get("description", "unknown")
            print("Clipboard fix injection failed:", desc)
        else:
            print("Clipboard fix injected!")

    async with websockets.connect(PAGE_WS, max_size=None) as ws:
        # Enable the Page domain so we are notified when Teams reloads the webview
        # (e.g. the tray "Refresh" entry, Ctrl+R) and can re-inject everything.
        await send_cmd(ws, "Page.enable")
        await inject_all(ws)
        print("Watching for page reloads (auto re-injection enabled)...")
        while True:
            try:
                raw = await ws.recv()
            except Exception:
                break
            try:
                msg = json.loads(raw)
            except Exception:
                continue
            if msg.get("method") == "Page.loadEventFired":
                print("Teams reloaded — re-injecting terminal...")
                await inject_all(ws)

asyncio.run(inject())
PYEOF
) &
