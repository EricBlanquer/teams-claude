#!/bin/bash
# teams-claude.sh — Launch Teams for Linux with an embedded Claude Code terminal.
#
# Prerequisites:
#   1. Teams for Linux (deb or flatpak): https://github.com/IsmaelMartinez/teams-for-linux?tab=readme-ov-file#installation
#   2. Claude Code UI (backend): https://github.com/siteboon/claudecodeui?tab=readme-ov-file#quick-start
#   3. Claude Code CLI: ~/.local/bin/claude
#   4. Chrome DevTools MCP configured in ~/.claude/settings.json:
#        "mcpServers": {
#          "chrome-devtools": {
#            "command": "npx",
#            "args": ["chrome-devtools-mcp@latest", "--browserUrl", "http://127.0.0.1:9222"]
#          }
#        }
#
# Usage:
#   ./teams-claude.sh                              # Normal mode
#   ./teams-claude.sh --dangerously-skip-permissions # Bypass permissions
#   CLAUDECODEUI_PORT=4000 ./teams-claude.sh       # Custom port
#
# Keyboard shortcuts (in Teams):
#   Ctrl+`  — Toggle terminal panel
#   Ctrl+V  — Paste (supports images from clipboard)

DEBUG_PORT=9222
export CLAUDECODEUI_PORT=${CLAUDECODEUI_PORT:-3001}
CLAUDE_EXTRA_FLAGS=""
FLATPAK_APP="com.github.IsmaelMartinez.teams_for_linux"

if [ "$1" = "--dangerously-skip-permissions" ]; then
    CLAUDE_EXTRA_FLAGS="--dangerously-skip-permissions"
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

# Write MCP config to connect chrome-devtools to Teams debug port
cat > /tmp/teams-mcp.json << 'MCPEOF'
{"mcpServers":{"chrome-devtools":{"command":"npx","args":["chrome-devtools-mcp@latest","--browserUrl","http://127.0.0.1:9222"]}}}
MCPEOF

# Copy system prompt next to MCP config so the PTY can find it
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cp "$SCRIPT_DIR/teams-claude.md" /tmp/teams-claude-prompt.md

# Write Teams-specific bashrc for manual Claude relaunches after Ctrl+C
cat > /tmp/teams-bashrc << BASHEOF
[ -f ~/.bashrc ] && source ~/.bashrc
cd "$SCRIPT_DIR"
alias claude='~/.local/bin/claude $CLAUDE_EXTRA_FLAGS --mcp-config /tmp/teams-mcp.json --append-system-prompt-file /tmp/teams-claude-prompt.md --continue || ~/.local/bin/claude $CLAUDE_EXTRA_FLAGS --mcp-config /tmp/teams-mcp.json --append-system-prompt-file /tmp/teams-claude-prompt.md'
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
python3 - "$PAGE_WS" "$CLAUDE_EXTRA_FLAGS" "$SCRIPT_DIR" << 'PYEOF'
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
CLAUDE_EXTRA_FLAGS = sys.argv[2] if len(sys.argv) > 2 else ""
TEAMS_DIR = sys.argv[3] if len(sys.argv) > 3 else os.path.expanduser("~")

XTERM_JS_URL = "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/lib/xterm.min.js"
XTERM_CSS_URL = "https://cdn.jsdelivr.net/npm/@xterm/xterm@5.5.0/css/xterm.min.css"
FIT_ADDON_URL = "https://cdn.jsdelivr.net/npm/@xterm/addon-fit@0.10.0/lib/addon-fit.min.js"
WEB_LINKS_ADDON_URL = "https://cdn.jsdelivr.net/npm/@xterm/addon-web-links@0.11.0/lib/addon-web-links.min.js"
WEBGL_ADDON_URL = "https://cdn.jsdelivr.net/npm/@xterm/addon-webgl@0.18.0/lib/addon-webgl.min.js"

def download(url):
    with urllib.request.urlopen(url) as r:
        return r.read().decode("utf-8")

