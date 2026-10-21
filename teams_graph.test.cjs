const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(`${__dirname}/teams_graph.js`, 'utf8');
const NOW_SECONDS = 1_800_000_000;
const ACCOUNT = 'user-id.tenant-id';
const SEND_SCOPES = 'openid https://graph.microsoft.com/ChatMessage.Send https://graph.microsoft.com/ChannelMessage.Send';
const CHAT_SCOPES = 'https://ic3.teams.office.com/Teams.AccessAsUser.All https://ic3.teams.office.com/.default';
const CHAT_ID = '19:abc_def@unq.gbl.spaces';
const CHANNEL_ID = '19:channel@thread.tacv2';
const GRAPH = 'https://graph.microsoft.com/v1.0';
const CHAT_SERVICE = 'https://teams.example/api/chatsvc/emea';
const ME_URL = '/me?$select=id,displayName';
const TOKEN_URL = 'POST https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token';
const CHAT_MESSAGES = `POST ${GRAPH}/chats/${encodeURIComponent(CHAT_ID)}/messages`;
const CHAT_MEMBERS = `GET ${GRAPH}/chats/${encodeURIComponent(CHAT_ID)}/members`;
const CHANNEL_PATH = `${GRAPH}/teams/team-x/channels/${encodeURIComponent(CHANNEL_ID)}`;
const DIALOG_ID = 'teams-assistant-send-confirmation';

class FakeElement {
    constructor(owner, tag) {
        this.owner = owner;
        this.tagName = tag.toUpperCase();
        this.style = {};
        this.attributes = {};
        this.children = [];
        this.listeners = {};
        this.parent = null;
        this.textContent = '';
    }

    setAttribute(name, value) {
        this.attributes[name] = String(value);
    }

    getAttribute(name) {
        return this.attributes[name] ?? null;
    }

    append(...nodes) {
        nodes.forEach(node => {
            node.parent = this;
            this.children.push(node);
        });
    }

    remove() {
        if (!this.parent) return;
        this.parent.children = this.parent.children.filter(child => child !== this);
        this.parent = null;
    }

    get isConnected() {
        let node = this;
        while (node.parent) node = node.parent;
        return node === this.owner.body;
    }

    addEventListener(type, listener) {
        (this.listeners[type] ||= []).push(listener);
    }

    dispatch(type, event = {}) {
        (this.listeners[type] || []).forEach(listener => listener({preventDefault() {}, stopPropagation() {}, ...event}));
    }

    focus() {
        this.owner.activeElement = this;
    }

    descendants() {
        return this.children.flatMap(child => [child, ...child.descendants()]);
    }
}

function accessToken(secret, expiresOn, target = SEND_SCOPES, homeAccountId = ACCOUNT) {
    return {credentialType: 'AccessToken', homeAccountId, target, secret, expiresOn: String(expiresOn)};
}

function chatToken(secret = 'chat-token', expiresOn = NOW_SECONDS + 3600) {
    return accessToken(secret, expiresOn, CHAT_SCOPES);
}

function refreshToken(homeAccountId = ACCOUNT) {
    return {credentialType: 'RefreshToken', homeAccountId, clientId: 'teams-client', secret: 'refresh-secret'};
}

const VALID_TOKENS = [accessToken('graph-token', NOW_SECONDS + 3600), chatToken()];

function jsonResponse(status, payload) {
    return {ok: status >= 200 && status < 300, status, json: async () => payload};
}

function found(body) {
    return {status: 200, body};
}

function conversationUrl(conversationId) {
    return `${CHAT_SERVICE}/v1/users/ME/conversations/${encodeURIComponent(conversationId)}`;
}

function conversation(id, threadProperties = {}, extra = {}) {
    return {id, threadProperties, ...extra};
}

const DEFAULT_CONVERSATIONS = [
    conversation(CHAT_ID, {topic: 'Projet', productThreadType: 'Chat'}),
    conversation(CHANNEL_ID, {topic: 'General', groupId: 'team-x', productThreadType: 'TeamsStandardChannel'}),
    conversation('48:notes', {productThreadType: 'StreamOfNotes'}),
];

function environment({
    credentials = VALID_TOKENS, regions = [CHAT_SERVICE], conversations = DEFAULT_CONVERSATIONS, graph = {}, routes = {},
    elements = [], title = null, documentTitle = 'Chat | Teams',
} = {}) {
    const entries = [
        ...credentials.map((credential, index) => [`credential-${index}`, JSON.stringify(credential)]),
        ...regions.map((region, index) => [`tmp.auth.v1.user-${index}.Discover.DISCOVER-REGION-GTM`, JSON.stringify({item: {chatServiceAfd: region}})]),
        ['broken', 'not json'],
        ['flag', 'true'],
    ];
    const requests = [];
    const writes = [];
    const listeners = [];
    const removed = [];
    const timers = [];
    const blobs = [];
    const revoked = [];
    const graphObjects = {[ME_URL]: found({id: 'me', displayName: 'Eric Blanquer'}), ...graph};
    const allRoutes = {
        [`POST ${GRAPH}/$batch`]: (url, init) => jsonResponse(200, {
            responses: JSON.parse(init.body).requests.map(request => ({
                id: request.id, ...(graphObjects[request.url] || {status: 404, body: {error: {code: 'NotFound'}}}),
            })),
        }),
        ...Object.fromEntries(conversations.map(item => [`GET ${conversationUrl(item.id)}`, jsonResponse(200, item)])),
        ...routes,
    };
    const window = {
        addEventListener: (type, listener, capture) => listeners.push({type, listener, capture}),
        removeEventListener: (type, listener, capture) => removed.push({type, listener, capture}),
    };
    const context = {
        window,
        localStorage: {
            length: entries.length,
            key: index => entries[index][0],
            getItem: key => (entries.find(entry => entry[0] === key) || [])[1] ?? null,
            setItem: (...args) => writes.push(args),
        },
        document: {
            title: documentTitle,
            activeElement: null,
            querySelectorAll: selector => (selector === '[data-track-thread-id]' ? elements : []),
            querySelector: selector => (selector === '[data-tid="chat-title"]' ? title : null),
            createElement: tag => new FakeElement(context.document, tag),
            getElementById: id => context.document.body.descendants().find(node => node.id === id) || null,
        },
        setTimeout: (callback, delay) => timers.push({callback, delay}),
        clearTimeout: id => {
            timers[id - 1] = null;
        },
        Blob: class {
            constructor(parts, options) {
                blobs.push({content: parts.join(''), type: options.type});
            }
        },
        URL: {
            createObjectURL: () => `blob:preview-${blobs.length}`,
            revokeObjectURL: url => revoked.push(url),
        },
        fetch: async (url, init = {}) => {
            requests.push({url, method: init.method || 'GET', headers: init.headers, body: init.body});
            const route = allRoutes[`${init.method || 'GET'} ${url.split('?')[0]}`];
            if (!route) throw new Error(`Unexpected request ${init.method} ${url}`);
            return typeof route === 'function' ? route(url, init) : route;
        },
        URLSearchParams, TextEncoder, crypto, Date,
    };
    context.Date = class extends Date {
        static now() {
            return NOW_SECONDS * 1000;
        }
    };
    context.document.body = new FakeElement(context.document, 'body');
    vm.createContext(context);
    const teamsGraph = vm.runInContext(source, context);
    const dialog = () => context.document.getElementById(DIALOG_ID);
    return {
        teamsGraph, requests, writes, window, listeners, removed, timers, blobs, revoked, document: context.document, dialog,
        button: label => dialog().descendants().find(node => node.tagName === 'BUTTON' && node.textContent === label),
        texts: () => dialog().descendants().filter(node => node.tagName === 'P').map(node => node.textContent),
        expire: () => timers.filter(Boolean).forEach(timer => timer.callback()),
        press: event => listeners.forEach(entry => entry.listener({key: 'Enter', ...event})),
        setDisplayed: (newElements, newTitle) => {
            elements = newElements;
            title = newTitle;
        },
    };
}

