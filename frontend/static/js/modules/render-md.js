// ==================== Shared Markdown Renderer ====================
// Used by both the main Front Desk chatbot (chatbot.js) and the
// Compare Concierge (comparison.js).
// Loaded BEFORE both so it's globally available.

function escapeHtml(str) {
    if (!str) return "";
    var div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
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
    var checked = text.match(/^[✓✔☑]$/);
    var crossed = text.match(/^[✗✘☒x]$/i);
    if (checked) return '<span class="comp-td-yes">✓</span>';
    if (crossed) return '<span class="comp-td-no">✗</span>';
    return inlineMarkdown(text);
}

function renderCompMarkdown(text) {
    var lines = text.split('\n');
    var html = '';
    var inTable = false;
    var tableHeaderDone = false;
    var inList = false;
    var i = 0;

    function closePending() {
        if (inTable) { html += '</tbody></table></div>'; inTable = false; tableHeaderDone = false; }
        if (inList) { html += '</ul>'; inList = false; }
    }

    while (i < lines.length) {
        var line = lines[i];
        var trimmed = line.trim();

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
        var h3Match = trimmed.match(/^###\s+(.+)$/);
        var h2Match = trimmed.match(/^##\s+(.+)$/);
        var h1Match = trimmed.match(/^#\s+(.+)$/);
        if (h3Match || h2Match || h1Match) {
            closePending();
            var content = inlineMarkdown(h3Match ? h3Match[1] : h2Match ? h2Match[1] : h1Match[1]);
            var tag = h3Match ? 'h4' : h2Match ? 'h3' : 'h2';
            var cls = h3Match ? 'comp-md-h3' : h2Match ? 'comp-md-h2' : 'comp-md-h1';
            html += '<' + tag + ' class="' + cls + '">' + content + '</' + tag + '>';
            i++; continue;
        }

        // Table row (starts with |)
        if (trimmed.charAt(0) === '|') {
            var cells = trimmed.split('|').map(function(c) { return c.trim(); }).filter(function(_, idx, arr) { return idx > 0 && idx < arr.length - 1; });
            // Separator row (| --- | --- |)
            if (cells.every(function(c) { return /^[-:]+$/.test(c); })) {
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
                html += '<thead><tr>' + cells.map(function(c) { return '<th>' + inlineMarkdown(c) + '</th>'; }).join('') + '</tr></thead><tbody>';
            } else {
                html += '<tr>' + cells.map(function(c) { return '<td>' + renderTableCell(c) + '</td>'; }).join('') + '</tr>';
            }
            i++; continue;
        }

        // Close table if we were in one and this line isn't a table row
        if (inTable) { html += '</tbody></table></div>'; inTable = false; tableHeaderDone = false; }

        // Bullet list
        var listMatch = trimmed.match(/^[*\-]\s+(.+)$/);
        if (listMatch) {
            if (!inList) { html += '<ul class="comp-md-list">'; inList = true; }
            html += '<li>' + inlineMarkdown(listMatch[1]) + '</li>';
            i++; continue;
        }
        if (inList) { html += '</ul>'; inList = false; }

        // Plain paragraph
        html += '<p class="comp-md-p">' + inlineMarkdown(trimmed) + '</p>';
        i++;
    }

    closePending();
    return html;
}
