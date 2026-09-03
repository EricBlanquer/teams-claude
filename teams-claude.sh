#!/bin/bash
# teams-claude.sh — Launch Teams for Linux with an embedded Codex terminal.
#
# Prerequisites:
#   1. Teams for Linux (deb or flatpak): https://github.com/IsmaelMartinez/teams-for-linux?tab=readme-ov-file#installation
#   2. Claude Code UI (backend): https://github.com/siteboon/claudecodeui?tab=readme-ov-file#quick-start
#   3. Codex CLI available on PATH
#
# Usage:
#   ./teams-claude.sh                              # Normal mode
#   ./teams-claude.sh --dangerously-skip-permissions # Bypass permissions
#   CLAUDECODEUI_PORT=4000 ./teams-claude.sh       # Custom port
#
# Keyboard shortcuts (in Teams):
#   Ctrl+`  — Toggle terminal panel
#   Ctrl+V  — Paste (supports images from clipboard)

DEBUG_PORT=9333
export CLAUDECODEUI_PORT=${CLAUDECODEUI_PORT:-3001}
CODEX_EXTRA_FLAGS=""
FLATPAK_APP="com.github.IsmaelMartinez.teams_for_linux"

if [ "$1" = "--dangerously-skip-permissions" ] || [ "$1" = "--dangerously-bypass-approvals-and-sandbox" ]; then
    CODEX_EXTRA_FLAGS="--dangerously-bypass-approvals-and-sandbox"
fi

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

# Verify claudecodeui is running BEFORE launching Teams
if ! curl -s "http://127.0.0.1:${CLAUDECODEUI_PORT}/" >/dev/null 2>&1; then
    echo "ERROR: claudecodeui not running on port $CLAUDECODEUI_PORT"
    echo "The terminal requires Claude Code UI (https://github.com/siteboon/claudecodeui)"
    echo "Opening installation page..."
    xdg-open "https://github.com/siteboon/claudecodeui?tab=readme-ov-file#quick-start" 2>/dev/null || \
        open "https://github.com/siteboon/claudecodeui?tab=readme-ov-file#quick-start" 2>/dev/null
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
exec codex $CODEX_EXTRA_FLAGS \
    -c 'mcp_servers.chrome-devtools.command="npx"' \
    -c 'mcp_servers.chrome-devtools.args=["-y", "chrome-devtools-mcp@latest", "--browserUrl", "http://127.0.0.1:$DEBUG_PORT"]' \
    -c "developer_instructions=\$(cat /tmp/teams-codex-prompt.md)" \
    "\$@"
CODEXEOF
chmod 700 /tmp/teams-codex

# Write Teams-specific bashrc for manual Codex relaunches after Ctrl+C
cat > /tmp/teams-codex-bashrc << BASHEOF
[ -f ~/.bashrc ] && source ~/.bashrc
cd "\$(cat /tmp/teams-codex-cwd 2>/dev/null)" 2>/dev/null || cd ~
PROMPT_COMMAND='printf "%s" "\$PWD" > /tmp/teams-codex-cwd'
alias codex='/tmp/teams-codex'
BASHEOF

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