function plain(value) {
    return JSON.parse(JSON.stringify(value));
}

function confirmInTeams(env) {
    env.button('Envoyer').dispatch('click', {isTrusted: true});
}

async function whenDialogShown(env, sending, decide) {
    let settled = false;
    sending.then(() => {
        settled = true;
    });
    for (let tick = 0; tick < 200 && !settled && !env.dialog(); tick++) await new Promise(resolve => setImmediate(resolve));
    if (!settled && env.dialog()) await decide(env);
    return sending;
}

async function startSend(env, request) {
    const preview = await env.teamsGraph({...request, action: 'preview'});
    if (!preview.ok) return {preview};
    return {preview, sending: env.teamsGraph({...request, action: 'send', approval: preview.result.approval})};
}

async function approvedSend(env, request, decide = confirmInTeams) {
    const {preview, sending} = await startSend(env, request);
    return sending ? whenDialogShown(env, sending, decide) : preview;
}

function threadElement(id, type) {
    return {getAttribute: name => ({'data-track-thread-id': id, 'data-track-thread-type': type}[name] ?? null)};
}

function posts(env) {
    return env.requests.filter(request => request.method === 'POST' && !request.url.endsWith('/$batch') && !request.url.includes('login.'));
}

function postedBody(env) {
    return JSON.parse(posts(env)[0].body);
}

function batchedUrls(env) {
    return env.requests
        .filter(request => request.url.endsWith('/$batch'))
        .map(request => JSON.parse(request.body).requests.map(item => item.url));
}

test('sends HTML to a chat with the freshest cached tokens', async () => {
    const env = environment({
        credentials: [
            accessToken('older', NOW_SECONDS + 600),
            accessToken('fresh', NOW_SECONDS + 3600),
            accessToken('expiring', NOW_SECONDS + 30),
            accessToken('no-send-scope', NOW_SECONDS + 7200, 'https://graph.microsoft.com/User.Read'),
            chatToken('chat-older', NOW_SECONDS + 600),
            chatToken('chat-fresh', NOW_SECONDS + 3600),
            refreshToken(),
        ],
        routes: {[CHAT_MESSAGES]: jsonResponse(201, {id: '42', createdDateTime: 'date', body: {content: '<b>hi</b>'}})},
    });
    const outcome = await approvedSend(env, {conversationId: CHAT_ID, html: '<b>hi</b>'});
    assert.deepEqual(plain(outcome), {
        ok: true,
        result: {
            kind: 'chat', conversationId: CHAT_ID, threadType: 'Chat', title: 'Projet',
            messageId: '42', createdDateTime: 'date', content: '<b>hi</b>', mentions: [],
        },
    });
    assert.equal(posts(env).length, 1);
    assert.equal(posts(env)[0].headers.Authorization, 'Bearer fresh');
    assert.deepEqual(postedBody(env), {body: {contentType: 'html', content: '<b>hi</b>'}});
    const chatServiceRequests = env.requests.filter(request => request.url.startsWith(CHAT_SERVICE));
    assert.ok(chatServiceRequests.length);
    assert.ok(chatServiceRequests.every(request => request.headers.Authorization === 'Bearer chat-fresh'));
});

test('refreshes the Graph token without touching the Teams cache when cached tokens expire', async () => {
    const env = environment({
        credentials: [accessToken('expired', NOW_SECONDS + 60), chatToken(), refreshToken()],
        routes: {
            [TOKEN_URL]: jsonResponse(200, {access_token: 'refreshed', scope: SEND_SCOPES}),
            [CHAT_MESSAGES]: jsonResponse(201, {id: '43'}),
        },
    });
    const outcome = await approvedSend(env, {conversationId: CHAT_ID, html: 'hi'});
    assert.equal(outcome.ok, true, outcome.error);
    const refresh = Object.fromEntries(env.requests[0].body);
    assert.equal(refresh.grant_type, 'refresh_token');
    assert.equal(refresh.refresh_token, 'refresh-secret');
    assert.equal(refresh.client_id, 'teams-client');
    assert.match(refresh.scope, /^https:\/\/graph\.microsoft\.com\/\.default /);
    assert.equal(posts(env)[0].headers.Authorization, 'Bearer refreshed');
    assert.deepEqual(env.writes, []);
});

test('refreshes the chat service token with its own scope', async () => {
    const env = environment({
        credentials: [accessToken('graph-token', NOW_SECONDS + 3600), chatToken('expired', NOW_SECONDS + 60), refreshToken()],
        routes: {[TOKEN_URL]: jsonResponse(200, {access_token: 'chat-refreshed', scope: CHAT_SCOPES})},
    });
    const outcome = await env.teamsGraph({action: 'preview', conversationId: CHAT_ID, html: 'hi'});
    assert.equal(outcome.ok, true, outcome.error);
    assert.match(Object.fromEntries(env.requests[0].body).scope, /^https:\/\/ic3\.teams\.office\.com\/\.default /);
    assert.equal(env.requests.find(request => request.url.startsWith(CHAT_SERVICE)).headers.Authorization, 'Bearer chat-refreshed');
});

