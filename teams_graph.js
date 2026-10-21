(function createTeamsGraph() {
    var GRAPH_URL = 'https://graph.microsoft.com/v1.0';
    var LOGIN_URL = 'https://login.microsoftonline.com/';
    var GRAPH_RESOURCE = {
        name: 'Graph',
        scopes: ['https://graph.microsoft.com/chatmessage.send', 'https://graph.microsoft.com/channelmessage.send'],
        refreshScope: 'https://graph.microsoft.com/.default openid profile offline_access',
        missingScopes: 'The refreshed Graph token cannot send Teams messages',
    };
    var CHAT_SERVICE_RESOURCE = {
        name: 'Teams chat service',
        scopes: ['https://ic3.teams.office.com/teams.accessasuser.all'],
        refreshScope: 'https://ic3.teams.office.com/.default openid profile offline_access',
        missingScopes: 'The refreshed Teams chat service token cannot read conversations',
    };
    var TOKEN_EXPIRY_MARGIN_SECONDS = 120;
    var REGION_DISCOVERY_SUFFIX = '.Discover.DISCOVER-REGION-GTM';
    var CONVERSATION_VIEW = 'msnp24Equivalent';
    var MESSAGE_VIEW = 'msnp24Equivalent|supportsMessageProperties';
    var CONVERSATION_PAGE_SIZE = 500;
    var MESSAGE_PAGE_SIZE = 200;
    var DEFAULT_CONVERSATION_LIMIT = 20;
    var DEFAULT_MESSAGE_LIMIT = 30;
    var USER_MESSAGE_TYPE = /^(Text|RichText)(\/|$)/;
    var PLAIN_TEXT_MESSAGE_TYPE = 'Text';
    var GRAPH_BATCH_SIZE = 20;
    var TITLE_MEMBER_LIMIT = 4;
    var ME_URL = '/me?$select=id,displayName';
    var CHANNEL_ID_PATTERN = /@thread\.(tacv2|skype)$/;
    var STREAM_ID_PREFIX = '48:';
    var THREAD_ID_ATTRIBUTE = 'data-track-thread-id';
    var THREAD_TYPE_ATTRIBUTE = 'data-track-thread-type';
    var TERMINAL_PANEL_SELECTOR = '[id$="-terminal-panel"]';
    var PROMPT_CAPTURE = '__teamsAssistantPromptConversation';
    var PROMPT_HANDLER = '__teamsAssistantPromptHandler';
    var SELF_CHAT_ID = '48:notes';
    var MISSING_USER_STATUSES = [403, 404];
    var NAME_BOUNDARY = '(?![\\p{L}\\p{N}])';
    var APPROVAL_CODE_BYTES = 6;
    var CONFIRMATION_DIALOG_ID = 'teams-assistant-send-confirmation';
    var CONFIRMATION_TITLE_ID = CONFIRMATION_DIALOG_ID + '-title';
    var CONFIRMATION_DESTINATION_ID = CONFIRMATION_DIALOG_ID + '-destination';
    var DEFAULT_CONFIRMATION_TIMEOUT_SECONDS = 300;
    var CONFIRMED = 'confirmed';
    var CANCELLED = 'cancelled';
    var EXPIRED = 'expired';
    var OVERLAY_STYLES = 'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;' +
        'background:rgba(0,0,0,0.45);';
    var DIALOG_STYLES = 'display:flex;flex-direction:column;gap:12px;box-sizing:border-box;width:min(640px,calc(100vw - 32px));' +
        'max-height:calc(100vh - 32px);padding:20px;border-radius:8px;background:#ffffff;color:#242424;' +
        'box-shadow:0 8px 32px rgba(0,0,0,0.35);font:14px/1.45 "Segoe UI",system-ui,sans-serif;';
    var HEADING_STYLES = 'margin:0;font-size:18px;font-weight:600;color:#242424;';
    var TEXT_STYLES = 'margin:0;color:#242424;overflow-wrap:anywhere;';
    var HINT_STYLES = 'margin:0;color:#616161;font-size:12px;';
    var FRAME_STYLES = 'width:100%;height:min(320px,45vh);border:1px solid #d1d1d1;border-radius:4px;background:#ffffff;';
    var BUTTON_ROW_STYLES = 'display:flex;justify-content:flex-end;gap:8px;';
    var BUTTON_STYLES = 'padding:6px 16px;border-radius:4px;font:inherit;font-weight:600;cursor:pointer;';
    var CANCEL_BUTTON_STYLES = BUTTON_STYLES + 'border:1px solid #8a8886;background:#ffffff;color:#242424;';
    var SEND_BUTTON_STYLES = BUTTON_STYLES + 'border:1px solid #5b5fc7;background:#5b5fc7;color:#ffffff;';
    var PREVIEW_POLICY = "default-src 'none'; style-src 'unsafe-inline'";
    var PREVIEW_STYLES = 'body{margin:12px;background:#ffffff;color:#242424;font:14px/1.45 "Segoe UI",system-ui,sans-serif;' +
        'overflow-wrap:anywhere}table{border-collapse:collapse}td,th{border:1px solid #c8c6c4;padding:4px 8px}' +
        'pre,code,codeblock{font-family:Consolas,"Courier New",monospace}' +
        'pre,codeblock{display:block;white-space:pre-wrap;background:#f5f5f5;padding:8px}' +
        'blockquote{margin:0;padding-left:12px;border-left:3px solid #c8c6c4}at{font-weight:600;color:#4f52b2}';

    function storageEntries() {
        var entries = [];
        for (var index = 0; index < localStorage.length; index++) {
            var key = localStorage.key(index);
            try {
                entries.push({key: key, value: JSON.parse(localStorage.getItem(key))});
            } catch (ex) {
                continue;
            }
        }
        return entries;
    }

    function cachedCredentials(type) {
        return storageEntries()
            .map(function(entry) { return entry.value; })
            .filter(function(credential) { return credential && credential.credentialType === type; });
    }

    function hasScopes(scopeList, scopes) {
        var granted = String(scopeList || '').toLowerCase().split(/\s+/);
        return scopes.every(function(scope) { return granted.indexOf(scope) !== -1; });
    }

    async function readJson(response) {
        try {
            return await response.json();
        } catch (ex) {
            return {};
        }
    }

    async function refreshAccessToken(refreshToken, resource) {
        var tenant = String(refreshToken.homeAccountId || '').split('.')[1];
        if (!tenant) throw new Error('The cached Teams refresh token has no tenant');
        var response = await fetch(LOGIN_URL + encodeURIComponent(tenant) + '/oauth2/v2.0/token', {
            method: 'POST',
            body: new URLSearchParams({
                client_id: refreshToken.clientId,
                grant_type: 'refresh_token',
                refresh_token: refreshToken.secret,
                scope: resource.refreshScope,
            }),
        });
        var payload = await readJson(response);
        if (!response.ok || !payload.access_token) {
            throw new Error(resource.name + ' token refresh failed with HTTP ' + response.status +
                (payload.error ? ' ' + payload.error : ''));
        }
        if (!hasScopes(payload.scope, resource.scopes)) throw new Error(resource.missingScopes);
        return payload.access_token;
    }

    async function accessToken(resource) {
        var accessTokens = cachedCredentials('AccessToken').filter(function(token) { return hasScopes(token.target, resource.scopes); });
        var refreshTokens = cachedCredentials('RefreshToken');
        var accounts = new Set(accessTokens.concat(refreshTokens).map(function(credential) { return credential.homeAccountId; }));
        if (accounts.size > 1) throw new Error('Several Teams accounts are cached, the ' + resource.name + ' identity is ambiguous');
        var now = Date.now() / 1000;
        var validTokens = accessTokens
            .filter(function(token) { return Number(token.expiresOn) - now > TOKEN_EXPIRY_MARGIN_SECONDS; })
            .sort(function(first, second) { return Number(second.expiresOn) - Number(first.expiresOn); });
        if (validTokens.length) return validTokens[0].secret;
        if (refreshTokens.length !== 1) {
            throw new Error('No valid ' + resource.name + ' token is cached and ' + refreshTokens.length + ' Teams refresh tokens were found');
        }
        return refreshAccessToken(refreshTokens[0], resource);
    }

    function chatServiceUrl() {
        var urls = new Set(storageEntries()
            .filter(function(entry) { return entry.key.endsWith(REGION_DISCOVERY_SUFFIX); })
            .map(function(entry) { return entry.value && entry.value.item && entry.value.item.chatServiceAfd; })
            .filter(Boolean));
        if (urls.size !== 1) {
            throw new Error(urls.size ? 'Several Teams chat service regions are cached' : 'The Teams chat service region is not cached');
        }
        return Array.from(urls)[0];
    }

    async function teamsClients() {
        return {
            graph: await accessToken(GRAPH_RESOURCE),
            chat: await accessToken(CHAT_SERVICE_RESOURCE),
            chatService: chatServiceUrl(),
        };
    }

    async function serviceRequest(service, token, method, url, body) {
        var headers = {Authorization: 'Bearer ' + token};
        if (body !== undefined) headers['Content-Type'] = 'application/json';
        var response = await fetch(url, {
            method: method,
            headers: headers,
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        var payload = await readJson(response);
        if (!response.ok) {
            var error = payload.error || {};
            var message = error.message || payload.message;
            var failure = new Error(service + ' ' + method + ' ' + url.split('?')[0] + ' failed with HTTP ' + response.status +
                (error.code ? ' ' + error.code : '') + (message ? ': ' + message : ''));
            failure.status = response.status;
            throw failure;
        }
        return payload;
    }

    function graphRequest(token, method, url, body) {
        return serviceRequest(GRAPH_RESOURCE.name, token, method, url.indexOf(GRAPH_URL) === 0 ? url : GRAPH_URL + url, body);
    }

    function chatServiceRequest(clients, url) {
        var absolute = url.indexOf('/') === 0 ? clients.chatService + url : url;
        if (absolute.indexOf(clients.chatService + '/') !== 0) throw new Error('Unexpected Teams chat service link: ' + url.split('?')[0]);
        return serviceRequest(CHAT_SERVICE_RESOURCE.name, clients.chat, 'GET', absolute);
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

    async function graphBatch(token, urls) {
        var unique = Array.from(new Set(urls));
        var responses = new Map();
        for (var start = 0; start < unique.length; start += GRAPH_BATCH_SIZE) {
            var chunk = unique.slice(start, start + GRAPH_BATCH_SIZE);
            var batch = await graphRequest(token, 'POST', '/$batch', {
                requests: chunk.map(function(url, index) { return {id: String(index), method: 'GET', url: url}; }),
            });
            (batch.responses || []).forEach(function(response) { responses.set(chunk[Number(response.id)], response); });
        }
        return responses;
    }

    function batchBody(responses, url) {
        var response = responses.get(url);
        return response && response.status >= 200 && response.status < 300 ? response.body : null;
    }

    function cleanName(name) {
        return String(name || '').replace(/\p{Cf}/gu, '').replace(/\s+/g, ' ').trim();
    }

    function nameTokens(name) {
        return cleanName(name).normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().split(/[\s,]+/).filter(Boolean);
    }

    function isoTime(value) {
        var time = Date.parse(value);
        return isNaN(time) ? null : new Date(time).toISOString();
    }

    function conversationPath(conversationId) {
        return '/v1/users/ME/conversations/' + encodeURIComponent(conversationId);
    }

    function teamUrl(teamId) {
        return '/teams/' + encodeURIComponent(teamId) + '?$select=displayName';
    }

    function channelUrl(teamId, channelId) {
        return '/teams/' + encodeURIComponent(teamId) + '/channels/' + encodeURIComponent(channelId) + '?$select=displayName';
    }

    function chatMembersUrl(chatId) {
        return '/chats/' + encodeURIComponent(chatId) + '/members';
    }

    function threadProperties(conversation) {
        return conversation.threadProperties || {};
    }

    function titleLookups(conversation) {
        var properties = threadProperties(conversation);
        if (CHANNEL_ID_PATTERN.test(conversation.id)) {
            return properties.groupId ? [teamUrl(properties.groupId), channelUrl(properties.groupId, conversation.id)] : [];
        }
        if (conversation.id === SELF_CHAT_ID || cleanName(properties.topic)) return [];
        return [chatMembersUrl(conversation.id)];
    }

    function memberNames(members, me, lastAuthor) {
        var names = (members.value || [])
            .filter(function(member) { return member.userId !== me.id; })
            .map(function(member) { return cleanName(member.displayName); })
            .filter(Boolean);
        if (!names.length) return lastAuthor || cleanName(me.displayName) || null;
        var shown = names.slice(0, TITLE_MEMBER_LIMIT).join(', ');
        return names.length > TITLE_MEMBER_LIMIT ? shown + ' +' + (names.length - TITLE_MEMBER_LIMIT) : shown;
    }

    function conversationTitle(conversation, responses, me) {
        var properties = threadProperties(conversation);
        if (CHANNEL_ID_PATTERN.test(conversation.id)) {
            var team = properties.groupId ? batchBody(responses, teamUrl(properties.groupId)) : null;
            var channel = properties.groupId ? batchBody(responses, channelUrl(properties.groupId, conversation.id)) : null;
            var names = [team && cleanName(team.displayName), channel ? cleanName(channel.displayName) : cleanName(properties.topic)];
            return names.filter(Boolean).join(' > ') || null;
        }
        if (conversation.id === SELF_CHAT_ID) return cleanName(me.displayName) || null;
        if (cleanName(properties.topic)) return cleanName(properties.topic);
        var members = batchBody(responses, chatMembersUrl(conversation.id));
        var lastAuthor = cleanName((conversation.lastMessage || {}).imdisplayname);
        return members ? memberNames(members, me, lastAuthor === cleanName(me.displayName) ? null : lastAuthor) : null;
    }

    async function conversationTitles(token, conversations) {
        var lookups = conversations.reduce(function(urls, conversation) { return urls.concat(titleLookups(conversation)); }, [ME_URL]);
        var responses = await graphBatch(token, lookups);
        var me = batchBody(responses, ME_URL) || {};
        return new Map(conversations.map(function(conversation) {
            return [conversation.id, conversationTitle(conversation, responses, me)];
        }));
    }

    function describeConversation(conversation, title) {
        var properties = threadProperties(conversation);
        var channel = CHANNEL_ID_PATTERN.test(conversation.id);
        var description = {
            kind: channel ? 'channel' : 'chat',
            conversationId: conversation.id,
            threadType: properties.productThreadType,
            title: title,
        };
        if (channel) description.teamId = properties.groupId;
        return description;
    }

    async function conversationTarget(clients, conversationId) {
        if (!conversationId) throw new Error('A conversation id is required');
        var conversation = await chatServiceRequest(clients, conversationPath(conversationId) + '?view=' + CONVERSATION_VIEW);
        var titles = await conversationTitles(clients.graph, [conversation]);
        var target = describeConversation(conversation, titles.get(conversation.id));
        if (target.kind === 'channel' && !target.teamId) throw new Error('The team of channel ' + conversation.id + ' is unknown');
        target.path = target.kind === 'channel'
            ? '/teams/' + encodeURIComponent(target.teamId) + '/channels/' + encodeURIComponent(target.conversationId)
            : '/chats/' + encodeURIComponent(target.conversationId);
        return target;
    }

    function publicTarget(target) {
        var description = Object.assign({}, target);
        delete description.path;
        return description;
    }

    function lastActivity(conversation) {
        var lastMessage = conversation.lastMessage || {};
        var properties = conversation.properties || {};
        return isoTime(lastMessage.composetime) || isoTime(properties.lastimreceivedtime) || isoTime(threadProperties(conversation).createdat);
    }

    function listedConversation(conversation) {
        return (conversation.id === SELF_CHAT_ID || conversation.id.indexOf(STREAM_ID_PREFIX) !== 0) &&
            threadProperties(conversation).hidden !== 'true';
    }

    function matchesQuery(title, query) {
        var normalized = nameTokens(title).join(' ');
        return query.every(function(token) { return normalized.indexOf(token) !== -1; });
    }

    async function listConversations(request) {
        var limit = Number(request.limit) || DEFAULT_CONVERSATION_LIMIT;
        var query = nameTokens(request.query);
        var clients = await teamsClients();
        var page = await chatServiceRequest(clients, '/v1/users/ME/conversations?view=' + CONVERSATION_VIEW +
            '&pageSize=' + CONVERSATION_PAGE_SIZE + '&startTime=1');
        var conversations = (page.conversations || [])
            .filter(listedConversation)
            .map(function(conversation) { return {conversation: conversation, lastActivity: lastActivity(conversation)}; })
            .sort(function(first, second) { return (second.lastActivity || '').localeCompare(first.lastActivity || ''); });
        if (!query.length) conversations = conversations.slice(0, limit);
        var titles = await conversationTitles(clients.graph, conversations.map(function(entry) { return entry.conversation; }));
        return conversations
            .map(function(entry) {
                var lastMessage = entry.conversation.lastMessage || {};
                return Object.assign(describeConversation(entry.conversation, titles.get(entry.conversation.id)), {
                    lastActivity: entry.lastActivity,
                    lastAuthor: cleanName(lastMessage.imdisplayname) || null,
                });
            })
            .filter(function(conversation) { return !query.length || matchesQuery(conversation.title, query); })
            .slice(0, limit);
    }

    function attachedFiles(files) {
        var list = files;
        if (typeof files === 'string') {
            try {
                list = JSON.parse(files);
            } catch (ex) {
                return [];
            }
        }
        return (Array.isArray(list) ? list : [])
            .map(function(file) { return file && cleanName(file.fileName || file.title); })
            .filter(Boolean);
    }

    function messageSummary(message) {
        var properties = message.properties || {};
        var summary = {
            id: message.id,
            time: isoTime(message.composetime) || isoTime(message.originalarrivaltime),
            author: cleanName(message.imdisplayname || message.fromDisplayNameInToken) || null,
        };
        if (message.rootMessageId && message.rootMessageId !== message.id) summary.replyTo = message.rootMessageId;
        if (cleanName(properties.subject)) summary.subject = cleanName(properties.subject);
        if (properties.deletetime) {
            summary.deleted = true;
            return summary;
        }
        if (properties.edittime) summary.edited = true;
        summary[message.messagetype === PLAIN_TEXT_MESSAGE_TYPE ? 'text' : 'html'] = message.content || '';
        var files = attachedFiles(properties.files);
        if (files.length) summary.files = files;
        return summary;
    }

    function creationOrder(first, second) {
        return Number(second.id) - Number(first.id);
    }

    function hasLatestMessages(messages, limit, oldestVersion) {
        return messages.length >= limit && Number(messages.slice().sort(creationOrder)[limit - 1].id) >= oldestVersion;
    }

    async function readMessages(request) {
        var limit = Number(request.limit) || DEFAULT_MESSAGE_LIMIT;
        var clients = await teamsClients();
        var target = await conversationTarget(clients, request.conversationId);
        if (request.threadId && target.kind !== 'channel') throw new Error('Only channel posts have reply threads');
        var thread = request.threadId ? target.conversationId + ';messageid=' + request.threadId : target.conversationId;
        var next = conversationPath(thread) + '/messages?view=' + encodeURIComponent(MESSAGE_VIEW) +
            '&pageSize=' + Math.min(limit, MESSAGE_PAGE_SIZE) + '&startTime=1';
        var messages = [];
        var oldestVersion = Infinity;
        while (next && !hasLatestMessages(messages, limit, oldestVersion)) {
            var page = await chatServiceRequest(clients, next);
            var received = page.messages || [];
            received.forEach(function(message) { oldestVersion = Math.min(oldestVersion, Number(message.version) || 0); });
            messages = messages.concat(received.filter(function(message) { return USER_MESSAGE_TYPE.test(message.messagetype || ''); }));
            var backward = received.length && page._metadata ? page._metadata.backwardLink : null;
            next = backward && backward !== next ? backward : null;
        }
        return Object.assign(publicTarget(target), {
            threadId: request.threadId || undefined,
            messages: messages.sort(creationOrder).slice(0, limit).reverse().map(messageSummary),
        });
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
            var me = await graphRequest(token, 'GET', ME_URL);
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
        var clients = await teamsClients();
        var target = await conversationTarget(clients, request.conversationId);
        if (request.replyTo && target.kind !== 'channel') throw new Error('Replies are only supported in channel posts');
        var people = names.length ? await mentionedPeople(clients.graph, target, names) : new Map();
        var payload = {body: {contentType: 'html', content: request.html}};
        if (people.size) {
            var withMentions = insertMentions(request.html, people);
            payload = {body: {contentType: 'html', content: withMentions.content}, mentions: withMentions.mentions};
        }
        return {token: clients.graph, target: target, replyTo: request.replyTo || null, people: people, payload: payload};
    }

    async function approvalCode(prepared) {
        var signed = JSON.stringify([
            prepared.target.kind, prepared.target.conversationId, prepared.target.teamId || null, prepared.replyTo, prepared.payload,
        ]);
        var digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(signed));
        return Array.from(new Uint8Array(digest).slice(0, APPROVAL_CODE_BYTES), function(byte) {
            return byte.toString(16).padStart(2, '0');
        }).join('');
    }

    function pageElement(tag, styles, text) {
        var node = document.createElement(tag);
        node.style.cssText = styles;
        if (text !== undefined) node.textContent = text;
        return node;
    }

    function previewDocument(html) {
        return '<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="' + PREVIEW_POLICY + '">' +
            '<style>' + PREVIEW_STYLES + '</style></head><body>' + html + '</body></html>';
    }

    function destinationText(prepared) {
        var destination = prepared.target.title || prepared.target.conversationId;
        return 'Destination\u00A0: ' + destination + (prepared.replyTo ? ', réponse dans un fil' : '');
    }

    function mentionText(people) {
        return 'Mentions\u00A0: ' + Array.from(people.values(), function(person) {
            return person.firstName + ' (' + person.displayName + ')';
        }).join(', ');
    }

    function askConfirmation(prepared, timeoutSeconds) {
        if (document.getElementById(CONFIRMATION_DIALOG_ID)) throw new Error('Another Teams message is waiting for confirmation');
        return new Promise(function(resolve) {
            var previousFocus = document.activeElement;
            var overlay = pageElement('div', OVERLAY_STYLES);
            overlay.id = CONFIRMATION_DIALOG_ID;
            var dialog = pageElement('div', DIALOG_STYLES);
            dialog.setAttribute('role', 'dialog');
            dialog.setAttribute('aria-modal', 'true');
            dialog.setAttribute('aria-labelledby', CONFIRMATION_TITLE_ID);
            dialog.setAttribute('aria-describedby', CONFIRMATION_DESTINATION_ID);
            var heading = pageElement('h2', HEADING_STYLES, 'Envoyer ce message\u00A0?');
            heading.id = CONFIRMATION_TITLE_ID;
            var destination = pageElement('p', TEXT_STYLES, destinationText(prepared));
            destination.id = CONFIRMATION_DESTINATION_ID;
            var preview = pageElement('iframe', FRAME_STYLES);
            preview.setAttribute('sandbox', '');
            preview.setAttribute('tabindex', '-1');
            preview.title = 'Aperçu du message';
            var previewUrl = URL.createObjectURL(new Blob([previewDocument(prepared.payload.body.content)], {type: 'text/html'}));
            preview.src = previewUrl;
            var hint = pageElement('p', HINT_STYLES, 'Sans réponse, l\u2019envoi est annulé dans ' + Math.ceil(timeoutSeconds / 60) + '\u00A0min.');
            var cancel = pageElement('button', CANCEL_BUTTON_STYLES, 'Annuler');
            cancel.type = 'button';
            var send = pageElement('button', SEND_BUTTON_STYLES, 'Envoyer');
            send.type = 'button';
            var buttons = pageElement('div', BUTTON_ROW_STYLES);
            buttons.append(cancel, send);
            dialog.append(heading, destination);
            if (prepared.people.size) dialog.append(pageElement('p', TEXT_STYLES, mentionText(prepared.people)));
            dialog.append(preview, hint, buttons);
            overlay.append(dialog);
            var finished = false;
            var timer = setTimeout(function() { finish(EXPIRED); }, timeoutSeconds * 1000);
            function finish(decision) {
                if (finished) return;
                finished = true;
                clearTimeout(timer);
                overlay.remove();
                URL.revokeObjectURL(previewUrl);
                if (previousFocus && previousFocus.isConnected && typeof previousFocus.focus === 'function') previousFocus.focus();
                resolve(decision);
            }
            cancel.addEventListener('click', function() { finish(CANCELLED); });
            send.addEventListener('click', function(event) {
                if (event.isTrusted) finish(CONFIRMED);
            });
            overlay.addEventListener('keydown', function(event) {
                event.stopPropagation();
                if (event.key === 'Escape') {
                    event.preventDefault();
                    finish(CANCELLED);
                } else if (event.key === 'Tab') {
                    event.preventDefault();
                    (document.activeElement === send ? cancel : send).focus();
                }
            });
            document.body.append(overlay);
            cancel.focus();
        });
    }

    async function previewMessage(request) {
        var prepared = await preparedMessage(request);
        return Object.assign(publicTarget(prepared.target), {
            replyTo: prepared.replyTo || undefined,
            html: prepared.payload.body.content,
            mentions: Array.from(prepared.people, function(entry) {
                return {mention: entry[0], firstName: entry[1].firstName, displayName: entry[1].displayName};
            }),
            approval: await approvalCode(prepared),
        });
    }

    async function sendMessage(request) {
        if (!request.approval) throw new Error('No approval code: preview the message and get the user approval first');
        var prepared = await preparedMessage(request);
        if (request.approval !== await approvalCode(prepared)) {
            throw new Error('The message, conversation or mentions differ from the approved preview');
        }
        var timeoutSeconds = Number(request.confirmationTimeoutSeconds) || DEFAULT_CONFIRMATION_TIMEOUT_SECONDS;
        var decision = await askConfirmation(prepared, timeoutSeconds);
        if (decision === CANCELLED) throw new Error('The user cancelled the message in the Teams confirmation dialog');
        if (decision === EXPIRED) throw new Error('The Teams confirmation dialog expired after ' + timeoutSeconds + ' s without an answer');
        var path = prepared.target.path + '/messages' + (prepared.replyTo ? '/' + encodeURIComponent(prepared.replyTo) + '/replies' : '');
        var message = await graphRequest(prepared.token, 'POST', path, prepared.payload);
        return Object.assign(publicTarget(prepared.target), {
            replyTo: prepared.replyTo || undefined,
            messageId: message.id,
            createdDateTime: message.createdDateTime,
            content: message.body ? message.body.content : undefined,
            mentions: (message.mentions || []).map(function(mention) {
                return {mentionText: mention.mentionText, userId: mention.mentioned && mention.mentioned.user ? mention.mentioned.user.id : undefined};
            }),
        });
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
            title: title && title.innerText.trim() ? title.innerText.trim().split('\n')[0].trim() : document.title,
        };
    }

    function capturePromptConversation(event) {
        if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey || event.isComposing) return;
        if (!event.target || typeof event.target.closest !== 'function' || !event.target.closest(TERMINAL_PANEL_SELECTOR)) return;
        var capture = {capturedAt: new Date(Date.now()).toISOString()};
        try {
            capture.conversation = displayedConversation();
        } catch (ex) {
            capture.error = ex.message;
        }
        window[PROMPT_CAPTURE] = capture;
    }

    function installPromptCapture() {
        if (window[PROMPT_HANDLER]) window.removeEventListener('keydown', window[PROMPT_HANDLER], true);
        window[PROMPT_HANDLER] = capturePromptConversation;
        window.addEventListener('keydown', capturePromptConversation, true);
    }

    function requestConversation() {
        var capture = window[PROMPT_CAPTURE];
        if (!capture) return Object.assign({source: 'display'}, displayedConversation());
        if (!capture.conversation) {
            throw new Error('No Teams conversation was identified when the request was submitted at ' + capture.capturedAt + ': ' + capture.error);
        }
        var conversation = Object.assign({source: 'prompt', capturedAt: capture.capturedAt}, capture.conversation);
        try {
            var displayed = displayedConversation();
            if (displayed.conversationId !== conversation.conversationId) {
                conversation.displayedNow = {conversationId: displayed.conversationId, title: displayed.title};
            }
        } catch (ex) {
            conversation.displayedNow = null;
        }
        return conversation;
    }

    installPromptCapture();

    return async function teamsGraph(request) {
        try {
            if (request.action === 'current') return {ok: true, result: requestConversation()};
            if (request.action === 'chats') return {ok: true, result: await listConversations(request)};
            if (request.action === 'read') return {ok: true, result: await readMessages(request)};
            if (request.action === 'preview') return {ok: true, result: await previewMessage(request)};
            if (request.action === 'send') return {ok: true, result: await sendMessage(request)};
            throw new Error('Unknown action: ' + request.action);
        } catch (ex) {
            return {ok: false, error: ex && ex.message ? ex.message : String(ex)};
        }
    };
})()
