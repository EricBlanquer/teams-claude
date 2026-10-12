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
        URLSearchParams, TextEncoder, crypto, Date: {now: () => NOW_SECONDS * 1000},
    };
    vm.createContext(context);
    return {teamsGraph: vm.runInContext(source, context), requests, writes};
}

async function approvedSend(env, request) {
    const preview = await env.teamsGraph({...request, action: 'preview'});
    if (!preview.ok) return preview;
    return env.teamsGraph({...request, action: 'send', approval: preview.result.approval});
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
    const outcome = await approvedSend(env, {conversationId: CHAT_ID, html: '<b>hi</b>'});
    assert.deepEqual(JSON.parse(JSON.stringify(outcome)), {
        ok: true,
        result: {kind: 'chat', conversationId: CHAT_ID, messageId: '42', createdDateTime: 'date', content: '<b>hi</b>', mentions: []},
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
    const outcome = await approvedSend(env, {conversationId: CHAT_ID, html: 'hi'});
    assert.equal(outcome.ok, true);
    const refresh = Object.fromEntries(env.requests[0].body);
    assert.equal(refresh.grant_type, 'refresh_token');
    assert.equal(refresh.refresh_token, 'refresh-secret');
    assert.equal(refresh.client_id, 'teams-client');
    assert.match(refresh.scope, /^https:\/\/graph\.microsoft\.com\/\.default /);
    assert.equal(env.requests.find(request => request.url.includes('/chats/')).headers.Authorization, 'Bearer refreshed');
    assert.deepEqual(env.writes, []);
});

test('reports a refresh failure without leaking token values', async () => {
    const env = environment({
        credentials: [refreshToken()],
        routes: {'POST https://login.microsoftonline.com/tenant-id/oauth2/v2.0/token': jsonResponse(400, {error: 'invalid_grant'})},
    });
    const outcome = await approvedSend(env, {conversationId: CHAT_ID, html: 'hi'});
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
    const outcome = await approvedSend(env, {conversationId: CHAT_ID, html: 'hi'});
    assert.deepEqual({...outcome}, {ok: false, error: 'The refreshed Graph token cannot send Teams messages'});
    assert.equal(env.requests.length, 1);
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
    const outcome = await approvedSend(env, {conversationId: CHANNEL_ID, html: 'hi'});
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
    const outcome = await approvedSend(env, {conversationId: '19:old@thread.skype', teamId: 'team-x', html: 'hi'});
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
    const outcome = await approvedSend(env, {conversationId: CHANNEL_ID, html: 'hi'});
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /^Channel not found in the joined teams \(1 team listings failed: .*HTTP 429 TooManyRequests: Slow down\), pass the team id$/);
});

test('surfaces Graph errors with their code and message', async () => {
    const env = environment({
        credentials: [accessToken('token', NOW_SECONDS + 3600)],
        routes: {[CHAT_MESSAGES]: jsonResponse(403, {error: {code: 'Forbidden', message: 'Denied'}})},
    });
    const outcome = await approvedSend(env, {conversationId: CHAT_ID, html: 'hi'});
    assert.equal(outcome.ok, false);
    assert.match(outcome.error, /failed with HTTP 403 Forbidden: Denied$/);
});

test('rejects an empty message before calling Graph', async () => {
    const env = environment({credentials: [accessToken('token', NOW_SECONDS + 3600)]});
    const outcome = await approvedSend(env, {conversationId: CHAT_ID, html: ''});
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

const GRAPH = 'https://graph.microsoft.com/v1.0';
const CHAT_MEMBERS = `GET ${GRAPH}/chats/${encodeURIComponent(CHAT_ID)}/members`;

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
    return environment({credentials: [accessToken('token', NOW_SECONDS + 3600)], routes});
}

function postedBody(env) {
    return JSON.parse(env.requests.find(request => request.method === 'POST').body);
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
    assert.deepEqual(JSON.parse(JSON.stringify(outcome.result.mentions)), [{mentionText: 'Marie', userId: 'u-marie'}]);
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
    assert.equal(env.requests.some(request => request.method === 'POST'), false);
});

test('refuses an unknown mention without posting', async () => {
    const env = mentionEnvironment([member('u-1', 'Marie Boudet')]);
    const outcome = await approvedSend(env, {conversationId: CHAT_ID, html: '@Paul', mentions: ['Paul']});
    assert.deepEqual({...outcome}, {ok: false, error: 'Mention "Paul" matches no member of the conversation'});
    assert.equal(env.requests.some(request => request.method === 'POST'), false);
});

test('requires a placeholder for every mention before calling Graph', async () => {
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
    assert.equal(env.requests.some(request => request.method === 'POST'), false);
});