test('reports a refresh failure without leaking token values', async () => {
    const env = environment({credentials: [refreshToken()], routes: {[TOKEN_URL]: jsonResponse(400, {error: 'invalid_grant'})}});
    const outcome = await approvedSend(env, {conversationId: CHAT_ID, html: 'hi'});
    assert.deepEqual({...outcome}, {ok: false, error: 'Graph token refresh failed with HTTP 400 invalid_grant'});
});

test('rejects refreshed tokens that lack the required scopes', async () => {
    const graphEnv = environment({
        credentials: [refreshToken()],
        routes: {[TOKEN_URL]: jsonResponse(200, {access_token: 'read-only', scope: 'https://graph.microsoft.com/User.Read'})},
    });
    const graphOutcome = await approvedSend(graphEnv, {conversationId: CHAT_ID, html: 'hi'});
    assert.deepEqual({...graphOutcome}, {ok: false, error: 'The refreshed Graph token cannot send Teams messages'});
    assert.equal(graphEnv.requests.length, 1);
    const chatEnv = environment({
        credentials: [accessToken('graph-token', NOW_SECONDS + 3600), refreshToken()],
        routes: {[TOKEN_URL]: jsonResponse(200, {access_token: 'other', scope: SEND_SCOPES})},
    });
    const chatOutcome = await chatEnv.teamsGraph({action: 'read', conversationId: CHAT_ID});
    assert.deepEqual({...chatOutcome}, {ok: false, error: 'The refreshed Teams chat service token cannot read conversations'});
});

test('refuses to choose between several cached accounts', async () => {
    const env = environment({
        credentials: [accessToken('first', NOW_SECONDS + 3600), accessToken('second', NOW_SECONDS + 3600, SEND_SCOPES, 'other.tenant')],
    });
    const outcome = await approvedSend(env, {conversationId: CHAT_ID, html: 'hi'});
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /Several Teams accounts/);
    assert.equal(env.requests.length, 0);
});

test('requires exactly one cached chat service region', async () => {
    const missing = await environment({regions: []}).teamsGraph({action: 'read', conversationId: CHAT_ID});
    assert.equal(missing.error, 'The Teams chat service region is not cached');
    const several = await environment({regions: [CHAT_SERVICE, 'https://other.example']}).teamsGraph({action: 'read', conversationId: CHAT_ID});
    assert.equal(several.error, 'Several Teams chat service regions are cached');
});

test('posts to a channel with the team given by the chat service', async () => {
    const env = environment({
        graph: {
            '/teams/team-x?$select=displayName': found({displayName: 'Infinity'}),
            [`/teams/team-x/channels/${encodeURIComponent(CHANNEL_ID)}?$select=displayName`]: found({displayName: 'Général'}),
        },
        routes: {[`POST ${CHANNEL_PATH}/messages`]: jsonResponse(201, {id: '44'})},
    });
    const outcome = await approvedSend(env, {conversationId: CHANNEL_ID, html: 'hi'});
    assert.equal(outcome.ok, true, outcome.error);
    assert.equal(outcome.result.kind, 'channel');
    assert.equal(outcome.result.teamId, 'team-x');
    assert.equal(outcome.result.title, 'Infinity > Général');
    assert.equal(outcome.result.messageId, '44');
});

test('replies inside a channel post', async () => {
    const env = environment({routes: {[`POST ${CHANNEL_PATH}/messages/123/replies`]: jsonResponse(201, {id: '45'})}});
    const outcome = await approvedSend(env, {conversationId: CHANNEL_ID, replyTo: '123', html: 'hi'});
    assert.equal(outcome.ok, true, outcome.error);
    assert.equal(outcome.result.replyTo, '123');
    assert.equal(outcome.result.messageId, '45');
});

test('refuses replies outside channels and channels without a team', async () => {
    const chat = await environment().teamsGraph({action: 'preview', conversationId: CHAT_ID, replyTo: '123', html: 'hi'});
    assert.equal(chat.error, 'Replies are only supported in channel posts');
    const env = environment({conversations: [conversation(CHANNEL_ID, {topic: 'General'})]});
    const orphan = await env.teamsGraph({action: 'preview', conversationId: CHANNEL_ID, html: 'hi'});
    assert.equal(orphan.error, `The team of channel ${CHANNEL_ID} is unknown`);
    assert.equal(posts(env).length, 0);
});

test('surfaces service errors with their code and message', async () => {
    const graphEnv = environment({routes: {[CHAT_MESSAGES]: jsonResponse(403, {error: {code: 'Forbidden', message: 'Denied'}})}});
    const graphOutcome = await approvedSend(graphEnv, {conversationId: CHAT_ID, html: 'hi'});
    assert.equal(graphOutcome.ok, false);
    assert.match(graphOutcome.error, /^Graph POST .*\/messages failed with HTTP 403 Forbidden: Denied$/);
    const chatEnv = environment({conversations: [], routes: {[`GET ${conversationUrl(CHAT_ID)}`]: jsonResponse(404, {message: 'Not found'})}});
    const chatOutcome = await chatEnv.teamsGraph({action: 'read', conversationId: CHAT_ID});
    assert.match(chatOutcome.error, /^Teams chat service GET .* failed with HTTP 404: Not found$/);
});

test('rejects an empty message before any request', async () => {
    const env = environment();
    const outcome = await approvedSend(env, {conversationId: CHAT_ID, html: ''});
    assert.deepEqual({...outcome}, {ok: false, error: 'The message is empty'});
    assert.equal(env.requests.length, 0);
});

test('describes the displayed conversation when no request was captured', async () => {
    const env = environment({
        elements: [threadElement('', null), threadElement(CHAT_ID, 'OneOnOneChat'), threadElement(CHAT_ID, 'OneOnOneChat')],
        title: {innerText: '  Alice  \nExterne'},
    });
    const outcome = await env.teamsGraph({action: 'current'});
    assert.deepEqual(plain(outcome), {
        ok: true, result: {source: 'display', kind: 'chat', conversationId: CHAT_ID, threadType: 'OneOnOneChat', title: 'Alice'},
    });
});

test('falls back to the document title and flags channels', async () => {
    const env = environment({elements: [threadElement(CHANNEL_ID, 'Channel')], documentTitle: 'General | Team'});
    const outcome = await env.teamsGraph({action: 'current'});
    assert.equal(outcome.result.kind, 'channel');
    assert.equal(outcome.result.title, 'General | Team');
});

