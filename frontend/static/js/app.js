// ==================== API Layer ====================
const API = {
    _refreshing: null,   // deduplicate concurrent refresh calls

    async request(method, path, body, _isRetry = false) {
        const opts = {
            method,
            headers: { "Content-Type": "application/json" },
            credentials: "include",
        };
        if (body && method !== "GET") {
            opts.body = JSON.stringify(body);
        }
        const res = await fetch(path, opts);

        // Auto-refresh on 401 — but skip for auth endpoints (they handle their own 401s),
        // EXCEPT /api/auth/me which needs refresh to detect logged-in state on page load.
        if (res.status === 401 && !_isRetry && (!path.startsWith("/api/auth/") || path === "/api/auth/me")) {
            const refreshed = await API._tryRefresh();
            if (refreshed) {
                // Retry the original request once with the new access token
                return API.request(method, path, body, true);
            } else {
                // Only force-redirect if we're on a protected page (not login/signup)
                const authPages = ["/login", "/signup", "/hotel-register"];
                const onAuthPage = authPages.some(p => window.location.pathname.startsWith(p));
                if (!onAuthPage) {
                    window.location.href = "/login";
                }
                throw new Error("Session expired. Please log in again.");
            }
        }

        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Request failed");
        return data;
    },

    async _tryRefresh() {
        // Deduplicate: if a refresh is already in-flight, wait for it
        if (API._refreshing) return API._refreshing;
        API._refreshing = (async () => {
            try {
                const res = await fetch("/api/auth/refresh", {
                    method: "POST",
                    credentials: "include",
                });
                return res.ok;
            } catch {
                return false;
            } finally {
                API._refreshing = null;
            }
        })();
        return API._refreshing;
    },

    get(path) { return this.request("GET", path); },
    post(path, body) { return this.request("POST", path, body); },
    put(path, body) { return this.request("PUT", path, body); },
    del(path) { return this.request("DELETE", path); },

    async uploadFile(path, file) {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch(path, {
            method: "POST",
            credentials: "include",
            body: form,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Upload failed");
        return data;
    },
};

// Proactively refresh the access token every 15 minutes (before its 20-min expiry)
// so API calls never hit a stale token.  Silently no-ops if not logged in.
setInterval(() => API._tryRefresh(), 15 * 60 * 1000);

// ==================== Auth ====================
async function checkAuth() {
    try {
        const user = await API.get("/api/auth/me");
        updateNav(user);
        connectWebSocket();
        return user;
    } catch {
        updateNav(null);
        disconnectWebSocket();
        return null;
    }
}

function updateNav(user) {
    const loginLink = document.getElementById("navLogin");
    const signupLink = document.getElementById("navSignup");
    const dashLink = document.getElementById("navDashboard");
    const adminLink = document.getElementById("navAdmin");
    const navMessages = document.getElementById("navMessages");
    const navHotelSetup = document.getElementById("navHotelSetup");
    const navbar = document.querySelector(".navbar");
    const navAccount = document.getElementById("navAccount");
    const navAccountAvatar = document.getElementById("navAccountAvatar");
    const navUserName = document.getElementById("navUserName");
    const navAccountMenu = document.getElementById("navAccountMenu");

    if (user) {
        loginLink.style.display = "none";
        signupLink.style.display = "none";
        dashLink.style.display = "inline";
        adminLink.style.display = user.role === "admin" ? "inline" : "none";
        navMessages.style.display = "inline-flex";
        navHotelSetup.style.display = "none";
        navbar.classList.add("navbar-compact");

        if (navAccount) {
            const displayName = user.full_name || user.email;
            navAccount.style.display = "inline-flex";
            navAccountAvatar.textContent = displayName.charAt(0).toUpperCase();
            navUserName.textContent = displayName;

            const menuItems = [];
            if (user.role === "customer") {
                menuItems.push(`<button type="button" onclick="openBookingsModal()">Past Bookings</button>`);
            }
            menuItems.push(`<a href="/dashboard">Dashboard</a>`);
            menuItems.push(`<button type="button" class="nav-account-logout" onclick="logout()">Logout</button>`);
            navAccountMenu.innerHTML = menuItems.join("");
        }
    } else {
        loginLink.style.display = "inline";
        signupLink.style.display = "inline";
        dashLink.style.display = "none";
        adminLink.style.display = "none";
        navMessages.style.display = "none";
        navHotelSetup.style.display = "inline";
        navbar.classList.remove("navbar-compact");
        if (navAccount) navAccount.style.display = "none";
    }
}

async function logout() {
    disconnectWebSocket();
    localStorage.removeItem("ai_chat_session_id");
    await API.post("/api/auth/logout");
    window.location.href = "/";
}

// ==================== Messaging ====================
let ws = null;
let wsReconnectTimer = null;
let msgCurrentOtherId = null;
let msgCurrentPropertyId = null;
let msgCurrentOtherRole = null;

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
    const title = propertyName ? `Re: ${propertyName} â€” ${otherName}` : otherName;
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

// ==================== Reviews ====================
async function openReviewModal(bookingId) {
    const existing = document.getElementById("reviewModalOverlay");
    if (existing) existing.remove();
    const overlay = document.createElement("div");
    overlay.id = "reviewModalOverlay";
    overlay.className = "modal-overlay";
    overlay.style.display = "flex";
    overlay.innerHTML = `
        <div class="modal" style="max-width:440px">
            <span class="close-modal" onclick="closeReviewModal()">&times;</span>
            <h3>Write a Review</h3>
            <input type="hidden" id="reviewBookingId" value="${bookingId}">
            <div class="form-group">
                <label>Rating</label>
                <div style="font-size:1.6rem;cursor:pointer;color:var(--sand-deep);">
                    ${[1,2,3,4,5].map(i => `<span class="review-star" data-value="${i}" onmouseenter="hoverStar(${i})" onmouseleave="resetStars()" onclick="setRating(${i})" style="transition:color var(--fast) var(--ease);">&#9733;</span>`).join("")}
                </div>
            </div>
            <div class="form-group">
                <label for="reviewComment">Comment (optional)</label>
                <textarea id="reviewComment" rows="4" placeholder="Share your experience..." style="width:100%;padding:10px 14px;border:2px solid var(--sand-deep);border-radius:var(--radius-sm);font-family:'Inter',sans-serif;font-size:0.9rem;resize:vertical;background:var(--paper);color:var(--ink);"></textarea>
            </div>
            <div id="reviewError" style="display:none;color:var(--bad);font-size:0.88rem;margin-bottom:12px;"></div>
            <div style="display:flex;gap:10px;justify-content:flex-end;">
                <button class="btn btn-secondary" onclick="closeReviewModal()">Cancel</button>
                <button class="btn btn-primary" onclick="submitReview()">Submit Review</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
}

function closeReviewModal() {
    const modal = document.getElementById("reviewModalOverlay");
    if (modal) modal.remove();
}

let selectedRating = 0;

function hoverStar(val) {
    document.querySelectorAll(".review-star").forEach(s => {
        s.style.color = parseInt(s.dataset.value) <= val ? "var(--lilac-deep)" : "var(--sand-deep)";
    });
}

function resetStars() {
    document.querySelectorAll(".review-star").forEach(s => {
        s.style.color = parseInt(s.dataset.value) <= selectedRating ? "var(--lilac-deep)" : "var(--sand-deep)";
    });
}

function setRating(val) {
    selectedRating = val;
    resetStars();
}

async function submitReview() {
    const bookingId = document.getElementById("reviewBookingId").value;
    const comment = document.getElementById("reviewComment").value.trim();
    const errDiv = document.getElementById("reviewError");
    errDiv.style.display = "none";
    if (selectedRating === 0) {
        errDiv.textContent = "Please select a rating.";
        errDiv.style.display = "block";
        return;
    }
    try {
        await API.post("/api/reviews", { booking_id: bookingId, rating: selectedRating, comment: comment || null });
        closeReviewModal();
        loadMyBookings();
    } catch (err) {
        errDiv.textContent = err.message;
        errDiv.style.display = "block";
    }
}

async function openPropertyReviews(propertyId) {
    try {
        const reviews = await API.get(`/api/reviews/property/${propertyId}`);
        const existing = document.getElementById("reviewModalOverlay");
        if (existing) existing.remove();
        const overlay = document.createElement("div");
        overlay.id = "reviewModalOverlay";
        overlay.className = "modal-overlay";
        overlay.style.display = "flex";
        let bodyHtml;
        if (reviews.length === 0) {
            bodyHtml = `<div class="empty-state">No reviews yet for this property.</div>`;
        } else {
            bodyHtml = reviews.map(r => `
                <div style="border-bottom:1px solid var(--sand-deep);padding:14px 0;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                        <strong>${escapeHtml(r.customer_name || "Anonymous")}</strong>
                        <span style="color:var(--lilac-deep);font-size:1rem;">${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</span>
                    </div>
                    ${r.comment ? `<p style="margin:6px 0;font-size:0.92rem;">${escapeHtml(r.comment)}</p>` : ""}
                    <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.78rem;color:var(--ink-faint);font-family:'Space Mono',monospace;margin-top:6px;">
                        <span>${new Date(r.created_at).toLocaleDateString()}</span>
                        ${r.is_mine ? `
                            <div style="display:flex;gap:6px;">
                                <button class="btn btn-outline btn-small" style="font-size:0.72rem;padding:2px 8px;" onclick="openEditReviewModal('${r.id}', ${r.rating})">Edit</button>
                                <button class="btn btn-danger btn-small" style="font-size:0.72rem;padding:2px 8px;" onclick="deleteReview('${r.id}', '${propertyId}')">Delete</button>
                            </div>
                        ` : ""}
                    </div>
                    ${r.rep_response ? `<div style="margin-top:8px;padding:10px 14px;background:var(--sand);border-radius:var(--radius-sm);font-size:0.88rem;"><strong>Host response:</strong> ${escapeHtml(r.rep_response)}</div>` : ""}
                </div>
            `).join("");
        }
        overlay.innerHTML = `
            <div class="modal" style="max-width:500px">
                <span class="close-modal" onclick="closeReviewModal()">&times;</span>
                <h3>Reviews</h3>
                <div>${bodyHtml}</div>
            </div>
        `;
        document.body.appendChild(overlay);
    } catch (err) {
        alert(err.message);
    }
}

let selectedEditRating = 0;

async function openEditReviewModal(reviewId, currentRating) {
    selectedEditRating = currentRating || 0;
    const existing = document.getElementById("reviewModalOverlay");
    if (existing) existing.remove();
    const overlay = document.createElement("div");
    overlay.id = "reviewModalOverlay";
    overlay.className = "modal-overlay";
    overlay.style.display = "flex";
    overlay.innerHTML = `
        <div class="modal" style="max-width:440px">
            <span class="close-modal" onclick="closeReviewModal()">&times;</span>
            <h3>Edit Review</h3>
            <input type="hidden" id="editReviewId" value="${reviewId}">
            <div class="form-group">
                <label>Rating</label>
                <div style="font-size:1.6rem;cursor:pointer;color:var(--sand-deep);" id="editStarContainer">
                    ${[1,2,3,4,5].map(i => `<span class="edit-star" data-value="${i}" style="color:${i <= selectedEditRating ? 'var(--lilac-deep)' : 'var(--sand-deep)'};transition:color var(--fast) var(--ease);">&#9733;</span>`).join("")}
                </div>
            </div>
            <div class="form-group">
                <label for="editReviewComment">Comment (optional)</label>
                <textarea id="editReviewComment" rows="4" placeholder="Share your experience..." style="width:100%;padding:10px 14px;border:2px solid var(--sand-deep);border-radius:var(--radius-sm);font-family:'Inter',sans-serif;font-size:0.9rem;resize:vertical;background:var(--paper);color:var(--ink);"></textarea>
            </div>
            <div id="editReviewError" style="display:none;color:var(--bad);font-size:0.88rem;margin-bottom:12px;"></div>
            <div style="display:flex;gap:10px;justify-content:flex-end;">
                <button class="btn btn-secondary" onclick="closeReviewModal()">Cancel</button>
                <button class="btn btn-primary" onclick="submitEditReview()">Update Review</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    // Star hover/click handlers
    const container = document.getElementById("editStarContainer");
    const stars = container.querySelectorAll(".edit-star");
    function highlightUpTo(val) {
        stars.forEach(s => {
            s.style.color = parseInt(s.dataset.value) <= val ? "var(--lilac-deep)" : "var(--sand-deep)";
        });
    }
    stars.forEach(s => {
        s.addEventListener("mouseenter", () => highlightUpTo(parseInt(s.dataset.value)));
        s.addEventListener("mouseleave", () => highlightUpTo(selectedEditRating));
        s.addEventListener("click", () => { selectedEditRating = parseInt(s.dataset.value); highlightUpTo(selectedEditRating); });
    });
}

async function submitEditReview() {
    const reviewId = document.getElementById("editReviewId").value;
    const comment = document.getElementById("editReviewComment").value.trim();
    const errDiv = document.getElementById("editReviewError");
    errDiv.style.display = "none";
    if (selectedEditRating === 0) { errDiv.textContent = "Please select a rating."; errDiv.style.display = "block"; return; }
    try {
        await API.put(`/api/reviews/${reviewId}`, { rating: selectedEditRating, comment: comment || null });
        closeReviewModal();
    } catch (err) {
        errDiv.textContent = err.message;
        errDiv.style.display = "block";
    }
}

async function deleteReview(reviewId, propertyId) {
    if (!confirm("Delete this review?")) return;
    try {
        await API.del(`/api/reviews/${reviewId}`);
        openPropertyReviews(propertyId);
    } catch (err) {
        alert(err.message);
    }
}

async function viewPropertyReviews(propertyId) {
    try {
        const reviews = await API.get(`/api/reviews/property/${propertyId}`);
        const existing = document.getElementById("reviewModalOverlay");
        if (existing) existing.remove();
        const overlay = document.createElement("div");
        overlay.id = "reviewModalOverlay";
        overlay.className = "modal-overlay";
        overlay.style.display = "flex";
        let bodyHtml;
        if (reviews.length === 0) {
            bodyHtml = `<div class="empty-state">No reviews yet for this property.</div>`;
        } else {
            bodyHtml = reviews.map(r => `
                <div style="border-bottom:1px solid var(--sand-deep);padding:14px 0;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                        <strong>${escapeHtml(r.customer_name || "Anonymous")}</strong>
                        <span style="color:var(--lilac-deep);font-size:1rem;">${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</span>
                    </div>
                    ${r.comment ? `<p style="margin:6px 0;font-size:0.92rem;">${escapeHtml(r.comment)}</p>` : ""}
                    <div style="font-size:0.78rem;color:var(--ink-faint);font-family:'Space Mono',monospace;">${new Date(r.created_at).toLocaleDateString()}</div>
                    ${r.rep_response ? `<div style="margin-top:8px;padding:10px 14px;background:var(--sand);border-radius:var(--radius-sm);font-size:0.88rem;"><strong>Your response:</strong> ${escapeHtml(r.rep_response)}</div>` : `
                        <div style="margin-top:8px;">
                            <textarea id="reviewResponse_${r.id}" rows="2" placeholder="Write a response..." style="width:100%;padding:8px 12px;border:2px solid var(--sand-deep);border-radius:var(--radius-sm);font-family:'Inter',sans-serif;font-size:0.85rem;resize:vertical;background:var(--paper);color:var(--ink);"></textarea>
                            <button class="btn btn-primary btn-small" style="margin-top:6px;" onclick="submitReviewResponse('${r.id}')">Respond</button>
                        </div>
                    `}
                </div>
            `).join("");
        }
        overlay.innerHTML = `
            <div class="modal" style="max-width:520px">
                <span class="close-modal" onclick="closeReviewModal()">&times;</span>
                <h3>Property Reviews</h3>
                <div>${bodyHtml}</div>
            </div>
        `;
        document.body.appendChild(overlay);
    } catch (err) {
        alert(err.message);
    }
}

async function submitReviewResponse(reviewId) {
    const textarea = document.getElementById(`reviewResponse_${reviewId}`);
    const response = textarea.value.trim();
    if (!response) return;
    try {
        await API.post(`/api/reviews/${reviewId}/respond`, { response });
        closeReviewModal();
    } catch (err) {
        alert(err.message);
    }
}

// ==================== Nav (mobile toggle) ====================
function initNavToggle() {
    const toggle = document.getElementById("navToggle");
    const links = document.getElementById("navLinks");
    if (!toggle || !links) return;

    toggle.addEventListener("click", () => {
        const isOpen = links.classList.toggle("open");
        toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    });

    // Close the mobile menu after picking a link
    links.querySelectorAll("a").forEach(a => {
        a.addEventListener("click", () => {
            links.classList.remove("open");
            toggle.setAttribute("aria-expanded", "false");
        });
    });
}

// ==================== Login ====================
document.addEventListener("DOMContentLoaded", () => {
    initNavToggle();

    const loginForm = document.getElementById("loginForm");
    if (loginForm) {
        loginForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            const errDiv = document.getElementById("loginError");
            try {
                const data = await API.post("/api/auth/login", {
                    email: document.getElementById("email").value,
                    password: document.getElementById("password").value,
                });
                window.location.href = data.role === "admin" ? "/admin" : "/dashboard";
            } catch (err) {
                errDiv.style.display = "block";
                errDiv.textContent = err.message;
            }
        });
    }

    const signupForm = document.getElementById("signupForm");
    if (signupForm) {
        signupForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            const errDiv = document.getElementById("signupError");
            try {
                await API.post("/api/auth/signup", {
                    email: document.getElementById("email").value,
                    password: document.getElementById("password").value,
                    full_name: document.getElementById("fullName")?.value || "",
                    phone: document.getElementById("phone")?.value || "",
                });
                window.location.href = "/login?registered=1";
            } catch (err) {
                errDiv.style.display = "block";
                errDiv.textContent = err.message;
            }
        });
    }

    const hotelForm = document.getElementById("hotelSetupForm");
    if (hotelForm) {
        hotelForm.addEventListener("submit", async (e) => {
            e.preventDefault();
            const errDiv = document.getElementById("hotelSetupError");
            const successDiv = document.getElementById("hotelSetupSuccess");
            errDiv.style.display = "none";
            successDiv.style.display = "none";
            try {
                const data = await API.post("/api/auth/hotel-register", {
                    email: document.getElementById("email").value,
                    password: document.getElementById("password").value,
                    full_name: document.getElementById("fullName").value,
                    phone: document.getElementById("phone").value,
                });

                const fileInput = document.getElementById("doc");
                if (fileInput && fileInput.files[0]) {
                    const uploadData = await API.uploadFile(`/api/admin/upload-doc/${data.id}`, fileInput.files[0]);
                }

                successDiv.style.display = "block";
                successDiv.textContent = "Registration submitted! An admin will review and approve your account.";
                hotelForm.reset();
            } catch (err) {
                errDiv.style.display = "block";
                errDiv.textContent = err.message;
            }
        });
    }

    // Dashboard
    const dashboardView = document.getElementById("dashboardView");
    if (dashboardView) {
        initDashboard();
    }

    // Admin
    const adminTabContent = document.getElementById("adminTabContent");
    if (adminTabContent) {
        initAdmin();
    }

    // Chat Enter key
    const chatInput = document.getElementById("chatMessageInput");
    if (chatInput) {
        chatInput.addEventListener("keydown", (e) => {
            if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                sendChatMessage();
            }
        });
    }

    // Nav update
    checkAuth();
});

// ==================== Dashboard ====================
let currentSelectedProperty = null;
let selectedCompareIds = [];
let compareChatHistory = [];
let comparisonContext = null;