test('mentions the signed-in user in the self chat', async () => {
    const selfChat = `${GRAPH}/chats/${encodeURIComponent('48:notes')}`;
    const env = environment({
        credentials: [accessToken('token', NOW_SECONDS + 3600)],
        routes: {
            [`GET ${GRAPH}/me`]: jsonResponse(200, {id: 'me', displayName: 'Eric Blanquer'}),
            [`GET ${GRAPH}/users/me`]: jsonResponse(200, {givenName: 'Eric'}),
            [`POST ${selfChat}/messages`]: echoMessage,
        },
    });
    const outcome = await approvedSend(env, {conversationId: '48:notes', html: '@Eric', mentions: ['Eric']});
    assert.equal(outcome.ok, true, outcome.error);
    assert.equal(postedBody(env).body.content, '<at id="0">Eric</at>');
    assert.equal('tenantId' in postedBody(env).mentions[0].mentioned.user, false);
});

test('mentions channel members from the channel member list', async () => {
    const channel = `${GRAPH}/teams/team-x/channels/${encodeURIComponent(CHANNEL_ID)}`;
    const env = environment({
        credentials: [accessToken('token', NOW_SECONDS + 3600)],
        routes: {
            [`GET ${channel}/members`]: jsonResponse(200, {value: [member('u-1', 'Marie Boudet')]}),
            [`GET ${GRAPH}/users/u-1`]: jsonResponse(200, {givenName: 'Marie'}),
            [`POST ${channel}/messages`]: echoMessage,
        },
    });
    const outcome = await approvedSend(env, {conversationId: CHANNEL_ID, teamId: 'team-x', html: '@Marie', mentions: ['Marie']});
    assert.equal(outcome.ok, true, outcome.error);
    assert.equal(postedBody(env).body.content, '<at id="0">Marie</at>');
});

test('previews the resolved message without posting it', async () => {
    const env = environment({
        credentials: [accessToken('token', NOW_SECONDS + 3600)],
        routes: {
            [CHAT_MEMBERS]: jsonResponse(200, {value: [member('u-marie', 'Marie Boudet')]}),
            [`GET ${GRAPH}/users/u-marie`]: jsonResponse(200, {givenName: 'Marie'}),
        },
        elements: [threadElement(CHAT_ID, 'GroupChat')],
        title: {innerText: 'Projet'},
    });
    const outcome = await env.teamsGraph({action: 'preview', conversationId: CHAT_ID, html: 'Hi @Marie Boudet', mentions: ['Marie Boudet']});
    assert.equal(outcome.ok, true, outcome.error);
    const {approval, ...preview} = JSON.parse(JSON.stringify(outcome.result));
    assert.match(approval, /^[0-9a-f]{12}$/);
    assert.deepEqual(preview, {
        kind: 'chat', conversationId: CHAT_ID, displayedTitle: 'Projet', html: 'Hi <at id="0">Marie</at>',
        mentions: [{mention: 'Marie Boudet', firstName: 'Marie', displayName: 'Marie Boudet'}],
    });
    assert.equal(env.requests.some(request => request.method === 'POST'), false);
});

test('leaves the title empty when the previewed conversation is not displayed', async () => {
    const env = environment({credentials: [accessToken('token', NOW_SECONDS + 3600)], elements: [threadElement(CHANNEL_ID, 'Channel')]});
    const outcome = await env.teamsGraph({action: 'preview', conversationId: CHAT_ID, html: 'hi'});
    assert.equal(outcome.result.displayedTitle, null);
    assert.equal(outcome.result.html, 'hi');
});

test('refuses to send without an approval code', async () => {
    const env = environment({credentials: [accessToken('token', NOW_SECONDS + 3600)]});
    const outcome = await env.teamsGraph({action: 'send', conversationId: CHAT_ID, html: 'hi'});
    assert.deepEqual({...outcome}, {ok: false, error: 'No approval code: preview the message and get the user approval first'});
    assert.equal(env.requests.length, 0);
});

test('refuses an approval code from another message, conversation or mention', async () => {
    const env = environment({
        credentials: [accessToken('token', NOW_SECONDS + 3600)],
        routes: {
            [CHAT_MEMBERS]: jsonResponse(200, {value: [member('u-1', 'Marie Boudet'), member('u-2', 'Marie Curie')]}),
            [`GET ${GRAPH}/chats/${encodeURIComponent('19:other@thread.v2')}/members`]: jsonResponse(200, {value: [member('u-1', 'Marie Boudet')]}),
            [`GET ${GRAPH}/users/u-1`]: jsonResponse(200, {givenName: 'Marie'}),
            [`GET ${GRAPH}/users/u-2`]: jsonResponse(200, {givenName: 'Marie'}),
        },
    });
    const approved = {conversationId: CHAT_ID, html: 'Hi @Boudet', mentions: ['Boudet']};
    const {approval} = (await env.teamsGraph({...approved, action: 'preview'})).result;
    const changes = [
        {html: 'Hi @Boudet!'},
        {conversationId: '19:other@thread.v2'},
        {html: 'Hi @Curie', mentions: ['Curie']},
    ];
    for (const change of changes) {
        const outcome = await env.teamsGraph({...approved, ...change, action: 'send', approval});
        assert.deepEqual({...outcome}, {ok: false, error: 'The message, conversation or mentions differ from the approved preview'});
    }
    assert.equal(env.requests.some(request => request.method === 'POST'), false);
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
