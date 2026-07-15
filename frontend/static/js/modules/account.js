// ==================== Bookings / Account ====================
let _bookingsContainer = null;

async function loadMyBookings(container) {
    _bookingsContainer = container || _bookingsContainer;
    const c = _bookingsContainer;
    if (!c) return;
    c.innerHTML = `<div class="empty-state">Loading your bookings...</div>`;
    try {
        const data = await API.get("/api/bookings");
        renderMyBookings(data.bookings || data, data.groups || [], c);
    } catch (err) {
        c.innerHTML = `<div class="empty-state" style="color:var(--bad)">Could not load bookings: ${escapeHtml(err.message)}</div>`;
    }
}

function renderMyBookings(bookings, groups, container) {
    if (bookings.length === 0 && groups.length === 0) {
        container.innerHTML = `<div class="empty-state">You have no bookings yet.</div>`;
        return;
    }

    let html = "";

    if (groups.length > 0) {
        html += `<h3 style="margin-bottom:12px;">Booking Groups</h3>`;
        for (const g of groups) {
            html += `
                <div class="card" style="margin-bottom:16px; padding:16px;">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <strong>${escapeHtml(g.property_name || "Property")}</strong>
                            <div style="font-size:0.85rem;color:var(--ink-soft);">
                                ${g.check_in} → ${g.check_out} · ${g.room_count} room(s)
                            </div>
                            <div style="font-size:0.8rem;color:var(--ink-soft);">
                                Booked: ${new Date(g.created_at).toLocaleDateString()}
                            </div>
                        </div>
                        <div style="display:flex; gap:8px; align-items:center;">
                            <span class="badge badge-${g.status}">${g.status}</span>
                            ${["pending", "confirmed"].includes(g.status) ? `
                                <button class="btn btn-danger btn-small" onclick="cancelGroup('${g.id}')">Cancel</button>
                            ` : ""}
                        </div>
                    </div>
                </div>
            `;
        }
    }

    if (bookings.length > 0) {
        html += `<h3 style="margin-bottom:12px;${groups.length > 0 ? 'margin-top:24px;' : ''}">Individual Bookings</h3>`;
        for (const b of bookings) {
            html += `
                <div class="card" style="margin-bottom:12px; padding:14px;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                        <div>
                            <strong>${escapeHtml(b.property_name || "Property")}</strong>
                            <div style="font-size:0.85rem;color:var(--ink-soft);">
                                ${escapeHtml(b.room_type || "Room")} · ${b.check_in} → ${b.check_out}
                            </div>
                            <div style="font-size:0.8rem;color:var(--ink-soft);">
                                Guests: ${b.adults_count || 0} Adults, ${b.children_count || 0} Children
                            </div>
                        </div>
                        <div style="display:flex; gap:8px; align-items:center;">
                            <span class="badge badge-${b.status}">${b.status}</span>
                            ${b.status === "confirmed" && b.can_review ? `
                                <button class="btn btn-primary btn-small" onclick="openReviewModal('${b.id}')">Review</button>
                            ` : ""}
                            ${["pending", "confirmed"].includes(b.status) ? `
                                <button class="btn btn-danger btn-small" onclick="cancelBooking('${b.id}')">Cancel</button>
                            ` : ""}
                        </div>
                    </div>
                </div>
            `;
        }
    }

    container.innerHTML = html;
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
    if (!confirm("Cancel all bookings in this group?")) return;
    try {
        await API.post(`/api/bookings/group/${groupId}/cancel`);
        loadMyBookings();
    } catch (err) {
        alert(err.message);
    }
}

function toggleAccountMenu(forceClose) {
    const menu = document.getElementById("navAccountMenu");
    if (!menu) return;
    if (forceClose) {
        menu.classList.remove("open");
        document.getElementById("navAccountBtn")?.setAttribute("aria-expanded", "false");
        return;
    }
    const isOpen = menu.classList.toggle("open");
    document.getElementById("navAccountBtn")?.setAttribute("aria-expanded", isOpen);
}

function openBookingsModal() {
    const existing = document.getElementById("bookingsModalOverlay");
    if (existing) existing.remove();

    const overlay = document.createElement("div");
    overlay.id = "bookingsModalOverlay";
    overlay.className = "modal-overlay";
    overlay.style.display = "flex";
    overlay.innerHTML = `
        <div class="modal modal-wide">
            <button class="close-modal" onclick="this.closest('.modal-overlay').remove()">&times;</button>
            <h3>My Bookings</h3>
            <div id="bookingsModalContent">
                <div class="empty-state">Loading...</div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    loadMyBookings(document.getElementById("bookingsModalContent"));
}