test('refuses ambiguous or missing displayed conversations', async () => {
    const missing = await environment().teamsGraph({action: 'current'});
    assert.equal(missing.error, 'No Teams conversation with a compose box is displayed');
    const several = await environment({elements: [threadElement(CHAT_ID), threadElement(CHANNEL_ID)]}).teamsGraph({action: 'current'});
    assert.equal(several.error, `Several Teams conversations are displayed: ${CHAT_ID}, ${CHANNEL_ID}`);
});

function terminalTarget(inside = true) {
    return {closest: selector => (inside && selector === '[id$="-terminal-panel"]' ? {} : null)};
}

test('keeps the conversation displayed when the request was submitted', async () => {
    const env = environment({elements: [threadElement(CHAT_ID, 'GroupChat')], title: {innerText: 'Projet'}});
    env.press({target: terminalTarget()});
    env.setDisplayed([threadElement(CHANNEL_ID, 'Channel')], {innerText: 'Général'});
    env.press({target: terminalTarget(), shiftKey: true});
    env.press({target: terminalTarget(false)});
    env.press({key: 'a', target: terminalTarget()});
    env.press({target: terminalTarget(), isComposing: true});
    const outcome = await env.teamsGraph({action: 'current'});
    assert.deepEqual(plain(outcome.result), {
        source: 'prompt', capturedAt: new Date(NOW_SECONDS * 1000).toISOString(),
        kind: 'chat', conversationId: CHAT_ID, threadType: 'GroupChat', title: 'Projet',
        displayedNow: {conversationId: CHANNEL_ID, title: 'Général'},
    });
});

test('omits the displayed conversation when it is the captured one and flags an empty view', async () => {
    const env = environment({elements: [threadElement(CHAT_ID, 'GroupChat')], title: {innerText: 'Projet'}});
    env.press({target: terminalTarget()});
    assert.equal('displayedNow' in (await env.teamsGraph({action: 'current'})).result, false);
    env.setDisplayed([], null);
    assert.equal((await env.teamsGraph({action: 'current'})).result.displayedNow, null);
});

test('reports a request submitted while no conversation was displayed', async () => {
    const env = environment();
    env.press({target: terminalTarget()});
    env.setDisplayed([threadElement(CHAT_ID, 'GroupChat')], {innerText: 'Projet'});
    const outcome = await env.teamsGraph({action: 'current'});
    assert.equal(outcome.error, 'No Teams conversation was identified when the request was submitted at ' +
        new Date(NOW_SECONDS * 1000).toISOString() + ': No Teams conversation with a compose box is displayed');
});

test('replaces the previous capture listener on every evaluation', async () => {
    const env = environment();
    assert.deepEqual(env.listeners.map(entry => [entry.type, entry.capture]), [['keydown', true]]);
    assert.deepEqual(env.removed, []);
    const previous = env.listeners[0].listener;
    vm.runInContext(source, vm.createContext(Object.assign(Object.create(null), {
        window: env.window, document: {}, localStorage: {length: 0}, Date,
    })));
    assert.equal(env.removed.length, 1);
    assert.equal(env.removed[0].listener, previous);
    assert.equal(env.listeners.length, 2);
    assert.equal(env.window.__teamsAssistantPromptHandler, env.listeners[1].listener);
});

function member(userId, displayName, tenantId = 'tenant-id') {
    return {userId, displayName, tenantId};
}

function echoMessage(url, init) {
    const body = JSON.parse(init.body);
    return jsonResponse(201, {id: '50', body: body.body, mentions: body.mentions});
}

function mentionEnvironment(members, users = {}, extraRoutes = {}) {
    const routes = {[CHAT_MEMBERS]: jsonResponse(200, {value: members}), [CHAT_MESSAGES]: echoMessage, ...extraRoutes};
    for (const [userId, response] of Object.entries(users)) routes[`GET ${GRAPH}/users/${userId}`] = response;
    return environment({routes});
}

test('mentions a chat member by given name only', async () => {
    const env = mentionEnvironment(
        [member('me', 'Eric Blanquer​'), member('u-marie', 'Marie Boudet​', 'other-tenant')],
        {'u-marie': jsonResponse(200, {givenName: 'Marie​'})},
    );
    const outcome = await approvedSend(env, {conversationId: CHAT_ID, html: '<p>Bonjour @Marie Boudet, merci</p>', mentions: ['Marie Boudet']});
    assert.equal(outcome.ok, true, outcome.error);
    assert.deepEqual(postedBody(env), {
        body: {contentType: 'html', content: '<p>Bonjour <at id="0">Marie</at>, merci</p>'},
        mentions: [{
            id: 0, mentionText: 'Marie',
            mentioned: {user: {
                '@odata.type': '#microsoft.graph.teamworkUserIdentity', id: 'u-marie', displayName: 'Marie Boudet',
                userIdentityType: 'aadUser', tenantId: 'other-tenant',
            }},
        }],
    });
    assert.deepEqual(plain(outcome.result.mentions), [{mentionText: 'Marie', userId: 'u-marie'}]);
});

test('matches mention names without case or accents and in any order', async () => {
    const env = mentionEnvironment([member('u-helene', 'Hélène Dupont')], {'u-helene': jsonResponse(200, {givenName: 'Hélène'})});
    const outcome = await approvedSend(env, {conversationId: CHAT_ID, html: '@DUPONT helene: ok', mentions: ['DUPONT helene']});
    assert.equal(outcome.ok, true, outcome.error);
    assert.equal(postedBody(env).body.content, '<at id="0">Hélène</at>: ok');
});

test('prefers the exact member name over a partial match', async () => {
    const env = mentionEnvironment(
        [member('u-anne', 'Marie Anne Boudet'), member('u-marie', 'Marie Boudet')],
        {'u-marie': jsonResponse(200, {givenName: 'Marie'})},
    );
    const outcome = await approvedSend(env, {conversationId: CHAT_ID, html: '@Marie Boudet', mentions: ['Marie Boudet']});
    assert.equal(outcome.ok, true, outcome.error);
    assert.equal(postedBody(env).mentions[0].mentioned.user.id, 'u-marie');
});

test('refuses an ambiguous mention without posting', async () => {
    const env = mentionEnvironment([member('u-1', 'Marie Anne Boudet'), member('u-2', 'Marie Boudet'), member(null, 'Marie Phone')]);
    const outcome = await approvedSend(env, {conversationId: CHAT_ID, html: '@Marie', mentions: ['Marie']});
    assert.deepEqual({...outcome}, {ok: false, error: 'Mention "Marie" matches several members: Marie Anne Boudet, Marie Boudet'});
    assert.equal(posts(env).length, 0);
});

