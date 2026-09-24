(function installAssistantTerminals() {
    if (window.__teamsAssistantTerminals) return;
    var PROVIDERS = ['codex', 'claude'];
    var STORAGE_KEY = 'teams-terminal-provider';
    var panels = {};
    var activeProvider = 'codex';

    function shellQuote(value) {
        return "'" + value.replace(/'/g, "'\\''") + "'";
    }

    function registerPanel(provider, panel, toggle, focus) {
        var header = panel.children[1];
        var buttons = header.lastElementChild;
        var target = provider === 'codex' ? 'claude' : 'codex';
        var button = document.createElement('button');
        button.type = 'button';
        button.textContent = target === 'claude' ? 'Claude' : 'Codex';
        button.title = 'Switch to ' + button.textContent;
        button.setAttribute('aria-label', button.title);
        button.dataset.assistantSwitch = target;
        button.style.cssText = 'background:none;border:1px solid #888;color:inherit;cursor:pointer;border-radius:3px;padding:1px 8px;font:inherit;';
        button.onclick = function(event) {
            event.stopPropagation();
            activate(target, true);
        };
        button.ondblclick = function(event) { event.stopPropagation(); };
        buttons.prepend(button);
        panels[provider] = {panel: panel, toggle: toggle, focus: focus};
        var close = Array.from(buttons.children).find(function(child) { return child.title === 'Close'; });
        if (close && close.onclick) {
            var originalClose = close.onclick;
            close.onclick = function(event) {
                originalClose.call(this, event);
                if (!panel.isConnected && panels[target] && panels[target].panel.isConnected) activate(target, true);
            };
        }
    }

    function activate(provider, focus) {
        if (PROVIDERS.indexOf(provider) === -1) return;
        if (!panels[provider] || !panels[provider].panel.isConnected) createTerminal(provider);
        if (!panels[provider]) return;
        activeProvider = provider;
        PROVIDERS.forEach(function(name) {
            var entry = panels[name];
            if (!entry) return;
            var selected = name === provider;
            entry.panel.style.display = selected ? 'flex' : 'none';
            entry.toggle.style.display = selected && parseInt(entry.panel.style.height) === 0 ? 'flex' : 'none';
        });
        localStorage.setItem(STORAGE_KEY, provider);
        if (focus) panels[provider].focus();
    }

    window.addEventListener('keydown', function(event) {
        if (event.key !== '`' || !event.ctrlKey) return;
        var entry = panels[activeProvider];
        if (!entry || !entry.panel.isConnected) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        entry.toggle.click();
    }, true);

function createTerminal(provider) {
    var panelId = provider + '-terminal-panel';
    var label = provider === 'claude' ? 'Claude' : 'Codex';
    if (document.getElementById(panelId)) return;

    var TERMINAL_HOST = 'ws://localhost:__TERMINAL_PORT__/shell';

    // --- Find the main conversation area (grid-area: main) ---
    var mainArea = document.querySelector('[class*="AppLayoutArea"][class*="___e1b8f60"]') ||
        Array.from(document.querySelectorAll('[class*="AppLayoutArea"]')).find(function(el) {
            return getComputedStyle(el).gridArea.includes('main');
        });
    if (!mainArea) {
        var n = (window.__codexTermRetry = (window.__codexTermRetry || 0) + 1);
        if (n <= 120) { setTimeout(function() { activate(provider, false); }, 500); }
        else { console.error('[Codex Terminal] Could not find main area after retries'); }
        return;
    }
    window.__codexTermRetry = 0;

    mainArea.style.display = 'flex';
    mainArea.style.flexDirection = 'column';
    mainArea.style.overflow = 'hidden';
    Array.from(mainArea.children).forEach(function(child) {
        if (child.id === 'codex-terminal-panel' || child.id === 'claude-terminal-panel') return;
        if (child.offsetHeight > 50) {
            child.style.flex = '1';
            child.style.minHeight = '0';
            child.style.overflow = 'hidden';
        }
    });

    // --- Build UI ---
    var panel = document.createElement('div');
    panel.id = panelId;
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
    titleSpan.textContent = label + ' Terminal';
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
        b.onmouseup = function() { setTimeout(function() { if (term && activeProvider === provider) term.focus(); }, 50); };
        return b;
    }

    if (provider === 'codex') {
        var answerBtn = mkBtn('Answer', 'Open pending question or edit queued message (Alt+Up)');
        answerBtn.id = provider + '-terminal-answer';
        answerBtn.onclick = function(e) {
            e.stopPropagation();
            sendAltUp();
            if (term) term.focus();
        };
        btnContainer.appendChild(answerBtn);
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
    termContainer.id = provider + '-term-container';
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
    toggleBtn.id = provider + '-terminal-toggle';
    toggleBtn.textContent = '>';
    toggleBtn.title = label + ' Terminal (Ctrl+`)';
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

    function sendAltUp() {
        if (ws && ws.readyState === 1) {
            ws.send(JSON.stringify({ type: 'input', data: '\x1b[1;3A' }));
        }
    }

    function scrollChatToBottom() {
        setTimeout(function() {
            if (!mainArea || activeProvider !== provider) return;
            mainArea.querySelectorAll('*').forEach(function(el) {
                var s = getComputedStyle(el);
                if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight + 50 && el.clientHeight > 200 && !el.closest('[id$="-terminal-panel"]')) {
                    el.scrollTop = el.scrollHeight;
                }
            });
        }, 350);
    }

    var lastCols = 0, lastRows = 0;
    var fitTimer = null;
    function fitTerminal() {
        if (fitAddon && term && activeProvider === provider) {
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
            setTimeout(function() { fitTerminal(); if (term && activeProvider === provider) term.focus(); }, 400);
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

    var resizeObserver = new ResizeObserver(function() { scheduleFit(); });
    resizeObserver.observe(termContainer);

    function connectShell(newConversation) {
        if (ws) { ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null; ws.close(); }
        lastCols = lastRows = 0;
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

        try { ws = new WebSocket(TERMINAL_HOST); }
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
            var cwdFile = '/tmp/teams-' + provider + '-cwd';
            var cdCmd = newConversation
                ? 'cd ' + shellQuote('__USER_HOME__')
                : 'cd "$(cat ' + cwdFile + ' 2>/dev/null)" 2>/dev/null || cd ' + shellQuote('__USER_HOME__');
            var launcher = provider === 'claude' ? '/tmp/teams-claude-agent' : '/tmp/teams-codex';
            var resumeArgs = provider === 'claude' ? ' --continue' : ' resume --last';
            var agentCmd = newConversation ? launcher : '(' + launcher + resumeArgs + ' || ' + launcher + ')';
            var bashrc = '/tmp/teams-' + provider + '-bashrc';
            ws.send(JSON.stringify({
                type: 'init',
                projectPath: '__USER_HOME__',
                sessionId: 'teams-terminal-' + provider + '-' + Date.now(),
                hasSession: false,
                provider: 'plain-shell',
                cols: term.cols, rows: term.rows,
                initialCommand: pathSetup + '; ' + cdCmd + ' && ' + agentCmd + '; exec bash --rcfile ' + bashrc,
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
            if (e.key === 'ArrowUp' && e.altKey && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
                e.preventDefault();
                e.stopPropagation();
                if (e.type === 'keydown') sendAltUp();
                return false;
            }
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
                setTimeout(function() { if (term && activeProvider === provider) term.focus(); }, 0);
                setTimeout(function() { if (term && activeProvider === provider) term.focus(); }, 50);
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
            var tempWs = new WebSocket(TERMINAL_HOST);
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

    registerPanel(provider, panel, toggleBtn, function() {
        if (!isOpen) togglePanel();
        else { fitTerminal(); if (term && activeProvider === provider) term.focus(); }
    });
    connectShell(true);
}
    window.__teamsAssistantTerminals = {activate: activate};
    var existing = document.getElementById('codex-terminal-panel');
    if (existing) {
        var existingToggle = document.getElementById('codex-terminal-toggle');
        registerPanel('codex', existing, existingToggle, function() {
            if (parseInt(existing.style.height) === 0) existingToggle.click();
            else {
                var input = existing.querySelector('textarea');
                if (input) input.focus();
            }
        });
    } else {
        activate(localStorage.getItem(STORAGE_KEY) === 'claude' ? 'claude' : 'codex', false);
    }
})();
