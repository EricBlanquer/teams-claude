const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

const source = fs.readFileSync(`${__dirname}/teams_graph.js`, 'utf8');
const NOW_SECONDS = 1_800_000_000;
const ACCOUNT = 'user-id.tenant-id';
const SEND_SCOPES = 'openid https://graph.microsoft.com/ChatMessage.Send https://graph.microsoft.com/ChannelMessage.Send';
const CHAT_ID = '19:abc_def@unq.gbl.spaces';
const CHANNEL_ID = '19:channel@thread.tacv2';

function accessToken(secret, expiresOn, target = SEND_SCOPES, homeAccountId = ACCOUNT) {
    return {credentialType: 'AccessToken', homeAccountId, target, secret, expiresOn: String(expiresOn)};
}

function refreshToken(homeAccountId = ACCOUNT) {
    return {credentialType: 'RefreshToken', homeAccountId, clientId: 'teams-client', secret: 'refresh-secret'};
}

function jsonResponse(status, payload) {
    return {ok: status >= 200 && status < 300, status, json: async () => payload};
}

function environment({credentials = [], routes = {}, elements = [], title = null, documentTitle = 'Chat | Teams'} = {}) {
    const entries = [...credentials.map(credential => JSON.stringify(credential)), 'not json', 'true'];
    const requests = [];
    const writes = [];
    const context = {
        localStorage: {
            length: entries.length,
            key: index => `key-${index}`,
            getItem: key => entries[Number(key.slice(4))],
            setItem: (...args) => writes.push(args),
        },
        document: {
            title: documentTitle,
            querySelectorAll: selector => (selector === '[data-track-thread-id]' ? elements : []),
            querySelector: selector => (selector === '[data-tid="chat-title"]' ? title : null),
        },
        fetch: async (url, init = {}) => {
            requests.push({url, method: init.method, headers: init.headers, body: init.body});
            const route = routes[`${init.method} ${url.split('?')[0]}`];
            if (!route) throw new Error(`Unexpected request ${init.method} ${url}`);
            return typeof route === 'function' ? route(url, init) : route;
        },
        URLSearchParams, Date: {now: () => NOW_SECONDS * 1000},
    };
    vm.createContext(context);
    return {teamsGraph: vm.runInContext(source, context), requests, writes};
}

function threadElement(id, type) {
    return {getAttribute: name => ({'data-track-thread-id': id, 'data-track-thread-type': type}[name] ?? null)};
}

const CHAT_MESSAGES = `POST https://graph.microsoft.com/v1.0/chats/${encodeURIComponent(CHAT_ID)}/messages`;

test('sends HTML to a chat with the freshest cached Graph token', async () => {
    const env = environment({
        credentials: [
            accessToken('older', NOW_SECONDS + 600),
            accessToken('fresh', NOW_SECONDS + 3600),
            accessToken('expiring', NOW_SECONDS + 30),
            accessToken('no-send-scope', NOW_SECONDS + 7200, 'https://graph.microsoft.com/User.Read'),
            refreshToken(),
        ],
        routes: {[CHAT_MESSAGES]: jsonResponse(201, {id: '42', createdDateTime: 'date', body: {content: '<b>hi</b>'}})},
    });
    const outcome = await env.teamsGraph({action: 'send', conversationId: CHAT_ID, html: '<b>hi</b>'});
    assert.deepEqual(JSON.parse(JSON.stringify(outcome)), {
        ok: true,
        result: {kind: 'chat', conversationId: CHAT_ID, messageId: '42', createdDateTime: 'date', content: '<b>hi</b>'},
    });
    assert.equal(env.requests.length, 1);
    assert.equal(env.requests[0].headers.Authorization, 'Bearer fresh');
    assert.deepEqual(JSON.parse(env.requests[0].body), {body: {contentType: 'html', content: '<b>hi</b>'}});
});

test('refreshes the Graph token without touching the Teams cache when cached tokens expire', async () => {
    const env = environment({
        credentials: [accessToken('expired', NOW_SECONDS + 60), refreshToken()],
        routes: {
            'POST https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token': jsonResponse(200, {
                access_token: 'refreshed', scope: SEND_SCOPES,
            }),
            [CHAT_MESSAGES]: jsonResponse(201, {id: '43'}),
        },
    });
    const outcome = await env.teamsGraph({action: 'send', conversationId: CHAT_ID, html: 'hi'});
    assert.equal(outcome.ok, true);
    const refresh = Object.fromEntries(env.requests[0].body);
    assert.equal(refresh.grant_type, 'refresh_token');
    assert.equal(refresh.refresh_token, 'refresh-secret');
    assert.equal(refresh.client_id, 'teams-client');
    assert.match(refresh.scope, /^https:\/\/graph\.microsoft\.com\/\.default /);
    assert.equal(env.requests[1].headers.Authorization, 'Bearer refreshed');
    assert.deepEqual(env.writes, []);
});

test('reports a refresh failure without leaking token values', async () => {
    const env = environment({
        credentials: [refreshToken()],
        routes: {'POST https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token': jsonResponse(400, {error: 'invalid_grant'})},
    });
    const outcome = await env.teamsGraph({action: 'send', conversationId: CHAT_ID, html: 'hi'});
    assert.deepEqual({...outcome}, {ok: false, error: 'Graph token refresh failed with HTTP 400 invalid_grant'});
});