async function initDashboard() {
    const user = await checkAuth();
    if (!user) {
        window.location.href = "/login";
        return;
    }

    const view = document.getElementById("dashboardView");
    const eyebrow = document.getElementById("dashboardEyebrow");
    const heading = document.getElementById("dashboardHeading");

    if (user.role === "customer") {
        if (eyebrow) eyebrow.textContent = "Traveler Dashboard";
        if (heading) heading.textContent = "Find your next stay";

        // Restore comparison view after a page refresh
        const savedCompareIds = sessionStorage.getItem("compareIds");
        const savedCompareActive = sessionStorage.getItem("compareViewActive");
        if (savedCompareActive === "1" && savedCompareIds) {
            try {
                const ids = JSON.parse(savedCompareIds);
                if (Array.isArray(ids) && ids.length >= 2) {
                    selectedCompareIds = ids;
                    startCompareView();
                    return;
                }
            } catch (e) {
                sessionStorage.removeItem("compareIds");
                sessionStorage.removeItem("compareViewActive");
            }
        }

        const urlParams = new URLSearchParams(window.location.search);
        const propId = urlParams.get("property_id");
        if (propId) {
            renderPropertyDetailView(view, propId);
        } else {
            renderCustomerDashboard(view, user);
        }
        return;
    }

    if (user.role === "admin") {
        if (eyebrow) eyebrow.textContent = "Platform Admin";
        if (heading) heading.textContent = "Dashboard";
        view.innerHTML = `<div class="card"><p>Go to the <a href="/admin">Admin Panel</a> to manage registrations.</p></div>`;
        return;
    }

    // Hotel Rep Dashboard
    if (eyebrow) eyebrow.textContent = "Hotel Rep Dashboard";
    if (heading) heading.textContent = "Your Properties";
    renderHotelRepDashboard(view, user);
}

window.showPropertyInDashboard = function(propertyId, fromComparison) {
    if (window.location.pathname !== "/dashboard") {
        window.location.href = `/dashboard?property_id=${propertyId}`;
        return;
    }
    
    if (fromComparison && selectedCompareIds.length > 0) {
        comparisonContext = [...selectedCompareIds];
    }

    const aiChatPanel = document.getElementById("aiChatPanel");
    if (aiChatPanel) {
        aiChatPanel.style.display = "none";
        const fab = document.getElementById("aiChatFAB");
        if (fab) fab.classList.remove("ai-fab-open");
    }

    const view = document.getElementById("dashboardView");
    if (view) {
        renderPropertyDetailView(view, propertyId);
    }
};

window.goBackToDashboard = function() {
    const url = new URL(window.location);
    url.searchParams.delete("property_id");
    window.history.replaceState({}, "", url);
    comparisonContext = null;
    initDashboard();
};

window.goBackToComparison = function() {
    const view = document.getElementById("dashboardView");
    if (comparisonContext && comparisonContext.length >= 2) {
        selectedCompareIds = [...comparisonContext];
        comparisonContext = null;
        const url = new URL(window.location);
        url.searchParams.delete("property_id");
        window.history.replaceState({}, "", url);
        startCompareView();
    } else {
        window.goBackToDashboard();
    }
};

window.handleCompareUpdate = function() {
    document.querySelectorAll(".compare-toggle-btn[data-property-id]").forEach(btn => {
        const pid = btn.getAttribute("data-property-id");
        const isComparing = selectedCompareIds.includes(pid);
        btn.classList.toggle("compare-toggle-active", isComparing);
        btn.innerHTML = isComparing ? "&#10003; Comparing" : "&#43; Compare";
    });
    document.querySelectorAll(".property-card[data-property-id]").forEach(card => {
        const pid = card.getAttribute("data-property-id");
        card.classList.toggle("property-card-compared", selectedCompareIds.includes(pid));
    });
    
    let bar = document.getElementById("compareFloatingBar");
    if (selectedCompareIds.length > 0) {
        if (!bar) {
            bar = document.createElement("div");
            bar.id = "compareFloatingBar";
            bar.className = "compare-floating-bar";
            document.body.appendChild(bar);
        }
        bar.innerHTML = `
            <div class="compare-bar-content container" style="display:flex; justify-content:space-between; align-items:center; width:100%; color:#fff;">
                <span>Selected <strong>${selectedCompareIds.length}</strong> stay${selectedCompareIds.length === 1 ? "" : "s"} for comparison</span>
                <div style="display:flex; gap:12px;">
                    <button class="btn btn-outline btn-small" onclick="clearCompareSelection()" style="border-color:rgba(255,255,255,0.3); color:#fff; background:transparent;">Clear</button>
                    <button class="btn btn-secondary btn-small" onclick="startCompareView()" ${selectedCompareIds.length < 2 ? "disabled" : ""}>Compare Now</button>
                </div>
            </div>
        `;
        setTimeout(() => bar.classList.add("open"), 10);
    } else {
        if (bar) {
            bar.classList.remove("open");
            setTimeout(() => bar.remove(), 200);
        }
    }
};

window.clearCompareSelection = function() {
    selectedCompareIds = [];
    sessionStorage.removeItem("compareIds");
    sessionStorage.removeItem("compareViewActive");
    document.querySelectorAll(".compare-toggle-btn").forEach(btn => {
        btn.classList.remove("compare-toggle-active");
        btn.innerHTML = "&#43; Compare";
    });
    document.querySelectorAll(".property-card-compared").forEach(card => {
        card.classList.remove("property-card-compared");
    });
    window.handleCompareUpdate();
};

window.toggleCompareFromDetail = function(propertyId) {
    const idx = selectedCompareIds.indexOf(propertyId);
    if (idx > -1) {
        selectedCompareIds.splice(idx, 1);
    } else {
        selectedCompareIds.push(propertyId);
    }
    window.handleCompareUpdate();
    const btn = document.querySelector(".compare-toggle-btn");
    if (btn) {
        const isComparing = selectedCompareIds.includes(propertyId);
        btn.className = "compare-toggle-btn" + (isComparing ? " compare-toggle-active" : "");
        btn.innerHTML = isComparing ? "&#10003; Comparing" : "&#43; Compare";
    }
};

window.toggleCompareFromSearch = function(propertyId) {
    const idx = selectedCompareIds.indexOf(propertyId);
    if (idx > -1) {
        selectedCompareIds.splice(idx, 1);
    } else {
        selectedCompareIds.push(propertyId);
    }
    window.handleCompareUpdate();
};

window.startCompareView = async function() {
    const bar = document.getElementById("compareFloatingBar");
    if (bar) {
        bar.classList.remove("open");
        setTimeout(() => bar.remove(), 200);
    }

    const view = document.getElementById("dashboardView");
    if (!view) return;

    // Persist compare state so a page refresh restores this view
    sessionStorage.setItem("compareIds", JSON.stringify(selectedCompareIds));
    sessionStorage.setItem("compareViewActive", "1");

    const url = new URL(window.location);
    url.searchParams.delete("property_id");
    window.history.replaceState({}, "", url);
    
    view.innerHTML = `<div class="empty-state">Preparing comparison workspace...</div>`;
    
    const eyebrow = document.getElementById("dashboardEyebrow");
    const heading = document.getElementById("dashboardHeading");
    if (eyebrow) eyebrow.textContent = "AI Workspace";
    if (heading) heading.textContent = "Compare Stays";

    try {
        const propPromises = selectedCompareIds.map(id => API.get(`/api/properties/${id}`));
        const properties = await Promise.all(propPromises);
        compareChatHistory = [];
        
        view.innerHTML = `
            <div class="comparison-container" style="display:flex; flex-direction:column; gap:32px; margin-top:20px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <button class="btn btn-outline btn-small" onclick="goBackToSearch()">&larr; Back to Search</button>
                    <span class="mono-label" style="font-size:0.8rem;">RAG-Powered Comparative Mode</span>
                </div>
                
                <div class="comparison-grid" style="display:grid; grid-template-columns: repeat(${properties.length}, 1fr); gap:20px;">
                    ${properties.map(p => {
                        const minPrice = p.rooms && p.rooms.length > 0 
                            ? Math.min(...p.rooms.map(r => r.base_price)) 
                            : null;
                        const priceStr = minPrice ? `From ₹${minPrice}/night` : "Price N/A";
                        const thumbnail = p.images && p.images.length > 0 ? p.images[0] : "";
                        return `
                            <div class="card comparison-prop-card" id="compCard_${p.id}" style="padding:20px; display:flex; flex-direction:column; gap:12px; cursor:pointer;" onclick="showPropertyInDashboard('${p.id}', true)">
                                <div class="comp-prop-thumb" style="height:140px; border-radius:var(--radius-md); overflow:hidden; background:var(--gold-tint);">
                                    ${thumbnail ? `<img src="${escapeHtml(thumbnail)}" alt="${escapeHtml(p.name)}" style="width:100%; height:100%; object-fit:cover;">` : `<div style="height:100%; display:flex; align-items:center; justify-content:center; font-size:2rem;">🏨</div>`}
                                </div>
                                <h4 style="font-size:1.1rem; margin-bottom:2px;">${escapeHtml(p.name)}</h4>
                                <div style="display:flex; justify-content:space-between; font-size:0.75rem; color:var(--ink-soft); font-family:'Space Mono',monospace;">
                                    <span>📍 ${escapeHtml(p.city || "Unknown")}</span>
                                    <span>⭐ ${p.avg_rating} (${p.review_count})</span>
                                </div>
                                <div style="font-family:'Space Mono',monospace; font-weight:700; font-size:0.85rem; color:var(--accent);">${priceStr}</div>
                                
                                <hr style="border:0; border-top:1px solid var(--line-soft); margin:4px 0;">
                                
                                <h5 class="mono-label" style="font-size:0.65rem; color:var(--gold); margin-bottom:4px;">Why Choose This Stay</h5>
                                <ul class="comp-attributes-list" id="compAttrs_${p.id}" style="list-style:none; padding:0; display:flex; flex-direction:column; gap:6px;">
                                    <li class="comp-attr-skeleton" style="height:14px; background:var(--line-soft); border-radius:4px; width:90%; animation: pulse 1.5s infinite;"></li>
                                    <li class="comp-attr-skeleton" style="height:14px; background:var(--line-soft); border-radius:4px; width:75%; animation: pulse 1.5s infinite;"></li>
                                    <li class="comp-attr-skeleton" style="height:14px; background:var(--line-soft); border-radius:4px; width:80%; animation: pulse 1.5s infinite;"></li>
                                </ul>
                            </div>
                        `;
                    }).join("")}
                </div>
                
                <div class="card comparison-chat-card" style="padding:24px; display:flex; flex-direction:column; gap:16px;">
                    <div style="display:flex; align-items:center; gap:8px;">
                        <span class="ai-chat-avatar" style="width:28px; height:28px; font-size:0.6rem; background:var(--accent); color:#fff; display:flex; align-items:center; justify-content:center; border-radius:50%;">VS</span>
                        <h4 style="font-size:1.15rem; margin:0;">Compare Concierge</h4>
                    </div>
                    <p style="font-size:0.85rem; color:var(--ink-soft); margin-top:-6px; margin-bottom:0;">Ask questions specifically comparing the properties above. The AI will query customer reviews and internal policy documents using RAG.</p>
                    
                    <div class="comparison-chat-messages" id="compChatMessages" style="max-height: 250px; overflow-y: auto; padding-right:8px; display:flex; flex-direction:column; gap:12px; font-size:0.9rem; border:1px solid var(--line-soft); border-radius:var(--radius-sm); padding:12px; background:rgba(0,0,0,0.015);">
                        <div class="chat-msg chat-msg-theirs" style="padding:10px 14px; background:var(--gold-tint); border-radius:var(--radius-sm); max-width:85%; align-self:flex-start; line-height:1.45;">
                            Hi! I am ready to compare these ${properties.length} properties. Ask me anything, or click a suggestion below!
                        </div>
                    </div>
                    
                    <div class="comparison-chat-suggestions" style="display:flex; flex-wrap:wrap; gap:8px;">
                        <button class="chat-suggestion-chip" onclick="askCompareQuestion(this.textContent)">Which property has a better cancellation policy?</button>
                        <button class="chat-suggestion-chip" onclick="askCompareQuestion(this.textContent)">Which stay is quieter for work?</button>
                        <button class="chat-suggestion-chip" onclick="askCompareQuestion(this.textContent)">Compare their child policies and amenities.</button>
                        <button class="chat-suggestion-chip" onclick="askCompareQuestion(this.textContent)">Which has better transit accessibility?</button>
                    </div>
                    
                    <div class="chat-input-area" style="margin-top:8px; display:flex; gap:10px; width:100%;">
                        <textarea id="compChatInput" rows="1" placeholder="Ask Compare Concierge..." style="flex:1; resize:none;" onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendCompareChatMessage()}"></textarea>
                        <button class="btn btn-primary btn-small" id="compChatSendBtn" style="height:auto;" onclick="sendCompareChatMessage()">Send</button>
                    </div>
                </div>
            </div>
        `;
        
        fetchCompareHighlights();

    } catch (err) {
        view.innerHTML = `<div class="empty-state" style="color:var(--bad)">Failed to initialize comparison: ${escapeHtml(err.message)}</div>`;
    }
};

window.goBackToSearch = function() {
    sessionStorage.removeItem("compareIds");
    sessionStorage.removeItem("compareViewActive");
    clearCompareSelection();
    initDashboard();
};

async function fetchCompareHighlights() {
    try {
        const highlights = await API.post("/api/properties/compare/highlights", { property_ids: selectedCompareIds });
        Object.keys(highlights).forEach(pid => {
            const listEl = document.getElementById(`compAttrs_${pid}`);
            if (listEl) {
                const bullets = highlights[pid];
                listEl.innerHTML = bullets.map(b => `
                    <li style="font-size:0.8rem; color:var(--ink-soft); display:flex; align-items:flex-start; gap:6px; line-height:1.4;">
                        <span style="color:var(--good); font-weight:bold;">✓</span>
                        <span>${escapeHtml(b)}</span>
                    </li>
                `).join("");
            }
        });
    } catch {
        selectedCompareIds.forEach(pid => {
            const listEl = document.getElementById(`compAttrs_${pid}`);
            if (listEl) listEl.innerHTML = `<li style="font-size:0.8rem; color:var(--bad);">Could not load highlights.</li>`;
        });
    }
}

window.askCompareQuestion = function(question) {
    const input = document.getElementById("compChatInput");
    if (input) {
        input.value = question;
        sendCompareChatMessage();
    }
};

window.sendCompareChatMessage = async function() {
    const input = document.getElementById("compChatInput");
    const sendBtn = document.getElementById("compChatSendBtn");
    const chatContainer = document.getElementById("compChatMessages");
    
    if (!input || !sendBtn || !chatContainer) return;
    
    const message = input.value.trim();
    if (!message) return;
    
    appendCompMessage("user", message);
    input.value = "";
    input.style.height = "auto";
    
    showCompTyping();
    sendBtn.disabled = true;
    
    try {
        const response = await API.post("/api/properties/compare/chat", {
            property_ids: selectedCompareIds,
            message: message,
            history: compareChatHistory
        });
        
        hideCompTyping();
        appendCompMessage("assistant", response.reply);
        
        compareChatHistory.push({ role: "user", content: message });
        const assistantEntry = { role: "assistant", content: response.reply };
        if (response.reasoning_details) {
            assistantEntry.reasoning_details = response.reasoning_details;
        }
        compareChatHistory.push(assistantEntry);
        if (compareChatHistory.length > 10) compareChatHistory.shift();

    } catch (err) {
        hideCompTyping();
        appendCompMessage("assistant", "⚠️ Sorry, I ran into an error comparing the properties. Please try again.");
    } finally {
        sendBtn.disabled = false;
        input.focus();
    }
};

