// ==================== Booking Cart Functions ====================
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
            <div id="galleryBody"><div class="gallery-empty">Loading photos…</div></div>
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

            // Redirect to dashboard with booking confirmation
            window.location.href = `/dashboard?booked=1&group_id=${resp.group_id || ""}`;
        } catch (err) {
            errDiv.style.display = "block";
            errDiv.textContent = err.message;
            confirmBtn.disabled = false;
        }
    });
}