test('rejects a refreshed token that cannot send messages', async () => {
    const env = environment({
        credentials: [refreshToken()],
        routes: {
            'POST https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token': jsonResponse(200, {
                access_token: 'read-only', scope: 'https://graph.microsoft.com/User.Read',
            }),
        },
    });
    const outcome = await env.teamsGraph({action: 'send', conversationId: CHAT_ID, html: 'hi'});
    assert.deepEqual({...outcome}, {ok: false, error: 'The refreshed Graph token cannot send Teams messages'});
    assert.equal(env.requests.length, 1);
});

test('refuses to choose between several cached accounts', async () => {
    const env = environment({
        credentials: [accessToken('first', NOW_SECONDS + 3600), accessToken('second', NOW_SECONDS + 3600, SEND_SCOPES, 'other.tenant')],
    });
    const outcome = await env.teamsGraph({action: 'send', conversationId: CHAT_ID, html: 'hi'});
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /Several Teams accounts/);
    assert.equal(env.requests.length, 0);
});

test('posts to a channel after resolving its team from the joined teams', async () => {
    const teamsUrl = 'https://graph.microsoft.com/v1.0/teams';
    const env = environment({
        credentials: [accessToken('token', NOW_SECONDS + 3600)],
        routes: {
            'GET https://graph.microsoft.com/v1.0/me/joinedTeams': jsonResponse(200, {
                value: [{id: 'team-a'}, {id: 'team-b'}, {id: 'team-c'}],
            }),
            [`GET ${teamsUrl}/team-a/channels`]: jsonResponse(200, {
                value: [{id: '19:other@thread.tacv2'}], '@odata.nextLink': `${teamsUrl}/team-a/channels/next`,
            }),
            [`GET ${teamsUrl}/team-a/channels/next`]: jsonResponse(200, {value: [{id: CHANNEL_ID}]}),
            [`GET ${teamsUrl}/team-b/channels`]: jsonResponse(200, {value: [{id: '19:more@thread.tacv2'}]}),
            [`GET ${teamsUrl}/team-c/channels`]: jsonResponse(403, {error: {code: 'Forbidden'}}),
            [`POST ${teamsUrl}/team-a/channels/${encodeURIComponent(CHANNEL_ID)}/messages`]: jsonResponse(201, {id: '44'}),
        },
    });
    const outcome = await env.teamsGraph({action: 'send', conversationId: CHANNEL_ID, html: 'hi'});
    assert.equal(outcome.ok, true);
    assert.equal(outcome.result.kind, 'channel');
    assert.equal(outcome.result.teamId, 'team-a');
    assert.equal(outcome.result.messageId, '44');
});

test('uses the given team id for a channel without listing teams', async () => {
    const env = environment({
        credentials: [accessToken('token', NOW_SECONDS + 3600)],
        routes: {
            [`POST https://graph.microsoft.com/v1.0/teams/team-x/channels/${encodeURIComponent('19:old@thread.skype')}/messages`]:
                jsonResponse(201, {id: '45'}),
        },
    });
    const outcome = await env.teamsGraph({action: 'send', conversationId: '19:old@thread.skype', teamId: 'team-x', html: 'hi'});
    assert.equal(outcome.ok, true);
    assert.equal(env.requests.length, 1);
});

test('explains when a channel is missing from the joined teams', async () => {
    const env = environment({
        credentials: [accessToken('token', NOW_SECONDS + 3600)],
        routes: {
            'GET https://graph.microsoft.com/v1.0/me/joinedTeams': jsonResponse(200, {value: [{id: 'team-a'}]}),
            'GET https://graph.microsoft.com/v1.0/teams/team-a/channels': jsonResponse(429, {error: {code: 'TooManyRequests', message: 'Slow down'}}),
        },
    });
    const outcome = await env.teamsGraph({action: 'send', conversationId: CHANNEL_ID, html: 'hi'});
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /^Channel not found in the joined teams \(1 team listings failed: .*HTTP 429 TooManyRequests: Slow down\), pass the team id$/);
});

test('surfaces Graph errors with their code and message', async () => {
    const env = environment({
        credentials: [accessToken('token', NOW_SECONDS + 3600)],
        routes: {[CHAT_MESSAGES]: jsonResponse(403, {error: {code: 'Forbidden', message: 'Denied'}})},
    });
    const outcome = await env.teamsGraph({action: 'send', conversationId: CHAT_ID, html: 'hi'});
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /failed with HTTP 403 Forbidden: Denied$/);
});

test('rejects an empty message before calling Graph', async () => {
    const env = environment({credentials: [accessToken('token', NOW_SECONDS + 3600)]});
    const outcome = await env.teamsGraph({action: 'send', conversationId: CHAT_ID, html: ''});
    assert.deepEqual({...outcome}, {ok: false, error: 'The message is empty'});
    assert.equal(env.requests.length, 0);
});

test('describes the displayed conversation from the compose box', async () => {
    const env = environment({
        elements: [threadElement('', null), threadElement(CHAT_ID, 'OneOnOneChat'), threadElement(CHAT_ID, 'OneOnOneChat')],
        title: {innerText: '  Alice  '},
    });
    const outcome = await env.teamsGraph({action: 'current'});
    assert.deepEqual(JSON.parse(JSON.stringify(outcome)), {
        ok: true, result: {kind: 'chat', conversationId: CHAT_ID, threadType: 'OneOnOneChat', title: 'Alice'},
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
