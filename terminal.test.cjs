const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(`${__dirname}/terminal.js`, 'utf8');

function environment(savedProvider, legacy = false) {
    const elements = [];
    const sockets = [];
    const terminals = [];
    const listeners = {};
    const storage = new Map([['teams-terminal-provider', savedProvider]]);
    function element(tag = 'div') {
        const node = {
            tag, children: [], style: {}, dataset: {}, isConnected: true,
            appendChild(child) { this.children.push(child); return child; },
            prepend(child) { this.children.unshift(child); },
            get lastElementChild() { return this.children.at(-1); },
            setAttribute(key, value) { this[key] = value; },
            querySelectorAll() { return []; },
            querySelector() { return null; },
            remove() { this.isConnected = false; },
            click() { this.onclick?.({ stopPropagation() {} }); },
        };
        elements.push(node);
        return node;
    }
    const main = element();
    const document = {
        body: element(), createElement: element,
        querySelector: () => main,
        querySelectorAll: () => [],
        getElementById: id => elements.find(node => node.id === id && node.isConnected),
        addEventListener() {}, removeEventListener() {},
    };
    if (legacy) {
        const panel = element();
        panel.id = 'codex-terminal-panel';
        panel.style.height = '350px';
        panel.appendChild(element());
        const header = panel.appendChild(element());
        header.appendChild(element());
        header.appendChild(element());
        const toggle = element();
        toggle.id = 'codex-terminal-toggle';
        toggle.onclick = () => { toggle.clicked = true; };
    }
    class Terminal {
        constructor() { this.cols = 80; this.rows = 24; this.output = ''; terminals.push(this); }
        loadAddon() {}
        open() {}
        focus() { this.focused = true; }
        dispose() { this.disposed = true; }
        write(text) { this.output += text; }
        attachCustomKeyEventHandler(handler) { this.keyHandler = handler; }
        onData(handler) { this.input = handler; }
    }
    class WebSocket {
        constructor() { this.readyState = 0; this.sent = []; sockets.push(this); }
        open() { this.readyState = 1; this.onopen(); }
        send(message) { this.sent.push(JSON.parse(message)); }
        close() { this.readyState = 3; this.closed = true; }
    }
    const context = {
        document, console, Terminal, WebSocket,
        FitAddon: { FitAddon: class { fit() {} } },
        WebLinksAddon: { WebLinksAddon: class {} },
        ResizeObserver: class { observe() {} },
        localStorage: { getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) },
        addEventListener: (name, handler) => { listeners[name] = handler; },
        setTimeout() {}, clearTimeout() {},
    };
    context.window = context;
    vm.createContext(context);
    vm.runInContext(source, context);
    return { context, elements, sockets, terminals, storage, listeners, document };
}

test('switching retains both terminals, output and input routing', () => {
    const env = environment();
    env.sockets[0].open();
    const original = env.terminals[0];
    original.input('unfinished prompt');
    env.context.__teamsAssistantTerminals.activate('claude', true);
    env.sockets[1].open();
    const init = env.sockets[1].sent.find(message => message.type === 'init');
    assert.match(init.initialCommand, /teams-claude-agent/);
    assert.match(init.initialCommand, /cd '__USER_HOME__'/);
    assert.equal(init.projectPath, '__USER_HOME__');
    assert.doesNotMatch(init.initialCommand, /resume --last/);
    assert.match(init.sessionId, /teams-terminal-claude-/);
    env.sockets[0].onmessage({ data: JSON.stringify({ type: 'output', data: 'background result' }) });
    assert.equal(original.output, 'background result');
    env.terminals[1].input('Claude input');
    assert.equal(env.sockets[1].sent.at(-1).data, 'Claude input');
    assert.equal(env.sockets[0].sent.at(-1).data, 'unfinished prompt');
    env.context.__teamsAssistantTerminals.activate('codex', true);
    assert.equal(env.sockets.length, 2);
    assert.ok(env.sockets.every(socket => !socket.closed));
    assert.ok(env.terminals.every(terminal => !terminal.disposed));
    assert.equal(env.storage.get('teams-terminal-provider'), 'codex');
    assert.equal(env.document.getElementById('claude-terminal-panel').style.display, 'none');
});

test('reconnect and new conversation apply only to the selected assistant', () => {
    const env = environment('claude');
    env.sockets[0].open();
    env.elements.find(node => node.title === 'Reconnect').click();
    env.sockets[1].open();
    const reconnect = env.sockets[1].sent.find(message => message.type === 'init');
    assert.match(reconnect.initialCommand, /teams-claude-agent --continue/);
    assert.match(reconnect.initialCommand, /cat \/tmp\/teams-claude-cwd/);
    env.elements.find(node => node.title === 'New conversation').click();
    env.sockets[2].open();
    const fresh = env.sockets[2].sent.find(message => message.type === 'init');
    assert.doesNotMatch(fresh.initialCommand, /--continue/);
    assert.match(fresh.initialCommand, /cd '__USER_HOME__'/);
    assert.equal(env.sockets[0].onmessage, null);
    assert.equal(env.sockets[1].onclose, null);
});

test('live installation preserves the existing Codex terminal without opening a socket', () => {
    const env = environment(undefined, true);
    assert.equal(env.sockets.length, 0);
    const button = env.elements.find(node => node.dataset.assistantSwitch === 'claude');
    assert.equal(button.textContent, 'Claude');
    assert.equal(env.document.getElementById('codex-terminal-panel').style.height, '350px');
    vm.runInContext(source, env.context);
    assert.equal(env.elements.filter(node => node.dataset.assistantSwitch).length, 1);
    button.click();
    assert.equal(env.sockets.length, 1);
    env.context.__teamsAssistantTerminals.activate('codex', true);
    assert.equal(env.sockets.length, 1);
});

test('the shortcut operates only on the visible assistant', () => {
    const env = environment(undefined, true);
    env.context.__teamsAssistantTerminals.activate('claude', true);
    let stopped = false;
    env.listeners.keydown({ key: '`', ctrlKey: true, preventDefault() {}, stopImmediatePropagation() { stopped = true; } });
    assert.ok(stopped);
    assert.equal(env.document.getElementById('claude-terminal-panel').style.height, '0');
    assert.equal(env.document.getElementById('codex-terminal-toggle').clicked, undefined);
});

test('closing one assistant keeps the other session reachable', () => {
    const env = environment(undefined, true);
    env.context.__teamsAssistantTerminals.activate('claude', true);
    const close = env.elements.find(node => node.title === 'Close');
    close.click();
    close.click();
    assert.equal(env.document.getElementById('claude-terminal-panel'), undefined);
    assert.equal(env.document.getElementById('codex-terminal-panel').style.display, 'flex');
    assert.ok(env.sockets[0].closed);
    assert.ok(env.terminals[0].disposed);
});

test('Codex Answer and Alt+Up keep sending the expected escape sequence', () => {
    const env = environment();
    env.sockets[0].open();
    env.elements.find(node => node.id === 'codex-terminal-answer').click();
    assert.equal(env.sockets[0].sent.at(-1).data, '\x1b[1;3A');
    env.terminals[0].keyHandler({ type: 'keydown', key: 'ArrowUp', altKey: true, preventDefault() {}, stopPropagation() {} });
    assert.equal(env.sockets[0].sent.at(-1).data, '\x1b[1;3A');
    env.context.__teamsAssistantTerminals.activate('claude', true);
    assert.equal(env.document.getElementById('claude-terminal-answer'), undefined);
});