// Lightweight Markdown → HTML renderer for comparison chat AI responses
function renderCompMarkdown(text) {
    const lines = text.split('\n');
    let html = '';
    let inTable = false;
    let tableHeaderDone = false;
    let inList = false;
    let i = 0;

    function closePending() {
        if (inTable) { html += '</tbody></table>'; inTable = false; tableHeaderDone = false; }
        if (inList) { html += '</ul>'; inList = false; }
    }

    while (i < lines.length) {
        const line = lines[i];
        const trimmed = line.trim();

        // Blank line
        if (!trimmed) {
            closePending();
            html += '<div style="height:6px"></div>';
            i++; continue;
        }

        // Horizontal rule
        if (/^---+$/.test(trimmed)) {
            closePending();
            html += '<hr class="comp-md-hr">';
            i++; continue;
        }

        // Headers
        const h3Match = trimmed.match(/^###\s+(.+)$/);
        const h2Match = trimmed.match(/^##\s+(.+)$/);
        const h1Match = trimmed.match(/^#\s+(.+)$/);
        if (h3Match || h2Match || h1Match) {
            closePending();
            const content = inlineMarkdown(h3Match ? h3Match[1] : h2Match ? h2Match[1] : h1Match[1]);
            const tag = h3Match ? 'h4' : h2Match ? 'h3' : 'h2';
            const cls = h3Match ? 'comp-md-h3' : h2Match ? 'comp-md-h2' : 'comp-md-h1';
            html += `<${tag} class="${cls}">${content}</${tag}>`;
            i++; continue;
        }

        // Table row (starts with |)
        if (trimmed.startsWith('|')) {
            const cells = trimmed.split('|').map(c => c.trim()).filter((_, idx, arr) => idx > 0 && idx < arr.length - 1);
            // Separator row (| --- | --- |)
            if (cells.every(c => /^[-:]+$/.test(c))) {
                tableHeaderDone = true;
                i++; continue;
            }
            if (!inTable) {
                closePending();
                html += '<div class="comp-md-table-wrap"><table class="comp-md-table">';
                inTable = true;
                tableHeaderDone = false;
            }
            if (!tableHeaderDone) {
                html += '<thead><tr>' + cells.map(c => `<th>${inlineMarkdown(c)}</th>`).join('') + '</tr></thead><tbody>';
            } else {
                html += '<tr>' + cells.map(c => `<td>${renderTableCell(c)}</td>`).join('') + '</tr>';
            }
            i++; continue;
        }

        // Close table if we were in one and this line isn't a table row
        if (inTable) { html += '</tbody></table></div>'; inTable = false; tableHeaderDone = false; }

        // Bullet list
        const listMatch = trimmed.match(/^[*\-]\s+(.+)$/);
        if (listMatch) {
            if (!inList) { html += '<ul class="comp-md-list">'; inList = true; }
            html += `<li>${inlineMarkdown(listMatch[1])}</li>`;
            i++; continue;
        }
        if (inList) { html += '</ul>'; inList = false; }

        // Plain paragraph
        html += `<p class="comp-md-p">${inlineMarkdown(trimmed)}</p>`;
        i++;
    }

    closePending();
    return html;
}

function inlineMarkdown(text) {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
        .replace(/\*(.+?)\*/g, '<em>$1</em>')
        .replace(/`(.+?)`/g, '<code class="comp-md-code">$1</code>');
}

function renderTableCell(text) {
    // Special: checkmarks / cross marks — upgrade lone ✓/✗ to badge
    if (!text || text === '') return '<span class="comp-td-empty">—</span>';
    const checked = text.match(/^[✓✔☑]$/);
    const crossed = text.match(/^[✗✘☒x]$/i);
    if (checked) return '<span class="comp-td-yes">✓</span>';
    if (crossed) return '<span class="comp-td-no">✗</span>';
    return inlineMarkdown(text);
}

function appendCompMessage(role, text) {
    const container = document.getElementById("compChatMessages");
    if (!container) return;
    
    const div = document.createElement("div");

    if (role === "user") {
        div.className = "comp-msg-user";
        div.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
    } else {
        div.className = "comp-msg-ai";
        div.innerHTML = renderCompMarkdown(text);
    }
    
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function showCompTyping() {
    const container = document.getElementById("compChatMessages");
    if (!container) return;
    
    const div = document.createElement("div");
    div.id = "compTypingIndicator";
    div.className = "chat-msg chat-msg-theirs ai-typing";
    div.style.alignSelf = "flex-start";
    div.style.padding = "10px 14px";
    div.innerHTML = '<span class="ai-typing-dot"></span><span class="ai-typing-dot"></span><span class="ai-typing-dot"></span>';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function hideCompTyping() {
    const el = document.getElementById("compTypingIndicator");
    if (el) el.remove();
}

async function renderPropertyDetailView(container, propertyId) {
    container.innerHTML = `<div class="empty-state">Loading property details...</div>`;
    try {
        const [prop, reviews] = await Promise.all([
            API.get(`/api/properties/${propertyId}`),
            API.get(`/api/reviews/property/${propertyId}`)
        ]);
        
        currentSelectedProperty = prop;
        
        const eyebrow = document.getElementById("dashboardEyebrow");
        const heading = document.getElementById("dashboardHeading");
        if (eyebrow) eyebrow.textContent = "Property Detail";
        if (heading) heading.textContent = prop.name;
        
        const badgesHtml = prop.avg_rating >= 4.0 
            ? `<span class="prop-badge">⭐ ${prop.avg_rating} (${prop.review_count} reviews)</span>` 
            : `<span>No ratings yet</span>`;
            
        const images = prop.images || [];
        let galleryHtml = "";
        if (images.length > 0) {
            galleryHtml = `
                <div class="property-detail-gallery">
                    <div class="gallery-main-img" onclick="openPropertyGallery('${prop.id}')" title="Click to view all photos">
                        <img src="${escapeHtml(images[0])}" alt="${escapeHtml(prop.name)}">
                    </div>
                    <div class="gallery-sub-images">
                        ${images.slice(1, 4).map(img => `
                            <div class="gallery-sub-img" onclick="openPropertyGallery('${prop.id}')">
                                <img src="${escapeHtml(img)}" alt="">
                            </div>
                        `).join("")}
                        ${images.length > 4 ? `
                            <div class="gallery-sub-img gallery-more-photos" onclick="openPropertyGallery('${prop.id}')">
                                <span>+${images.length - 4} photos</span>
                            </div>
                        ` : ""}
                    </div>
                </div>
            `;
        } else {
            galleryHtml = `<div class="thumb-placeholder" style="height: 200px; display:flex; align-items:center; justify-content:center; background: var(--gold-tint); border-radius: var(--radius-md);">No photos available</div>`;
        }
        
        const amenitiesList = prop.amenities ? Object.keys(prop.amenities).filter(k => prop.amenities[k]) : [];
        const amenitiesHtml = amenitiesList.length > 0
            ? `<div class="prop-amenity-tags" style="display:flex; flex-wrap:wrap; gap:8px; margin:16px 0;">
                ${amenitiesList.map(a => `<span class="badge badge-pending" style="background:#e3f2fd; color:#0d47a1; text-transform: capitalize; padding: 6px 12px; font-size:0.85rem;">${escapeHtml(a.replace('_', ' '))}</span>`).join("")}
               </div>`
            : `<p style="color:var(--ink-soft);">No amenities specified.</p>`;

        let reviewsHtml = "";
        if (reviews.length === 0) {
            reviewsHtml = `<div class="empty-state">No reviews yet for this property.</div>`;
        } else {
            reviewsHtml = `
                <div class="reviews-list-inline" style="margin-top: 20px; max-height: 400px; overflow-y: auto; padding-right: 8px;">
                    ${reviews.map(r => `
                        <div style="border-bottom:1px solid var(--line-soft); padding:14px 0;">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                                <strong>${escapeHtml(r.customer_name || "Anonymous")}</strong>
                                <span style="color:var(--accent); font-size:1rem;">${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</span>
                            </div>
                            ${r.comment ? `<p style="margin:6px 0; font-size:0.92rem;">${escapeHtml(r.comment)}</p>` : ""}
                            <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.78rem; color:var(--ink-faint); font-family:'Space Mono',monospace; margin-top:6px;">
                                <span>${new Date(r.created_at).toLocaleDateString()}</span>
                            </div>
                            ${r.rep_response ? `<div style="margin-top:8px; padding:10px 14px; background:var(--gold-tint); border-radius:var(--radius-sm); font-size:0.88rem;"><strong>Host response:</strong> ${escapeHtml(r.rep_response)}</div>` : ""}
                        </div>
                    `).join("")}
                </div>
            `;
        }

        let roomsHtml = "";
        if (!prop.rooms || prop.rooms.length === 0) {
            roomsHtml = `<div class="empty-state">No rooms available at this property.</div>`;
        } else {
            roomsHtml = `
                <div class="room-pick-list" style="margin-top: 15px;">
                    ${prop.rooms.map(r => `
                        <div class="room-item">
                            <div class="room-item-header">
                                ${r.images && r.images.length > 0
                                    ? `<div class="room-item-thumb" onclick="openPropertyGallery('${prop.id}', '${r.id}')" title="View photos"><img src="${escapeHtml(r.images[0])}" alt="${escapeHtml(r.room_type)}"></div>`
                                    : `<div class="room-item-thumb placeholder">🛏️</div>`}
                                <div style="flex:1">
                                    <h5 style="margin-bottom:2px">${escapeHtml(r.room_type)}</h5>
                                    <div class="room-details" style="margin-bottom:0">
                                        <span>₹${r.base_price}/night</span>
                                        <span>Capacity: ${r.capacity_adults} Adults ${r.capacity_children ? `, ${r.capacity_children} Children` : ""}</span>
                                    </div>
                                    ${r.room_amenities && Object.keys(r.room_amenities).length > 0 ? `
                                        <div class="room-amenity-tags" style="margin-top: 8px; display: flex; flex-wrap: wrap; gap: 5px;">
                                            ${Object.keys(r.room_amenities).filter(k => r.room_amenities[k]).map(k => `<span class="badge badge-pending" style="background:#e3f2fd; color:#0d47a1; text-transform: capitalize; font-size:0.72rem; padding: 2px 6px;">${escapeHtml(k.replace('_', ' '))}</span>`).join('')}
                                        </div>
                                    ` : ''}
                                </div>
                            </div>
                            <button class="btn btn-secondary btn-small" onclick="openBookingModal('${prop.id}', '${r.id}')">Book Room</button>
                        </div>
                    `).join("")}
                </div>
            `;
        }

        const backBtnHtml = comparisonContext
            ? `<button class="btn btn-outline btn-small" onclick="goBackToComparison()">&larr; Back to Comparison</button>`
            : `<button class="btn btn-outline btn-small" onclick="goBackToDashboard()">&larr; Back to Search</button>`;

        const isComparing = selectedCompareIds.includes(prop.id);
        const compareToggleHtml = `
            <button class="compare-toggle-btn ${isComparing ? 'compare-toggle-active' : ''}" onclick="toggleCompareFromDetail('${prop.id}')">
                ${isComparing ? '&#10003; Comparing' : '&#43; Compare'}
            </button>`;

        container.innerHTML = `
            <div class="property-detail-container" style="display:flex; flex-direction:column; gap:24px; margin-top:20px;">
                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
                    ${backBtnHtml}
                    <div style="display:flex; align-items:center; gap:10px;">
                        ${compareToggleHtml}
                        ${badgesHtml}
                    </div>
                </div>
                
                ${galleryHtml}
                
                <div class="property-detail-body" style="display:grid; grid-template-columns: 2fr 1fr; gap:32px; min-width:0;">
                    <div class="detail-main-col">
                        <section class="card" style="margin-bottom:20px; padding: 24px;">
                            <h3>About the Property</h3>
                            <p style="line-height:1.6; margin-top:12px;">${escapeHtml(prop.description || "No description provided.")}</p>
                            <h4 style="margin-top:24px;">Address & Location</h4>
                            <p style="color:var(--ink-soft); margin-top:8px;">📍 ${escapeHtml(prop.address)}</p>
                        </section>
                        
                        <section class="card" style="padding: 24px;">
                            <h3>Available Rooms</h3>
                            ${roomsHtml}
                        </section>
                    </div>
                    
                    <div class="detail-side-col">
                        <section class="card" style="margin-bottom:20px; padding: 20px;">
                            <h3>Amenities</h3>
                            ${amenitiesHtml}
                        </section>
                        
                        <section class="card" style="padding: 20px;">
                            <h3>Guest Reviews</h3>
                            ${reviewsHtml}
                        </section>
                    </div>
                </div>
            </div>
        `;
        
    } catch (err) {
        container.innerHTML = `<div class="empty-state" style="color:var(--bad)">Failed to load property details: ${escapeHtml(err.message)}</div>`;
    }
}

// ==================== Customer Dashboard: search + book + history ====================
let lastSearchResults = [];

async function renderCustomerDashboard(container, user) {
    container.innerHTML = `
        <div class="card search-panel">
            <p class="eyebrow" style="margin-bottom:10px">Search stays</p>
            <form id="searchForm" class="search-form">
                <div class="form-group search-location autocomplete-wrapper">
                    <label for="searchLocation">Where to?</label>
                    <input type="text" id="searchLocation" placeholder="City, region or hotel name" autocomplete="off">
                    <div id="searchLocationDropdown" class="autocomplete-dropdown"></div>
                </div>
                <div class="form-group">
                    <label for="searchCheckIn">Check-in</label>
                    <input type="date" id="searchCheckIn" required>
                </div>
                <div class="form-group">
                    <label for="searchCheckOut">Check-out</label>
                    <input type="date" id="searchCheckOut" required>
                </div>
                <div class="form-group">
                    <label for="searchAdults">Adults</label>
                    <input type="number" id="searchAdults" min="1" value="2">
                </div>
                <div class="form-group">
                    <label for="searchChildren">Children</label>
                    <input type="number" id="searchChildren" min="0" value="0">
                </div>
                <button type="submit" class="btn btn-primary">Search</button>
            </form>
            <div id="searchError" class="error-msg"></div>
        </div>

        <div class="card filter-panel" id="filterPanel" style="margin-top:16px; display:none;">
            <div style="display:flex; gap:16px; align-items:center; flex-wrap:wrap;">
                <div class="form-group" style="flex:1; min-width:200px;">
                    <label for="filterPriceRange">Max price per night: &#8377;<span id="filterPriceLabel">5000</span></label>
                    <input type="range" id="filterPriceRange" min="0" max="20000" step="500" value="5000" style="width:100%;">
                </div>
                <div class="form-group" style="min-width:150px;">
                    <label for="filterMinRating">Min rating</label>
                    <select id="filterMinRating">
                        <option value="">Any</option>
                        <option value="1">1+</option>
                        <option value="2">2+</option>
                        <option value="3">3+</option>
                        <option value="4">4+</option>
                        <option value="4.5">4.5+</option>
                    </select>
                </div>
                <div class="form-group" style="min-width:130px;">
                    <label for="filterPropertyType">Property type</label>
                    <select id="filterPropertyType">
                        <option value="">All types</option>
                        <option value="hotel">Hotel</option>
                        <option value="villa">Villa</option>
                        <option value="homestay">Homestay</option>
                        <option value="resort">Resort</option>
                    </select>
                </div>
                <div class="form-group" style="min-width:120px;">
                    <label for="filterSortBy">Sort by</label>
                    <select id="filterSortBy">
                        <option value="trending">Trending</option>
                        <option value="price_asc">Price: Low to High</option>
                        <option value="price_desc">Price: High to Low</option>
                        <option value="rating_desc">Rating: High to Low</option>
                    </select>
                </div>
                <button class="btn btn-primary btn-small" onclick="applyFilters()" style="margin-top:18px;">Apply Filters</button>
                <button class="btn btn-outline btn-small" onclick="resetFilters()" style="margin-top:18px;">Reset</button>
            </div>
            <div style="display:flex; gap:12px; flex-wrap:wrap; margin-top:10px;">
                <label class="amenity-checkbox-label"><input type="checkbox" name="filterAmenity" value="wifi"> WiFi</label>
                <label class="amenity-checkbox-label"><input type="checkbox" name="filterAmenity" value="parking"> Parking</label>
                <label class="amenity-checkbox-label"><input type="checkbox" name="filterAmenity" value="pool"> Pool</label>
                <label class="amenity-checkbox-label"><input type="checkbox" name="filterAmenity" value="ac"> A/C</label>
                <label class="amenity-checkbox-label"><input type="checkbox" name="filterAmenity" value="gym"> Gym</label>
                <label class="amenity-checkbox-label"><input type="checkbox" name="filterAmenity" value="restaurant"> Restaurant</label>
                <label class="amenity-checkbox-label"><input type="checkbox" name="filterAmenity" value="spa"> Spa</label>
            </div>
        </div>

        <div id="searchResults"></div>
    `;

    // Sensible defaults so the form is bookable with zero typing
    const in1 = new Date(); in1.setDate(in1.getDate() + 1);
    const in2 = new Date(); in2.setDate(in2.getDate() + 2);
    const todayStr = new Date().toISOString().slice(0, 10);
    const in1Str = in1.toISOString().slice(0, 10);
    const in2Str = in2.toISOString().slice(0, 10);

    const checkInEl = document.getElementById("searchCheckIn");
    const checkOutEl = document.getElementById("searchCheckOut");
    checkInEl.value = in1Str;
    checkOutEl.value = in2Str;
    checkInEl.min = todayStr;
    checkOutEl.min = in1Str;

    // Keep check-out after check-in as the person edits check-in
    checkInEl.addEventListener("change", () => {
        checkOutEl.min = checkInEl.value;
        if (checkOutEl.value <= checkInEl.value) {
            const next = new Date(checkInEl.value);
            next.setDate(next.getDate() + 1);
            checkOutEl.value = next.toISOString().slice(0, 10);
        }
    });

    document.getElementById("searchForm").addEventListener("submit", (e) => {
        e.preventDefault();
        runPropertySearch();
    });

    document.getElementById("filterPriceRange").addEventListener("input", () => {
        document.getElementById("filterPriceLabel").textContent = document.getElementById("filterPriceRange").value;
    });

    initSearchAutocomplete();

    // Restore search state from URL params (survives page refresh)
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("searched") === "1") {
        const locVal = urlParams.get("location") || "";
        if (locVal) document.getElementById("searchLocation").value = locVal;

        const checkIn = urlParams.get("check_in");
        const checkOut = urlParams.get("check_out");
        if (checkIn) document.getElementById("searchCheckIn").value = checkIn;
        if (checkOut) document.getElementById("searchCheckOut").value = checkOut;

        const adults = urlParams.get("adults");
        if (adults) document.getElementById("searchAdults").value = adults;
        const children = urlParams.get("children");
        if (children) document.getElementById("searchChildren").value = children;

        // Filters
        const maxPrice = urlParams.get("max_price");
        if (maxPrice) {
            document.getElementById("filterPriceRange").value = maxPrice;
            document.getElementById("filterPriceLabel").textContent = maxPrice;
        }
        const minRating = urlParams.get("min_rating");
        if (minRating) document.getElementById("filterMinRating").value = minRating;
        const propType = urlParams.get("property_type");
        if (propType) document.getElementById("filterPropertyType").value = propType;
        const sortBy = urlParams.get("sort_by");
        if (sortBy) document.getElementById("filterSortBy").value = sortBy;
        const amenities = urlParams.getAll("amenities");
        if (amenities.length) {
            document.querySelectorAll('input[name="filterAmenity"]').forEach(cb => {
                cb.checked = amenities.includes(cb.value);
            });
        }

        // Show filters and re-run the search automatically
        document.getElementById("filterPanel").style.display = "block";
        runPropertySearch();
    }
}

function initSearchAutocomplete() {
    const input = document.getElementById("searchLocation");
    const dropdown = document.getElementById("searchLocationDropdown");
    if (!input || !dropdown) return;
    let debounceTimer, selectedIndex = -1, selectedLocation = null;

    async function fetchAndRender(q) {
        try {
            const locations = await API.get(`/api/hotels/locations/search?q=${encodeURIComponent(q)}`);
            dropdown.innerHTML = "";
            if (locations.length === 0) {
                dropdown.innerHTML = `<div class="autocomplete-empty">No locations found</div>`;
                dropdown.classList.add("open");
                return;
            }
            locations.forEach((loc, i) => {
                const item = document.createElement("div");
                item.className = "autocomplete-item";
                const typeLabel = loc.type === "property" ? "property" : loc.type;
                item.innerHTML = `${escapeHtml(loc.name)}<span class="location-type">${escapeHtml(typeLabel)}</span>`;
                item.addEventListener("click", () => {
                    selectedLocation = loc;
                    input.value = loc.name;
                    dropdown.classList.remove("open");
                    input.focus();
                });
                item.addEventListener("mouseenter", () => {
                    document.querySelectorAll(".autocomplete-item").forEach((el, j) => el.classList.toggle("highlighted", j === i));
                    selectedIndex = i;
                });
                dropdown.appendChild(item);
            });
            dropdown.classList.add("open");
        } catch {
            dropdown.classList.remove("open");
        }
    }

    input.addEventListener("input", () => {
        clearTimeout(debounceTimer);
        selectedLocation = null;
        const val = input.value.trim();
        if (val.length < 1) { dropdown.classList.remove("open"); return; }
        debounceTimer = setTimeout(() => fetchAndRender(val), 250);
    });

    input.addEventListener("focus", () => {
        const val = input.value.trim();
        if (val.length >= 1 && !selectedLocation) fetchAndRender(val);
    });

    input.addEventListener("keydown", (e) => {
        const items = dropdown.querySelectorAll(".autocomplete-item");
        if (e.key === "ArrowDown") { e.preventDefault(); selectedIndex = Math.min(selectedIndex + 1, items.length - 1); items.forEach((el, i) => el.classList.toggle("highlighted", i === selectedIndex)); }
        else if (e.key === "ArrowUp") { e.preventDefault(); selectedIndex = Math.max(selectedIndex - 1, -1); items.forEach((el, i) => el.classList.toggle("highlighted", i === selectedIndex)); }
        else if (e.key === "Enter" && selectedIndex >= 0) { e.preventDefault(); items[selectedIndex]?.click(); }
        else if (e.key === "Escape") { dropdown.classList.remove("open"); selectedIndex = -1; input.blur(); }
    });

    document.addEventListener("click", (e) => {
        if (!input.closest(".autocomplete-wrapper")?.contains(e.target)) {
            dropdown.classList.remove("open");
        }
    });
}

async function runPropertySearch() {
    const resultsDiv = document.getElementById("searchResults");
    const errDiv = document.getElementById("searchError");
    errDiv.style.display = "none";

    const params = new URLSearchParams({
        check_in: document.getElementById("searchCheckIn").value,
        check_out: document.getElementById("searchCheckOut").value,
        adults: document.getElementById("searchAdults").value || "1",
        children: document.getElementById("searchChildren").value || "0",
    });
    const location = document.getElementById("searchLocation").value.trim();
    if (location) params.set("location", location);

    // Filters
    const maxPrice = document.getElementById("filterPriceRange").value;
    if (maxPrice && maxPrice !== "5000") params.set("max_price", maxPrice);

    const minRating = document.getElementById("filterMinRating").value;
    if (minRating) params.set("min_rating", minRating);

    const propType = document.getElementById("filterPropertyType").value;
    if (propType) params.set("property_type", propType);

    const sortBy = document.getElementById("filterSortBy").value;
    if (sortBy && sortBy !== "trending") params.set("sort_by", sortBy);

    const amenityCbs = document.querySelectorAll('input[name="filterAmenity"]:checked');
    amenityCbs.forEach(cb => params.append("amenities", cb.value));

    // Persist search state in the URL so a page refresh restores the results
    params.set("searched", "1");
    const newUrl = new URL(window.location);
    newUrl.search = params.toString();
    window.history.replaceState({}, "", newUrl);

    resultsDiv.innerHTML = `<div class="empty-state">Searching…</div>`;

    // Show filter panel on first search
    document.getElementById("filterPanel").style.display = "block";

    try {
        const properties = await API.get(`/api/properties/search?${params.toString()}`);
        lastSearchResults = properties;
        renderSearchResults(properties);
    } catch (err) {
        errDiv.style.display = "block";
        errDiv.textContent = err.message;
        resultsDiv.innerHTML = "";
    }
}
function applyFilters() {
    if (lastSearchResults.length > 0) runPropertySearch();
}

function resetFilters() {
    document.getElementById("filterPriceRange").value = "5000";
    document.getElementById("filterPriceLabel").textContent = "5000";
    document.getElementById("filterMinRating").value = "";
    document.getElementById("filterPropertyType").value = "";
    document.getElementById("filterSortBy").value = "trending";
    document.querySelectorAll('input[name="filterAmenity"]').forEach(cb => cb.checked = false);
}

// ── Multi-room cart state ────────────────────────────────────────────────────
let bookingCart = {};  // keyed by `${propertyId}:${roomId}`: { propId, roomData, qty, pricePerUnit }

function getCartTotal(propertyId) {
    const entries = Object.entries(bookingCart).filter(([k]) => k.startsWith(propertyId + ":"));
    return entries.reduce((sum, [, item]) => sum + (item.pricePerUnit * item.qty), 0);
}

function getCartCount(propertyId) {
    const entries = Object.entries(bookingCart).filter(([k]) => k.startsWith(propertyId + ":"));
    return entries.reduce((sum, [, item]) => sum + item.qty, 0);
}

function updateCartUI(propertyId) {
    const bar = document.getElementById(`cartBar_${propertyId}`);
    const count = getCartCount(propertyId);
    const total = getCartTotal(propertyId);
    if (bar) {
        if (count > 0) {
            bar.style.display = "flex";
            bar.querySelector(".cart-count").textContent = count;
            bar.querySelector(".cart-total").textContent = `₹${total}`;
        } else {
            bar.style.display = "none";
        }
    }
}

function changeRoomQty(propertyId, room, delta) {
    const key = `${propertyId}:${room.id}`;
    const current = bookingCart[key];
    const curQty = current ? current.qty : 0;
    const newQty = curQty + delta;
    if (newQty < 0) return;

    const maxQty = room.free_units !== undefined ? room.free_units : room.total_quantity;

    if (newQty > maxQty) {
        alert(`Only ${maxQty} unit(s) available for this room.`);
        return;
    }

    if (newQty === 0) {
        delete bookingCart[key];
    } else {
        bookingCart[key] = {
            propId: propertyId,
            roomData: room,
            qty: newQty,
            pricePerUnit: room.total_price || room.base_price,
        };
    }

    // Update UI
    const input = document.querySelector(`.qty-input[data-room="${room.id}"]`);
    if (input) input.value = newQty;
    const btn_container = document.querySelector(`.book-btn-container[data-room="${room.id}"]`);
    if (btn_container) {
        if (newQty > 0) {
            const subtotal = newQty * (room.total_price || room.base_price);
            btn_container.innerHTML = `<span class="room-subtotal">₹${subtotal}</span>`;
        } else {
            btn_container.innerHTML = `<span class="room-subtotal" style="color:var(--ink-soft)">—</span>`;
        }
    }
    updateCartUI(propertyId);
}

function renderSearchResults(properties) {
    const resultsDiv = document.getElementById("searchResults");
    if (properties.length === 0) {
        resultsDiv.innerHTML = `<div class="empty-state">No stays match those dates yet. Try a different location or date range.</div>`;
        return;
    }

    resultsDiv.innerHTML = `<div class="property-list">` + properties.map(p => {
        const isComparing = selectedCompareIds.includes(p.id);
        const propRooms = p.rooms || [];
        const totalNights = propRooms.length > 0 && propRooms[0].nights ? propRooms[0].nights : 1;
        const availableStr = propRooms.some(r => r.free_units !== undefined)
            ? propRooms.map(r => `${r.room_type}: ${r.free_units}/${r.total_quantity} available`).join(" · ")
            : "";

        return `
        <div class="property-card ${isComparing ? 'property-card-compared' : ''}" data-property-id="${p.id}">
            <div class="property-thumb" onclick="openPropertyGallery('${p.id}')" title="View photos">
                ${p.thumbnail
                    ? `<img src="${escapeHtml(p.thumbnail)}" alt="${escapeHtml(p.name)}">`
                    : `<div class="thumb-placeholder">No photos yet</div>`}
                ${p.photo_count ? `<span class="photo-count-badge">📷 ${p.photo_count}</span>` : ""}
            </div>
            <h4>${escapeHtml(p.name)}</h4>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                <div class="prop-type">${escapeHtml([p.city, p.district].filter(Boolean).join(", ") || "Location N/A")}${p.property_type ? " · " + escapeHtml(p.property_type) : ""}</div>
                <button class="compare-toggle-btn ${isComparing ? 'compare-toggle-active' : ''}" data-property-id="${p.id}" onclick="toggleCompareFromSearch('${p.id}')">
                    ${isComparing ? '&#10003; Comparing' : '&#43; Compare'}
                </button>
            </div>
            ${p.description ? `<p>${escapeHtml(p.description.slice(0, 110))}${p.description.length > 110 ? "…" : ""}</p>` : ""}
            ${p.badges && p.badges.length > 0 ? `<div class="prop-badges">${p.badges.map(b => `<span class="prop-badge">${b.icon} ${b.label}</span>`).join("")}</div>` : ""}
            ${p.ai_highlight ? `<div class="prop-ai-highlight">✨ ${escapeHtml(p.ai_highlight)}</div>` : ""}
            <p style="font-family:'Space Mono',monospace; font-size:0.78rem; color:var(--ink-soft); margin:10px 0 14px;">From ₹${p.from_price} total &middot; <a href="#" onclick="event.preventDefault();openPropertyReviews('${p.id}')" style="color:var(--lilac-deep);">${p.review_count} review${p.review_count === 1 ? "" : "s"}</a></p>
            ${availableStr ? `<p style="font-size:0.75rem;color:var(--lilac-deep);margin:-4px 0 10px;">${availableStr}</p>` : ""}
            <div class="room-pick-list">
                ${propRooms.map(r => `
                    <div class="room-item">
                        <div class="room-item-header">
                            ${r.images && r.images.length > 0
                                ? `<div class="room-item-thumb" onclick="openPropertyGallery('${p.id}', '${r.id}')" title="View photos"><img src="${escapeHtml(r.images[0])}" alt="${escapeHtml(r.room_type)}"></div>`
                                : `<div class="room-item-thumb placeholder">🏛</div>`}
                            <div style="flex:1">
                                <h5 style="margin-bottom:2px">${escapeHtml(r.room_type)}</h5>
                                <div class="room-details" style="margin-bottom:0">
                                    <span>₹${r.base_price}/night</span>
                                    <span>Sleeps ${r.capacity_adults + r.capacity_children}</span>
                                    ${totalNights > 1 ? `<span>${totalNights} nights</span>` : ""}
                                </div>
                            </div>
                        </div>
                        <div style="display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap;">
                            <div class="qty-selector">
                                <button class="qty-btn" onclick="changeRoomQty('${p.id}', ${JSON.stringify(r).replace(/"/g, "'")}, -1)">−</button>
                                <input type="number" class="qty-input" data-room="${r.id}" value="${bookingCart[`${p.id}:${r.id}`]?.qty || 0}" min="0" max="${r.free_units !== undefined ? r.free_units : r.total_quantity}" readonly>
                                <button class="qty-btn" onclick="changeRoomQty('${p.id}', ${JSON.stringify(r).replace(/"/g, "'")}, 1)">+</button>
                            </div>
                            <div class="book-btn-container" data-room="${r.id}">
                                <span class="room-subtotal" style="${bookingCart[`${p.id}:${r.id}`] ? '' : 'color:var(--ink-soft)'}">${bookingCart[`${p.id}:${r.id}`] ? '₹' + (bookingCart[`${p.id}:${r.id}`].qty * (r.total_price || r.base_price)) : '—'}</span>
                            </div>
                        </div>
                    </div>
                `).join("")}
            </div>
            <div id="cartBar_${p.id}" class="cart-bar" style="display:${getCartCount(p.id) > 0 ? 'flex' : 'none'};">
                <span class="cart-info"><span class="cart-count">${getCartCount(p.id)}</span> room(s) selected · <span class="cart-total">₹${getCartTotal(p.id)}</span></span>
                <button class="btn btn-primary btn-small" onclick="openBulkBookingModal('${p.id}')">Book Now</button>
            </div>
            <div class="prop-actions" style="${getCartCount(p.id) > 0 ? 'margin-top:0;' : ''}">
                <button class="btn btn-outline btn-small" onclick="openPropertyGallery('${p.id}')">View Photos</button>
                <button class="btn btn-secondary btn-small" onclick="contactHost('${p.id}')">Contact Host</button>
            </div>
        </div>
        `;
    }).join("") + `</div>`;
}