test('refuses an unknown mention without posting', async () => {
    const env = mentionEnvironment([member('u-1', 'Marie Boudet')]);
    const outcome = await approvedSend(env, {conversationId: CHAT_ID, html: '@Paul', mentions: ['Paul']});
    assert.deepEqual({...outcome}, {ok: false, error: 'Mention "Paul" matches no member of the conversation'});
    assert.equal(posts(env).length, 0);
});

test('requires a placeholder for every mention before any request', async () => {
    const env = mentionEnvironment([member('u-1', 'Marie Boudet')]);
    const outcome = await approvedSend(env, {conversationId: CHAT_ID, html: '@Mariette @Marie Boudet', mentions: ['Marie', 'Marie Boudet']});
    assert.deepEqual({...outcome}, {ok: false, error: 'The message must contain @Marie where each mention goes'});
    assert.equal(env.requests.length, 0);
});

test('gives every occurrence its own mention id, longest names first', async () => {
    const env = mentionEnvironment(
        [member('u-marie', 'Marie Boudet'), member('u-marc', 'Marc Boudet')],
        {'u-marie': jsonResponse(200, {givenName: 'Marie'}), 'u-marc': jsonResponse(200, {givenName: 'Marc'})},
    );
    const outcome = await approvedSend(env, {
        conversationId: CHAT_ID, html: '@Marie Boudet, @Marc and @Marie Boudet', mentions: ['Marc', 'Marie Boudet', 'Marc'],
    });
    assert.equal(outcome.ok, true, outcome.error);
    const body = postedBody(env);
    assert.equal(body.body.content, '<at id="0">Marie</at>, <at id="1">Marc</at> and <at id="2">Marie</at>');
    assert.deepEqual(body.mentions.map(mention => [mention.id, mention.mentioned.user.id]), [[0, 'u-marie'], [1, 'u-marc'], [2, 'u-marie']]);
});

test('falls back to the display name when the user profile is unavailable', async () => {
    const env = mentionEnvironment(
        [member('u-guest', 'Dupont, Jean <Partner>'), member('u-ext', 'Anna Smith (External)')],
        {'u-guest': jsonResponse(404, {error: {code: 'Request_ResourceNotFound'}}), 'u-ext': jsonResponse(403, {})},
    );
    const outcome = await approvedSend(env, {conversationId: CHAT_ID, html: '@Jean @Anna', mentions: ['Jean', 'Anna']});
    assert.equal(outcome.ok, true, outcome.error);
    assert.equal(postedBody(env).body.content, '<at id="0">Jean</at> <at id="1">Anna</at>');
});

test('escapes the first name inserted in the HTML', async () => {
    const env = mentionEnvironment([member('u-1', 'Tom Smith')], {'u-1': jsonResponse(200, {givenName: 'T<o>m & co'})});
    const outcome = await approvedSend(env, {conversationId: CHAT_ID, html: '@Tom', mentions: ['Tom']});
    assert.equal(outcome.ok, true, outcome.error);
    assert.equal(postedBody(env).body.content, '<at id="0">T&lt;o&gt;m &amp; co</at>');
    assert.equal(postedBody(env).mentions[0].mentionText, 'T<o>m & co');
});

test('stops on unexpected profile errors', async () => {
    const env = mentionEnvironment([member('u-1', 'Tom Smith')], {'u-1': jsonResponse(500, {error: {code: 'InternalServerError'}})});
    const outcome = await approvedSend(env, {conversationId: CHAT_ID, html: '@Tom', mentions: ['Tom']});
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /HTTP 500 InternalServerError/);
    assert.equal(posts(env).length, 0);
});

test('mentions the signed-in user in the self chat', async () => {
    const selfChat = `${GRAPH}/chats/${encodeURIComponent('48:notes')}`;
    const env = environment({
        routes: {
            [`GET ${GRAPH}/me`]: jsonResponse(200, {id: 'me', displayName: 'Eric Blanquer'}),
            [`GET ${GRAPH}/users/me`]: jsonResponse(200, {givenName: 'Eric'}),
            [`POST ${selfChat}/messages`]: echoMessage,
        },
    });
    const outcome = await approvedSend(env, {conversationId: '48:notes', html: '@Eric', mentions: ['Eric']});
    assert.equal(outcome.ok, true, outcome.error);
    assert.equal(outcome.result.title, 'Eric Blanquer');
    assert.equal(postedBody(env).body.content, '<at id="0">Eric</at>');
    assert.equal('tenantId' in postedBody(env).mentions[0].mentioned.user, false);
});

test('mentions channel members from the channel member list', async () => {
    const env = environment({
        routes: {
            [`GET ${CHANNEL_PATH}/members`]: jsonResponse(200, {value: [member('u-1', 'Marie Boudet')]}),
            [`GET ${GRAPH}/users/u-1`]: jsonResponse(200, {givenName: 'Marie'}),
            [`POST ${CHANNEL_PATH}/messages`]: echoMessage,
        },
    });
    const outcome = await approvedSend(env, {conversationId: CHANNEL_ID, html: '@Marie', mentions: ['Marie']});
    assert.equal(outcome.ok, true, outcome.error);
    assert.equal(postedBody(env).body.content, '<at id="0">Marie</at>');
});

test('previews the resolved message and its destination without posting it', async () => {
    const env = environment({
        routes: {
            [CHAT_MEMBERS]: jsonResponse(200, {value: [member('u-marie', 'Marie Boudet')]}),
            [`GET ${GRAPH}/users/u-marie`]: jsonResponse(200, {givenName: 'Marie'}),
        },
    });
    const outcome = await env.teamsGraph({action: 'preview', conversationId: CHAT_ID, html: 'Hi @Marie Boudet', mentions: ['Marie Boudet']});
    assert.equal(outcome.ok, true, outcome.error);
    const {approval, ...preview} = plain(outcome.result);
    assert.match(approval, /^[0-9a-f]{12}$/);
    assert.deepEqual(preview, {
        kind: 'chat', conversationId: CHAT_ID, threadType: 'Chat', title: 'Projet', html: 'Hi <at id="0">Marie</at>',
        mentions: [{mention: 'Marie Boudet', firstName: 'Marie', displayName: 'Marie Boudet'}],
    });
    assert.equal(posts(env).length, 0);
});

test('refuses to send without an approval code', async () => {
    const env = environment();
    const outcome = await env.teamsGraph({action: 'send', conversationId: CHAT_ID, html: 'hi'});
    assert.deepEqual({...outcome}, {ok: false, error: 'No approval code: preview the message and get the user approval first'});
    assert.equal(env.requests.length, 0);
});

