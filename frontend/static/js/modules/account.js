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
                <div class="card" style="margin-bottom:16px; padding:16px; cursor:pointer;" onclick="openGroupDetail('${g.id}')">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <strong>${escapeHtml(g.property_name || "Property")}</strong>
                            <div style="font-size:0.85rem;color:var(--ink-soft);">
                                ${g.check_in} → ${g.check_out} · ${g.room_count} room(s)
                            </div>
                            <div style="font-size:0.8rem;color:var(--ink-soft);">
                                Booked: ${new Date(g.created_at).toLocaleDateString()}
                                ${g.total_price ? ` · ₹${g.total_price.toLocaleString()}` : ""}
                            </div>
                        </div>
                        <div style="display:flex; gap:8px; align-items:center;">
                            <span class="badge badge-${g.status}">${g.status}</span>
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
                <div class="card" style="margin-bottom:12px; padding:14px; cursor:pointer;" onclick="openBookingDetail('${b.id}')">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                        <div>
                            <strong>${escapeHtml(b.property_name || "Property")}</strong>
                            <div style="font-size:0.85rem;color:var(--ink-soft);">
                                ${escapeHtml(b.room_type || "Room")} · ${b.check_in} → ${b.check_out}
                            </div>
                            <div style="font-size:0.8rem;color:var(--ink-soft);">
                                Guests: ${b.num_adults || 0} Adults, ${b.num_children || 0} Children
                                ${b.total_price ? ` · ₹${b.total_price.toLocaleString()}` : ""}
                            </div>
                        </div>
                        <div style="display:flex; gap:8px; align-items:center;">
                            <span class="badge badge-${b.status}">${b.status}</span>
                        </div>
                    </div>
                </div>
            `;
        }
    }

    container.innerHTML = html;
}

async function openBookingDetail(bookingId) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.style.display = "flex";
    overlay.innerHTML = `<div class="modal"><div class="empty-state">Loading booking details...</div></div>`;
    document.body.appendChild(overlay);

    try {
        const data = await API.get("/api/bookings");
        const bookings = data.bookings || data || [];
        const b = bookings.find(x => x.id === bookingId);
        if (!b) throw new Error("Booking not found");

        const nights = Math.max(1, Math.round((new Date(b.check_out) - new Date(b.check_in)) / 86400000));
        overlay.querySelector(".modal").innerHTML = `
            <button class="close-modal" onclick="this.closest('.modal-overlay').remove()">&times;</button>
            <h3>Booking Details</h3>
            <div style="margin-top:12px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                    <strong style="font-size:1.05rem;">${escapeHtml(b.property_name || "Property")}</strong>
                    <span class="badge badge-${b.status}">${b.status}</span>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:0.9rem;margin-bottom:14px;">
                    <div><span style="color:var(--ink-soft);">Room:</span> ${escapeHtml(b.room_type || "N/A")}</div>
                    <div><span style="color:var(--ink-soft);">Price:</span> ${b.total_price ? "₹" + b.total_price.toLocaleString() : "N/A"}</div>
                    <div><span style="color:var(--ink-soft);">Check-in:</span> ${b.check_in}</div>
                    <div><span style="color:var(--ink-soft);">Check-out:</span> ${b.check_out}</div>
                    <div><span style="color:var(--ink-soft);">Duration:</span> ${nights} night${nights > 1 ? "s" : ""}</div>
                    <div><span style="color:var(--ink-soft);">Guests:</span> ${b.num_adults || 0} Adults, ${b.num_children || 0} Children</div>
                </div>
                <div style="display:flex;gap:8px;padding-top:12px;border-top:1px solid var(--line);">
                    <button class="btn btn-primary btn-small" onclick="window.showPropertyInDashboard('${b.property_id}');this.closest('.modal-overlay').remove();">View Property</button>
                    ${["pending", "confirmed"].includes(b.status) ? `
                        <button class="btn btn-danger btn-small" onclick="cancelBooking('${b.id}');this.closest('.modal-overlay').remove();">Cancel Booking</button>
                    ` : ""}
                </div>
            </div>
        `;
    } catch (err) {
        overlay.querySelector(".modal").innerHTML = `
            <button class="close-modal" onclick="this.closest('.modal-overlay').remove()">&times;</button>
            <div class="empty-state" style="color:var(--bad)">Could not load booking: ${escapeHtml(err.message)}</div>
        `;
    }
}

async function openGroupDetail(groupId) {
    const overlay = document.createElement("div");
    overlay.className = "modal-overlay";
    overlay.style.display = "flex";
    overlay.innerHTML = `<div class="modal modal-wide"><div class="empty-state">Loading group details...</div></div>`;
    document.body.appendChild(overlay);

    try {
        const data = await API.get("/api/bookings");
        const groups = data.groups || [];
        const group = groups.find(g => g.id === groupId);

        const groupBookings = group?.bookings || [];
        const nights = group ? Math.max(1, Math.round((new Date(group.check_out) - new Date(group.check_in)) / 86400000)) : 0;

        let roomsHtml = "";
        if (groupBookings.length > 0) {
            roomsHtml = groupBookings.map(b => `
                <div style="padding:10px;border:1px solid var(--line);border-radius:var(--radius-sm);margin-bottom:8px;">
                    <div style="display:flex;justify-content:space-between;align-items:center;">
                        <strong>${escapeHtml(b.room_type || "Room")}</strong>
                        <span style="font-weight:600;">${b.total_price ? "₹" + b.total_price.toLocaleString() : "N/A"}</span>
                    </div>
                    <div style="font-size:0.85rem;color:var(--ink-soft);margin-top:4px;">
                        Guests: ${b.num_adults || 0} Adults, ${b.num_children || 0} Children
                    </div>
                </div>
            `).join("");
        } else {
            roomsHtml = `<div style="color:var(--ink-soft);font-size:0.9rem;">Room details unavailable.</div>`;
        }

        overlay.querySelector(".modal").innerHTML = `
            <button class="close-modal" onclick="this.closest('.modal-overlay').remove()">&times;</button>
            <h3>Group Booking Details</h3>
            <div style="margin-top:12px;">
                <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;">
                    <strong style="font-size:1.05rem;">${escapeHtml(group?.property_name || "Property")}</strong>
                    <span class="badge badge-${group?.status || "unknown"}">${group?.status || "unknown"}</span>
                </div>
                <div style="display:grid;grid-template-columns:1fr 1fr;gap:10px;font-size:0.9rem;margin-bottom:14px;">
                    <div><span style="color:var(--ink-soft);">Check-in:</span> ${group?.check_in || "N/A"}</div>
                    <div><span style="color:var(--ink-soft);">Check-out:</span> ${group?.check_out || "N/A"}</div>
                    <div><span style="color:var(--ink-soft);">Duration:</span> ${nights} night${nights > 1 ? "s" : ""}</div>
                    <div><span style="color:var(--ink-soft);">Total Price:</span> ${group?.total_price ? "₹" + group.total_price.toLocaleString() : "N/A"}</div>
                    <div><span style="color:var(--ink-soft);">Guests:</span> ${group?.num_adults || 0} Adults, ${group?.num_children || 0} Children</div>
                    <div><span style="color:var(--ink-soft);">Rooms:</span> ${group?.room_count || groupBookings.length}</div>
                </div>
                <div style="margin-bottom:14px;">
                    <div style="font-weight:600;margin-bottom:8px;">Rooms</div>
                    ${roomsHtml}
                </div>
                <div style="display:flex;gap:8px;padding-top:12px;border-top:1px solid var(--line);">
                    ${group?.property_id ? `<button class="btn btn-primary btn-small" onclick="window.showPropertyInDashboard('${group.property_id}');this.closest('.modal-overlay').remove();">View Property</button>` : ""}
                    ${["pending", "confirmed"].includes(group?.status) ? `
                        <button class="btn btn-danger btn-small" onclick="cancelGroup('${group.id}');this.closest('.modal-overlay').remove();">Cancel All</button>
                    ` : ""}
                </div>
            </div>
        `;
    } catch (err) {
        overlay.querySelector(".modal").innerHTML = `
            <button class="close-modal" onclick="this.closest('.modal-overlay').remove()">&times;</button>
            <div class="empty-state" style="color:var(--bad)">Could not load group details: ${escapeHtml(err.message)}</div>
        `;
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
