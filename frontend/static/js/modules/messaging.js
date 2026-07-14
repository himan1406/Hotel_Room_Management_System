// ==================== Messaging ====================
const CHAT_SUGGESTIONS = {
    hotel_rep: [
        "What's your cancellation policy?",
        "What time is check-in?",
        "Do you offer airport pickup?",
        "Is breakfast included?",
        "What amenities do you have?",
    ],
    admin: [
        "How can I help you?",
    ],
};

function toggleChatPanel() {
    const panel = document.getElementById("chatPanel");
    if (panel.style.display === "none" || !panel.style.display) {
        panel.style.display = "flex";
        loadConversations();
    } else {
        panel.style.display = "none";
    }
}

function showChatConversations() {
    document.getElementById("chatConversations").style.display = "block";
    document.getElementById("chatConversationView").style.display = "none";
    const suggestions = document.getElementById("chatSuggestions");
    if (suggestions) suggestions.style.display = "none";
    msgCurrentOtherId = null;
    msgCurrentPropertyId = null;
    msgCurrentOtherRole = null;
}

function renderSuggestions(role) {
    const container = document.getElementById("chatSuggestions");
    if (!container) return;
    const suggestions = CHAT_SUGGESTIONS[role];
    if (!suggestions) {
        container.style.display = "none";
        return;
    }
    container.style.display = "flex";
    container.innerHTML = suggestions.map(s =>
        `<button class="chat-suggestion-chip" onclick="useSuggestion(this.textContent)">${escapeHtml(s)}</button>`
    ).join("");
}

function useSuggestion(text) {
    const input = document.getElementById("chatMessageInput");
    if (input) {
        input.value = text;
        input.focus();
        input.style.height = "auto";
        input.style.height = input.scrollHeight + "px";
    }
}

async function loadConversations() {
    const container = document.getElementById("chatConversations");
    try {
        const convos = await API.get("/api/messages/conversations");
        convos.unshift({
            other_user_id: "ai-frontdesk",
            other_user_name: "Front Desk AI",
            other_user_role: "ai",
            property_id: null,
            property_name: "AI Assistant",
            last_message: "Ask me about properties, policies, and local attractions!",
            unread_count: 0,
        });
        container.innerHTML = convos.map(c => {
            const isAi = c.other_user_id === "ai-frontdesk";
            return `
            <div class="chat-conv-item" onclick="openConversation('${isAi ? 'ai-frontdesk' : c.other_user_id}', '${isAi ? '' : c.property_id || ''}', '${escapeHtml(c.property_name)}', '${escapeHtml(c.other_user_name)}', '${c.other_user_role || ''}')">
                <div class="chat-conv-avatar ${isAi ? 'ai-avatar' : ''}">${isAi ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>' : escapeHtml(c.other_user_name.charAt(0).toUpperCase())}</div>
                <div class="chat-conv-info">
                    <div class="chat-conv-name">${escapeHtml(c.other_user_name)}</div>
                    <div class="chat-conv-preview">${escapeHtml(c.property_name)} ${c.property_name ? '—' : ''} ${escapeHtml(c.last_message)}</div>
                </div>
                ${c.unread_count > 0 ? `<span class="chat-conv-badge">${c.unread_count}</span>` : ""}
            </div>`;
        }).join("");
        updateMsgBadge(convos);
    } catch {
        container.innerHTML = `<div class="empty-state" style="padding:20px;text-align:center;">Could not load conversations.</div>`;
    }
}

function updateMsgBadge(convos) {
    const total = convos.reduce((sum, c) => sum + c.unread_count, 0);
    const badge = document.getElementById("msgBadge");
    if (total > 0) {
        badge.style.display = "inline";
        badge.textContent = total;
    } else {
        badge.style.display = "none";
    }
}

async function openConversation(otherUserId, propertyId, propertyName, otherName, otherUserRole) {
    if (otherUserId === "ai-frontdesk") {
        if (typeof openAIChat === "function") openAIChat();
        return;
    }
    msgCurrentOtherId = otherUserId;
    msgCurrentPropertyId = propertyId || null;
    msgCurrentOtherRole = otherUserRole || "customer";
    document.getElementById("chatConversations").style.display = "none";
    document.getElementById("chatConversationView").style.display = "flex";
    const title = propertyName ? `Re: ${propertyName} — ${otherName}` : otherName;
    document.getElementById("chatViewTitle").textContent = title;
    renderSuggestions(msgCurrentOtherRole);
    await loadMessages(otherUserId, propertyId);
}