// ==================== Photo gallery (lightbox) ====================
// Used by customers to browse every photo a hotel rep has uploaded for a
// property and its rooms, since the search card only has room for one
// thumbnail per listing.
async function openPropertyGallery(propertyId, focusRoomId) {
    const modal = document.createElement("div");
    modal.className = "modal-overlay gallery-modal";
    modal.innerHTML = `
        <div class="modal">
            <button class="close-modal" onclick="this.closest('.modal-overlay').remove()">&times;</button>
            <h3>Photos</h3>
            <div id="galleryBody"><div class="gallery-empty">Loading photosâ€¦</div></div>
        </div>
    `;
    document.body.appendChild(modal);

    let slides = [];
    try {
        const prop = await API.get(`/api/properties/${propertyId}`);
        (prop.images || []).forEach(url => slides.push({ url, caption: prop.name }));
        (prop.rooms || []).forEach(room => {
            (room.images || []).forEach(url => slides.push({ url, caption: room.room_type, roomId: room.id }));
        });
    } catch (err) {
        document.getElementById("galleryBody").innerHTML = `<div class="gallery-empty">Couldn't load photos.</div>`;
        return;
    }

    const body = document.getElementById("galleryBody");
    if (slides.length === 0) {
        body.innerHTML = `<div class="gallery-empty">No photos uploaded for this property yet.</div>`;
        return;
    }

    let index = 0;
    if (focusRoomId) {
        const found = slides.findIndex(s => s.roomId === focusRoomId);
        if (found >= 0) index = found;
    }

    function render() {
        const s = slides[index];
        body.innerHTML = `
            <div class="gallery-main">
                ${slides.length > 1 ? `<button class="gallery-nav prev" onclick="event.stopPropagation();window.__galleryPrev()">&larr;</button>` : ""}
                <img src="${escapeHtml(s.url)}" alt="${escapeHtml(s.caption)}">
                ${slides.length > 1 ? `<button class="gallery-nav next" onclick="event.stopPropagation();window.__galleryNext()">&rarr;</button>` : ""}
            </div>
            <div class="gallery-caption">${escapeHtml(s.caption)} &middot; ${index + 1} / ${slides.length}</div>
            <div class="gallery-thumbs">
                ${slides.map((sl, i) => `<div class="g-thumb ${i === index ? "active" : ""}" onclick="window.__galleryJump(${i})"><img src="${escapeHtml(sl.url)}" alt=""></div>`).join("")}
            </div>
        `;
    }

    window.__galleryPrev = () => { index = (index - 1 + slides.length) % slides.length; render(); };
    window.__galleryNext = () => { index = (index + 1) % slides.length; render(); };
    window.__galleryJump = (i) => { index = i; render(); };

    render();
}

function openBulkBookingModal(propertyId) {
    let prop = lastSearchResults.find(p => p.id === propertyId);
    if (!prop && currentSelectedProperty && currentSelectedProperty.id === propertyId) {
        prop = currentSelectedProperty;
    }
    if (!prop) return;

    const checkIn = document.getElementById("searchCheckIn")?.value || new Date(Date.now() + 86400000).toISOString().slice(0, 10);
    const checkOut = document.getElementById("searchCheckOut")?.value || new Date(Date.now() + 172800000).toISOString().slice(0, 10);

    const cartEntries = Object.entries(bookingCart)
        .filter(([k]) => k.startsWith(propertyId + ":"))
        .map(([, item]) => item);

    if (cartEntries.length === 0) return;

    let nights = 1;
    if (checkIn && checkOut) {
        const d1 = new Date(checkIn);
        const d2 = new Date(checkOut);
        nights = Math.max(1, Math.round((d2 - d1) / (1000 * 60 * 60 * 24)));
    }

    // Build guest distribution UI
    function buildGuestRows() {
        let html = "";
        let entryIndex = 0;
        for (const item of cartEntries) {
            for (let i = 0; i < item.qty; i++) {
                const roomData = item.roomData;
                const key = `entry_${entryIndex}`;
                const defaultAdults = Math.min(roomData.capacity_adults, roomData.capacity_adults);
                const defaultChildren = 0;
                html += `
                    <div class="guest-entry" data-key="${key}" data-room-id="${roomData.id}" style="padding:8px 0;border-bottom:1px solid var(--border);">
                        <div style="display:flex;justify-content:space-between;align-items:center;">
                            <strong>${escapeHtml(roomData.room_type)} #${i + 1}</strong>
                            <span style="font-size:0.8rem;color:var(--ink-soft);">Max: ${roomData.capacity_adults}A + ${roomData.capacity_children}C</span>
                        </div>
                        <div style="display:flex;gap:16px;margin-top:6px;">
                            <label style="display:flex;align-items:center;gap:6px;">Adults:
                                <select class="guest-adults" data-key="${key}" style="width:70px;">
                                    ${Array.from({length: roomData.capacity_adults}, (_, a) => `<option value="${a + 1}" ${a + 1 === defaultAdults ? 'selected' : ''}>${a + 1}</option>`).join("")}
                                </select>
                            </label>
                            <label style="display:flex;align-items:center;gap:6px;">Children:
                                <select class="guest-children" data-key="${key}" style="width:70px;">
                                    ${Array.from({length: roomData.capacity_children + 1}, (_, c) => `<option value="${c}" ${c === defaultChildren ? 'selected' : ''}>${c}</option>`).join("")}
                                </select>
                            </label>
                        </div>
                    </div>
                `;
                entryIndex++;
            }
        }
        return html;
    }

    const totalPrice = getCartTotal(propertyId);

    const modal = document.createElement("div");
    modal.className = "modal-overlay";
    modal.innerHTML = `
        <div class="modal modal-wide">
            <button class="close-modal" onclick="this.closest('.modal-overlay').remove()">&times;</button>
            <h3>Complete Your Stay</h3>
            <p style="font-weight:600; margin-bottom:4px;">${escapeHtml(prop.name)}</p>
            <p style="color:var(--ink-soft); margin-bottom:14px;">${checkIn} → ${checkOut} · ${nights} night${nights > 1 ? "s" : ""}</p>

            <h4 style="margin-bottom:8px;">Guest Distribution</h4>
            <p style="font-size:0.8rem;color:var(--ink-soft);margin-bottom:12px;">Set how many adults and children stay in each room.</p>
            <div id="guestEntries">${buildGuestRows()}</div>

            <div style="margin-top:16px;padding-top:12px;border-top:1px solid var(--border);display:flex;justify-content:space-between;align-items:center;">
                <span style="font-weight:600;">Total: ₹${totalPrice}</span>
            </div>
            <div id="bulkBookingError" class="error-msg"></div>
            <button id="confirmBulkBookingBtn" class="btn btn-primary btn-full" style="margin-top:12px;">Confirm &amp; Book All Rooms</button>
        </div>
    `;
    document.body.appendChild(modal);

    const confirmBtn = document.getElementById("confirmBulkBookingBtn");
    confirmBtn.addEventListener("click", async () => {
        const errDiv = document.getElementById("bulkBookingError");
        errDiv.style.display = "none";
        confirmBtn.disabled = true;

        // Build room list with per-room guest distribution
        const roomsPayload = [];
        const seen = {};
        for (const item of cartEntries) {
            const roomId = item.roomData.id;
            const key = roomId;
            if (!seen[key]) {
                seen[key] = { room_id: roomId, quantity: 0, adults_per_room: [], children_per_room: [] };
                roomsPayload.push(seen[key]);
            }
        }

        // Collect all guest entries in order
        const entryDivs = document.querySelectorAll(".guest-entry");
        const entriesByRoom = {};
        entryDivs.forEach(el => {
            const rid = el.dataset.roomId;
            const adults = parseInt(el.querySelector(".guest-adults").value);
            const children = parseInt(el.querySelector(".guest-children").value);
            if (!entriesByRoom[rid]) entriesByRoom[rid] = [];
            entriesByRoom[rid].push({ adults, children });
        });

        for (const entry of roomsPayload) {
            const allocs = entriesByRoom[entry.room_id] || [];
            entry.quantity = allocs.length;
            entry.adults_per_room = allocs.map(a => a.adults);
            entry.children_per_room = allocs.map(a => a.children);
        }

        try {
            const resp = await API.post("/api/bookings/bulk", {
                property_id: propertyId,
                check_in: checkIn,
                check_out: checkOut,
                rooms: roomsPayload,
                idempotency_key: (window.crypto && crypto.randomUUID)
                    ? crypto.randomUUID()
                    : `${propertyId}-${checkIn}-${Date.now()}`,
            });
            modal.remove();
            // Clear cart for this property
            Object.keys(bookingCart).forEach(k => { if (k.startsWith(propertyId + ":")) delete bookingCart[k]; });
            loadMyBookings();
            if (document.getElementById("searchResults")) {
                runPropertySearch();
            }
        } catch (err) {
            errDiv.style.display = "block";
            errDiv.textContent = err.message;
            confirmBtn.disabled = false;
        }
    });
}


let _bookingsContainer = null;

async function loadMyBookings(container) {
    container = container || _bookingsContainer || document.getElementById("myBookings");
    if (!container) return;
    _bookingsContainer = container;
    container.innerHTML = `<div class="empty-state">Loading your stays…</div>`;
    try {
        const [bookings, groups] = await Promise.all([
            API.get("/api/bookings"),
            API.get("/api/bookings/groups"),
        ]);
        renderMyBookings(bookings, groups, container);
    } catch (err) {
        container.innerHTML = `<div class="empty-state">Couldn't load your stays.</div>`;
    }
}

