(function createTeamsGraph() {
    var GRAPH_URL = 'https://graph.microsoft.com/v1.0';
    var LOGIN_URL = 'https://login.microsoftonline.com/';
    var REFRESH_SCOPE = 'https://graph.microsoft.com/.default openid profile offline_access';
    var REQUIRED_SCOPES = ['https://graph.microsoft.com/chatmessage.send', 'https://graph.microsoft.com/channelmessage.send'];
    var TOKEN_EXPIRY_MARGIN_SECONDS = 120;
    var CHANNEL_ID_PATTERN = /@thread\.(tacv2|skype)$/;
    var THREAD_ID_ATTRIBUTE = 'data-track-thread-id';
    var THREAD_TYPE_ATTRIBUTE = 'data-track-thread-type';
    var SELF_CHAT_ID = '48:notes';
    var MISSING_USER_STATUSES = [403, 404];
    var NAME_BOUNDARY = '(?![\\p{L}\\p{N}])';
    var APPROVAL_CODE_BYTES = 6;

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
            var failure = new Error('Graph ' + method + ' ' + url.split('?')[0] + ' failed with HTTP ' + response.status +
                (error.code ? ' ' + error.code : '') + (error.message ? ': ' + error.message : ''));
            failure.status = response.status;
            throw failure;
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
            return {kind: 'chat', conversationId: conversationId, path: '/chats/' + encodeURIComponent(conversationId)};
        }
        var team = teamId || await channelTeamId(token, conversationId);
        return {
            kind: 'channel', conversationId: conversationId, teamId: team,
            path: '/teams/' + encodeURIComponent(team) + '/channels/' + encodeURIComponent(conversationId),
        };
    }

    function cleanName(name) {
        return String(name || '').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();
    }

    function nameTokens(name) {
        return cleanName(name).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[\s,]+/).filter(Boolean);
    }

    function escapeRegExp(text) {
        return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }

    function escapeHtml(text) {
        return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    }

    function mentionPattern(names) {
        var longestFirst = names.slice().sort(function(first, second) { return second.length - first.length; });
        return new RegExp('@(' + longestFirst.map(escapeRegExp).join('|') + ')' + NAME_BOUNDARY, 'gu');
    }

    function requireMentionPlaceholders(html, names) {
        var found = new Set(Array.from(html.matchAll(mentionPattern(names)), function(match) { return match[1]; }));
        var missing = names.filter(function(name) { return !found.has(name); });
        if (missing.length) {
            throw new Error('The message must contain ' + missing.map(function(name) { return '@' + name; }).join(', ') +
                ' where each mention goes');
        }
    }

    async function conversationMembers(token, target) {
        if (target.conversationId === SELF_CHAT_ID) {
            var me = await graphRequest(token, 'GET', '/me?$select=id,displayName');
            return [{userId: me.id, displayName: me.displayName}];
        }
        return graphList(token, target.path + '/members');
    }

    function matchingMember(members, name) {
        var query = nameTokens(name);
        if (!query.length) throw new Error('A mention name is empty');
        var key = query.slice().sort().join(' ');
        var people = members.filter(function(member) { return member.userId; });
        var exact = people.filter(function(member) { return nameTokens(member.displayName).sort().join(' ') === key; });
        var candidates = exact.length ? exact : people.filter(function(member) {
            var tokens = nameTokens(member.displayName);
            return query.every(function(token) { return tokens.indexOf(token) !== -1; });
        });
        if (candidates.length === 1) return candidates[0];
        throw new Error(candidates.length
            ? 'Mention "' + name + '" matches several members: ' + candidates.map(function(member) { return cleanName(member.displayName); }).join(', ')
            : 'Mention "' + name + '" matches no member of the conversation');
    }

    function displayFirstName(displayName) {
        var name = cleanName(displayName);
        var comma = name.indexOf(',');
        return (comma === -1 ? name : name.slice(comma + 1).trim()).split(' ')[0];
    }

    async function firstName(token, member) {
        try {
            var user = await graphRequest(token, 'GET', '/users/' + encodeURIComponent(member.userId) + '?$select=givenName');
            if (cleanName(user.givenName)) return cleanName(user.givenName);
        } catch (ex) {
            if (MISSING_USER_STATUSES.indexOf(ex.status) === -1) throw ex;
        }
        return displayFirstName(member.displayName);
    }

    async function mentionedPeople(token, target, names) {
        var members = await conversationMembers(token, target);
        var people = new Map();
        for (var index = 0; index < names.length; index++) {
            var member = matchingMember(members, names[index]);
            people.set(names[index], {
                userId: member.userId,
                displayName: cleanName(member.displayName),
                tenantId: member.tenantId,
                firstName: await firstName(token, member),
            });
        }
        return people;
    }

    function insertMentions(html, people) {
        var mentions = [];
        var content = html.replace(mentionPattern(Array.from(people.keys())), function(match, name) {
            var person = people.get(name);
            var id = mentions.length;
            mentions.push({
                id: id,
                mentionText: person.firstName,
                mentioned: {user: {
                    '@odata.type': '#microsoft.graph.teamworkUserIdentity',
                    id: person.userId,
                    displayName: person.displayName,
                    userIdentityType: 'aadUser',
                    tenantId: person.tenantId,
                }},
            });
            return '<at id="' + id + '">' + escapeHtml(person.firstName) + '</at>';
        });
        return {content: content, mentions: mentions};
    }

    async function preparedMessage(request) {
        if (!request.conversationId) throw new Error('A conversation id is required');
        if (!request.html) throw new Error('The message is empty');
        var names = Array.from(new Set(request.mentions || []));
        if (names.length) requireMentionPlaceholders(request.html, names);
        var token = await graphToken();
        var target = await conversationTarget(token, request.conversationId, request.teamId);
        var people = names.length ? await mentionedPeople(token, target, names) : new Map();
        var payload = {body: {contentType: 'html', content: request.html}};
        if (people.size) {
            var withMentions = insertMentions(request.html, people);
            payload = {body: {contentType: 'html', content: withMentions.content}, mentions: withMentions.mentions};
        }
        return {token: token, target: target, people: people, payload: payload};
    }

    async function approvalCode(prepared) {
        var signed = JSON.stringify([prepared.target.kind, prepared.target.conversationId, prepared.target.teamId || null, prepared.payload]);
        var digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signed));
        return Array.from(new Uint8Array(digest).slice(0, APPROVAL_CODE_BYTES), function(byte) {
            return byte.toString(16).padStart(2, '0');
        }).join('');
    }

    function displayedTitle(conversationId) {
        try {
            var displayed = displayedConversation();
            return displayed.conversationId === conversationId ? displayed.title : null;
        } catch (ex) {
            return null;
        }
    }

    async function previewMessage(request) {
        var prepared = await preparedMessage(request);
        return {
            kind: prepared.target.kind,
            conversationId: prepared.target.conversationId,
            teamId: prepared.target.teamId,
            displayedTitle: displayedTitle(prepared.target.conversationId),
            html: prepared.payload.body.content,
            mentions: Array.from(prepared.people, function(entry) {
                return {mention: entry[0], firstName: entry[1].firstName, displayName: entry[1].displayName};
            }),
            approval: await approvalCode(prepared),
        };
    }

    async function sendMessage(request) {
        if (!request.approval) throw new Error('No approval code: preview the message and get the user approval first');
        var prepared = await preparedMessage(request);
        if (request.approval !== await approvalCode(prepared)) {
            throw new Error('The message, conversation or mentions differ from the approved preview');
        }
        var message = await graphRequest(prepared.token, 'POST', prepared.target.path + '/messages', prepared.payload);
        return {
            kind: prepared.target.kind,
            conversationId: prepared.target.conversationId,
            teamId: prepared.target.teamId,
            messageId: message.id,
            createdDateTime: message.createdDateTime,
            content: message.body ? message.body.content : undefined,
            mentions: (message.mentions || []).map(function(mention) {
                return {mentionText: mention.mentionText, userId: mention.mentioned && mention.mentioned.user ? mention.mentioned.user.id : undefined};
            }),
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
            if (request.action === 'preview') return {ok: true, result: await previewMessage(request)};
            if (request.action === 'send') return {ok: true, result: await sendMessage(request)};
            throw new Error('Unknown action: ' + request.action);
        } catch (ex) {
            return {ok: false, error: ex && ex.message ? ex.message : String(ex)};
        }
    };
})()
