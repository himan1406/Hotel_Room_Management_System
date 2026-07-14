// ==================== Comparison Markdown Renderer ====================
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
