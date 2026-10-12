(function createTeamsGraph() {
    var GRAPH_URL = 'https://graph.microsoft.com/v1.0';
    var LOGIN_URL = 'https://login.microsoftonline.com/';
    var REFRESH_SCOPE = 'https://graph.microsoft.com/.default openid profile offline_access';
    var REQUIRED_SCOPES = ['https://graph.microsoft.com/chatmessage.send', 'https://graph.microsoft.com/channelmessage.send'];
    var TOKEN_EXPIRY_MARGIN_SECONDS = 120;
    var CHANNEL_ID_PATTERN = /@thread\.(tacv2|skype)$/;
    var THREAD_ID_ATTRIBUTE = 'data-track-thread-id';
    var THREAD_TYPE_ATTRIBUTE = 'data-track-thread-type';

    function cachedCredentials(type) {
        var credentials = [];
        for (var index = 0; index < localStorage.length; index++) {
            var credential;
            try {
                credential = JSON.parse(localStorage.getItem(localStorage.key(index)));
            } catch (ex) {
                continue;
            }
            if (credential && credential.credentialType === type) credentials.push(credential);
        }
        return credentials;
    }

    function hasSendScopes(scopeList) {
        var scopes = String(scopeList || '').toLowerCase().split(/\s+/);
        return REQUIRED_SCOPES.every(function(scope) { return scopes.indexOf(scope) !== -1; });
    }

    async function readJson(response) {
        try {
            return await response.json();
        } catch (ex) {
            return {};
        }
    }

    async function refreshAccessToken(refreshToken) {
        var tenant = String(refreshToken.homeAccountId || '').split('.')[1];
        if (!tenant) throw new Error('The cached Teams refresh token has no tenant');
        var response = await fetch(LOGIN_URL + encodeURIComponent(tenant) + '/oauth2/v2.0/token', {
            method: 'POST',
            body: new URLSearchParams({
                client_id: refreshToken.clientId,
                grant_type: 'refresh_token',
                refresh_token: refreshToken.secret,
                scope: REFRESH_SCOPE,
            }),
        });
        var payload = await readJson(response);
        if (!response.ok || !payload.access_token) {
            throw new Error('Graph token refresh failed with HTTP ' + response.status +
                (payload.error ? ' ' + payload.error : ''));
        }
        if (!hasSendScopes(payload.scope)) throw new Error('The refreshed Graph token cannot send Teams messages');
        return payload.access_token;
    }

    async function graphToken() {
        var accessTokens = cachedCredentials('AccessToken').filter(function(token) { return hasSendScopes(token.target); });
        var refreshTokens = cachedCredentials('RefreshToken');
        var accounts = new Set(accessTokens.concat(refreshTokens).map(function(credential) { return credential.homeAccountId; }));
        if (accounts.size > 1) throw new Error('Several Teams accounts are cached, the Graph identity is ambiguous');
        var now = Date.now() / 1000;
        var validTokens = accessTokens
            .filter(function(token) { return Number(token.expiresOn) - now > TOKEN_EXPIRY_MARGIN_SECONDS; })
            .sort(function(first, second) { return Number(second.expiresOn) - Number(first.expiresOn); });
        if (validTokens.length) return validTokens[0].secret;
        if (refreshTokens.length !== 1) {
            throw new Error('No valid Graph token is cached and ' + refreshTokens.length + ' Teams refresh tokens were found');
        }
        return refreshAccessToken(refreshTokens[0]);
    }

    async function graphRequest(token, method, url, body) {
        var response = await fetch(url.indexOf(GRAPH_URL) === 0 ? url : GRAPH_URL + url, {
            method: method,
            headers: {Authorization: 'Bearer ' + token, 'Content-Type': 'application/json'},
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        var payload = await readJson(response);
        if (!response.ok) {
            var error = payload.error || {};
            throw new Error('Graph ' + method + ' ' + url.split('?')[0] + ' failed with HTTP ' + response.status +
                (error.code ? ' ' + error.code : '') + (error.message ? ': ' + error.message : ''));
        }
        return payload;
    }

    async function graphList(token, url) {
        var items = [];
        var next = url;
        while (next) {
            var page = await graphRequest(token, 'GET', next);
            items = items.concat(page.value || []);
            next = page['@odata.nextLink'];
        }
        return items;
    }

    async function channelTeamId(token, channelId) {
        var teams = await graphList(token, '/me/joinedTeams?$select=id,displayName');
        var channelLists = await Promise.allSettled(teams.map(function(team) {
            return graphList(token, '/teams/' + encodeURIComponent(team.id) + '/channels?$select=id');
        }));
        var matches = teams.filter(function(team, index) {
            return channelLists[index].status === 'fulfilled' &&
                channelLists[index].value.some(function(channel) { return channel.id === channelId; });
        });
        if (matches.length === 1) return matches[0].id;
        var failures = channelLists.filter(function(list) { return list.status === 'rejected'; });
        throw new Error((matches.length ? 'Channel found in several joined teams' : 'Channel not found in the joined teams') +
            (failures.length ? ' (' + failures.length + ' team listings failed: ' + failures[0].reason.message + ')' : '') +
            ', pass the team id');
    }

    async function conversationTarget(token, conversationId, teamId) {
        if (!CHANNEL_ID_PATTERN.test(conversationId)) {
            return {kind: 'chat', conversationId: conversationId, path: '/chats/' + encodeURIComponent(conversationId) + '/messages'};
        }
        var team = teamId || await channelTeamId(token, conversationId);
        return {
            kind: 'channel', conversationId: conversationId, teamId: team,
            path: '/teams/' + encodeURIComponent(team) + '/channels/' + encodeURIComponent(conversationId) + '/messages',
        };
    }

    async function sendMessage(request) {
        if (!request.conversationId) throw new Error('A conversation id is required');
        if (!request.html) throw new Error('The message is empty');
        var token = await graphToken();
        var target = await conversationTarget(token, request.conversationId, request.teamId);
        var message = await graphRequest(token, 'POST', target.path, {body: {contentType: 'html', content: request.html}});
        return {
            kind: target.kind,
            conversationId: target.conversationId,
            teamId: target.teamId,
            messageId: message.id,
            createdDateTime: message.createdDateTime,
            content: message.body ? message.body.content : undefined,
        };
    }

    function displayedConversation() {
        var elements = Array.from(document.querySelectorAll('[' + THREAD_ID_ATTRIBUTE + ']'))
            .filter(function(element) { return element.getAttribute(THREAD_ID_ATTRIBUTE); });
        var ids = Array.from(new Set(elements.map(function(element) { return element.getAttribute(THREAD_ID_ATTRIBUTE); })));
        if (!ids.length) throw new Error('No Teams conversation with a compose box is displayed');
        if (ids.length > 1) throw new Error('Several Teams conversations are displayed: ' + ids.join(', '));
        var title = document.querySelector('[data-tid="chat-title"]');
        return {
            kind: CHANNEL_ID_PATTERN.test(ids[0]) ? 'channel' : 'chat',
            conversationId: ids[0],
            threadType: elements[0].getAttribute(THREAD_TYPE_ATTRIBUTE),
            title: title && title.innerText.trim() ? title.innerText.trim() : document.title,
        };
    }

    return async function teamsGraph(request) {
        try {
            if (request.action === 'current') return {ok: true, result: displayedConversation()};
            if (request.action === 'send') return {ok: true, result: await sendMessage(request)};
            throw new Error('Unknown action: ' + request.action);
        } catch (ex) {
            return {ok: false, error: ex && ex.message ? ex.message : String(ex)};
        }
    };
})()
