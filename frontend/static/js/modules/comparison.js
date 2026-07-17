// ==================== Comparison Concierge ====================
// Uses renderCompMarkdown() and escapeHtml() from render-md.js (global, loaded before this)

function appendCompMessage(role, text) {
    var container = document.getElementById("compChatMessages");
    if (!container) return;

    var div = document.createElement("div");

    if (role === "user") {
        div.className = "comp-msg-user";
        div.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
        container.appendChild(div);
        container.scrollTop = container.scrollHeight;
        return;
    }

    // ── For assistant messages: extract PropertyCard markers before markdown render ──
    var cleanText = text;
    var seenIds = {};
    var propCards = [];

    // Match [PropertyCard: <id>] or [PropertyCard: <id> | <name>]
    // Deduplicate by ID — the LLM often mentions the same property multiple
    // times in one response, which would create duplicate cards.
    cleanText = cleanText.replace(/\[PropertyCard:\s*([^\]\|]+?)(?:\s*\|\s*([^\]]+?))?\]/gi, function(match, propId, propName) {
        var id = propId.trim();
        if (!seenIds[id]) {
            seenIds[id] = true;
            propCards.push({ id: id, name: propName ? propName.trim() : null });
        }
        return "";
    });

    // Render the markdown (without the marker text)
    div.className = "comp-msg-ai";
    div.innerHTML = renderCompMarkdown(cleanText.trim());
    container.appendChild(div);

    // ── Append property card placeholders below the message ──
    if (propCards.length > 0) {
        propCards.forEach(function(card) {
            var placeholder = document.createElement("div");
            placeholder.className = "comparison-prop-card-placeholder";
            placeholder.style.margin = "8px 0 4px";
            placeholder.innerHTML = '<div class="chat-prop-card-loading">Loading property info...</div>';
            div.appendChild(placeholder);

            // Check if the ID looks like a valid UUID
            var isUuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(card.id)
                      || /^[a-f0-9]{32}$/i.test(card.id);

            if (!isUuid) {
                if (card.name) {
                    placeholder.innerHTML =
                        '<div class="chat-prop-card chat-prop-card-mini" style="cursor:default;opacity:0.7">' +
                            '<div class="chat-prop-card-details">' +
                                '<h5 class="chat-prop-card-title" style="font-size:0.85rem;">' + escapeHtml(card.name) + '</h5>' +
                                '<div class="chat-prop-card-footer"><span style="font-size:0.72rem;color:var(--ink-faint);">Details unavailable</span></div>' +
                            '</div>' +
                        '</div>';
                } else {
                    placeholder.innerHTML = '<div class="chat-prop-card-error">⚠️ Property info unavailable</div>';
                }
                return;
            }

            // Valid UUID — fetch property details
            fetch("/api/properties/" + card.id)
                .then(function(res) { if (!res.ok) throw new Error("Failed"); return res.json(); })
                .then(function(prop) {
                    var thumb = prop.images && prop.images.length > 0
                        ? '<img src="' + escapeHtml(prop.images[0]) + '" class="chat-prop-card-thumb" alt="' + escapeHtml(prop.name) + '">'
                        : '<div class="chat-prop-card-thumb-placeholder">🏨</div>';
                    var prices = prop.rooms && prop.rooms.length > 0
                        ? Math.min.apply(null, prop.rooms.map(function(r) { return r.base_price; }))
                        : null;
                    var priceHtml = prices !== null
                        ? '<span class="chat-prop-card-price">From ₹' + prices + '/night</span>'
                        : '';
                    placeholder.innerHTML =
                        '<div class="chat-prop-card" onclick="window.showPropertyInDashboard(\'' + escapeHtml(prop.id) + '\')" title="Click to view details in dashboard">' +
                            thumb +
                            '<div class="chat-prop-card-details">' +
                                '<h5 class="chat-prop-card-title">' + escapeHtml(prop.name) + '</h5>' +
                                '<div class="chat-prop-card-meta">' +
                                    '<span>📍 ' + escapeHtml(prop.city || "Unknown") + '</span>' +
                                    '<span>⭐ ' + (prop.avg_rating || "0.0") + ' (' + (prop.review_count || 0) + ')</span>' +
                                '</div>' +
                                '<div class="chat-prop-card-footer">' +
                                    priceHtml +
                                    '<span class="chat-prop-card-action">View details →</span>' +
                                '</div>' +
                            '</div>' +
                        '</div>';
                })
                .catch(function() {
                    if (card.name) {
                        placeholder.innerHTML =
                            '<div class="chat-prop-card chat-prop-card-mini" onclick="window.showPropertyInDashboard(\'' + escapeHtml(card.id) + '\')" title="' + escapeHtml(card.name) + '">' +
                                '<div class="chat-prop-card-thumb-placeholder" style="width:48px;height:48px;font-size:1.2rem;">🏨</div>' +
                                '<div class="chat-prop-card-details">' +
                                    '<h5 class="chat-prop-card-title" style="font-size:0.85rem;">' + escapeHtml(card.name) + '</h5>' +
                                    '<div class="chat-prop-card-footer"><span style="font-size:0.72rem;color:var(--ink-faint);">Click to view details</span></div>' +
                                '</div>' +
                            '</div>';
                    } else {
                        placeholder.innerHTML = '<div class="chat-prop-card-error">⚠️ Property info unavailable</div>';
                    }
                });
        });
    }

    container.scrollTop = container.scrollHeight;
}

function showCompTyping() {
    var container = document.getElementById("compChatMessages");
    if (!container) return;

    var div = document.createElement("div");
    div.id = "compTypingIndicator";
    div.className = "chat-msg chat-msg-theirs ai-typing";
    div.style.alignSelf = "flex-start";
    div.style.padding = "10px 14px";
    div.innerHTML = '<span class="ai-typing-dot"></span><span class="ai-typing-dot"></span><span class="ai-typing-dot"></span>';
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
}

function hideCompTyping() {
    var el = document.getElementById("compTypingIndicator");
    if (el) el.remove();
}

async function fetchCompareHighlights() {
    try {
        var highlights = await API.post("/api/properties/compare/highlights", { property_ids: selectedCompareIds });
        Object.keys(highlights).forEach(function(pid) {
            var listEl = document.getElementById("compAttrs_" + pid);
            if (listEl) {
                var bullets = highlights[pid];
                listEl.innerHTML = bullets.map(function(b) {
                    return '<li style="font-size:0.8rem; color:var(--ink-soft); display:flex; align-items:flex-start; gap:6px; line-height:1.4;">' +
                        '<span style="color:var(--good); font-weight:bold;">✓</span>' +
                        '<span>' + escapeHtml(b) + '</span></li>';
                }).join("");
            }
        });
    } catch (e) {
        selectedCompareIds.forEach(function(pid) {
            var listEl = document.getElementById("compAttrs_" + pid);
            if (listEl) listEl.innerHTML = '<li style="font-size:0.8rem; color:var(--bad);">Could not load highlights.</li>';
        });
    }
}
