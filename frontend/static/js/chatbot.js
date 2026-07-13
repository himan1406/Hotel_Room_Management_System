(function () {
    const AI_SESSION_KEY = "ai_chat_session_id";
    let aiSessionId = localStorage.getItem(AI_SESSION_KEY);
    let isLoading = false;

    const HTML = `
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

    function renderAISuggestions() {
        const container = document.getElementById("aiChatSuggestions");
        if (!container) return;
        const msgs = document.getElementById("aiChatMessages");
        const hasMessages = msgs && msgs.querySelectorAll(".chat-msg").length > 0;
        container.style.display = hasMessages ? "none" : "flex";
        container.innerHTML = AI_SUGGESTIONS.map(s =>
            `<button class="chat-suggestion-chip" onclick="document.getElementById('aiChatInput').value=this.textContent;document.getElementById('aiChatInput').focus();document.getElementById('aiChatInput').style.height='auto'">${s}</button>`
        ).join("");
    }

    document.addEventListener("DOMContentLoaded", function () {
        document.body.insertAdjacentHTML("beforeend", HTML);

        if (aiSessionId) {
            loadChatHistory();
        }
        renderAISuggestions();
    });

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

        try {
            const res = await fetch("/api/chat", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                credentials: "include",
                body: JSON.stringify({ message: msg, session_id: aiSessionId }),
            });
            if (!res.ok) throw new Error("Chat request failed");
            const data = await res.json();

            aiSessionId = data.session_id;
            localStorage.setItem(AI_SESSION_KEY, aiSessionId);
            hideAITyping();
            appendAIMessage("assistant", data.reply, data.sources);
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
        
        let formattedText = text.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/\n/g, '<br>');
        
        // Extract property IDs and remove them from the chat bubble text
        const propertyIds = [];
        formattedText = formattedText.replace(/\[PropertyCard:\s*([a-f0-9\-]{36})\]/gi, (match, propId) => {
            propertyIds.push(propId);
            return "";
        });
        
        // Clean up trailing linebreaks/spaces in bubble text
        body.innerHTML = formattedText.trim().replace(/(<br>\s*)+$/g, '');
        div.appendChild(body);

        // Append placeholders outside the bubble but inside the message block
        propertyIds.forEach(propId => {
            const placeholder = document.createElement("div");
            placeholder.className = "chat-property-card-placeholder";
            placeholder.setAttribute("data-property-id", propId);
            placeholder.innerHTML = `<div class="chat-prop-card-loading">Loading property info...</div>`;
            div.appendChild(placeholder);
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

        // Load property cards if any placeholders exist
        div.querySelectorAll(".chat-property-card-placeholder").forEach(async (placeholder) => {
            const propId = placeholder.getAttribute("data-property-id");
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
                placeholder.innerHTML = `<div class="chat-prop-card-error">⚠️ Property info unavailable</div>`;
            }
            container.scrollTop = container.scrollHeight;
        });
    }

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