print("Downloading xterm.js...")
xterm_js = download(XTERM_JS_URL)
xterm_css = download(XTERM_CSS_URL)
fit_js = download(FIT_ADDON_URL)
web_links_js = download(WEB_LINKS_ADDON_URL)
webgl_js = download(WEBGL_ADDON_URL)
print("Downloaded xterm.js + addons + CSS")

TERMINAL_JS = r"""
(function() {
    if (document.getElementById('claude-terminal-panel')) return;

    var CCUI_HOST = 'ws://localhost:__CCUI_PORT__/shell';

    // --- Find the main conversation area (grid-area: main) ---
    var mainArea = document.querySelector('[class*="AppLayoutArea"][class*="___e1b8f60"]') ||
        Array.from(document.querySelectorAll('[class*="AppLayoutArea"]')).find(function(el) {
            return getComputedStyle(el).gridArea.includes('main');
        });
    if (!mainArea) { console.error('[Claude Terminal] Could not find main area'); return; }

    mainArea.style.display = 'flex';
    mainArea.style.flexDirection = 'column';
    mainArea.style.overflow = 'hidden';
    Array.from(mainArea.children).forEach(function(child) {
        if (child.id === 'claude-terminal-panel') return;
        if (child.offsetHeight > 50) {
            child.style.flex = '1';
            child.style.minHeight = '0';
            child.style.overflow = 'hidden';
        }
    });

    // --- Build UI ---
    var panel = document.createElement('div');
    panel.id = 'claude-terminal-panel';
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
    titleSpan.textContent = 'Claude Terminal';
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
    termContainer.id = 'claude-term-container';
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
    toggleBtn.id = 'claude-terminal-toggle';
    toggleBtn.textContent = '>';
    toggleBtn.title = 'Claude Terminal (Ctrl+`)';
    toggleBtn.style.cssText =
        'position:fixed;bottom:8px;right:12px;width:32px;height:32px;' +
        'background:#6c5ce7;color:white;border-radius:50%;' +
        'display:flex;align-items:center;justify-content:center;' +
        'cursor:pointer;z-index:999998;font-size:16px;font-weight:bold;' +
        'box-shadow:0 2px 8px rgba(0,0,0,0.3);user-select:none;font-family:monospace;';
    document.body.appendChild(toggleBtn);

    var isOpen = false;
    var panelHeight = parseInt(localStorage.getItem('claude-terminal-height')) || 350;
    var term = null;
    var fitAddon = null;
    var ws = null;

    function scrollChatToBottom() {
        setTimeout(function() {
            if (!mainArea) return;
            mainArea.querySelectorAll('*').forEach(function(el) {
                var s = getComputedStyle(el);
                if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200 && el.id !== 'claude-term-container') {
                    el.scrollTop = el.scrollHeight;
                }
            });
        }, 350);
    }

    function fitTerminal() {
        if (fitAddon && term) {
            try {
                fitAddon.fit();
                if (ws && ws.readyState === 1) {
                    ws.send(JSON.stringify({ type: 'resize', cols: term.cols, rows: term.rows }));
                }
            } catch(e) {}
        }
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
            fitTerminal();
        }
        function onUp() {
            resizing = false;
            resizeHandle.style.background = 'transparent';
            panel.style.transition = 'height 0.3s ease';
            localStorage.setItem('claude-terminal-height', panelHeight);
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
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

    var resizeObserver = new ResizeObserver(function() { fitTerminal(); });
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
        try { var webglAddon = new window.WebglAddon.WebglAddon(); term.loadAddon(webglAddon); }
        catch(e) { console.warn('[Claude Terminal] WebGL not available, using DOM renderer'); }
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
            ws.send(JSON.stringify({
                type: 'init',
                projectPath: '__TEAMS_DIR__',
                sessionId: 'teams-terminal-' + Date.now(),
                hasSession: false,
                provider: 'plain-shell',
                cols: term.cols, rows: term.rows,
                initialCommand: 'export PATH="$HOME/.local/bin:$HOME/.nvm/versions/node/$(ls $HOME/.nvm/versions/node/ 2>/dev/null | tail -1)/bin:$PATH" 2>/dev/null; cd __TEAMS_DIR__ && ' + (newConversation ? '~/.local/bin/claude __CLAUDE_EXTRA_FLAGS__ --mcp-config /tmp/teams-mcp.json --append-system-prompt-file /tmp/teams-claude-prompt.md' : '(~/.local/bin/claude __CLAUDE_EXTRA_FLAGS__ --mcp-config /tmp/teams-mcp.json --append-system-prompt-file /tmp/teams-claude-prompt.md --continue || ~/.local/bin/claude __CLAUDE_EXTRA_FLAGS__ --mcp-config /tmp/teams-mcp.json --append-system-prompt-file /tmp/teams-claude-prompt.md)') + '; exec bash --rcfile /tmp/teams-bashrc',
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

    // Image paste: decode and write to disk via temp shell, then send path to Claude
    function saveImageAndSendPath(blob) {
        var reader = new FileReader();
        reader.onload = function() {
            var base64 = reader.result.split(',')[1];
            var filename = '/tmp/claude-paste-' + Date.now() + '.png';
            var tempWs = new WebSocket(CCUI_HOST);
            var done = false;
            tempWs.onmessage = function(event) {
                try {
                    var msg = JSON.parse(event.data);
                    if (msg.type === 'output' && msg.data && msg.data.indexOf('IMG_SAVED') !== -1) {
                        done = true;
                        tempWs.send(JSON.stringify({ type: 'input', data: 'exit\n' }));
                        setTimeout(function() { tempWs.close(); }, 200);
                        // Insert image path at Claude's prompt
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

    connectShell();
    console.log('[Claude Terminal] Injected. Ctrl+` to toggle.');
})();
"""