function renderMyBookings(bookings, groups, container) {
    container = container || _bookingsContainer || document.getElementById("myBookings");
    if (!container) return;

    const statusBadge = { confirmed: "approved", pending: "pending", cancelled: "rejected", completed: "approved" };

    let html = "";

    if (groups && groups.length > 0) {
        html += `<h4 style="margin:12px 0 6px;">Stays</h4>`;
        for (const g of groups) {
            const isActive = g.status === "confirmed" || g.status === "pending";
            const roomList = g.bookings.map(b => `  • ${b.room_type} (${b.room_adults || b.num_adults}A, ${b.room_children || b.num_children}C)`).join("<br>");
            html += `
            <div class="group-card" style="border:1px solid var(--border);border-radius:8px;padding:12px;margin-bottom:10px;">
                <div style="display:flex;justify-content:space-between;align-items:flex-start;">
                    <div>
                        <strong>${escapeHtml(g.property_name)}</strong>
                        <span class="badge badge-${statusBadge[g.status] || "pending"}">${g.status}</span>
                        <div style="font-size:0.85rem;color:var(--ink-soft);margin-top:4px;">${g.check_in} → ${g.check_out} · ${g.bookings.length} room(s)</div>
                        <div style="font-size:0.85rem;margin-top:6px;">
                            ${roomList}
                        </div>
                        <div style="font-weight:600;margin-top:6px;">₹${g.total_price} total</div>
                    </div>
                    <div>
                        ${isActive ? `<button class="btn btn-danger btn-small" onclick="cancelGroup('${g.id}')">Cancel Stay</button>` : ""}
                    </div>
                </div>
            </div>`;
        }
    }

    const ungrouped = bookings.filter(b => b.group_id == null);
    if (ungrouped.length > 0) {
        if (!html) html += `<h4 style="margin:16px 0 6px;">Bookings</h4>`;
        html += `<div class="table-container"><table>
            <thead><tr><th>Property</th><th>Room</th><th>Dates</th><th>Guests</th><th>Status</th><th>Total</th><th></th></tr></thead>
            <tbody>
            ${ungrouped.map(b => `
                <tr>
                    <td>${escapeHtml(b.property_name)}</td>
                    <td>${escapeHtml(b.room_type)}</td>
                    <td>${b.check_in} → ${b.check_out}</td>
                    <td>${b.num_adults} adult${b.num_adults === 1 ? "" : "s"}${b.num_children ? `, ${b.num_children} child${b.num_children === 1 ? "" : "ren"}` : ""}</td>
                    <td><span class="badge badge-${statusBadge[b.status] || "pending"}">${b.status}</span></td>
                    <td>${b.total_price != null ? "₹" + b.total_price : "—"}</td>
                    <td>${b.status === "pending" || b.status === "confirmed" ? `<button class="btn btn-danger btn-small" onclick="cancelBooking('${b.id}')">Cancel</button>` : b.status === "completed" ? `<button class="btn btn-primary btn-small" onclick="openReviewModal('${b.id}')">Write Review</button>` : ""}</td>
                </tr>
            `).join("")}
            </tbody>
        </table></div>`;
    }

    if (!html) {
        container.innerHTML = `<div class="empty-state">No stays yet. Search above to plan your stay.</div>`;
    } else {
        container.innerHTML = html;
    }
}

async function cancelBooking(bookingId) {
    if (!confirm("Cancel this booking?")) return;
    try {
        await API.post(`/api/bookings/${bookingId}/cancel`);
        loadMyBookings();
    } catch (err) {
        alert(err.message);
    }
}

async function cancelGroup(groupId) {
    if (!confirm("Cancel the entire stay (all rooms)?")) return;
    try {
        await API.post(`/api/bookings/groups/${groupId}/cancel`);
        loadMyBookings();
    } catch (err) {
        alert(err.message);
    }
}


// ==================== Account menu + Past Bookings modal ====================
function toggleAccountMenu(forceClose) {
    const menu = document.getElementById("navAccountMenu");
    const btn = document.getElementById("navAccountBtn");
    if (!menu || !btn) return;
    const shouldOpen = forceClose === true ? false : !menu.classList.contains("open");
    menu.classList.toggle("open", shouldOpen);
    btn.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
}

document.addEventListener("click", (e) => {
    const account = document.getElementById("navAccount");
    if (account && !account.contains(e.target)) {
        toggleAccountMenu(true);
    }
});

function openBookingsModal() {
    toggleAccountMenu(true);
    const modal = document.createElement("div");
    modal.className = "modal-overlay";
    modal.innerHTML = `
        <div class="modal modal-wide">
            <button class="close-modal" onclick="this.closest('.modal-overlay').remove()">&times;</button>
            <h3>Past Bookings</h3>
            <div id="pastBookingsList"><div class="empty-state">Loading your bookingsâ€¦</div></div>
        </div>
    `;
    document.body.appendChild(modal);
    loadMyBookings(document.getElementById("pastBookingsList"));
}

async function renderHotelRepDashboard(container, user) {
    const [properties, locations] = await Promise.all([
        API.get("/api/hotels"),
        API.get("/api/hotels/locations"),
    ]);

    let html = `
        <div class="section-header">
            <h3>My Properties</h3>
            <button class="btn btn-primary btn-small" onclick="showAddPropertyModal()">+ Add Property</button>
            <button class="btn btn-outline btn-small" onclick="renderRepBookings()">View Bookings</button>
        </div>
    `;

    if (properties.length === 0) {
        html += `<div class="empty-state">No properties yet. Click "Add Property" to get started.</div>`;
    } else {
        html += `<div class="property-list">`;
        for (const p of properties) {
            const photoCount = (p.images || []).length;
            html += `
                <div class="property-card">
                    <div class="property-thumb" onclick="managePropertyPhotos('${p.id}')" title="Manage photos">
                        ${photoCount > 0
                            ? `<img src="${escapeHtml(p.images[0])}" alt="${escapeHtml(p.name)}">`
                            : `<div class="thumb-placeholder">Click to add photos</div>`}
                        ${photoCount > 0 ? `<span class="photo-count-badge">📷 ${photoCount}</span>` : ""}
                    </div>
                    <h4>${escapeHtml(p.name)}</h4>
                    <div class="prop-type">${p.property_type || "N/A"} ${p.is_approved ? '<span class="badge badge-approved">Approved</span>' : '<span class="badge badge-pending">Pending</span>'}</div>
                    <p>${escapeHtml(p.description || "")}</p>
                    ${p.amenities && Object.keys(p.amenities).length > 0 ? `
                        <div class="property-amenity-tags" style="margin-bottom: 15px; display: flex; flex-wrap: wrap; gap: 5px;">
                            ${Object.keys(p.amenities).filter(k => p.amenities[k]).map(k => `<span class="badge badge-pending" style="background:#e8f5e9; color:#1b5e20; text-transform: capitalize;">${k.replace('_', ' ')}</span>`).join('')}
                        </div>
                    ` : ''}
                    <div class="prop-actions">
                        <button class="btn btn-secondary btn-small" onclick="viewProperty('${p.id}')">Manage Rooms</button>
                        <button class="btn btn-outline btn-small" onclick="managePropertyPhotos('${p.id}')">Photos${photoCount ? ` (${photoCount})` : ""}</button>
                        <button class="btn btn-outline btn-small" onclick="managePropertyDocuments('${p.id}')">Docs</button>
                        <button class="btn btn-outline btn-small" onclick="editProperty('${p.id}')">Edit</button>
                        <button class="btn btn-outline btn-small" onclick="viewPropertyReviews('${p.id}')">Reviews</button>
                    </div>
                </div>
            `;
        }
        html += `</div>`;
    }

    html += `<div id="propertyDetail"></div>`;
    html += `<div id="repBookingsSection" style="display:none"></div>`;
    container.innerHTML = html;
}

async function renderRepBookings() {
    const section = document.getElementById("repBookingsSection");
    const detailDiv = document.getElementById("propertyDetail");
    detailDiv.innerHTML = "";
    section.style.display = "block";
    section.innerHTML = `<div class="section-header"><h3>My Bookings</h3><button class="btn btn-outline btn-small" onclick="document.getElementById('repBookingsSection').style.display='none'">Close</button></div><div class="empty-state">Loadingâ€¦</div>`;
    try {
        const bookings = await API.get("/api/hotels/bookings");
        let html = `<div class="section-header"><h3>My Bookings</h3><button class="btn btn-outline btn-small" onclick="document.getElementById('repBookingsSection').style.display='none'">Close</button></div>`;
        if (bookings.length === 0) {
            html += `<div class="empty-state">No bookings for your properties yet.</div>`;
            section.innerHTML = html;
            return;
        }
        html += `<div class="table-container"><table>
            <thead><tr>
                <th>Property</th><th>Room</th><th>Guest</th><th>Check In</th><th>Check Out</th><th>Guests</th><th>Total</th><th>Status</th><th>Booked On</th>
            </tr></thead>
            <tbody>
        `;
        for (const b of bookings) {
            html += `<tr>
                <td><strong>${escapeHtml(b.property_name)}</strong></td>
                <td>${escapeHtml(b.room_type)}</td>
                <td>${escapeHtml(b.customer_name || "â€”")}<br><small style="color:var(--ink-faint)">${escapeHtml(b.customer_email)}</small></td>
                <td>${b.check_in}</td>
                <td>${b.check_out}</td>
                <td>${b.num_adults}A ${b.num_children}C</td>
                <td>₹${b.total_price}</td>
                <td><span class="badge badge-${b.status === "confirmed" ? "approved" : b.status}">${b.status}</span></td>
                <td>${new Date(b.created_at).toLocaleDateString()}</td>
            </tr>`;
        }
        html += `</tbody></table></div>`;
        section.innerHTML = html;
    } catch (err) {
        const msg = typeof err === "object" && err !== null ? (err.message || JSON.stringify(err)) : String(err);
        section.innerHTML = `<div class="section-header"><h3>My Bookings</h3><button class="btn btn-outline btn-small" onclick="this.closest('#repBookingsSection').style.display='none'">Close</button></div><div class="empty-state" style="color:var(--bad)">${escapeHtml(msg)}</div>`;
    }
}

function showAddPropertyModal() {
    const modal = document.createElement("div");
    modal.className = "modal-overlay";
    modal.innerHTML = `
        <div class="modal">
            <button class="close-modal" onclick="this.closest('.modal-overlay').remove()">&times;</button>
            <h3>Add Property</h3>
            <form id="addPropertyForm">
                <div class="form-group">
                    <label>Property Name</label>
                    <input type="text" id="propName" required>
                </div>
                <div class="form-group">
                    <label>Description</label>
                    <textarea id="propDesc" rows="3"></textarea>
                </div>
                <div class="form-group">
                    <label>Type</label>
                    <select id="propType">
                        <option value="hotel">Hotel</option>
                        <option value="villa">Villa</option>
                        <option value="homestay">Homestay</option>
                        <option value="resort">Resort</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>City</label>
                    <select id="propCity"><option value="">Select city...</option></select>
                </div>
                <div class="form-group">
                    <label>District</label>
                    <select id="propDistrict"><option value="">Select district...</option></select>
                </div>
                <div class="form-group">
                    <label>Address</label>
                    <textarea id="propAddress" rows="2"></textarea>
                </div>
                <div class="form-group">
                    <label>Amenities</label>
                    <div class="amenities-grid">
                        <label class="amenity-checkbox-label"><input type="checkbox" name="propAmenity" value="wifi"> WiFi</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="propAmenity" value="parking"> Parking</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="propAmenity" value="pool"> Swimming Pool</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="propAmenity" value="gym"> Gym / Fitness</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="propAmenity" value="ac"> Air Conditioning</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="propAmenity" value="bar"> Bar / Lounge</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="propAmenity" value="restaurant"> Restaurant</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="propAmenity" value="spa"> Spa / Wellness</label>
                    </div>
                </div>
                <button type="submit" class="btn btn-primary btn-full">Create Property</button>
            </form>
        </div>
    `;
    document.body.appendChild(modal);

    // Load cities
    (async () => {
        try {
            const cities = await API.get("/api/hotels/locations?type=city");
            const sel = document.getElementById("propCity");
            cities.forEach(c => {
                const opt = document.createElement("option");
                opt.value = c.id;
                opt.textContent = c.name;
                sel.appendChild(opt);
            });
        } catch {}
    })();

    // When city changes, load districts
    document.getElementById("propCity").addEventListener("change", async () => {
        const cityId = document.getElementById("propCity").value;
        const districtSel = document.getElementById("propDistrict");
        districtSel.innerHTML = `<option value="">Select district...</option>`;
        districtSel.disabled = !cityId;
        if (!cityId) return;
        try {
            const districts = await API.get(`/api/hotels/locations?type=district&parent_id=${cityId}`);
            districts.forEach(d => {
                const opt = document.createElement("option");
                opt.value = d.id;
                opt.textContent = d.name;
                districtSel.appendChild(opt);
            });
        } catch {}
    });

    document.getElementById("addPropertyForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
            const checkedBoxes = document.querySelectorAll("input[name='propAmenity']:checked");
            const amenities = {};
            checkedBoxes.forEach(cb => {
                amenities[cb.value] = true;
            });
            await API.post("/api/hotels", {
                name: document.getElementById("propName").value,
                description: document.getElementById("propDesc").value,
                property_type: document.getElementById("propType").value,
                city_id: document.getElementById("propCity").value || null,
                district_id: document.getElementById("propDistrict").value || null,
                address: document.getElementById("propAddress").value,
                amenities: amenities,
            });
            modal.remove();
            initDashboard();
        } catch (err) {
            alert(err.message);
        }
    });
}

async function viewProperty(propertyId) {
    const user = await checkAuth();
    const [prop, rooms] = await Promise.all([
        API.get(`/api/hotels/${propertyId}`),
        API.get(`/api/hotels/${propertyId}/rooms`),
    ]);

    const detailDiv = document.getElementById("propertyDetail");
    let html = `
        <div class="section-header" style="margin-top:30px">
            <h3>${escapeHtml(prop.name)} â€” Rooms</h3>
            <button class="btn btn-primary btn-small" onclick="showAddRoomModal('${propertyId}')">+ Add Room</button>
            <button class="btn btn-outline btn-small" onclick="document.getElementById('propertyDetail').innerHTML=''">Close</button>
        </div>
    `;

    if (rooms.length === 0) {
        html += `<div class="empty-state">No rooms yet. Click "Add Room" to add one.</div>`;
    } else {
        for (const r of rooms) {
            const roomImagesHtml = (r.images && r.images.length > 0)
                ? `<div class="image-gallery" style="margin-bottom:10px">${r.images.map((url, i) => `
                    <div class="image-thumb">
                        <img src="${escapeHtml(url)}" alt="Room image">
                        <button type="button" class="image-thumb-remove" title="Remove photo" onclick="deleteRoomImage('${propertyId}','${r.id}',${i})">&times;</button>
                    </div>`).join("")}</div>`
                : `<div class="gallery-empty" style="height:60px; margin-bottom:10px;">No photos yet for this room.</div>`;
            html += `
                <div class="room-item">
                    <h5>${escapeHtml(r.room_type)}</h5>
                    <div class="room-details">
                        <span>₹${r.base_price}/night</span>
                        <span>Adults: ${r.capacity_adults}</span>
                        <span>Children: ${r.capacity_children}</span>
                        <span>Total: ${r.total_quantity}</span>
                        <span>Avail today: ${r.available_today}</span>
                    </div>
                    ${r.room_amenities && Object.keys(r.room_amenities).length > 0 ? `
                        <div class="room-amenity-tags" style="margin-bottom: 15px; display: flex; flex-wrap: wrap; gap: 5px;">
                            ${Object.keys(r.room_amenities).filter(k => r.room_amenities[k]).map(k => `<span class="badge badge-pending" style="background:#e3f2fd; color:#0d47a1; text-transform: capitalize;">${k.replace('_', ' ')}</span>`).join('')}
                        </div>
                    ` : ''}
                    <p class="photo-section-label">Photos${r.images && r.images.length ? ` (${r.images.length})` : ""}</p>
                    ${roomImagesHtml}
                    <div class="image-upload-area" style="margin-bottom:10px">
                        <input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden id="roomUpload_${r.id}">
                        <button class="btn btn-outline btn-small" onclick="document.getElementById('roomUpload_${r.id}').click()">+ Upload Room Photos</button>
                    </div>
                    <button class="btn btn-danger btn-small" onclick="deleteRoom('${propertyId}', '${r.id}')">Delete</button>
                </div>
            `;
        }
    }
    detailDiv.innerHTML = html;

    // Bind room image uploads
    for (const r of rooms) {
        const input = document.getElementById(`roomUpload_${r.id}`);
        if (input) {
            input.addEventListener("change", async (e) => {
                const files = e.target.files;
                if (!files.length) return;
                try {
                    const form = new FormData();
                    for (const f of files) form.append("files", f);
                    const res = await fetch(`/api/hotels/${propertyId}/rooms/${r.id}/images`, {
                        method: "POST", credentials: "include", body: form,
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.detail || "Upload failed");
                    viewProperty(propertyId);
                } catch (err) { alert(err.message); }
            });
        }
    }
}

function showAddRoomModal(propertyId) {
    const modal = document.createElement("div");
    modal.className = "modal-overlay";
    modal.innerHTML = `
        <div class="modal">
            <button class="close-modal" onclick="this.closest('.modal-overlay').remove()">&times;</button>
            <h3>Add Room</h3>
            <form id="addRoomForm">
                <div class="form-group">
                    <label>Room Type</label>
                    <input type="text" id="roomType" required placeholder="e.g. Deluxe Room">
                </div>
                <div class="form-group">
                    <label>Base Price (₹ per night)</label>
                    <input type="number" id="roomPrice" required min="1">
                </div>
                <div class="form-group">
                    <label>Capacity (Adults)</label>
                    <input type="number" id="roomAdults" value="2" min="1">
                </div>
                <div class="form-group">
                    <label>Capacity (Children)</label>
                    <input type="number" id="roomChildren" value="0" min="0">
                </div>
                <div class="form-group">
                    <label>Total Quantity</label>
                    <input type="number" id="roomQty" required min="1">
                </div>
                <div class="form-group">
                    <label>Room Amenities</label>
                    <div class="amenities-grid">
                        <label class="amenity-checkbox-label"><input type="checkbox" name="roomAmenity" value="wifi"> WiFi</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="roomAmenity" value="ac"> Air Conditioning</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="roomAmenity" value="tv"> Smart TV</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="roomAmenity" value="minibar"> Minibar</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="roomAmenity" value="balcony"> Balcony / View</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="roomAmenity" value="bathtub"> Bathtub</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="roomAmenity" value="room_service"> Room Service</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="roomAmenity" value="safe"> In-room Safe</label>
                    </div>
                </div>
                <button type="submit" class="btn btn-primary btn-full">Add Room</button>
            </form>
        </div>
    `;
    document.body.appendChild(modal);

    document.getElementById("addRoomForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
            const checkedBoxes = document.querySelectorAll("input[name='roomAmenity']:checked");
            const amenities = {};
            checkedBoxes.forEach(cb => {
                amenities[cb.value] = true;
            });
            await API.post(`/api/hotels/${propertyId}/rooms`, {
                room_type: document.getElementById("roomType").value,
                base_price: parseFloat(document.getElementById("roomPrice").value),
                capacity_adults: parseInt(document.getElementById("roomAdults").value),
                capacity_children: parseInt(document.getElementById("roomChildren").value),
                total_quantity: parseInt(document.getElementById("roomQty").value),
                room_amenities: amenities,
            });
            modal.remove();
            viewProperty(propertyId);
        } catch (err) {
            alert(err.message);
        }
    });
}