test('refuses an approval code from another message, conversation, reply target or mention', async () => {
    const other = '19:other@thread.v2';
    const env = environment({
        conversations: [...DEFAULT_CONVERSATIONS, conversation(other, {topic: 'Other'})],
        routes: {
            [`GET ${CHANNEL_PATH}/members`]: jsonResponse(200, {value: [member('u-1', 'Marie Boudet'), member('u-2', 'Marie Curie')]}),
            [`GET ${GRAPH}/chats/${encodeURIComponent(other)}/members`]: jsonResponse(200, {value: [member('u-1', 'Marie Boudet')]}),
            [`GET ${GRAPH}/users/u-1`]: jsonResponse(200, {givenName: 'Marie'}),
            [`GET ${GRAPH}/users/u-2`]: jsonResponse(200, {givenName: 'Marie'}),
        },
    });
    const approved = {conversationId: CHANNEL_ID, replyTo: '1', html: 'Hi @Boudet', mentions: ['Boudet']};
    const {approval} = (await env.teamsGraph({...approved, action: 'preview'})).result;
    const changes = [
        {html: 'Hi @Boudet!'},
        {conversationId: other, replyTo: undefined},
        {replyTo: '2'},
        {replyTo: undefined},
        {html: 'Hi @Curie', mentions: ['Curie']},
    ];
    for (const change of changes) {
        const outcome = await env.teamsGraph({...approved, ...change, action: 'send', approval});
        assert.deepEqual({...outcome}, {ok: false, error: 'The message, conversation or mentions differ from the approved preview'});
    }
    assert.equal(posts(env).length, 0);
});

test('resolves each distinct mention name once', async () => {
    const env = mentionEnvironment(
        [member('u-marie', 'Marie Boudet'), member('u-marc', 'Marc Boudet')],
        {'u-marie': jsonResponse(200, {givenName: 'Marie'}), 'u-marc': jsonResponse(200, {givenName: 'Marc'})},
    );
    const outcome = await env.teamsGraph({action: 'preview', conversationId: CHAT_ID, html: '@Marc @Marie Boudet', mentions: ['Marc', 'Marie Boudet', 'Marc']});
    assert.equal(outcome.ok, true, outcome.error);
    assert.equal(env.requests.filter(request => request.url.endsWith('/users/u-marc?$select=givenName')).length, 1);
    assert.deepEqual(Array.from(outcome.result.mentions, mention => mention.mention), ['Marc', 'Marie Boudet']);
});

