// ==================== Hotel Rep Dashboard ====================
async function renderHotelRepDashboard(container, user) {
    try {
        const props = await API.get("/api/hotels/my-properties");
        container.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:16px;">
                <h3 style="margin:0;">Your Properties (${props.length})</h3>
                <a href="/dashboard?add=1" class="btn btn-primary btn-small">+ Add Property</a>
            </div>
            <div id="repPropertiesList"></div>
            <div id="repBookingsSection" style="margin-top:32px;">
                <h3 style="margin-bottom:12px;">Booking Requests</h3>
                <div id="repBookingsList"></div>
            </div>
        `;

        const listEl = document.getElementById("repPropertiesList");
        if (props.length === 0) {
            listEl.innerHTML = `<div class="empty-state">You have not added any properties yet. Click "+ Add Property" to get started.</div>`;
        } else {
            listEl.innerHTML = props.map(p => `
                <div class="card" style="margin-bottom:12px; padding:16px;">
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <div>
                            <strong>${escapeHtml(p.name)}</strong>
                            <div style="font-size:0.85rem;color:var(--ink-soft);">
                                ${escapeHtml(p.city || "Unknown")} ${p.property_type ? "· " + escapeHtml(p.property_type) : ""}
                            </div>
                            <div style="font-size:0.8rem;color:var(--ink-soft);">
                                ⭐ ${p.avg_rating || "N/A"} · ${p.review_count || 0} reviews · ${p.room_count || 0} rooms
                            </div>
                        </div>
                        <div style="display:flex; gap:8px; align-items:center;">
                            <span class="badge badge-${p.is_active ? "approved" : "pending"}">${p.is_active ? "Active" : "Inactive"}</span>
                            <button class="btn btn-outline btn-small" onclick="viewPropertyReviews('${p.id}')">Reviews</button>
                        </div>
                    </div>
                </div>
            `).join("");
        }

        renderRepBookings();
    } catch (err) {
        container.innerHTML = `<div class="empty-state" style="color:var(--bad)">Failed to load dashboard: ${escapeHtml(err.message)}</div>`;
    }
}

async function renderRepBookings() {
    const container = document.getElementById("repBookingsList");
    if (!container) return;
    try {
        const bookings = await API.get("/api/bookings/my-bookings?role=hotel_rep");
        if (bookings.length === 0) {
            container.innerHTML = `<div class="empty-state">No booking requests yet.</div>`;
            return;
        }
        container.innerHTML = bookings.map(b => `
            <div class="card" style="margin-bottom:8px; padding:12px;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <div>
                        <strong>${escapeHtml(b.customer_name || "Guest")}</strong>
                        <div style="font-size:0.85rem;color:var(--ink-soft);">
                            ${escapeHtml(b.property_name)} · ${b.room_type} · ${b.check_in} → ${b.check_out}
                        </div>
                        <div style="font-size:0.8rem;color:var(--ink-soft);">
                            Guests: ${b.adults_count || 0}A ${b.children_count || 0}C
                        </div>
                    </div>
                    <div style="display:flex; gap:8px; align-items:center;">
                        <span class="badge badge-${b.status}">${b.status}</span>
                        ${b.status === "pending" ? `
                            <button class="btn btn-success btn-small" onclick="confirmBooking('${b.id}')">Confirm</button>
                            <button class="btn btn-danger btn-small" onclick="rejectBooking('${b.id}')">Reject</button>
                        ` : ""}
                    </div>
                </div>
            </div>
        `).join("");
    } catch {
        container.innerHTML = `<div class="empty-state">Could not load booking requests.</div>`;
    }
}

async function confirmBooking(bookingId) {
    try {
        await API.post(`/api/bookings/${bookingId}/confirm`);
        renderRepBookings();
    } catch (err) {
        alert(err.message);
    }
}

async function rejectBooking(bookingId) {
    try {
        await API.post(`/api/bookings/${bookingId}/reject`);
        renderRepBookings();
    } catch (err) {
        alert(err.message);
    }
}