async function editProperty(propertyId) {
    const prop = await API.get(`/api/hotels/${propertyId}`);
    const modal = document.createElement("div");
    modal.className = "modal-overlay";
    modal.innerHTML = `
        <div class="modal">
            <button class="close-modal" onclick="this.closest('.modal-overlay').remove()">&times;</button>
            <h3>Edit Property</h3>
            <form id="editPropertyForm">
                <div class="form-group">
                    <label>Property Name</label>
                    <input type="text" id="propName" value="${escapeHtml(prop.name)}" required>
                </div>
                <div class="form-group">
                    <label>Description</label>
                    <textarea id="propDesc" rows="3">${escapeHtml(prop.description || "")}</textarea>
                </div>
                <div class="form-group">
                    <label>Type</label>
                    <select id="propType">
                        <option value="hotel" ${prop.property_type === "hotel" ? "selected" : ""}>Hotel</option>
                        <option value="villa" ${prop.property_type === "villa" ? "selected" : ""}>Villa</option>
                        <option value="homestay" ${prop.property_type === "homestay" ? "selected" : ""}>Homestay</option>
                        <option value="resort" ${prop.property_type === "resort" ? "selected" : ""}>Resort</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>City</label>
                    <select id="editPropCity"><option value="">Select city...</option></select>
                </div>
                <div class="form-group">
                    <label>District</label>
                    <select id="editPropDistrict"><option value="">Select district...</option></select>
                </div>
                <div class="form-group">
                    <label>Address</label>
                    <textarea id="propAddress" rows="2">${escapeHtml(prop.address || "")}</textarea>
                </div>
                <p style="font-size:0.85rem; color:var(--ink-faint); margin-bottom:18px;">Tip: use the "Photos" button on the property card to add or remove photos.</p>
                <button type="submit" class="btn btn-primary btn-full">Save Changes</button>
            </form>
        </div>
    `;
    document.body.appendChild(modal);
    const citySel = document.getElementById("editPropCity");
    const districtSel = document.getElementById("editPropDistrict");

    // Load cities
    try {
        const cities = await API.get("/api/hotels/locations?type=city");
        cities.forEach(c => {
            const opt = document.createElement("option");
            opt.value = c.id;
            opt.textContent = c.name;
            if (c.id === prop.city_id) opt.selected = true;
            citySel.appendChild(opt);
        });
    } catch {}

    // Load districts for the current city
    if (prop.city_id) {
        try {
            const districts = await API.get(`/api/hotels/locations?type=district&parent_id=${prop.city_id}`);
            districts.forEach(d => {
                const opt = document.createElement("option");
                opt.value = d.id;
                opt.textContent = d.name;
                if (d.id === prop.district_id) opt.selected = true;
                districtSel.appendChild(opt);
            });
        } catch {}
    }

    // When city changes, reload districts
    citySel.addEventListener("change", async () => {
        const cityId = citySel.value;
        districtSel.innerHTML = `<option value="">Select district...</option>`;
        districtSel.disabled = !cityId;
        if (!cityId) return;
        try {
            const districts = await API.get(`/api/hotels/locations?type=district&parent_id=${cityId}`);
            districts.forEach(d => {
                const opt = document.createElement("option");
                opt.value = d.id;
                opt.textContent = d.name;
                districtSel.appendChild(opt);
            });
        } catch {}
    });

    document.getElementById("editPropertyForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
            await API.put(`/api/hotels/${propertyId}`, {
                name: document.getElementById("propName").value,
                description: document.getElementById("propDesc").value,
                property_type: document.getElementById("propType").value,
                city_id: citySel.value || null,
                district_id: districtSel.value || null,
                address: document.getElementById("propAddress").value,
            });
            modal.remove();
            initDashboard();
        } catch (err) {
            alert(err.message);
        }
    });
}

async function deleteRoomImage(propertyId, roomId, imageIndex) {
    try {
        await API.del(`/api/hotels/${propertyId}/rooms/${roomId}/images/${imageIndex}`);
        viewProperty(propertyId);
    } catch (err) { alert(err.message); }
}

// ── Dedicated property photo manager (separate from Edit Property so photo
// management doesn't get lost among the text fields) ─────────────────────
async function managePropertyPhotos(propertyId) {
    const prop = await API.get(`/api/hotels/${propertyId}`);
    const modal = document.createElement("div");
    modal.className = "modal-overlay";
    modal.innerHTML = `
        <div class="modal">
            <button class="close-modal" onclick="this.closest('.modal-overlay').remove()">&times;</button>
            <h3>Photos â€” ${escapeHtml(prop.name)}</h3>
            <p class="photo-section-label">Property photos</p>
            <div id="propPhotoGallery" class="image-gallery"></div>
            <div class="image-upload-area">
                <input type="file" id="propPhotoInput" accept="image/jpeg,image/png,image/webp" multiple hidden>
                <button type="button" class="btn btn-outline btn-small" onclick="document.getElementById('propPhotoInput').click()">+ Upload Photos</button>
            </div>
            <p style="font-size:0.82rem; color:var(--ink-faint); margin-top:14px;">These show up first in search results. Add room-specific photos from "Manage Rooms" on each room.</p>
        </div>
    `;
    document.body.appendChild(modal);

    let images = prop.images || [];

    function renderGallery() {
        const gallery = document.getElementById("propPhotoGallery");
        if (images.length === 0) {
            gallery.innerHTML = `<div class="gallery-empty" style="height:90px;">No photos yet â€” add some so travelers can see this property.</div>`;
            return;
        }
        gallery.innerHTML = "";
        images.forEach((url, i) => {
            const div = document.createElement("div");
            div.className = "image-thumb";
            div.innerHTML = `
                <img src="${escapeHtml(url)}" alt="Property photo ${i + 1}">
                <button type="button" class="image-thumb-remove" title="Remove photo">&times;</button>
            `;
            div.querySelector(".image-thumb-remove").addEventListener("click", async () => {
                if (!confirm("Remove this photo?")) return;
                try {
                    const result = await API.del(`/api/hotels/${propertyId}/images/${i}`);
                    images = result.images;
                    renderGallery();
                } catch (err) { alert(err.message); }
            });
            gallery.appendChild(div);
        });
    }
    renderGallery();

    document.getElementById("propPhotoInput").addEventListener("change", async (e) => {
        const files = e.target.files;
        if (!files.length) return;
        try {
            const form = new FormData();
            for (const f of files) form.append("files", f);
            const res = await fetch(`/api/hotels/${propertyId}/images`, {
                method: "POST", credentials: "include", body: form,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || "Upload failed");
            images = data.images;
            renderGallery();
        } catch (err) { alert(err.message); }
        e.target.value = "";
    });

    // Refresh the dashboard cards underneath so the new thumbnail/count show
    // up as soon as the photo manager is closed.
    modal.addEventListener("click", (e) => {
        if (e.target === modal) { modal.remove(); initDashboard(); }
    });
    modal.querySelector(".close-modal").addEventListener("click", () => initDashboard());
}

async function managePropertyDocuments(propertyId) {
    const prop = await API.get(`/api/hotels/${propertyId}`);
    const modal = document.createElement("div");
    modal.className = "modal-overlay";
    modal.innerHTML = `
        <div class="modal modal-wide">
            <button class="close-modal" onclick="this.closest('.modal-overlay').remove()">&times;</button>
            <h3>Documents â€” ${escapeHtml(prop.name)}</h3>
            <p class="form-subtitle">Upload cancellation policies, house rules, local guides, or other documents for this property.</p>
            <hr style="margin:16px 0">
            <form id="docUploadForm" style="display:flex; flex-direction:column; gap:10px;">
                <div class="form-group">
                    <label>Document Title</label>
                    <input type="text" id="docTitle" required placeholder="e.g. Cancellation Policy">
                </div>
                <div class="form-group">
                    <label>Type</label>
                    <select id="docType">
                        <option value="cancellation_policy">Cancellation Policy</option>
                        <option value="house_rules">House Rules</option>
                        <option value="transportation">Transportation</option>
                        <option value="local_guide">Local Guide</option>
                        <option value="other">Other</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Summary / Content <small>(will be used for search)</small></label>
                    <textarea id="docSummary" rows="4" placeholder="Paste or type the document content here so guests can search it..."></textarea>
                </div>
                <div class="form-group">
                    <label>File (PDF, image, or document)</label>
                    <input type="file" id="docFile" accept=".pdf,.jpg,.jpeg,.png,.txt,.doc,.docx">
                </div>
                <div id="docUploadError" class="error-msg"></div>
                <button type="submit" class="btn btn-primary btn-full">Upload Document</button>
            </form>
            <hr style="margin:16px 0">
            <h4>Uploaded Documents</h4>
            <div id="docList"><div class="empty-state" style="padding:12px">Loading...</div></div>
        </div>
    `;
    document.body.appendChild(modal);

    async function loadDocs() {
        try {
            const docs = await API.get(`/api/hotels/${propertyId}/documents`);
            const container = document.getElementById("docList");
            if (docs.length === 0) {
                container.innerHTML = `<div class="empty-state" style="padding:12px">No documents yet.</div>`;
                return;
            }
            container.innerHTML = docs.map(d => `
                <div class="property-card" style="padding:12px; margin-bottom:8px;">
                    <div style="display:flex; justify-content:space-between; align-items:start;">
                        <div>
                            <strong>${escapeHtml(d.title)}</strong>
                            <span class="badge badge-pending" style="font-size:0.75rem; margin-left:6px;">${d.doc_type.replace(/_/g, ' ')}</span>
                            ${d.summary_text ? `<p style="font-size:0.85rem; color:var(--ink-faint); margin-top:4px;">${escapeHtml(d.summary_text.slice(0, 200))}${d.summary_text.length > 200 ? '...' : ''}</p>` : ''}
                            <small style="color:var(--ink-faint)">${new Date(d.created_at).toLocaleDateString()}</small>
                        </div>
                        <button class="btn btn-danger btn-small" onclick="deleteDocument('${propertyId}', '${d.id}')">Delete</button>
                    </div>
                </div>
            `).join("");
        } catch (err) { document.getElementById("docList").innerHTML = `<div class="empty-state" style="padding:12px;color:var(--bad)">${escapeHtml(err.message)}</div>`; }
    }

    await loadDocs();

    document.getElementById("docUploadForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const errDiv = document.getElementById("docUploadError");
        errDiv.textContent = "";
        const title = document.getElementById("docTitle").value.trim();
        const docType = document.getElementById("docType").value;
        const summary = document.getElementById("docSummary").value.trim();
        const fileInput = document.getElementById("docFile");
        if (!fileInput.files[0]) { errDiv.textContent = "Please select a file."; return; }

        try {
            const form = new FormData();
            form.append("file", fileInput.files[0]);
            form.append("title", title);
            form.append("doc_type", docType);
            form.append("summary", summary);
            const res = await fetch(`/api/hotels/${propertyId}/documents`, {
                method: "POST", credentials: "include", body: form,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || "Upload failed");
            document.getElementById("docUploadForm").reset();
            await loadDocs();
        } catch (err) { errDiv.textContent = err.message; }
    });

    modal.addEventListener("click", (e) => {
        if (e.target === modal) { modal.remove(); initDashboard(); }
    });
    modal.querySelector(".close-modal").addEventListener("click", () => initDashboard());
}

async function deleteDocument(propertyId, documentId) {
    if (!confirm("Delete this document?")) return;
    try {
        await API.del(`/api/hotels/${propertyId}/documents/${documentId}`);
        // Re-fetch the document list
        const container = document.getElementById("docList");
        if (container) {
            const docs = await API.get(`/api/hotels/${propertyId}/documents`);
            if (docs.length === 0) {
                container.innerHTML = `<div class="empty-state" style="padding:12px">No documents yet.</div>`;
                return;
            }
            container.innerHTML = docs.map(d => `
                <div class="property-card" style="padding:12px; margin-bottom:8px;">
                    <div style="display:flex; justify-content:space-between; align-items:start;">
                        <div>
                            <strong>${escapeHtml(d.title)}</strong>
                            <span class="badge badge-pending" style="font-size:0.75rem; margin-left:6px;">${d.doc_type.replace(/_/g, ' ')}</span>
                            ${d.summary_text ? `<p style="font-size:0.85rem; color:var(--ink-faint); margin-top:4px;">${escapeHtml(d.summary_text.slice(0, 200))}${d.summary_text.length > 200 ? '...' : ''}</p>` : ''}
                            <small style="color:var(--ink-faint)">${new Date(d.created_at).toLocaleDateString()}</small>
                        </div>
                        <button class="btn btn-danger btn-small" onclick="deleteDocument('${propertyId}', '${d.id}')">Delete</button>
                    </div>
                </div>
            `).join("");
        }
    } catch (err) { alert(err.message); }
}

async function deleteRoom(propertyId, roomId) {
    if (!confirm("Delete this room?")) return;
    await API.del(`/api/hotels/${propertyId}/rooms/${roomId}`);
    viewProperty(propertyId);
}

// ==================== Admin ====================
async function initAdmin() {
    const user = await checkAuth();
    if (!user || user.role !== "admin") {
        window.location.href = "/login";
        return;
    }

    // Tab switching
    document.querySelectorAll(".tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            if (btn.dataset.tab === "pending") renderPendingTab();
            else if (btn.dataset.tab === "reps") renderRepsTab();
            else if (btn.dataset.tab === "properties") renderPropertiesTab();
        });
    });

    renderPendingTab();
}

async function renderPendingTab() {
    const container = document.getElementById("adminTabContent");
    const data = await API.get("/api/admin/pending-hotels/all");
    const pendings = data.filter(p => p.status === "pending");
    const history = data.filter(p => p.status !== "pending");

    let html = `<h3>Pending Registrations (${pendings.length})</h3>`;

    if (pendings.length === 0) {
        html += `<div class="empty-state">No pending registrations.</div>`;
    } else {
        html += `<div class="table-container"><table>
            <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Date</th><th>Actions</th></tr></thead>
            <tbody>
        `;
        for (const p of pendings) {
            html += `<tr>
                <td>${escapeHtml(p.full_name || "â€”")}</td>
                <td>${escapeHtml(p.email)}</td>
                <td>${escapeHtml(p.phone || "â€”")}</td>
                <td>${new Date(p.created_at).toLocaleDateString()}</td>
                <td>
                    <button class="btn btn-success btn-small" onclick="approveHotel('${p.id}')">Approve</button>
                    <button class="btn btn-danger btn-small" onclick="rejectHotel('${p.id}')">Reject</button>
                </td>
            </tr>`;
        }
        html += `</tbody></table></div>`;
    }

    if (history.length > 0) {
        html += `<h3 style="margin-top:30px">History</h3>
        <div class="table-container"><table>
            <thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Date</th></tr></thead>
            <tbody>
        `;
        for (const p of history) {
            html += `<tr>
                <td>${escapeHtml(p.full_name || "â€”")}</td>
                <td>${escapeHtml(p.email)}</td>
                <td><span class="badge badge-${p.status}">${p.status}</span></td>
                <td>${new Date(p.created_at).toLocaleDateString()}</td>
            </tr>`;
        }
        html += `</tbody></table></div>`;
    }

    container.innerHTML = html;
}

async function renderRepsTab() {
    const container = document.getElementById("adminTabContent");
    const reps = await API.get("/api/admin/hotel-reps");

    let html = `<h3>Hotel Representatives</h3>`;
    if (reps.length === 0) {
        html += `<div class="empty-state">No hotel reps yet.</div>`;
    } else {
        html += `<div class="table-container"><table>
            <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
        `;
        for (const r of reps) {
            html += `<tr>
                <td>${escapeHtml(r.full_name || "â€”")}</td>
                <td>${escapeHtml(r.email)}</td>
                <td>${escapeHtml(r.phone || "â€”")}</td>
                <td><span class="badge badge-${r.is_active ? "approved" : "rejected"}">${r.is_active ? "Active" : "Inactive"}</span></td>
                <td><button class="btn btn-${r.is_active ? "danger" : "success"} btn-small" onclick="toggleRep('${r.id}')">${r.is_active ? "Deactivate" : "Activate"}</button></td>
            </tr>`;
        }
        html += `</tbody></table></div>`;
    }
    container.innerHTML = html;
}

async function approveHotel(id) {
    await API.post("/api/admin/approve-hotel", { id });
    renderPendingTab();
}

async function rejectHotel(id) {
    await API.post("/api/admin/reject-hotel", { id });
    renderPendingTab();
}

async function toggleRep(id) {
    await API.post(`/api/admin/toggle-rep/${id}`);
    await checkAuth();
    renderRepsTab();
}

// â”€â”€ Properties tab â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let propFilterTimer;

async function renderPropertiesTab() {
    const container = document.getElementById("adminTabContent");
    const status = document.getElementById("propFilterStatus")?.value || "pending";
    const q = document.getElementById("propFilterQ")?.value || "";
    const params = new URLSearchParams({ status, q: q || "" });
    container.innerHTML = `
        <h3>All Properties</h3>
        <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-bottom:18px;">
            <select id="propFilterStatus" onchange="renderPropertiesTab()">
                <option value="pending" ${status === "pending" ? "selected" : ""}>Pending</option>
                <option value="approved" ${status === "approved" ? "selected" : ""}>Approved</option>
                <option value="all" ${status === "all" ? "selected" : ""}>All</option>
            </select>
            <input type="text" id="propFilterQ" placeholder="Search name / address / city" value="${escapeHtml(q)}" style="flex:1;min-width:200px;padding:8px 12px;border:2px solid var(--sand-deep);border-radius:var(--radius-sm);font-family:inherit;">
            <span class="loader" id="propLoader" style="display:none"></span>
        </div>
        <div id="propTableWrap"></div>
    `;

    document.getElementById("propFilterQ").addEventListener("input", () => {
        clearTimeout(propFilterTimer);
        propFilterTimer = setTimeout(renderPropertiesTab, 350);
    });

    const wrap = document.getElementById("propTableWrap");
    wrap.innerHTML = `<div class="empty-state">Loadingâ€¦</div>`;
    try {
        const props = await API.get(`/api/admin/properties?${params.toString()}`);
        if (props.length === 0) {
            wrap.innerHTML = `<div class="empty-state">No properties match those filters.</div>`;
            return;
        }
        const rows = props.map(p => `
            <tr>
                <td><strong>${escapeHtml(p.name)}</strong></td>
                <td>${escapeHtml(p.property_type || "â€”")}</td>
                <td>${escapeHtml(p.owner_name || "â€”")}<br><small style="color:var(--ink-faint)">${escapeHtml(p.owner_email || "")}</small></td>
                <td>${escapeHtml(p.city || "â€”")}</td>
                <td style="max-width:240px;word-break:break-word">${escapeHtml(p.address || "â€”")}</td>
                <td><button class="btn btn-outline btn-small" onclick="viewPropertyDocs('${p.id}','${escapeHtml(p.name)}')">${p.document_count} doc${p.document_count === 1 ? "" : "s"}</button></td>
                <td><span class="badge badge-${p.is_approved ? "approved" : "pending"}">${p.is_approved ? "Approved" : "Pending"}</span></td>
                <td>
                    ${p.is_approved
                        ? `<button class="btn btn-danger btn-small" onclick="rejectProperty('${p.id}','${escapeHtml(p.name)}')">Unapprove</button>`
                        : `<button class="btn btn-success btn-small" onclick="approveProperty('${p.id}','${escapeHtml(p.name)}')">Approve</button>`
                    }
                </td>
            </tr>
        `).join("");

        wrap.innerHTML = `<div class="table-container"><table>
            <thead><tr>
                <th>Name</th><th>Type</th><th>Owner</th><th>City</th><th>Address</th><th>Docs</th><th>Status</th><th>Actions</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table></div>`;
    } catch (err) {
        wrap.innerHTML = `<div class="empty-state" style="color:var(--bad)">${escapeHtml(err.message)}</div>`;
    }
}

async function viewPropertyDocs(propertyId, propertyName) {
    const modal = document.createElement("div");
    modal.className = "modal-overlay";
    modal.innerHTML = `
        <div class="modal modal-wide">
            <button class="close-modal" onclick="this.closest(\".modal-overlay\").remove()">&times;</button>
            <h3>Documents — ${escapeHtml(propertyName)}</h3>
            <div id="adminDocList"><div class="empty-state" style="padding:12px">Loading...</div></div>
        </div>
    `;
    document.body.appendChild(modal);

    try {
        const docs = await API.get(`/api/admin/properties/${propertyId}/documents`);
        const container = document.getElementById("adminDocList");
        if (docs.length === 0) {
            container.innerHTML = `<div class="empty-state" style="padding:12px">No documents uploaded for this property yet.</div>`;
            return;
        }
        container.innerHTML = docs.map(d => `
            <div class="property-card" style="padding:12px; margin-bottom:8px;">
                <div style="display:flex; justify-content:space-between; align-items:start;">
                    <div>
                        <strong>${escapeHtml(d.title)}</strong>
                        <span class="badge badge-pending" style="font-size:0.75rem; margin-left:6px;">${d.doc_type.replace(/_/g, " ")}</span>
                        ${d.summary_text ? `<p style="font-size:0.85rem; color:var(--ink-faint); margin-top:4px; white-space:pre-wrap;">${escapeHtml(d.summary_text)}</p>` : `<p style="font-size:0.85rem; color:var(--ink-faint); margin-top:4px;"><em>No content</em></p>`}
                        <small style="color:var(--ink-faint)">Uploaded ${new Date(d.created_at).toLocaleDateString()}</small>
                    </div>
                </div>
            </div>
        `).join("");
    } catch (err) { document.getElementById("adminDocList").innerHTML = `<div class="empty-state" style="padding:12px;color:var(--bad)">${escapeHtml(err.message)}</div>`; }

    modal.addEventListener("click", (e) => {
        if (e.target === modal) modal.remove();
    });
}