TERMINAL_JS = r"""
(function codexTermInit() {
    if (document.getElementById('codex-terminal-panel')) return;

    var CCUI_HOST = 'ws://localhost:__CCUI_PORT__/shell';

    // --- Find the main conversation area (grid-area: main) ---
    var mainArea = document.querySelector('[class*="AppLayoutArea"][class*="___e1b8f60"]') ||
        Array.from(document.querySelectorAll('[class*="AppLayoutArea"]')).find(function(el) {
            return getComputedStyle(el).gridArea.includes('main');
        });
    if (!mainArea) {
        var n = (window.__codexTermRetry = (window.__codexTermRetry || 0) + 1);
        if (n <= 120) { setTimeout(codexTermInit, 500); }
        else { console.error('[Codex Terminal] Could not find main area after retries'); }
        return;
    }
    window.__codexTermRetry = 0;

    mainArea.style.display = 'flex';
    mainArea.style.flexDirection = 'column';
    mainArea.style.overflow = 'hidden';
    Array.from(mainArea.children).forEach(function(child) {
        if (child.id === 'codex-terminal-panel') return;
        if (child.offsetHeight > 50) {
            child.style.flex = '1';
            child.style.minHeight = '0';
            child.style.overflow = 'hidden';
        }
    });

    // --- Build UI ---
    var panel = document.createElement('div');
    panel.id = 'codex-terminal-panel';
    panel.style.cssText =
        'height:0;flex-shrink:0;' +
        'background:#1e1e2e;border-top:2px solid #6c5ce7;' +
        'display:flex;flex-direction:column;' +
        'transition:height 0.3s ease;overflow:hidden;';

    var header = document.createElement('div');
    header.style.cssText =
        'display:flex;align-items:center;justify-content:space-between;' +
        'padding:4px 12px;background:#2d2b55;color:#e2e0f0;' +
        'font-size:12px;cursor:pointer;user-select:none;min-height:28px;' +
        'font-family:"Cascadia Code","Fira Code",Consolas,monospace;';

    var titleSpan = document.createElement('span');
    titleSpan.textContent = 'Codex Terminal';
    titleSpan.style.fontWeight = 'bold';

    var statusDot = document.createElement('span');
    statusDot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:#ff6b6b;margin-left:8px;display:inline-block;';

    var titleLeft = document.createElement('div');
    titleLeft.style.cssText = 'display:flex;align-items:center;';
    titleLeft.appendChild(titleSpan);
    titleLeft.appendChild(statusDot);

    var btnContainer = document.createElement('div');
    btnContainer.style.cssText = 'display:flex;gap:6px;';

    function mkBtn(label, title) {
        var b = document.createElement('button');
        b.textContent = label;
        b.title = title;
        b.style.cssText =
            'background:none;border:1px solid #555;color:#ccc;cursor:pointer;' +
            'border-radius:3px;padding:1px 8px;font-size:12px;line-height:18px;display:inline-flex;align-items:center;justify-content:center;outline:none;';
        b.onmouseenter = function() { b.style.background = '#444'; };
        b.onmouseleave = function() { b.style.background = 'none'; };
        b.onmouseup = function() { setTimeout(function() { if (term) term.focus(); }, 50); };
        return b;
    }

    var reconnectBtn = mkBtn('\u27F3', 'Reconnect');
    var newConvBtn = mkBtn('\u002B', 'New conversation');
    var minimizeBtn = mkBtn('\u25BC', 'Minimize');
    var closeBtn = mkBtn('\u2715', 'Close');
    btnContainer.appendChild(newConvBtn);
    btnContainer.appendChild(reconnectBtn);
    btnContainer.appendChild(minimizeBtn);
    btnContainer.appendChild(closeBtn);

    header.appendChild(titleLeft);
    header.appendChild(btnContainer);

    var termContainer = document.createElement('div');
    termContainer.id = 'codex-term-container';
    termContainer.style.cssText = 'flex:1;overflow:hidden;';

    // Resize handle (top edge of panel)
    var resizeHandle = document.createElement('div');
    resizeHandle.style.cssText =
        'height:4px;cursor:ns-resize;background:transparent;flex-shrink:0;';
    resizeHandle.onmouseenter = function() { resizeHandle.style.background = '#6c5ce7'; };
    resizeHandle.onmouseleave = function() { if (!resizing) resizeHandle.style.background = 'transparent'; };

    panel.appendChild(resizeHandle);
    panel.appendChild(header);
    panel.appendChild(termContainer);
    mainArea.appendChild(panel);

    var toggleBtn = document.createElement('div');
    toggleBtn.id = 'codex-terminal-toggle';
    toggleBtn.textContent = '>';
    toggleBtn.title = 'Codex Terminal (Ctrl+`)';
    toggleBtn.style.cssText =
        'position:fixed;bottom:8px;right:12px;width:32px;height:32px;' +
        'background:#6c5ce7;color:white;border-radius:50%;' +
        'display:flex;align-items:center;justify-content:center;' +
        'cursor:pointer;z-index:999998;font-size:16px;font-weight:bold;' +
        'box-shadow:0 2px 8px rgba(0,0,0,0.3);user-select:none;font-family:monospace;';
    document.body.appendChild(toggleBtn);

    var isOpen = false;
    var panelHeight = parseInt(localStorage.getItem('codex-terminal-height') || localStorage.getItem('claude-terminal-height')) || 350;
    var term = null;
    var fitAddon = null;
    var ws = null;

    function scrollChatToBottom() {
        setTimeout(function() {
            if (!mainArea) return;
            mainArea.querySelectorAll('*').forEach(function(el) {
                var s = getComputedStyle(el);
                if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200 && el.id !== 'codex-term-container') {
                    el.scrollTop = el.scrollHeight;
                }
            });
        }, 350);
    }

    var lastCols = 0, lastRows = 0;
    var fitTimer = null;
    function fitTerminal() {
        if (fitAddon && term) {
            try {
                fitAddon.fit();
                if (ws && ws.readyState === 1 && (term.cols !== lastCols || term.rows !== lastRows)) {
                    lastCols = term.cols;
                    lastRows = term.rows;
                    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
                }
            } catch(e) {}
        }
    }
    function scheduleFit() {
        if (fitTimer) clearTimeout(fitTimer);
        fitTimer = setTimeout(function() {
            fitTimer = null;
            if (!resizing) fitTerminal();
        }, 120);
    }

    function togglePanel() {
        isOpen = !isOpen;
        panel.style.height = isOpen ? panelHeight + 'px' : '0';
        toggleBtn.style.display = isOpen ? 'none' : 'flex';
        if (isOpen) {
            scrollChatToBottom();
            setTimeout(function() { fitTerminal(); if (term) term.focus(); }, 400);
        }
    }

    toggleBtn.onclick = togglePanel;
    header.ondblclick = togglePanel;
    minimizeBtn.onclick = function(e) { e.stopPropagation(); togglePanel(); };
    closeBtn.onclick = function(e) {
        e.stopPropagation();
        if (closeBtn._minimizing) { closeBtn._minimizing = false; return; }
        if (closeBtn._confirming) {
            closeBtn._confirming = false;
            panel.remove();
            toggleBtn.remove();
            if (ws) ws.close();
            if (term) term.dispose();
            return;
        }
        closeBtn._confirming = true;
        closeBtn.textContent = 'Close? \u2715';
        closeBtn.style.color = '#f38ba8';
        var minBtn = document.createElement('span');
        minBtn.textContent = ' Minimize \u25BC';
        minBtn.style.cssText = 'color:#a6e3a1;cursor:pointer;margin-left:8px;';
        minBtn.onclick = function(ev) {
            ev.stopPropagation();
            closeBtn._minimizing = true;
            closeBtn._confirming = false;
            closeBtn.textContent = '\u2715';
            closeBtn.style.color = '';
            togglePanel();
        };
        closeBtn.appendChild(minBtn);
        setTimeout(function() {
            if (closeBtn._confirming) {
                closeBtn._confirming = false;
                closeBtn.textContent = '\u2715';
                closeBtn.style.color = '';
            }
        }, 3000);
    };

    var resizing = false;
    resizeHandle.onmousedown = function(e) {
        e.preventDefault();
        resizing = true;
        resizeHandle.style.background = '#6c5ce7';
        panel.style.transition = 'none';
        var startY = e.clientY;
        var startH = panel.offsetHeight;
        function onMove(ev) {
            if (!resizing) return;
            var newH = Math.max(120, startH + (startY - ev.clientY));
            panel.style.height = newH + 'px';
            panelHeight = newH;
        }
        function onUp() {
            resizing = false;
            resizeHandle.style.background = 'transparent';
            panel.style.transition = 'height 0.3s ease';
            localStorage.setItem('codex-terminal-height', panelHeight);
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
            fitTerminal();
        }
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    };

    document.addEventListener('keydown', function(e) {
        if (e.key === '`' && e.ctrlKey) {
            e.preventDefault();
            e.stopPropagation();
            togglePanel();
        }
    }, true);

    var resizeObserver = new ResizeObserver(function() { scheduleFit(); });
    resizeObserver.observe(termContainer);

    function connectShell(newConversation) {
        if (ws && ws.readyState <= 1) ws.close();
        statusDot.style.background = '#f9e2af';

        if (term) { term.dispose(); term = null; fitAddon = null; }

        term = new window.Terminal({
            theme: {
                background: '#1e1e2e', foreground: '#cdd6f4', cursor: '#f5e0dc',
                selectionBackground: '#585b7066',
                black: '#45475a', red: '#f38ba8', green: '#a6e3a1', yellow: '#f9e2af',
                blue: '#89b4fa', magenta: '#f5c2e7', cyan: '#94e2d5', white: '#bac2de',
                brightBlack: '#585b70', brightRed: '#f38ba8', brightGreen: '#a6e3a1', brightYellow: '#f9e2af',
                brightBlue: '#89b4fa', brightMagenta: '#f5c2e7', brightCyan: '#94e2d5', brightWhite: '#a6adc8'
            },
            fontFamily: '"Cascadia Code", "Fira Code", Consolas, monospace',
            fontSize: 13, cursorBlink: true, scrollback: 5000, convertEol: false
        });

        fitAddon = new window.FitAddon.FitAddon();
        term.loadAddon(fitAddon);
        var webLinksAddon = new window.WebLinksAddon.WebLinksAddon(function(event, uri) {
            window.open(uri, '_blank');
        });
        term.loadAddon(webLinksAddon);
        term.open(termContainer);
        fitTerminal();

        try { ws = new WebSocket(CCUI_HOST); }
        catch(e) {
            statusDot.style.background = '#ff6b6b';
            term.write('\x1b[31mConnection failed: ' + e.message + '\x1b[0m\r\n');
            return;
        }

        ws.onopen = function() {
            statusDot.style.background = '#a6e3a1';
            fitTerminal();
            if (isOpen) scrollChatToBottom();
            var pathSetup = 'export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node/ 2>/dev/null | tail -1)/bin:$PATH" 2>/dev/null';
            var cdCmd = 'cd "$(cat /tmp/teams-codex-cwd 2>/dev/null)" 2>/dev/null || cd ~';
            var cwdWatcher = '(MISS=0; while sleep 2; do PID=$(pgrep -nf "codex.*mcp_servers.chrome-devtools" 2>/dev/null); if [ -n "$PID" ]; then readlink /proc/$PID/cwd > /tmp/teams-codex-cwd 2>/dev/null; MISS=0; else MISS=$((MISS+1)); [ $MISS -gt 5 ] && break; fi; done &)';
            var codexCmd = newConversation
                ? '/tmp/teams-codex'
                : '(/tmp/teams-codex resume --last || /tmp/teams-codex)';
            ws.send(JSON.stringify({
                type: 'init',
                projectPath: '__TEAMS_DIR__',
                sessionId: 'teams-terminal-' + Date.now(),
                hasSession: false,
                provider: 'plain-shell',
                cols: term.cols, rows: term.rows,
                initialCommand: pathSetup + '; ' + cdCmd + ' && ' + cwdWatcher + ' && ' + codexCmd + '; exec bash --rcfile /tmp/teams-codex-bashrc',
                isPlainShell: true, skipPermissions: false
            }));
        };

        ws.onmessage = function(event) {
            try {
                var msg = JSON.parse(event.data);
                if (msg.type === 'output' && msg.data) term.write(msg.data);
            } catch(e) {}
        };

        ws.onclose = function() {
            statusDot.style.background = '#ff6b6b';
            if (term) term.write('\r\n\x1b[31m[Disconnected]\x1b[0m\r\n');
        };
        ws.onerror = function() { statusDot.style.background = '#ff6b6b'; };

        // Intercept Ctrl+V to check clipboard for images
        term.attachCustomKeyEventHandler(function(e) {
            if (e.type === 'keydown' && (e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'v') {
                e.preventDefault();
                e.stopPropagation();
                checkClipboardForImage();
                return false;
            }
            // Prevent Tab from leaving the terminal
            if (e.key === 'Tab') {
                e.preventDefault();
                e.stopPropagation();
                if (e.type === 'keydown' && ws && ws.readyState === 1) {
                    ws.send(JSON.stringify({ type: 'input', data: '\t' }));
                }
                // Force focus back to terminal after a tick (Teams steals it)
                setTimeout(function() { if (term) term.focus(); }, 0);
                setTimeout(function() { if (term) term.focus(); }, 50);
                return false;
            }
            return true;
        });

        term.onData(function(data) {
            if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'input', data: data }));
        });
    }

    reconnectBtn.onclick = function(e) { e.stopPropagation(); connectShell(); };
    newConvBtn.onclick = function(e) { e.stopPropagation(); connectShell(true); };

    // Image paste: decode and write to disk via temp shell, then send path to Codex
    function saveImageAndSendPath(blob) {
        var reader = new FileReader();
        reader.onload = function() {
            var base64 = reader.result.split(',')[1];
            var filename = '/tmp/codex-paste-' + Date.now() + '.png';
            var tempWs = new WebSocket(CCUI_HOST);
            var done = false;
            tempWs.onmessage = function(event) {
                try {
                    var msg = JSON.parse(event.data);
                    if (msg.type === 'output' && msg.data && msg.data.indexOf('IMG_SAVED') !== -1 && !done) {
                        done = true;
                        tempWs.send(JSON.stringify({ type: 'input', data: 'exit\n' }));
                        setTimeout(function() { tempWs.close(); }, 200);
                        // Insert image path at Codex's prompt
                        if (ws && ws.readyState === 1) {
                            ws.send(JSON.stringify({ type: 'input', data: filename + ' ' }));
                        }
                    }
                } catch(ex) {}
            };
            tempWs.onopen = function() {
                tempWs.send(JSON.stringify({
                    type: 'init', projectPath: '__USER_HOME__',
                    sessionId: 'img-upload-' + Date.now(), hasSession: false,
                    provider: 'plain-shell', cols: 200, rows: 10,
                    initialCommand: 'bash', isPlainShell: true, skipPermissions: false
                }));
                setTimeout(function() {
                    // Write base64 to a temp file in chunks, then decode to PNG
                    var b64file = filename + '.b64';
                    var chunkSize = 4000;
                    // Truncate file first
                    tempWs.send(JSON.stringify({ type: 'input', data: '> ' + b64file + '\n' }));
                    // Append chunks using printf (no echo to avoid interpretation)
                    for (var i = 0; i < base64.length; i += chunkSize) {
                        var chunk = base64.slice(i, i + chunkSize);
                        tempWs.send(JSON.stringify({ type: 'input', data: 'printf "%s" "' + chunk + '" >> ' + b64file + '\n' }));
                    }
                    // Decode and cleanup
                    tempWs.send(JSON.stringify({ type: 'input', data: 'base64 -d < ' + b64file + ' > ' + filename + ' && rm ' + b64file + ' && echo IMG_SAVED\n' }));
                    // Timeout fallback
                    setTimeout(function() {
                        if (!done) {
                            tempWs.close();
                            if (ws && ws.readyState === 1) {
                                ws.send(JSON.stringify({ type: 'input', data: filename + ' ' }));
                            }
                        }
                    }, 10000);
                }, 1500);
            };
        };
        reader.readAsDataURL(blob);
    }

    // Image paste: use clipboard API on Ctrl+V when terminal is focused
    function checkClipboardForImage() {
        if (!navigator.clipboard || !navigator.clipboard.read) {
            if (term) term.write('\r\n\x1b[31m[Clipboard API not available]\x1b[0m\r\n');
            return;
        }
        navigator.clipboard.read().then(function(clipboardItems) {
            for (var ci = 0; ci < clipboardItems.length; ci++) {
                var types = clipboardItems[ci].types;
                for (var ti = 0; ti < types.length; ti++) {
                    if (types[ti].indexOf('image') !== -1) {
                        clipboardItems[ci].getType(types[ti]).then(function(blob) {
                            saveImageAndSendPath(blob);
                        });
                        return;
                    }
                }
            }
            // No image found, let normal paste through
            if (ws && ws.readyState === 1) {
                navigator.clipboard.readText().then(function(text) {
                    if (text) ws.send(JSON.stringify({ type: 'input', data: text }));
                });
            }
        }).catch(function(err) {
            // Fallback to text paste
            if (ws && ws.readyState === 1) {
                navigator.clipboard.readText().then(function(text) {
                    if (text) ws.send(JSON.stringify({ type: 'input', data: text }));
                }).catch(function() {});
            }
        });
    }

    connectShell(true);
    console.log('[Codex Terminal] Injected. Ctrl+` to toggle.');
})();
"""

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
    const TERMINAL_SEL = "#codex-terminal-panel";

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