test('asks the user in Teams before posting and restores the focus', async () => {
    const env = environment({routes: {[CHAT_MESSAGES]: jsonResponse(201, {id: '42'})}});
    const compose = env.document.createElement('textarea');
    env.document.body.append(compose);
    compose.focus();
    const outcome = await approvedSend(env, {conversationId: CHAT_ID, html: '<p>Bonjour</p>'}, current => {
        const dialog = current.dialog().children[0];
        assert.equal(dialog.getAttribute('role'), 'dialog');
        assert.equal(dialog.getAttribute('aria-modal'), 'true');
        assert.equal(current.document.getElementById(dialog.getAttribute('aria-labelledby')).textContent, 'Envoyer ce message\u00A0?');
        assert.equal(current.document.getElementById(dialog.getAttribute('aria-describedby')).textContent, 'Destination\u00A0: Projet');
        assert.deepEqual(current.texts(), ['Destination\u00A0: Projet', 'Sans réponse, l\u2019envoi est annulé dans 5\u00A0min.']);
        const frame = current.dialog().descendants().find(node => node.tagName === 'IFRAME');
        assert.equal(frame.getAttribute('sandbox'), '');
        assert.equal(frame.getAttribute('tabindex'), '-1');
        assert.equal(frame.src, 'blob:preview-1');
        assert.equal(current.blobs[0].type, 'text/html');
        assert.match(current.blobs[0].content, /^<!doctype html>.*<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'"><style>.*<\/style><\/head><body><p>Bonjour<\/p><\/body><\/html>$/);
        assert.equal(current.document.activeElement, current.button('Annuler'));
        assert.equal(current.timers[0].delay, 300_000);
        assert.equal(posts(current).length, 0);
        confirmInTeams(current);
    });
    assert.equal(outcome.ok, true, outcome.error);
    assert.equal(posts(env).length, 1);
    assert.equal(env.dialog(), null);
    assert.equal(env.document.activeElement, compose);
    assert.deepEqual(env.revoked, ['blob:preview-1']);
});

test('ignores scripted clicks and cancels on Escape', async () => {
    const env = environment();
    const outcome = await approvedSend(env, {conversationId: CHAT_ID, html: 'hi'}, current => {
        current.button('Envoyer').dispatch('click', {isTrusted: false});
        assert.notEqual(current.dialog(), null);
        current.dialog().dispatch('keydown', {key: 'Escape'});
    });
    assert.deepEqual({...outcome}, {ok: false, error: 'The user cancelled the message in the Teams confirmation dialog'});
    assert.equal(posts(env).length, 0);
    assert.equal(env.dialog(), null);
});

test('cancels with the Annuler button and keeps the focus inside the dialog', async () => {
    const env = environment();
    const outcome = await approvedSend(env, {conversationId: CHAT_ID, html: 'hi'}, current => {
        current.dialog().dispatch('keydown', {key: 'Tab'});
        assert.equal(current.document.activeElement, current.button('Envoyer'));
        current.dialog().dispatch('keydown', {key: 'Tab', shiftKey: true});
        assert.equal(current.document.activeElement, current.button('Annuler'));
        current.button('Annuler').dispatch('click', {isTrusted: false});
    });
    assert.equal(outcome.error, 'The user cancelled the message in the Teams confirmation dialog');
    assert.equal(posts(env).length, 0);
});

test('expires when the user does not answer', async () => {
    const env = environment();
    const outcome = await approvedSend(env, {conversationId: CHAT_ID, html: 'hi', confirmationTimeoutSeconds: 90}, current => {
        assert.equal(current.timers[0].delay, 90_000);
        assert.equal(current.texts()[1], 'Sans réponse, l\u2019envoi est annulé dans 2\u00A0min.');
        const send = current.button('Envoyer');
        current.expire();
        send.dispatch('click', {isTrusted: true});
    });
    assert.equal(outcome.error, 'The Teams confirmation dialog expired after 90 s without an answer');
    assert.equal(posts(env).length, 0);
    assert.equal(env.dialog(), null);
});

test('shows the reply target and mentions, and refuses a second pending message', async () => {
    const env = environment({
        routes: {
            [`GET ${CHANNEL_PATH}/members`]: jsonResponse(200, {value: [member('u-1', 'Marie Boudet')]}),
            [`GET ${GRAPH}/users/u-1`]: jsonResponse(200, {givenName: 'Marie'}),
        },
    });
    const outcome = await approvedSend(env, {conversationId: CHANNEL_ID, replyTo: '7', html: '@Marie', mentions: ['Marie']}, async current => {
        assert.deepEqual(current.texts().slice(0, 2), ['Destination\u00A0: General, réponse dans un fil', 'Mentions\u00A0: Marie (Marie Boudet)']);
        const second = await startSend(current, {conversationId: CHAT_ID, html: 'other'});
        assert.equal((await second.sending).error, 'Another Teams message is waiting for confirmation');
        current.button('Annuler').dispatch('click');
    });
    assert.equal(outcome.error, 'The user cancelled the message in the Teams confirmation dialog');
    assert.equal(posts(env).length, 0);
});

function membersUrl(chatId) {
    return `/chats/${encodeURIComponent(chatId)}/members`;
}

function lastMessage(composetime, imdisplayname = 'Someone') {
    return {lastMessage: {composetime, imdisplayname}};
}

function listEnvironment(conversations, graph = {}) {
    return environment({
        conversations: [],
        graph,
        routes: {[`GET ${CHAT_SERVICE}/v1/users/ME/conversations`]: jsonResponse(200, {conversations})},
    });
}

test('names conversations from their topic, members, channel or last author', async () => {
    const env = listEnvironment([
        conversation('19:one@unq.gbl.spaces', {productThreadType: 'OneToOneChat'}, lastMessage('2026-10-21T07:00:00.0000000Z')),
        conversation('19:group@thread.v2', {productThreadType: 'Chat'}, lastMessage('2026-10-21T06:00:00Z')),
        conversation('19:bot@unq.gbl.spaces', {}, lastMessage('2026-10-21T05:00:00Z', 'Jira Cloud​')),
        conversation('19:mine@unq.gbl.spaces', {}, lastMessage('2026-10-21T04:30:00Z', 'Eric Blanquer')),
        conversation('19:topic@thread.v2', {topic: '  Release  '}, lastMessage('2026-10-21T04:00:00Z')),
        conversation('48:notes', {}, lastMessage('2026-10-21T03:00:00Z')),
        conversation(CHANNEL_ID, {topic: 'Annonces', groupId: 'team-x'}, lastMessage('2026-10-21T02:00:00Z')),
        conversation('19:general@thread.skype', {groupId: 'team-y'}, lastMessage('2026-10-21T01:00:00Z')),
        conversation('19:lost@thread.v2', {}, lastMessage('2026-10-21T00:00:00Z')),
    ], {
        [membersUrl('19:one@unq.gbl.spaces')]: found({value: [member('me', 'Eric Blanquer'), member('u-1', 'Marie Boudet​')]}),
        [membersUrl('19:group@thread.v2')]: found({value: ['A', 'B', 'C', 'D', 'E', 'F'].map(name => member(`u-${name}`, name)).concat(member('me', 'Eric'))}),
        [membersUrl('19:bot@unq.gbl.spaces')]: found({value: [member('me', 'Eric Blanquer')]}),
        [membersUrl('19:mine@unq.gbl.spaces')]: found({value: [member('me', 'Eric Blanquer')]}),
        '/teams/team-x?$select=displayName': found({displayName: 'Infinity'}),
        '/teams/team-y?$select=displayName': found({displayName: 'Social'}),
        [`/teams/team-y/channels/${encodeURIComponent('19:general@thread.skype')}?$select=displayName`]: found({displayName: 'General'}),
    });
    const outcome = await env.teamsGraph({action: 'chats', limit: 20});
    assert.equal(outcome.ok, true, outcome.error);
    assert.deepEqual(outcome.result.map(item => item.title), [
        'Marie Boudet', 'A, B, C, D +2', 'Jira Cloud', 'Eric Blanquer', 'Release', 'Eric Blanquer', 'Infinity > Annonces', 'Social > General', null,
    ]);
    assert.deepEqual(plain(outcome.result[0]), {
        kind: 'chat', conversationId: '19:one@unq.gbl.spaces', threadType: 'OneToOneChat', title: 'Marie Boudet',
        lastActivity: '2026-10-21T07:00:00.000Z', lastAuthor: 'Someone',
    });
    assert.equal(outcome.result[6].teamId, 'team-x');
});

test('lists visible conversations by last activity and resolves only the listed titles', async () => {
    const env = listEnvironment([
        conversation('19:old@thread.v2', {}, {properties: {lastimreceivedtime: '2026-10-01T00:00:00Z'}}),
        conversation('48:mentions', {}, lastMessage('2026-10-21T09:00:00Z')),
        conversation('19:hidden@thread.v2', {hidden: 'true', topic: 'Hidden'}, lastMessage('2026-10-21T09:00:00Z')),
        conversation('19:new@thread.v2', {topic: 'New'}, lastMessage('2026-10-21T08:00:00Z')),
        conversation('19:created@thread.v2', {createdat: '2026-10-10T00:00:00Z'}),
        conversation('19:unknown@thread.v2', {}),
    ]);
    const outcome = await env.teamsGraph({action: 'chats', limit: 2});
    assert.deepEqual(outcome.result.map(item => item.conversationId), ['19:new@thread.v2', '19:created@thread.v2']);
    assert.deepEqual(batchedUrls(env), [[ME_URL, membersUrl('19:created@thread.v2')]]);
    assert.match(env.requests.find(request => request.url.startsWith(CHAT_SERVICE)).url, /\?view=msnp24Equivalent&pageSize=500&startTime=1$/);
});

test('searches every conversation title without case or accents', async () => {
    const conversations = Array.from({length: 25}, (unused, index) => conversation(`19:c${index}@thread.v2`, {},
        lastMessage(`2026-10-${String(25 - index).padStart(2, '0')}T00:00:00Z`)));
    const graph = Object.fromEntries(conversations.map((item, index) => [membersUrl(item.id),
        found({value: [member(`u-${index}`, index === 23 ? 'Hélène Dupont' : `Person ${index}`)]})]));
    const env = listEnvironment(conversations, graph);
    const outcome = await env.teamsGraph({action: 'chats', query: 'DUPONT helene', limit: 1});
    assert.deepEqual(outcome.result.map(item => item.title), ['Hélène Dupont']);
    assert.deepEqual(batchedUrls(env).map(urls => urls.length), [20, 6]);
});

function messagesUrl(threadId) {
    return `${conversationUrl(threadId)}/messages`;
}

function message(id, extra = {}) {
    return {id, messagetype: 'RichText/Html', content: `<p>${id}</p>`, imdisplayname: 'Alice', composetime: '2026-10-21T07:12:44.0960000Z', ...extra};
}

test('reads the latest user messages oldest first across pages', async () => {
    const older = `${messagesUrl(CHAT_ID)}?startTime=1&syncState=abc&pageSize=3`;
    const env = environment({
        routes: {
            [`GET ${messagesUrl(CHAT_ID)}`]: (url) => (url.includes('syncState') ? jsonResponse(200, {
                messages: [message('3'), message('2'), message('1')], _metadata: {backwardLink: null},
            }) : jsonResponse(200, {
                messages: [message('6'), {id: '5', messagetype: 'ThreadActivity/AddMember', content: '<addmember/>'}, message('4')],
                _metadata: {backwardLink: older},
            })),
        },
    });
    const outcome = await env.teamsGraph({action: 'read', conversationId: CHAT_ID, limit: 3});
    assert.equal(outcome.ok, true, outcome.error);
    assert.deepEqual(plain(outcome.result.messages).map(item => item.id), ['3', '4', '6']);
    assert.equal(outcome.result.title, 'Projet');
    const pages = env.requests.filter(request => request.url.includes('/messages'));
    assert.match(pages[0].url, /\/messages\?view=msnp24Equivalent%7CsupportsMessageProperties&pageSize=3&startTime=1$/);
    assert.equal(pages[1].url, older);
});

test('returns the latest created messages when older ones were updated recently', async () => {
    const older = `${messagesUrl(CHAT_ID)}?startTime=1&syncState=older`;
    const routes = {
        [`GET ${messagesUrl(CHAT_ID)}`]: url => jsonResponse(200, url.includes('syncState') ? {
            messages: [message('60', {version: '60'}), message('40', {version: '40'})],
        } : {
            messages: [message('50', {version: '90'}), message('80', {version: '80'}), message('70', {version: '70'})],
            _metadata: {backwardLink: older},
        }),
    };
    const two = environment({routes});
    assert.deepEqual(plain((await two.teamsGraph({action: 'read', conversationId: CHAT_ID, limit: 2})).result.messages).map(item => item.id), ['70', '80']);
    assert.equal(two.requests.filter(request => request.url.includes('/messages')).length, 1);
    const three = environment({routes});
    assert.deepEqual(plain((await three.teamsGraph({action: 'read', conversationId: CHAT_ID, limit: 3})).result.messages).map(item => item.id), ['60', '70', '80']);
    assert.equal(three.requests.filter(request => request.url.includes('/messages')).length, 2);
});

test('summarizes message details', async () => {
    const env = environment({
        routes: {
            [`GET ${messagesUrl(CHAT_ID)}`]: jsonResponse(200, {
                messages: [
                    message('5', {messagetype: 'Text', content: 'a < b', imdisplayname: '', fromDisplayNameInToken: 'Bob​'}),
                    message('4', {properties: {files: JSON.stringify([{fileName: 'report.pdf'}, {title: 'notes.txt'}, {}])}}),
                    message('3', {properties: {deletetime: 1, edittime: 1}, content: ''}),
                    message('2', {properties: {edittime: 1792529524490, subject: 'Release', files: 'not json'}}),
                    message('1', {imdisplayname: null, composetime: 'bad', originalarrivaltime: '2026-10-21T07:00:00Z', properties: {files: '[]'}}),
                ],
            }),
        },
    });
    const outcome = await env.teamsGraph({action: 'read', conversationId: CHAT_ID});
    assert.deepEqual(plain(outcome.result.messages), [
        {id: '1', time: '2026-10-21T07:00:00.000Z', author: null, html: '<p>1</p>'},
        {id: '2', time: '2026-10-21T07:12:44.096Z', author: 'Alice', subject: 'Release', edited: true, html: '<p>2</p>'},
        {id: '3', time: '2026-10-21T07:12:44.096Z', author: 'Alice', deleted: true},
        {id: '4', time: '2026-10-21T07:12:44.096Z', author: 'Alice', html: '<p>4</p>', files: ['report.pdf', 'notes.txt']},
        {id: '5', time: '2026-10-21T07:12:44.096Z', author: 'Bob', text: 'a < b'},
    ]);
});

test('reads the replies of a channel post', async () => {
    const thread = `${CHANNEL_ID};messageid=100`;
    const env = environment({
        routes: {[`GET ${messagesUrl(thread)}`]: jsonResponse(200, {messages: [message('101', {rootMessageId: '100'}), message('100', {rootMessageId: '100'})]})},
    });
    const outcome = await env.teamsGraph({action: 'read', conversationId: CHANNEL_ID, threadId: '100'});
    assert.equal(outcome.ok, true, outcome.error);
    assert.equal(outcome.result.threadId, '100');
    assert.deepEqual(plain(outcome.result.messages).map(item => [item.id, item.replyTo]), [['100', undefined], ['101', '100']]);
});

test('refuses reply threads outside channels and foreign paging links', async () => {
    const thread = await environment().teamsGraph({action: 'read', conversationId: CHAT_ID, threadId: '100'});
    assert.equal(thread.error, 'Only channel posts have reply threads');
    const env = environment({
        routes: {[`GET ${messagesUrl(CHAT_ID)}`]: jsonResponse(200, {messages: [message('1')], _metadata: {backwardLink: 'https://evil.example/steal?x=1'}})},
    });
    const outcome = await env.teamsGraph({action: 'read', conversationId: CHAT_ID, limit: 5});
    assert.equal(outcome.error, 'Unexpected Teams chat service link: https://evil.example/steal');
    assert.equal(env.requests.some(request => request.url.startsWith('https://evil.example')), false);
});

test('stops paging when the service repeats the same link', async () => {
    const same = `${messagesUrl(CHAT_ID)}?startTime=1&syncState=loop`;
    const env = environment({routes: {[`GET ${messagesUrl(CHAT_ID)}`]: jsonResponse(200, {messages: [message('1')], _metadata: {backwardLink: same}})}});
    const outcome = await env.teamsGraph({action: 'read', conversationId: CHAT_ID, limit: 50});
    assert.equal(outcome.ok, true, outcome.error);
    assert.equal(env.requests.filter(request => request.url.includes('/messages')).length, 2);
});