async function approveProperty(id, name) {
    if (!confirm(`Approve "${name}"?`)) return;
    await API.post(`/api/admin/properties/${id}/approve`);
    renderPropertiesTab();
}

async function rejectProperty(id, name) {
    if (!confirm(`Unapprove "${name}"?`)) return;
    await API.post(`/api/admin/properties/${id}/reject`);
    renderPropertiesTab();
}

// ==================== Utils ====================
function escapeHtml(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

// ==================== Init ====================
checkAuth();





// ==================== Account menu + Past Bookings modal ====================
function toggleAccountMenu(forceClose) {
    const menu = document.getElementById("navAccountMenu");
    const btn = document.getElementById("navAccountBtn");
    if (!menu || !btn) return;
    const shouldOpen = forceClose === true ? false : !menu.classList.contains("open");
    menu.classList.toggle("open", shouldOpen);
    btn.setAttribute("aria-expanded", shouldOpen ? "true" : "false");
}

document.addEventListener("click", (e) => {
    const account = document.getElementById("navAccount");
    if (account && !account.contains(e.target)) {
        toggleAccountMenu(true);
    }
});

function openBookingsModal() {
    toggleAccountMenu(true);
    const modal = document.createElement("div");
    modal.className = "modal-overlay";
    modal.innerHTML = `
        <div class="modal modal-wide">
            <button class="close-modal" onclick="this.closest('.modal-overlay').remove()">&times;</button>
            <h3>Past Bookings</h3>
            <div id="pastBookingsList"><div class="empty-state">Loading your bookingsâ€¦</div></div>
        </div>
    `;
    document.body.appendChild(modal);
    loadMyBookings(document.getElementById("pastBookingsList"));
}

async function renderHotelRepDashboard(container, user) {
    const [properties, locations] = await Promise.all([
        API.get("/api/hotels"),
        API.get("/api/hotels/locations"),
    ]);

    let html = `
        <div class="section-header">
            <h3>My Properties</h3>
            <button class="btn btn-primary btn-small" onclick="showAddPropertyModal()">+ Add Property</button>
            <button class="btn btn-outline btn-small" onclick="renderRepBookings()">View Bookings</button>
        </div>
    `;

    if (properties.length === 0) {
        html += `<div class="empty-state">No properties yet. Click "Add Property" to get started.</div>`;
    } else {
        html += `<div class="property-list">`;
        for (const p of properties) {
            const photoCount = (p.images || []).length;
            html += `
                <div class="property-card">
                    <div class="property-thumb" onclick="managePropertyPhotos('${p.id}')" title="Manage photos">
                        ${photoCount > 0
                            ? `<img src="${escapeHtml(p.images[0])}" alt="${escapeHtml(p.name)}">`
                            : `<div class="thumb-placeholder">Click to add photos</div>`}
                        ${photoCount > 0 ? `<span class="photo-count-badge">📷 ${photoCount}</span>` : ""}
                    </div>
                    <h4>${escapeHtml(p.name)}</h4>
                    <div class="prop-type">${p.property_type || "N/A"} ${p.is_approved ? '<span class="badge badge-approved">Approved</span>' : '<span class="badge badge-pending">Pending</span>'}</div>
                    <p>${escapeHtml(p.description || "")}</p>
                    ${p.amenities && Object.keys(p.amenities).length > 0 ? `
                        <div class="property-amenity-tags" style="margin-bottom: 15px; display: flex; flex-wrap: wrap; gap: 5px;">
                            ${Object.keys(p.amenities).filter(k => p.amenities[k]).map(k => `<span class="badge badge-pending" style="background:#e8f5e9; color:#1b5e20; text-transform: capitalize;">${k.replace('_', ' ')}</span>`).join('')}
                        </div>
                    ` : ''}
                    <div class="prop-actions">
                        <button class="btn btn-secondary btn-small" onclick="viewProperty('${p.id}')">Manage Rooms</button>
                        <button class="btn btn-outline btn-small" onclick="managePropertyPhotos('${p.id}')">Photos${photoCount ? ` (${photoCount})` : ""}</button>
                        <button class="btn btn-outline btn-small" onclick="managePropertyDocuments('${p.id}')">Docs</button>
                        <button class="btn btn-outline btn-small" onclick="editProperty('${p.id}')">Edit</button>
                        <button class="btn btn-outline btn-small" onclick="viewPropertyReviews('${p.id}')">Reviews</button>
                    </div>
                </div>
            `;
        }
        html += `</div>`;
    }

    html += `<div id="propertyDetail"></div>`;
    html += `<div id="repBookingsSection" style="display:none"></div>`;
    container.innerHTML = html;
}

async function renderRepBookings() {
    const section = document.getElementById("repBookingsSection");
    const detailDiv = document.getElementById("propertyDetail");
    detailDiv.innerHTML = "";
    section.style.display = "block";
    section.innerHTML = `<div class="section-header"><h3>My Bookings</h3><button class="btn btn-outline btn-small" onclick="document.getElementById('repBookingsSection').style.display='none'">Close</button></div><div class="empty-state">Loadingâ€¦</div>`;
    try {
        const bookings = await API.get("/api/hotels/bookings");
        let html = `<div class="section-header"><h3>My Bookings</h3><button class="btn btn-outline btn-small" onclick="document.getElementById('repBookingsSection').style.display='none'">Close</button></div>`;
        if (bookings.length === 0) {
            html += `<div class="empty-state">No bookings for your properties yet.</div>`;
            section.innerHTML = html;
            return;
        }
        html += `<div class="table-container"><table>
            <thead><tr>
                <th>Property</th><th>Room</th><th>Guest</th><th>Check In</th><th>Check Out</th><th>Guests</th><th>Total</th><th>Status</th><th>Booked On</th>
            </tr></thead>
            <tbody>
        `;
        for (const b of bookings) {
            html += `<tr>
                <td><strong>${escapeHtml(b.property_name)}</strong></td>
                <td>${escapeHtml(b.room_type)}</td>
                <td>${escapeHtml(b.customer_name || "â€”")}<br><small style="color:var(--ink-faint)">${escapeHtml(b.customer_email)}</small></td>
                <td>${b.check_in}</td>
                <td>${b.check_out}</td>
                <td>${b.num_adults}A ${b.num_children}C</td>
                <td>₹${b.total_price}</td>
                <td><span class="badge badge-${b.status === "confirmed" ? "approved" : b.status}">${b.status}</span></td>
                <td>${new Date(b.created_at).toLocaleDateString()}</td>
            </tr>`;
        }
        html += `</tbody></table></div>`;
        section.innerHTML = html;
    } catch (err) {
        const msg = typeof err === "object" && err !== null ? (err.message || JSON.stringify(err)) : String(err);
        section.innerHTML = `<div class="section-header"><h3>My Bookings</h3><button class="btn btn-outline btn-small" onclick="this.closest('#repBookingsSection').style.display='none'">Close</button></div><div class="empty-state" style="color:var(--bad)">${escapeHtml(msg)}</div>`;
    }
}

function showAddPropertyModal() {
    const modal = document.createElement("div");
    modal.className = "modal-overlay";
    modal.innerHTML = `
        <div class="modal">
            <button class="close-modal" onclick="this.closest('.modal-overlay').remove()">&times;</button>
            <h3>Add Property</h3>
            <form id="addPropertyForm">
                <div class="form-group">
                    <label>Property Name</label>
                    <input type="text" id="propName" required>
                </div>
                <div class="form-group">
                    <label>Description</label>
                    <textarea id="propDesc" rows="3"></textarea>
                </div>
                <div class="form-group">
                    <label>Type</label>
                    <select id="propType">
                        <option value="hotel">Hotel</option>
                        <option value="villa">Villa</option>
                        <option value="homestay">Homestay</option>
                        <option value="resort">Resort</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>City</label>
                    <select id="propCity"><option value="">Select city...</option></select>
                </div>
                <div class="form-group">
                    <label>District</label>
                    <select id="propDistrict"><option value="">Select district...</option></select>
                </div>
                <div class="form-group">
                    <label>Address</label>
                    <textarea id="propAddress" rows="2"></textarea>
                </div>
                <div class="form-group">
                    <label>Amenities</label>
                    <div class="amenities-grid">
                        <label class="amenity-checkbox-label"><input type="checkbox" name="propAmenity" value="wifi"> WiFi</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="propAmenity" value="parking"> Parking</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="propAmenity" value="pool"> Swimming Pool</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="propAmenity" value="gym"> Gym / Fitness</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="propAmenity" value="ac"> Air Conditioning</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="propAmenity" value="bar"> Bar / Lounge</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="propAmenity" value="restaurant"> Restaurant</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="propAmenity" value="spa"> Spa / Wellness</label>
                    </div>
                </div>
                <button type="submit" class="btn btn-primary btn-full">Create Property</button>
            </form>
        </div>
    `;
    document.body.appendChild(modal);

    // Load cities
    (async () => {
        try {
            const cities = await API.get("/api/hotels/locations?type=city");
            const sel = document.getElementById("propCity");
            cities.forEach(c => {
                const opt = document.createElement("option");
                opt.value = c.id;
                opt.textContent = c.name;
                sel.appendChild(opt);
            });
        } catch {}
    })();

    // When city changes, load districts
    document.getElementById("propCity").addEventListener("change", async () => {
        const cityId = document.getElementById("propCity").value;
        const districtSel = document.getElementById("propDistrict");
        districtSel.innerHTML = `<option value="">Select district...</option>`;
        districtSel.disabled = !cityId;
        if (!cityId) return;
        try {
            const districts = await API.get(`/api/hotels/locations?type=district&parent_id=${cityId}`);
            districts.forEach(d => {
                const opt = document.createElement("option");
                opt.value = d.id;
                opt.textContent = d.name;
                districtSel.appendChild(opt);
            });
        } catch {}
    });

    document.getElementById("addPropertyForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
            const checkedBoxes = document.querySelectorAll("input[name='propAmenity']:checked");
            const amenities = {};
            checkedBoxes.forEach(cb => {
                amenities[cb.value] = true;
            });
            await API.post("/api/hotels", {
                name: document.getElementById("propName").value,
                description: document.getElementById("propDesc").value,
                property_type: document.getElementById("propType").value,
                city_id: document.getElementById("propCity").value || null,
                district_id: document.getElementById("propDistrict").value || null,
                address: document.getElementById("propAddress").value,
                amenities: amenities,
            });
            modal.remove();
            initDashboard();
        } catch (err) {
            alert(err.message);
        }
    });
}

async function viewProperty(propertyId) {
    const user = await checkAuth();
    const [prop, rooms] = await Promise.all([
        API.get(`/api/hotels/${propertyId}`),
        API.get(`/api/hotels/${propertyId}/rooms`),
    ]);

    const detailDiv = document.getElementById("propertyDetail");
    let html = `
        <div class="section-header" style="margin-top:30px">
            <h3>${escapeHtml(prop.name)} â€” Rooms</h3>
            <button class="btn btn-primary btn-small" onclick="showAddRoomModal('${propertyId}')">+ Add Room</button>
            <button class="btn btn-outline btn-small" onclick="document.getElementById('propertyDetail').innerHTML=''">Close</button>
        </div>
    `;

    if (rooms.length === 0) {
        html += `<div class="empty-state">No rooms yet. Click "Add Room" to add one.</div>`;
    } else {
        for (const r of rooms) {
            const roomImagesHtml = (r.images && r.images.length > 0)
                ? `<div class="image-gallery" style="margin-bottom:10px">${r.images.map((url, i) => `
                    <div class="image-thumb">
                        <img src="${escapeHtml(url)}" alt="Room image">
                        <button type="button" class="image-thumb-remove" title="Remove photo" onclick="deleteRoomImage('${propertyId}','${r.id}',${i})">&times;</button>
                    </div>`).join("")}</div>`
                : `<div class="gallery-empty" style="height:60px; margin-bottom:10px;">No photos yet for this room.</div>`;
            html += `
                <div class="room-item">
                    <h5>${escapeHtml(r.room_type)}</h5>
                    <div class="room-details">
                        <span>₹${r.base_price}/night</span>
                        <span>Adults: ${r.capacity_adults}</span>
                        <span>Children: ${r.capacity_children}</span>
                        <span>Total: ${r.total_quantity}</span>
                        <span>Avail today: ${r.available_today}</span>
                    </div>
                    ${r.room_amenities && Object.keys(r.room_amenities).length > 0 ? `
                        <div class="room-amenity-tags" style="margin-bottom: 15px; display: flex; flex-wrap: wrap; gap: 5px;">
                            ${Object.keys(r.room_amenities).filter(k => r.room_amenities[k]).map(k => `<span class="badge badge-pending" style="background:#e3f2fd; color:#0d47a1; text-transform: capitalize;">${k.replace('_', ' ')}</span>`).join('')}
                        </div>
                    ` : ''}
                    <p class="photo-section-label">Photos${r.images && r.images.length ? ` (${r.images.length})` : ""}</p>
                    ${roomImagesHtml}
                    <div class="image-upload-area" style="margin-bottom:10px">
                        <input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden id="roomUpload_${r.id}">
                        <button class="btn btn-outline btn-small" onclick="document.getElementById('roomUpload_${r.id}').click()">+ Upload Room Photos</button>
                    </div>
                    <button class="btn btn-danger btn-small" onclick="deleteRoom('${propertyId}', '${r.id}')">Delete</button>
                </div>
            `;
        }
    }
    detailDiv.innerHTML = html;

    // Bind room image uploads
    for (const r of rooms) {
        const input = document.getElementById(`roomUpload_${r.id}`);
        if (input) {
            input.addEventListener("change", async (e) => {
                const files = e.target.files;
                if (!files.length) return;
                try {
                    const form = new FormData();
                    for (const f of files) form.append("files", f);
                    const res = await fetch(`/api/hotels/${propertyId}/rooms/${r.id}/images`, {
                        method: "POST", credentials: "include", body: form,
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.detail || "Upload failed");
                    viewProperty(propertyId);
                } catch (err) { alert(err.message); }
            });
        }
    }
}

function showAddRoomModal(propertyId) {
    const modal = document.createElement("div");
    modal.className = "modal-overlay";
    modal.innerHTML = `
        <div class="modal">
            <button class="close-modal" onclick="this.closest('.modal-overlay').remove()">&times;</button>
            <h3>Add Room</h3>
            <form id="addRoomForm">
                <div class="form-group">
                    <label>Room Type</label>
                    <input type="text" id="roomType" required placeholder="e.g. Deluxe Room">
                </div>
                <div class="form-group">
                    <label>Base Price (₹ per night)</label>
                    <input type="number" id="roomPrice" required min="1">
                </div>
                <div class="form-group">
                    <label>Capacity (Adults)</label>
                    <input type="number" id="roomAdults" value="2" min="1">
                </div>
                <div class="form-group">
                    <label>Capacity (Children)</label>
                    <input type="number" id="roomChildren" value="0" min="0">
                </div>
                <div class="form-group">
                    <label>Total Quantity</label>
                    <input type="number" id="roomQty" required min="1">
                </div>
                <div class="form-group">
                    <label>Room Amenities</label>
                    <div class="amenities-grid">
                        <label class="amenity-checkbox-label"><input type="checkbox" name="roomAmenity" value="wifi"> WiFi</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="roomAmenity" value="ac"> Air Conditioning</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="roomAmenity" value="tv"> Smart TV</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="roomAmenity" value="minibar"> Minibar</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="roomAmenity" value="balcony"> Balcony / View</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="roomAmenity" value="bathtub"> Bathtub</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="roomAmenity" value="room_service"> Room Service</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="roomAmenity" value="safe"> In-room Safe</label>
                    </div>
                </div>
                <button type="submit" class="btn btn-primary btn-full">Add Room</button>
            </form>
        </div>
    `;
    document.body.appendChild(modal);

    document.getElementById("addRoomForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
            const checkedBoxes = document.querySelectorAll("input[name='roomAmenity']:checked");
            const amenities = {};
            checkedBoxes.forEach(cb => {
                amenities[cb.value] = true;
            });
            await API.post(`/api/hotels/${propertyId}/rooms`, {
                room_type: document.getElementById("roomType").value,
                base_price: parseFloat(document.getElementById("roomPrice").value),
                capacity_adults: parseInt(document.getElementById("roomAdults").value),
                capacity_children: parseInt(document.getElementById("roomChildren").value),
                total_quantity: parseInt(document.getElementById("roomQty").value),
                room_amenities: amenities,
            });
            modal.remove();
            viewProperty(propertyId);
        } catch (err) {
            alert(err.message);
        }
    });
}

async function editProperty(propertyId) {
    const prop = await API.get(`/api/hotels/${propertyId}`);
    const modal = document.createElement("div");
    modal.className = "modal-overlay";
    modal.innerHTML = `
        <div class="modal">
            <button class="close-modal" onclick="this.closest('.modal-overlay').remove()">&times;</button>
            <h3>Edit Property</h3>
            <form id="editPropertyForm">
                <div class="form-group">
                    <label>Property Name</label>
                    <input type="text" id="propName" value="${escapeHtml(prop.name)}" required>
                </div>
                <div class="form-group">
                    <label>Description</label>
                    <textarea id="propDesc" rows="3">${escapeHtml(prop.description || "")}</textarea>
                </div>
                <div class="form-group">
                    <label>Type</label>
                    <select id="propType">
                        <option value="hotel" ${prop.property_type === "hotel" ? "selected" : ""}>Hotel</option>
                        <option value="villa" ${prop.property_type === "villa" ? "selected" : ""}>Villa</option>
                        <option value="homestay" ${prop.property_type === "homestay" ? "selected" : ""}>Homestay</option>
                        <option value="resort" ${prop.property_type === "resort" ? "selected" : ""}>Resort</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>City</label>
                    <select id="editPropCity"><option value="">Select city...</option></select>
                </div>
                <div class="form-group">
                    <label>District</label>
                    <select id="editPropDistrict"><option value="">Select district...</option></select>
                </div>
                <div class="form-group">
                    <label>Address</label>
                    <textarea id="propAddress" rows="2">${escapeHtml(prop.address || "")}</textarea>
                </div>
                <p style="font-size:0.85rem; color:var(--ink-faint); margin-bottom:18px;">Tip: use the "Photos" button on the property card to add or remove photos.</p>
                <button type="submit" class="btn btn-primary btn-full">Save Changes</button>
            </form>
        </div>
    `;
    document.body.appendChild(modal);
    const citySel = document.getElementById("editPropCity");
    const districtSel = document.getElementById("editPropDistrict");

    // Load cities
    try {
        const cities = await API.get("/api/hotels/locations?type=city");
        cities.forEach(c => {
            const opt = document.createElement("option");
            opt.value = c.id;
            opt.textContent = c.name;
            if (c.id === prop.city_id) opt.selected = true;
            citySel.appendChild(opt);
        });
    } catch {}

    // Load districts for the current city
    if (prop.city_id) {
        try {
            const districts = await API.get(`/api/hotels/locations?type=district&parent_id=${prop.city_id}`);
            districts.forEach(d => {
                const opt = document.createElement("option");
                opt.value = d.id;
                opt.textContent = d.name;
                if (d.id === prop.district_id) opt.selected = true;
                districtSel.appendChild(opt);
            });
        } catch {}
    }

    // When city changes, reload districts
    citySel.addEventListener("change", async () => {
        const cityId = citySel.value;
        districtSel.innerHTML = `<option value="">Select district...</option>`;
        districtSel.disabled = !cityId;
        if (!cityId) return;
        try {
            const districts = await API.get(`/api/hotels/locations?type=district&parent_id=${cityId}`);
            districts.forEach(d => {
                const opt = document.createElement("option");
                opt.value = d.id;
                opt.textContent = d.name;
                districtSel.appendChild(opt);
            });
        } catch {}
    });

    document.getElementById("editPropertyForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
            await API.put(`/api/hotels/${propertyId}`, {
                name: document.getElementById("propName").value,
                description: document.getElementById("propDesc").value,
                property_type: document.getElementById("propType").value,
                city_id: citySel.value || null,
                district_id: districtSel.value || null,
                address: document.getElementById("propAddress").value,
            });
            modal.remove();
            initDashboard();
        } catch (err) {
            alert(err.message);
        }
    });
}

