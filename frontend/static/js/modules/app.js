// ==================== Dashboard ====================
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

// ==================== Window-level functions (referenced by onclick) ====================
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

// ==================== Init (DOMContentLoaded) ====================
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
