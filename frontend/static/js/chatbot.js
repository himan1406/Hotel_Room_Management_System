(function () {
    const AI_SESSION_KEY = "ai_chat_session_id";
    let aiSessionId = localStorage.getItem(AI_SESSION_KEY);
    let isLoading = false;
    let aiUserRole = null;
    let mediaRecorder = null;
    let audioChunks = [];
    let isRecording = false;
    let usedVoiceInput = false;

    const HTML = `
    <style>
        .ai-mic-btn {
            background: none;
            border: none;
            cursor: pointer;
            color: var(--ink-faint);
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 4px;
            transition: color 0.2s;
        }
        .ai-mic-btn:hover { color: var(--accent); }
        .ai-mic-recording {
            color: var(--bad) !important;
            animation: pulse-mic 1.5s infinite;
        }
        @keyframes pulse-mic {
            0% { transform: scale(1); }
            50% { transform: scale(1.15); }
            100% { transform: scale(1); }
        }
        .chat-input-area {
            display: flex;
            align-items: center;
            gap: 8px;
        }
        .ai-tts-stop {
            margin-top: 8px;
            font-size: 0.75rem;
            color: var(--ink-faint);
            cursor: pointer;
            text-decoration: underline;
            display: none;
        }
        .ai-tts-stop:hover { color: var(--bad); }
    </style>
    <button id="aiChatFAB" class="ai-fab" onclick="toggleAIChat()" aria-label="Open Front Desk AI chat">
        <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
    </button>
    <div id="aiChatPanel" class="chat-panel ai-chat-panel" style="display:none">
        <div class="ai-chat-header chat-header">
            <span class="ai-chat-header-left">
                <span class="ai-chat-avatar">FD</span>
                <span>Front Desk</span>
            </span>
            <button class="chat-close" onclick="toggleAIChat()">&times;</button>
        </div>
        <div class="chat-messages" id="aiChatMessages">
            <div class="ai-welcome">
                <div class="ai-welcome-icon">
                    <svg viewBox="0 0 24 24" width="32" height="32" fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                </div>
                <p class="ai-welcome-text">Hi! I'm <strong>Front Desk</strong>, your AI concierge. Ask me anything about properties, policies, or local attractions!</p>
                <p class="ai-kb-warning" id="aiKbWarning" style="display:none">⚠️ No property documents have been indexed yet. Answers will be based on general knowledge.</p>
            </div>
        </div>
        <div class="chat-suggestions" id="aiChatSuggestions"></div>
        <div class="chat-input-area">
            <textarea id="aiChatInput" rows="1" placeholder="Ask Front Desk..." onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();sendAIChatMessage()}"></textarea>
            <button id="aiChatMicBtn" class="ai-mic-btn" onclick="toggleMicRecording()" title="Click to record audio">
                <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a3 3 0 0 0-3 3v7a3 3 0 0 0 6 0V5a3 3 0 0 0-3-3Z"/><path d="M19 10v2a7 7 0 0 1-14 0v-2"/><line x1="12" y1="19" x2="12" y2="23"/><line x1="8" y1="23" x2="16" y2="23"/></svg>
            </button>
            <button class="btn btn-primary btn-small" onclick="sendAIChatMessage()" id="aiChatSendBtn">Send</button>
        </div>
    </div>`;

    const AI_SUGGESTIONS = [
        "Where to go for a romantic getaway?",
        "Best family-friendly hotels?",
        "What's the cancellation policy?",
        "Show me hotels with pools",
        "Any good resorts in Goa?",
    ];

    const ADMIN_SUGGESTIONS = [
        "How many properties are registered?",
        "Show pending registrations",
        "How many rooms in Gurugram?",
        "Show me all hotel reps",
    ];

    function escapeHtml(str) {
        if (!str) return "";
        const div = document.createElement("div");
        div.textContent = str;
        return div.innerHTML;
    }

    function renderAISuggestions() {
        const container = document.getElementById("aiChatSuggestions");
        if (!container) return;
        const msgs = document.getElementById("aiChatMessages");
        const hasMessages = msgs && msgs.querySelectorAll(".chat-msg").length > 0;
        container.style.display = hasMessages ? "none" : "flex";
        const suggestions = aiUserRole === "admin" ? ADMIN_SUGGESTIONS : AI_SUGGESTIONS;
        container.innerHTML = suggestions.map(s =>
            `<button class="chat-suggestion-chip" onclick="document.getElementById('aiChatInput').value=this.textContent;document.getElementById('aiChatInput').focus();document.getElementById('aiChatInput').style.height='auto'">${s}</button>`
        ).join("");
    }

    document.addEventListener("DOMContentLoaded", function () {
        document.body.insertAdjacentHTML("beforeend", HTML);

        fetchUserRole();
        if (aiSessionId) {
            loadChatHistory();
        }
        renderAISuggestions();
    });

    async function fetchUserRole() {
        // Reuse the global checkAuth() instead of making a separate HTTP request.
        // checkAuth() caches its promise, so if app.js already called it,
        // this returns the cached result — only 1 network call to /api/auth/me.
        const user = await checkAuth();
        aiUserRole = user?.role || null;
    }

    window.openAIChat = function () {
        const panel = document.getElementById("aiChatPanel");
        if (panel.style.display !== "none") return;
        toggleAIChat();
    };

    window.toggleAIChat = function () {
        const panel = document.getElementById("aiChatPanel");
        const fab = document.getElementById("aiChatFAB");
        const isOpen = panel.style.display !== "none";
        panel.style.display = isOpen ? "none" : "flex";
        fab.classList.toggle("ai-fab-open", !isOpen);

        if (!isOpen) {
            const input = document.getElementById("aiChatInput");
            setTimeout(() => input && input.focus(), 300);
            const msgs = document.getElementById("aiChatMessages");
            if (msgs) msgs.scrollTop = msgs.scrollHeight;
            checkKbStatus();
            renderAISuggestions();
        } else {
            if (window.speechSynthesis) window.speechSynthesis.cancel();
        }
    };

    window.toggleMicRecording = async function () {
        const micBtn = document.getElementById("aiChatMicBtn");
        const input = document.getElementById("aiChatInput");
        
        if (isRecording) {
            mediaRecorder.stop();
            micBtn.classList.remove("ai-mic-recording");
            input.placeholder = "Processing audio...";
            isRecording = false;
            return;
        }

        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream);
            audioChunks = [];

            mediaRecorder.ondataavailable = e => {
                if (e.data.size > 0) audioChunks.push(e.data);
            };

            mediaRecorder.onstop = async () => {
                const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                stream.getTracks().forEach(t => t.stop());
                
                const formData = new FormData();
                formData.append("file", audioBlob, "recording.webm");
                
                try {
                    const res = await fetch("/api/chat/transcribe", {
                        method: "POST",
                        body: formData
                    });
                    if (!res.ok) throw new Error("Transcription failed");
                    const data = await res.json();
                    
                    input.value = data.text;
                    input.placeholder = "Ask Front Desk...";
                    usedVoiceInput = true;
                    sendAIChatMessage();
                } catch (e) {
                    input.placeholder = "Ask Front Desk...";
                    alert("Speech recognition failed. Please try again.");
                }
            };

            mediaRecorder.start();
            isRecording = true;
            micBtn.classList.add("ai-mic-recording");
            input.value = "";
            input.placeholder = "Listening...";
        } catch (e) {
            alert("Microphone access denied or unavailable.");
        }
    };

    async function checkKbStatus() {
        try {
            const res = await fetch("/api/chat/kb-status", { credentials: "include" });
            if (!res.ok) return;
            const data = await res.json();
            const warning = document.getElementById("aiKbWarning");
            if (warning) {
                warning.style.display = data.indexed ? "none" : "block";
            }
        } catch {}
    }

    function getPropertyContextFromPage() {
        // Detect if the current page has a property context — e.g. the user
        // is viewing a specific property detail. This lets the chatbot answer
        // questions like "what's the cancellation policy?" without needing
        // the user to mention the property name.
        const params = new URLSearchParams(window.location.search);
        const pid = params.get("property_id");
        if (pid) return pid;
        return null;
    }

    window.sendAIChatMessage = async function () {
        const input = document.getElementById("aiChatInput");
        const sendBtn = document.getElementById("aiChatSendBtn");
        const msg = input.value.trim();
        if (!msg || isLoading) return;

        input.value = "";
        input.style.height = "auto";
        const suggestions = document.getElementById("aiChatSuggestions");
        if (suggestions) suggestions.style.display = "none";
        appendAIMessage("user", msg);
        showAITyping();
        isLoading = true;
        sendBtn.disabled = true;

        // Detect property context from the current page
        const bodyPayload = { message: msg, session_id: aiSessionId };
        const contextPropId = getPropertyContextFromPage();
        if (contextPropId) {
            bodyPayload.property_id = contextPropId;
        }

        try {
            const res = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify(bodyPayload),
            });
            if (!res.ok) throw new Error("Chat request failed");
            const data = await res.json();

            aiSessionId = data.session_id;
            localStorage.setItem(AI_SESSION_KEY, aiSessionId);
            hideAITyping();
            const msgEl = appendAIMessage("assistant", data.reply, data.sources);
            
            if (usedVoiceInput && window.speechSynthesis) {
                usedVoiceInput = false;
                window.speechSynthesis.cancel();
                
                const cleanTextForSpeech = data.reply
                    .replace(/\[PropertyCard:.*?\]/g, '')
                    .replace(/\[PendingHotel:.*?\]/g, '')
                    .replace(/\[Action:.*?\]/g, '')
                    .replace(/[*_#`~]/g, '');
                
                const utterance = new SpeechSynthesisUtterance(cleanTextForSpeech);
                
                const stopBtn = document.createElement("div");
                stopBtn.className = "ai-tts-stop";
                stopBtn.textContent = "🔇 Stop speaking";
                stopBtn.style.display = "block";
                stopBtn.onclick = () => {
                    window.speechSynthesis.cancel();
                    stopBtn.style.display = "none";
                };
                msgEl.querySelector(".chat-msg-body").appendChild(stopBtn);
                
                utterance.onend = () => { stopBtn.style.display = "none"; };
                
                window.speechSynthesis.speak(utterance);
            }
        } catch (e) {
            hideAITyping();
            appendAIMessage("assistant", "Sorry, I couldn't process your request. Please try again later.");
        } finally {
            isLoading = false;
            sendBtn.disabled = false;
            input.focus();
        }
    };

    function appendAIMessage(role, text, sources) {
        const container = document.getElementById("aiChatMessages");
        const welcome = container.querySelector(".ai-welcome");
        if (welcome) welcome.style.display = "none";

        const div = document.createElement("div");
        div.className = "chat-msg " + (role === "user" ? "chat-msg-mine" : "chat-msg-theirs ai-chat-msg-assistant");

        const body = document.createElement("div");
        body.className = "chat-msg-body";
        
        // ── Extract special markers from RAW text (before markdown render) ──
        let cleanText = text;
        
        const propertyCards = [];  // { id, name }
        // Match [PropertyCard: <id>] or [PropertyCard: <id> | <name>]
        cleanText = cleanText.replace(/\[PropertyCard:\s*([^\]\|]+?)(?:\s*\|\s*([^\]]+?))?\]/gi, (match, propId, propName) => {
            propertyCards.push({ id: propId.trim(), name: propName ? propName.trim() : null });
            return "";
        });

        const pendingHotels = [];
        cleanText = cleanText.replace(/\[PendingHotel:\s*([a-f0-9\-]{36})\s*\|\s*([^|]+?)\s*\|\s*([^\]]+?)\]/gi, (match, id, name, email) => {
            pendingHotels.push({ id, name: name.trim(), email: email.trim() });
            return "";
        });

        const actions = [];
        cleanText = cleanText.replace(/\[Action:\s*(approve_hotel|reject_hotel|deactivate_hotel_rep|activate_hotel_rep)\s*\|\s*([a-f0-9\-]{36})\s*\|\s*([^\]]+?)\]/gi, (match, action, id, name) => {
            actions.push({ action, id, name: name.trim() });
            return "";
        });
        
        // ── Render: user gets simple HTML, assistant gets full markdown ──
        if (role === "user") {
            body.innerHTML = escapeHtml(cleanText.trim()).replace(/\n/g, '<br>');
        } else {
            body.innerHTML = renderCompMarkdown(cleanText.trim());
        }
        div.appendChild(body);

        // Append property card placeholders
        propertyCards.forEach(card => {
            const placeholder = document.createElement("div");
            placeholder.className = "chat-property-card-placeholder";
            placeholder.setAttribute("data-property-id", card.id);
            if (card.name) {
                placeholder.setAttribute("data-property-name", card.name);
            }
            placeholder.innerHTML = `<div class="chat-prop-card-loading">Loading property info...</div>`;
            div.appendChild(placeholder);
        });

        // Render pending hotel cards
        if (pendingHotels.length > 0) {
            const hotelsContainer = document.createElement("div");
            hotelsContainer.className = "chat-admin-section";
            hotelsContainer.innerHTML = `<div class="chat-admin-label">Pending Registrations</div>`;
            pendingHotels.forEach(hotel => {
                const card = document.createElement("div");
                card.className = "chat-admin-hotel-card";
                card.innerHTML = `
                    <div class="chat-admin-hotel-info">
                        <strong>${escapeHtml(hotel.name)}</strong>
                        <div class="chat-admin-hotel-meta">${escapeHtml(hotel.email)}</div>
                    </div>
                    <div class="chat-admin-hotel-actions">
                        <button class="btn btn-success btn-small" onclick="window._adminChatAction('approve_hotel', '${hotel.id}', '${escapeHtml(hotel.name)}', this)">Approve</button>
                        <button class="btn btn-danger btn-small" onclick="window._adminChatAction('reject_hotel', '${hotel.id}', '${escapeHtml(hotel.name)}', this)">Reject</button>
                    </div>
                `;
                hotelsContainer.appendChild(card);
            });
            div.appendChild(hotelsContainer);
        }

        // Render action confirmation cards
        actions.forEach(({ action, id, name }) => {
            const confirmDiv = document.createElement("div");
            confirmDiv.className = "chat-admin-section chat-action-confirm";
            const isRepAction = action.includes("hotel_rep");
            const isActivate = action === "activate_hotel_rep" || action === "approve_hotel";
            let actionLabel, btnClass, contextText;
            if (action === "approve_hotel") {
                actionLabel = "approve"; btnClass = "btn-success"; contextText = "registration for";
            } else if (action === "reject_hotel") {
                actionLabel = "reject"; btnClass = "btn-danger"; contextText = "registration for";
            } else if (action === "deactivate_hotel_rep") {
                actionLabel = "deactivate"; btnClass = "btn-danger"; contextText = "hotel rep";
            } else {
                actionLabel = "activate"; btnClass = "btn-success"; contextText = "hotel rep";
            }
            confirmDiv.innerHTML = `
                <div class="chat-action-confirm-text">
                    I will <strong>${actionLabel}</strong> the ${contextText} <strong>${escapeHtml(name)}</strong>. Confirm?
                </div>
                <div class="chat-action-confirm-buttons">
                    <button class="btn ${btnClass} btn-small" onclick="window._confirmAdminAction('${action}', '${id}', '${escapeHtml(name)}', this)">Yes, do it</button>
                    <button class="btn btn-outline btn-small" onclick="this.closest('.chat-action-confirm').remove()">No, cancel</button>
                </div>
            `;
            div.appendChild(confirmDiv);
        });

        if (sources && sources.length > 0 && role === "assistant") {
            const srcDiv = document.createElement("div");
            srcDiv.className = "ai-sources";
            srcDiv.textContent = "Sources: " + sources.map(s => s.title).join(", ");
            div.appendChild(srcDiv);
        }

        const time = document.createElement("div");
        time.className = "chat-msg-time";
        time.textContent = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
        div.appendChild(time);

        container.appendChild(div);
        container.scrollTop = container.scrollHeight;

        // Helper: render a mini card with just the property name
        // Only makes it clickable if the ID is a valid UUID (avoids 422 errors
        // from old chat history with hallucinated integer IDs like 6, 5, etc.)
        function showMiniCard(el, id, name) {
            if (name) {
                const isValid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)
                            || /^[a-f0-9]{32}$/i.test(id);
                const clickAttr = isValid ? `onclick="window.showPropertyInDashboard('${escapeHtml(id)}')"` : '';
                const clickHint = isValid ? 'Click to view details' : 'Details unavailable';
                el.innerHTML = `
                    <div class="chat-prop-card chat-prop-card-mini" ${clickAttr} title="${escapeHtml(name)}">
                        <div class="chat-prop-card-thumb-placeholder" style="width:48px;height:48px;font-size:1.2rem;">🏨</div>
                        <div class="chat-prop-card-details">
                            <h5 class="chat-prop-card-title" style="font-size:0.85rem;">${escapeHtml(name)}</h5>
                            <div class="chat-prop-card-footer">
                                <span style="font-size:0.72rem;color:var(--ink-faint);">${clickHint}</span>
                            </div>
                        </div>
                    </div>
                `;
            } else {
                el.innerHTML = '<div class="chat-prop-card-error">⚠️ Property info unavailable</div>';
            }
        }

        // Load property cards if any placeholders exist
        div.querySelectorAll(".chat-property-card-placeholder").forEach(async (placeholder) => {
            const propId = placeholder.getAttribute("data-property-id");
            const propName = placeholder.getAttribute("data-property-name");

            // Validate: only fetch if the ID looks like a UUID (36 chars with dashes, or 32 hex chars)
            // Integer IDs like "6", "5" etc. are hallucinated — skip the API call entirely.
            const isUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(propId)
                        || /^[a-f0-9]{32}$/i.test(propId);

            if (!isUuid) {
                showMiniCard(placeholder, propId, propName);
                container.scrollTop = container.scrollHeight;
                return;
            }

            try {
                const res = await fetch(`/api/properties/${propId}`);
                if (!res.ok) throw new Error("Failed to load");
                const prop = await res.json();
                
                const thumbnailHtml = prop.images && prop.images.length > 0
                    ? `<img src="${prop.images[0]}" class="chat-prop-card-thumb" alt="${prop.name}">`
                    : `<div class="chat-prop-card-thumb-placeholder">🏨</div>`;
                
                const minPrice = prop.rooms && prop.rooms.length > 0
                    ? Math.min(...prop.rooms.map(r => r.base_price))
                    : null;
                const priceHtml = minPrice !== null ? `<span class="chat-prop-card-price">From ₹${minPrice}/night</span>` : "";
                
                placeholder.innerHTML = `
                    <div class="chat-prop-card" onclick="window.showPropertyInDashboard('${prop.id}')" title="Click to view details in dashboard">
                        ${thumbnailHtml}
                        <div class="chat-prop-card-details">
                            <h5 class="chat-prop-card-title">${prop.name}</h5>
                            <div class="chat-prop-card-meta">
                                <span>📍 ${[prop.city, prop.district].filter(Boolean).join(", ") || "Location N/A"}</span>
                                <span>⭐ ${prop.avg_rating || "0.0"} (${prop.review_count})</span>
                            </div>
                            <div class="chat-prop-card-footer">
                                ${priceHtml}
                                <span class="chat-prop-card-action">View details →</span>
                            </div>
                        </div>
                    </div>
                `;
            } catch (err) {
                showMiniCard(placeholder, propId, propName);
            }
            container.scrollTop = container.scrollHeight;
        });
        
        return div;
    }

    // ── Admin action handlers ──────────────────────────────────────────────

    window._adminChatAction = async function (action, id, name, btnEl) {
        const card = btnEl.closest(".chat-admin-hotel-card");
        if (!card) return;
        const actionsDiv = card.querySelector(".chat-admin-hotel-actions");
        actionsDiv.innerHTML = `<span style="font-size:0.8rem; color:var(--ink-faint);">Processing...</span>`;

        try {
            const res = await fetch("/api/chat/admin-action", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ action, id }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || "Action failed");
            actionsDiv.innerHTML = `<span style="font-size:0.8rem; color:var(--good);">✓ ${escapeHtml(data.message)}</span>`;
        } catch (err) {
            actionsDiv.innerHTML = `<span style="font-size:0.8rem; color:var(--bad);">✗ ${escapeHtml(err.message)}</span>`;
        }
        const container = document.getElementById("aiChatMessages");
        if (container) container.scrollTop = container.scrollHeight;
    };

    window._confirmAdminAction = async function (action, id, name, btnEl) {
        const confirmDiv = btnEl.closest(".chat-action-confirm");
        if (!confirmDiv) return;
        const buttonsDiv = confirmDiv.querySelector(".chat-action-confirm-buttons");
        buttonsDiv.innerHTML = `<span style="font-size:0.8rem; color:var(--ink-faint);">Executing...</span>`;

        try {
            const res = await fetch("/api/chat/admin-action", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ action, id }),
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || "Action failed");
            confirmDiv.innerHTML = `<div style="font-size:0.85rem; color:var(--good); padding:8px 0;">✓ ${escapeHtml(data.message)}</div>`;
        } catch (err) {
            confirmDiv.innerHTML = `<div style="font-size:0.85rem; color:var(--bad); padding:8px 0;">✗ ${escapeHtml(err.message)}</div>`;
        }
        const container = document.getElementById("aiChatMessages");
        if (container) container.scrollTop = container.scrollHeight;
    };

    function showAITyping() {
        const container = document.getElementById("aiChatMessages");
        const existing = container.querySelector(".ai-typing");
        if (existing) return;

        const div = document.createElement("div");
        div.className = "chat-msg chat-msg-theirs ai-typing";
        div.innerHTML = '<span class="ai-typing-dot"></span><span class="ai-typing-dot"></span><span class="ai-typing-dot"></span>';
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
    }

    function hideAITyping() {
        const el = document.querySelector(".ai-typing");
        if (el) el.remove();
    }

    async function loadChatHistory() {
        if (!aiSessionId) return;
        try {
            const res = await fetch("/api/chat/history?session_id=" + aiSessionId, { credentials: "include" });
            if (!res.ok) return;
            const data = await res.json();
            if (data.messages && data.messages.length > 0) {
                const container = document.getElementById("aiChatMessages");
                const welcome = container.querySelector(".ai-welcome");
                if (welcome) welcome.style.display = "none";
                data.messages.forEach(m => {
                    appendAIMessage(m.role, m.content, m.sources);
                });
                const suggestions = document.getElementById("aiChatSuggestions");
                if (suggestions) suggestions.style.display = "none";
            }
        } catch (e) {
            // silently fail
        }
    }
})();