async function loadMessages(otherUserId, propertyId, afterId) {
    const container = document.getElementById("chatMessages");
    try {
        let url = `/api/messages/conversation/${otherUserId}`;
        const params = [];
        if (propertyId) params.push(`property_id=${propertyId}`);
        if (afterId) params.push(`after_id=${afterId}`);
        if (params.length) url += `?${params.join("&")}`;
        const msgs = await API.get(url);
        if (afterId) {
            if (msgs.length === 0) return;
            container.insertAdjacentHTML("beforeend", msgs.map(m => `
                <div class="chat-msg ${m.is_mine ? "chat-msg-mine" : "chat-msg-theirs"}">
                    ${escapeHtml(m.body)}
                    <div class="chat-msg-time">${new Date(m.created_at).toLocaleString()}</div>
                </div>
            `).join(""));
            container.scrollTop = container.scrollHeight;
            msgLastMessageId = msgs[msgs.length - 1].id;
            for (const m of msgs) {
                if (!m.is_mine && !m.is_read) {
                    API.put(`/api/messages/${m.id}/read`).catch(() => {});
                }
            }
        } else {
            container.innerHTML = msgs.map(m => `
                <div class="chat-msg ${m.is_mine ? "chat-msg-mine" : "chat-msg-theirs"}">
                    ${escapeHtml(m.body)}
                    <div class="chat-msg-time">${new Date(m.created_at).toLocaleString()}</div>
                </div>
            `).join("") || `<div class="empty-state" style="padding:20px;text-align:center;">No messages yet. Say hello!</div>`;
            container.scrollTop = container.scrollHeight;
            if (msgs.length > 0) {
                msgLastMessageId = msgs[msgs.length - 1].id;
            }
            for (const m of msgs) {
                if (!m.is_mine && !m.is_read) {
                    API.put(`/api/messages/${m.id}/read`).catch(() => {});
                }
            }
        }
    } catch {
        if (!afterId) {
            container.innerHTML = `<div class="empty-state" style="padding:20px;text-align:center;">Could not load messages.</div>`;
        }
    }
}

async function sendChatMessage() {
    const input = document.getElementById("chatMessageInput");
    const body = input.value.trim();
    if (!body || !msgCurrentOtherId) return;
    input.value = "";
    try {
        await API.post("/api/messages", {
            receiver_id: msgCurrentOtherId,
            property_id: msgCurrentPropertyId,
            body,
        });
        await loadMessages(msgCurrentOtherId, msgCurrentPropertyId);
    } catch (err) {
        alert(err.message);
    }
}

async function contactHost(propertyId) {
    try {
        const prop = await API.get(`/api/properties/${propertyId}`);
        if (!prop.owner_rep_id) {
            alert("This property does not have a host assigned yet.");
            return;
        }
        toggleChatPanel();
        openConversation(prop.owner_rep_id, propertyId, prop.name, prop.owner_name || "Host", "hotel_rep");
    } catch (err) {
        alert(err.message);
    }
}

function connectWebSocket() {
    disconnectWebSocket();
    const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
    ws = new WebSocket(`${proto}//${window.location.host}/ws/chat`);
    ws.onopen = () => {
        if (wsReconnectTimer) {
            clearTimeout(wsReconnectTimer);
            wsReconnectTimer = null;
        }
    };
    ws.onmessage = (e) => {
        try {
            handleWsEvent(JSON.parse(e.data));
        } catch {}
    };
    ws.onclose = (e) => {
        ws = null;
        if (e.code !== 4001 && e.code !== 1000) {
            wsReconnectTimer = setTimeout(connectWebSocket, 3000);
        }
    };
}

function disconnectWebSocket() {
    if (ws) {
        ws.onclose = null;
        ws.close();
        ws = null;
    }
    if (wsReconnectTimer) {
        clearTimeout(wsReconnectTimer);
        wsReconnectTimer = null;
    }
}

function handleWsEvent(data) {
    if (data.type === "new_message") {
        const panel = document.getElementById("chatPanel");
        if (panel && panel.style.display !== "none" && msgCurrentOtherId === data.sender_id) {
            const container = document.getElementById("chatMessages");
            container.insertAdjacentHTML("beforeend", `
                <div class="chat-msg chat-msg-theirs">
                    ${escapeHtml(data.body)}
                    <div class="chat-msg-time">${new Date(data.created_at).toLocaleString()}</div>
                </div>
            `);
            container.scrollTop = container.scrollHeight;
            API.put(`/api/messages/${data.id}/read`).catch(() => {});
        } else {
            loadConversations();
        }
    } else if (data.type === "conversations_updated") {
        if (document.getElementById("chatPanel")?.style.display !== "none") {
            loadConversations();
        }
    }
}