async def inject():
    msg_id = 0

    async def evaluate(ws, code):
        nonlocal msg_id
        msg_id += 1
        await ws.send(json.dumps({
            "id": msg_id,
            "method": "Runtime.evaluate",
            "params": {"expression": code, "awaitPromise": False, "returnByValue": False}
        }))
        return json.loads(await ws.recv())

    async with websockets.connect(PAGE_WS) as ws:
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
        for addon_name, addon_js in [("web-links", web_links_js), ("webgl", webgl_js)]:
            print(f"Injecting {addon_name} addon...")
            result = await evaluate(ws, addon_js)
            if "exceptionDetails" in result.get("result", {}):
                print(f"{addon_name} addon injection failed:", result["result"]["exceptionDetails"].get("text"))
                if addon_name in ("web-links",):
                    return

        # 3. Inject CSS as a <style> tag
        print("Injecting xterm CSS...")
        css_escaped = json.dumps(xterm_css)
        await evaluate(ws, f"(function(){{ var s=document.createElement('style'); s.textContent={css_escaped}; document.head.appendChild(s); }})()")

        # 4. Inject terminal UI
        print("Injecting terminal UI...")
        final_js = TERMINAL_JS.replace("__CLAUDE_EXTRA_FLAGS__", CLAUDE_EXTRA_FLAGS)
        final_js = final_js.replace("__TEAMS_DIR__", TEAMS_DIR)
        final_js = final_js.replace("__USER_HOME__", os.path.expanduser("~"))
        final_js = final_js.replace("__CCUI_PORT__", os.environ.get("CLAUDECODEUI_PORT", "3001"))
        # Clean up double space if no extra flags
        while "claude  " in final_js:
            final_js = final_js.replace("claude  ", "claude ")
        result = await evaluate(ws, final_js)
        if "exceptionDetails" in result.get("result", {}):
            desc = result["result"]["exceptionDetails"].get("exception", {}).get("description", "unknown")
            print("Terminal injection failed:", desc)
        else:
            print("Injection successful!")

asyncio.run(inject())
PYEOF
) &