async function deleteRoomImage(propertyId, roomId, imageIndex) {
    try {
        await API.del(`/api/hotels/${propertyId}/rooms/${roomId}/images/${imageIndex}`);
        viewProperty(propertyId);
    } catch (err) { alert(err.message); }
}

// ── Dedicated property photo manager (separate from Edit Property so photo
// management doesn't get lost among the text fields) ─────────────────────
async function managePropertyPhotos(propertyId) {
    const prop = await API.get(`/api/hotels/${propertyId}`);
    const modal = document.createElement("div");
    modal.className = "modal-overlay";
    modal.innerHTML = `
        <div class="modal">
            <button class="close-modal" onclick="this.closest('.modal-overlay').remove()">&times;</button>
            <h3>Photos â€” ${escapeHtml(prop.name)}</h3>
            <p class="photo-section-label">Property photos</p>
            <div id="propPhotoGallery" class="image-gallery"></div>
            <div class="image-upload-area">
                <input type="file" id="propPhotoInput" accept="image/jpeg,image/png,image/webp" multiple hidden>
                <button type="button" class="btn btn-outline btn-small" onclick="document.getElementById('propPhotoInput').click()">+ Upload Photos</button>
            </div>
            <p style="font-size:0.82rem; color:var(--ink-faint); margin-top:14px;">These show up first in search results. Add room-specific photos from "Manage Rooms" on each room.</p>
        </div>
    `;
    document.body.appendChild(modal);

    let images = prop.images || [];

    function renderGallery() {
        const gallery = document.getElementById("propPhotoGallery");
        if (images.length === 0) {
            gallery.innerHTML = `<div class="gallery-empty" style="height:90px;">No photos yet â€” add some so travelers can see this property.</div>`;
            return;
        }
        gallery.innerHTML = "";
        images.forEach((url, i) => {
            const div = document.createElement("div");
            div.className = "image-thumb";
            div.innerHTML = `
                <img src="${escapeHtml(url)}" alt="Property photo ${i + 1}">
                <button type="button" class="image-thumb-remove" title="Remove photo">&times;</button>
            `;
            div.querySelector(".image-thumb-remove").addEventListener("click", async () => {
                if (!confirm("Remove this photo?")) return;
                try {
                    const result = await API.del(`/api/hotels/${propertyId}/images/${i}`);
                    images = result.images;
                    renderGallery();
                } catch (err) { alert(err.message); }
            });
            gallery.appendChild(div);
        });
    }
    renderGallery();

    document.getElementById("propPhotoInput").addEventListener("change", async (e) => {
        const files = e.target.files;
        if (!files.length) return;
        try {
            const form = new FormData();
            for (const f of files) form.append("files", f);
            const res = await fetch(`/api/hotels/${propertyId}/images`, {
                method: "POST", credentials: "include", body: form,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || "Upload failed");
            images = data.images;
            renderGallery();
        } catch (err) { alert(err.message); }
        e.target.value = "";
    });

    // Refresh the dashboard cards underneath so the new thumbnail/count show
    // up as soon as the photo manager is closed.
    modal.addEventListener("click", (e) => {
        if (e.target === modal) { modal.remove(); initDashboard(); }
    });
    modal.querySelector(".close-modal").addEventListener("click", () => initDashboard());
}

async function managePropertyDocuments(propertyId) {
    const prop = await API.get(`/api/hotels/${propertyId}`);
    const modal = document.createElement("div");
    modal.className = "modal-overlay";
    modal.innerHTML = `
        <div class="modal modal-wide">
            <button class="close-modal" onclick="this.closest('.modal-overlay').remove()">&times;</button>
            <h3>Documents â€” ${escapeHtml(prop.name)}</h3>
            <p class="form-subtitle">Upload cancellation policies, house rules, local guides, or other documents for this property.</p>
            <hr style="margin:16px 0">
            <form id="docUploadForm" style="display:flex; flex-direction:column; gap:10px;">
                <div class="form-group">
                    <label>Document Title</label>
                    <input type="text" id="docTitle" required placeholder="e.g. Cancellation Policy">
                </div>
                <div class="form-group">
                    <label>Type</label>
                    <select id="docType">
                        <option value="cancellation_policy">Cancellation Policy</option>
                        <option value="house_rules">House Rules</option>
                        <option value="transportation">Transportation</option>
                        <option value="local_guide">Local Guide</option>
                        <option value="other">Other</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Summary / Content <small>(will be used for search)</small></label>
                    <textarea id="docSummary" rows="4" placeholder="Paste or type the document content here so guests can search it..."></textarea>
                </div>
                <div class="form-group">
                    <label>File (PDF, image, or document)</label>
                    <input type="file" id="docFile" accept=".pdf,.jpg,.jpeg,.png,.txt,.doc,.docx">
                </div>
                <div id="docUploadError" class="error-msg"></div>
                <button type="submit" class="btn btn-primary btn-full">Upload Document</button>
            </form>
            <hr style="margin:16px 0">
            <h4>Uploaded Documents</h4>
            <div id="docList"><div class="empty-state" style="padding:12px">Loading...</div></div>
        </div>
    `;
    document.body.appendChild(modal);

    async function loadDocs() {
        try {
            const docs = await API.get(`/api/hotels/${propertyId}/documents`);
            const container = document.getElementById("docList");
            if (docs.length === 0) {
                container.innerHTML = `<div class="empty-state" style="padding:12px">No documents yet.</div>`;
                return;
            }
            container.innerHTML = docs.map(d => `
                <div class="property-card" style="padding:12px; margin-bottom:8px;">
                    <div style="display:flex; justify-content:space-between; align-items:start;">
                        <div>
                            <strong>${escapeHtml(d.title)}</strong>
                            <span class="badge badge-pending" style="font-size:0.75rem; margin-left:6px;">${d.doc_type.replace(/_/g, ' ')}</span>
                            ${d.summary_text ? `<p style="font-size:0.85rem; color:var(--ink-faint); margin-top:4px;">${escapeHtml(d.summary_text.slice(0, 200))}${d.summary_text.length > 200 ? '...' : ''}</p>` : ''}
                            <small style="color:var(--ink-faint)">${new Date(d.created_at).toLocaleDateString()}</small>
                        </div>
                        <button class="btn btn-danger btn-small" onclick="deleteDocument('${propertyId}', '${d.id}')">Delete</button>
                    </div>
                </div>
            `).join("");
        } catch (err) { document.getElementById("docList").innerHTML = `<div class="empty-state" style="padding:12px;color:var(--bad)">${escapeHtml(err.message)}</div>`; }
    }

    await loadDocs();

    document.getElementById("docUploadForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const errDiv = document.getElementById("docUploadError");
        errDiv.textContent = "";
        const title = document.getElementById("docTitle").value.trim();
        const docType = document.getElementById("docType").value;
        const summary = document.getElementById("docSummary").value.trim();
        const fileInput = document.getElementById("docFile");
        if (!fileInput.files[0]) { errDiv.textContent = "Please select a file."; return; }

        try {
            const form = new FormData();
            form.append("file", fileInput.files[0]);
            form.append("title", title);
            form.append("doc_type", docType);
            form.append("summary", summary);
            const res = await fetch(`/api/hotels/${propertyId}/documents`, {
                method: "POST", credentials: "include", body: form,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || "Upload failed");
            document.getElementById("docUploadForm").reset();
            await loadDocs();
        } catch (err) { errDiv.textContent = err.message; }
    });

    modal.addEventListener("click", (e) => {
        if (e.target === modal) { modal.remove(); initDashboard(); }
    });
    modal.querySelector(".close-modal").addEventListener("click", () => initDashboard());
}

async function deleteDocument(propertyId, documentId) {
    if (!confirm("Delete this document?")) return;
    try {
        await API.del(`/api/hotels/${propertyId}/documents/${documentId}`);
        // Re-fetch the document list
        const container = document.getElementById("docList");
        if (container) {
            const docs = await API.get(`/api/hotels/${propertyId}/documents`);
            if (docs.length === 0) {
                container.innerHTML = `<div class="empty-state" style="padding:12px">No documents yet.</div>`;
                return;
            }
            container.innerHTML = docs.map(d => `
                <div class="property-card" style="padding:12px; margin-bottom:8px;">
                    <div style="display:flex; justify-content:space-between; align-items:start;">
                        <div>
                            <strong>${escapeHtml(d.title)}</strong>
                            <span class="badge badge-pending" style="font-size:0.75rem; margin-left:6px;">${d.doc_type.replace(/_/g, ' ')}</span>
                            ${d.summary_text ? `<p style="font-size:0.85rem; color:var(--ink-faint); margin-top:4px;">${escapeHtml(d.summary_text.slice(0, 200))}${d.summary_text.length > 200 ? '...' : ''}</p>` : ''}
                            <small style="color:var(--ink-faint)">${new Date(d.created_at).toLocaleDateString()}</small>
                        </div>
                        <button class="btn btn-danger btn-small" onclick="deleteDocument('${propertyId}', '${d.id}')">Delete</button>
                    </div>
                </div>
            `).join("");
        }
    } catch (err) { alert(err.message); }
}

async function deleteRoom(propertyId, roomId) {
    if (!confirm("Delete this room?")) return;
    await API.del(`/api/hotels/${propertyId}/rooms/${roomId}`);
    viewProperty(propertyId);
}

// ==================== Admin ====================
async function initAdmin() {
    const user = await checkAuth();
    if (!user || user.role !== "admin") {
        window.location.href = "/login";
        return;
    }

    // Tab switching
    document.querySelectorAll(".tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            if (btn.dataset.tab === "pending") renderPendingTab();
            else if (btn.dataset.tab === "reps") renderRepsTab();
            else if (btn.dataset.tab === "properties") renderPropertiesTab();
        });
    });

    renderPendingTab();
}

async function renderPendingTab() {
    const container = document.getElementById("adminTabContent");
    const data = await API.get("/api/admin/pending-hotels/all");
    const pendings = data.filter(p => p.status === "pending");
    const history = data.filter(p => p.status !== "pending");

    let html = `<h3>Pending Registrations (${pendings.length})</h3>`;

    if (pendings.length === 0) {
        html += `<div class="empty-state">No pending registrations.</div>`;
    } else {
        html += `<div class="table-container"><table>
            <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Date</th><th>Actions</th></tr></thead>
            <tbody>
        `;
        for (const p of pendings) {
            html += `<tr>
                <td>${escapeHtml(p.full_name || "â€”")}</td>
                <td>${escapeHtml(p.email)}</td>
                <td>${escapeHtml(p.phone || "â€”")}</td>
                <td>${new Date(p.created_at).toLocaleDateString()}</td>
                <td>
                    <button class="btn btn-success btn-small" onclick="approveHotel('${p.id}')">Approve</button>
                    <button class="btn btn-danger btn-small" onclick="rejectHotel('${p.id}')">Reject</button>
                </td>
            </tr>`;
        }
        html += `</tbody></table></div>`;
    }

    if (history.length > 0) {
        html += `<h3 style="margin-top:30px">History</h3>
        <div class="table-container"><table>
            <thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Date</th></tr></thead>
            <tbody>
        `;
        for (const p of history) {
            html += `<tr>
                <td>${escapeHtml(p.full_name || "â€”")}</td>
                <td>${escapeHtml(p.email)}</td>
                <td><span class="badge badge-${p.status}">${p.status}</span></td>
                <td>${new Date(p.created_at).toLocaleDateString()}</td>
            </tr>`;
        }
        html += `</tbody></table></div>`;
    }

    container.innerHTML = html;
}

async function renderRepsTab() {
    const container = document.getElementById("adminTabContent");
    const reps = await API.get("/api/admin/hotel-reps");

    let html = `<h3>Hotel Representatives</h3>`;
    if (reps.length === 0) {
        html += `<div class="empty-state">No hotel reps yet.</div>`;
    } else {
        html += `<div class="table-container"><table>
            <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
        `;
        for (const r of reps) {
            html += `<tr>
                <td>${escapeHtml(r.full_name || "â€”")}</td>
                <td>${escapeHtml(r.email)}</td>
                <td>${escapeHtml(r.phone || "â€”")}</td>
                <td><span class="badge badge-${r.is_active ? "approved" : "rejected"}">${r.is_active ? "Active" : "Inactive"}</span></td>
                <td><button class="btn btn-${r.is_active ? "danger" : "success"} btn-small" onclick="toggleRep('${r.id}')">${r.is_active ? "Deactivate" : "Activate"}</button></td>
            </tr>`;
        }
        html += `</tbody></table></div>`;
    }
    container.innerHTML = html;
}

async function approveHotel(id) {
    await API.post("/api/admin/approve-hotel", { id });
    renderPendingTab();
}

async function rejectHotel(id) {
    await API.post("/api/admin/reject-hotel", { id });
    renderPendingTab();
}

async function toggleRep(id) {
    await API.post(`/api/admin/toggle-rep/${id}`);
    await checkAuth();
    renderRepsTab();
}

// â”€â”€ Properties tab â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€

let propFilterTimer;

async function renderPropertiesTab() {
    const container = document.getElementById("adminTabContent");
    const status = document.getElementById("propFilterStatus")?.value || "pending";
    const q = document.getElementById("propFilterQ")?.value || "";
    const params = new URLSearchParams({ status, q: q || "" });
    container.innerHTML = `
        <h3>All Properties</h3>
        <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-bottom:18px;">
            <select id="propFilterStatus" onchange="renderPropertiesTab()">
                <option value="pending" ${status === "pending" ? "selected" : ""}>Pending</option>
                <option value="approved" ${status === "approved" ? "selected" : ""}>Approved</option>
                <option value="all" ${status === "all" ? "selected" : ""}>All</option>
            </select>
            <input type="text" id="propFilterQ" placeholder="Search name / address / city" value="${escapeHtml(q)}" style="flex:1;min-width:200px;padding:8px 12px;border:2px solid var(--sand-deep);border-radius:var(--radius-sm);font-family:inherit;">
            <span class="loader" id="propLoader" style="display:none"></span>
        </div>
        <div id="propTableWrap"></div>
    `;

    document.getElementById("propFilterQ").addEventListener("input", () => {
        clearTimeout(propFilterTimer);
        propFilterTimer = setTimeout(renderPropertiesTab, 350);
    });

    const wrap = document.getElementById("propTableWrap");
    wrap.innerHTML = `<div class="empty-state">Loadingâ€¦</div>`;
    try {
        const props = await API.get(`/api/admin/properties?${params.toString()}`);
        if (props.length === 0) {
            wrap.innerHTML = `<div class="empty-state">No properties match those filters.</div>`;
            return;
        }
        const rows = props.map(p => `
            <tr>
                <td><strong>${escapeHtml(p.name)}</strong></td>
                <td>${escapeHtml(p.property_type || "â€”")}</td>
                <td>${escapeHtml(p.owner_name || "â€”")}<br><small style="color:var(--ink-faint)">${escapeHtml(p.owner_email || "")}</small></td>
                <td>${escapeHtml(p.city || "â€”")}</td>
                <td style="max-width:240px;word-break:break-word">${escapeHtml(p.address || "â€”")}</td>
                <td><button class="btn btn-outline btn-small" onclick="viewPropertyDocs('${p.id}','${escapeHtml(p.name)}')">${p.document_count} doc${p.document_count === 1 ? "" : "s"}</button></td>
                <td><span class="badge badge-${p.is_approved ? "approved" : "pending"}">${p.is_approved ? "Approved" : "Pending"}</span></td>
                <td>
                    ${p.is_approved
                        ? `<button class="btn btn-danger btn-small" onclick="rejectProperty('${p.id}','${escapeHtml(p.name)}')">Unapprove</button>`
                        : `<button class="btn btn-success btn-small" onclick="approveProperty('${p.id}','${escapeHtml(p.name)}')">Approve</button>`
                    }
                </td>
            </tr>
        `).join("");

        wrap.innerHTML = `<div class="table-container"><table>
            <thead><tr>
                <th>Name</th><th>Type</th><th>Owner</th><th>City</th><th>Address</th><th>Docs</th><th>Status</th><th>Actions</th>
            </tr></thead>
            <tbody>${rows}</tbody>
        </table></div>`;
    } catch (err) {
        wrap.innerHTML = `<div class="empty-state" style="color:var(--bad)">${escapeHtml(err.message)}</div>`;
    }
}

async function viewPropertyDocs(propertyId, propertyName) {
    const modal = document.createElement("div");
    modal.className = "modal-overlay";
    modal.innerHTML = `
        <div class="modal modal-wide">
            <button class="close-modal" onclick="this.closest(\".modal-overlay\").remove()">&times;</button>
            <h3>Documents — ${escapeHtml(propertyName)}</h3>
            <div id="adminDocList"><div class="empty-state" style="padding:12px">Loading...</div></div>
        </div>
    `;
    document.body.appendChild(modal);

    try {
        const docs = await API.get(`/api/admin/properties/${propertyId}/documents`);
        const container = document.getElementById("adminDocList");
        if (docs.length === 0) {
            container.innerHTML = `<div class="empty-state" style="padding:12px">No documents uploaded for this property yet.</div>`;
            return;
        }
        container.innerHTML = docs.map(d => `
            <div class="property-card" style="padding:12px; margin-bottom:8px;">
                <div style="display:flex; justify-content:space-between; align-items:start;">
                    <div>
                        <strong>${escapeHtml(d.title)}</strong>
                        <span class="badge badge-pending" style="font-size:0.75rem; margin-left:6px;">${d.doc_type.replace(/_/g, " ")}</span>
                        ${d.summary_text ? `<p style="font-size:0.85rem; color:var(--ink-faint); margin-top:4px; white-space:pre-wrap;">${escapeHtml(d.summary_text)}</p>` : `<p style="font-size:0.85rem; color:var(--ink-faint); margin-top:4px;"><em>No content</em></p>`}
                        <small style="color:var(--ink-faint)">Uploaded ${new Date(d.created_at).toLocaleDateString()}</small>
                    </div>
                </div>
            </div>
        `).join("");
    } catch (err) { document.getElementById("adminDocList").innerHTML = `<div class="empty-state" style="padding:12px;color:var(--bad)">${escapeHtml(err.message)}</div>`; }

    modal.addEventListener("click", (e) => {
        if (e.target === modal) modal.remove();
    });
}

async function approveProperty(id, name) {
    if (!confirm(`Approve "${name}"?`)) return;
    await API.post(`/api/admin/properties/${id}/approve`);
    renderPropertiesTab();
}

async function rejectProperty(id, name) {
    if (!confirm(`Unapprove "${name}"?`)) return;
    await API.post(`/api/admin/properties/${id}/reject`);
    renderPropertiesTab();
}

// ==================== Utils ====================
function escapeHtml(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

// ==================== Init ====================
checkAuth();






