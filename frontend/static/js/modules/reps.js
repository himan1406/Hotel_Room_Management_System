// ==================== Hotel Rep Dashboard ====================
async function renderHotelRepDashboard(container, user) {
    container.innerHTML = `<div class="empty-state">Loading your dashboard...</div>`;
    try {
        const [props, bookings] = await Promise.all([
            API.get("/api/hotels"),
            API.get("/api/hotels/bookings").catch(() => []),
        ]);
        container.innerHTML = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                <h3 style="margin:0;">Your Properties (${props.length})</h3>
                <button class="btn btn-primary btn-small" onclick="openAddPropertyModal()">+ Add Property</button>
            </div>
            <div id="repPropertiesList"></div>
            <div id="repBookingsSection" style="margin-top:36px;">
                <h3 style="margin-bottom:14px;">Recent Bookings</h3>
                <div id="repBookingsList"></div>
            </div>
        `;

        const listEl = document.getElementById("repPropertiesList");
        if (props.length === 0) {
            listEl.innerHTML = `<div class="empty-state">You have not added any properties yet. Click "+ Add Property" to get started.</div>`;
        } else {
            listEl.innerHTML = props.map(p => renderPropertyCard(p)).join("");
        }

        renderRepBookings(bookings);
    } catch (err) {
        container.innerHTML = `<div class="empty-state" style="color:var(--bad)">Failed to load dashboard: ${escapeHtml(err.message)}</div>`;
    }
}

function renderPropertyCard(p) {
    const typeLabels = { hotel: "Hotel", villa: "Villa", homestay: "Homestay", resort: "Resort", heritage: "Heritage", hostel: "Hostel" };
    const thumb = p.images && p.images.length > 0 ? p.images[0] : "";
    return `
        <div class="card" style="margin-bottom:16px; padding:0; overflow:hidden;">
            <div style="display:flex; gap:0;">
                <div style="width:180px; min-height:140px; flex-shrink:0; background:var(--gold-tint); overflow:hidden;">
                    ${thumb
                        ? `<img src="${escapeHtml(thumb)}" alt="${escapeHtml(p.name)}" style="width:100%; height:100%; object-fit:cover;">`
                        : `<div style="height:140px; display:flex; align-items:center; justify-content:center; font-size:2.2rem; color:var(--ink-faint);">🏨</div>`}
                </div>
                <div style="flex:1; padding:18px 22px;">
                    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                        <div>
                            <strong style="font-size:1.05rem;">${escapeHtml(p.name)}</strong>
                            <div style="font-size:0.85rem; color:var(--ink-soft); margin-top:2px;">
                                ${typeLabels[p.property_type] || escapeHtml(p.property_type || "")} ${p.city ? "· " + escapeHtml(p.city) : ""}
                            </div>
                            <div style="font-size:0.8rem; color:var(--ink-faint); margin-top:4px;">
                                ⭐ ${p.avg_rating || "N/A"} · ${p.review_count || 0} reviews · ${p.room_count || 0} rooms
                            </div>
                            ${p.address ? `<div style="font-size:0.8rem; color:var(--ink-faint); margin-top:2px;">📍 ${escapeHtml(p.address)}</div>` : ""}
                        </div>
                        <div style="display:flex; gap:6px; align-items:center; flex-shrink:0;">
                            <span class="badge badge-${p.is_active ? "approved" : "pending"}">${p.is_active ? "Active" : "Inactive"}</span>
                        </div>
                    </div>
                    <div style="display:flex; gap:8px; margin-top:14px; flex-wrap:wrap;">
                        <button class="btn btn-outline btn-small" onclick="togglePropertyExpand('${p.id}')">Manage</button>
                        <button class="btn btn-outline btn-small" onclick="openEditPropertyModal('${p.id}')">Edit</button>
                        <button class="btn btn-outline btn-small" onclick="openPropertyImagesModal('${p.id}', '${escapeHtml(p.name)}')">Images ${p.images && p.images.length ? "(" + p.images.length + ")" : ""}</button>
                        <button class="btn btn-outline btn-small" onclick="openPropertyDocsModal('${p.id}', '${escapeHtml(p.name)}')">Docs</button>
                        <button class="btn btn-outline btn-small" onclick="viewPropertyReviews('${p.id}')">Reviews</button>
                    </div>
                </div>
            </div>
            <div id="expand_${p.id}" style="display:none; border-top:1px solid var(--line-soft); padding:18px 22px; background:var(--paper);">
                <div id="expandContent_${p.id}"><div class="empty-state" style="padding:20px;">Loading rooms...</div></div>
            </div>
        </div>
    `;
}

// ── Expand / collapse property ──────────────────────────────────────────
async function togglePropertyExpand(propertyId) {
    const section = document.getElementById(`expand_${propertyId}`);
    if (!section) return;
    if (section.style.display === "none") {
        section.style.display = "block";
        await loadPropertyRooms(propertyId);
    } else {
        section.style.display = "none";
    }
}

async function loadPropertyRooms(propertyId) {
    const container = document.getElementById(`expandContent_${propertyId}`);
    if (!container) return;
    container.innerHTML = `<div class="empty-state" style="padding:16px;">Loading rooms...</div>`;
    try {
        const rooms = await API.get(`/api/hotels/${propertyId}/rooms`);
        let html = `
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:14px;">
                <h4 style="margin:0;">Rooms (${rooms.length})</h4>
                <button class="btn btn-primary btn-small" onclick="openAddRoomModal('${propertyId}')">+ Add Room</button>
            </div>
        `;
        if (rooms.length === 0) {
            html += `<div class="empty-state" style="padding:20px;">No rooms yet. Add a room type to start accepting bookings.</div>`;
        } else {
            html += rooms.map(r => renderRoomItem(propertyId, r)).join("");
        }
        container.innerHTML = html;
    } catch (err) {
        container.innerHTML = `<div class="empty-state" style="padding:16px; color:var(--bad);">Failed to load rooms: ${escapeHtml(err.message)}</div>`;
    }
}

function renderRoomItem(propertyId, r) {
    const thumb = r.images && r.images.length > 0 ? r.images[0] : "";
    return `
        <div class="room-item" style="display:flex; gap:14px; align-items:flex-start;">
            <div class="room-item-thumb ${thumb ? "" : "placeholder"}" style="width:56px; height:56px; border-radius:var(--radius-sm); overflow:hidden; flex-shrink:0; border:1px solid var(--line); background:var(--surface); display:flex; align-items:center; justify-content:center;">
                ${thumb ? `<img src="${escapeHtml(thumb)}" alt="" style="width:100%; height:100%; object-fit:cover;">` : "🛏"}
            </div>
            <div style="flex:1; min-width:0;">
                <div style="display:flex; justify-content:space-between; align-items:center;">
                    <h5 style="margin:0; font-size:1rem;">${escapeHtml(r.room_type)}</h5>
                    <div style="display:flex; gap:4px;">
                        <button class="btn btn-outline btn-small" style="padding:5px 10px; font-size:0.65rem;" onclick="openEditRoomModal('${propertyId}', '${r.id}')">Edit</button>
                        <button class="btn btn-outline btn-small" style="padding:5px 10px; font-size:0.65rem;" onclick="openRoomImagesModal('${propertyId}', '${r.id}', '${escapeHtml(r.room_type)}')">Images ${r.images && r.images.length ? "(" + r.images.length + ")" : ""}</button>
                        <button class="btn btn-danger btn-small" style="padding:5px 10px; font-size:0.65rem;" onclick="deleteRoom('${propertyId}', '${r.id}', '${escapeHtml(r.room_type)}')">Delete</button>
                    </div>
                </div>
                <div class="room-details" style="grid-template-columns: repeat(auto-fit, minmax(100px, 1fr)); gap:6px; font-size:0.82rem; color:var(--ink-soft); margin-top:6px;">
                    <span>₹${r.base_price}/night</span>
                    <span>${r.capacity_adults}A ${r.capacity_children}C</span>
                    <span>${r.total_quantity} total</span>
                    <span>${r.available_today ?? "—"} available today</span>
                </div>
            </div>
        </div>
    `;
}

// ── Add Property Modal ──────────────────────────────────────────────────
function openAddPropertyModal() {
    closeRepModal();
    const overlay = document.createElement("div");
    overlay.id = "repModalOverlay";
    overlay.className = "modal-overlay";
    overlay.style.display = "flex";
    overlay.innerHTML = `
        <div class="modal modal-wide">
            <button class="close-modal" onclick="closeRepModal()">&times;</button>
            <h3>Add New Property</h3>
            <div id="addPropertyError" class="error-msg"></div>
            <form id="addPropertyForm">
                <div class="form-group">
                    <label>Property Name *</label>
                    <input type="text" id="apName" required maxlength="255" placeholder="e.g. The Grand Palace">
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
                    <div class="form-group">
                        <label>Type</label>
                        <select id="apType">
                            <option value="hotel">Hotel</option>
                            <option value="villa">Villa</option>
                            <option value="homestay">Homestay</option>
                            <option value="resort">Resort</option>
                            <option value="heritage">Heritage</option>
                            <option value="hostel">Hostel</option>
                        </select>
                    </div>
                    <div class="form-group">
                        <label>City</label>
                        <div class="autocomplete-wrapper">
                            <input type="text" id="apCitySearch" placeholder="Search city..." autocomplete="off">
                            <input type="hidden" id="apCityId">
                            <div class="autocomplete-dropdown" id="apCityDropdown"></div>
                        </div>
                    </div>
                </div>
                <div class="form-group">
                    <label>Address</label>
                    <input type="text" id="apAddress" placeholder="Full address">
                </div>
                <div class="form-group">
                    <label>Description</label>
                    <textarea id="apDescription" rows="3" placeholder="Describe your property..."></textarea>
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
                    <div class="form-group">
                        <label>Latitude</label>
                        <input type="number" id="apLat" step="any" placeholder="e.g. 28.6139">
                    </div>
                    <div class="form-group">
                        <label>Longitude</label>
                        <input type="number" id="apLng" step="any" placeholder="e.g. 77.2090">
                    </div>
                </div>
                <button type="submit" class="btn btn-primary btn-full">Create Property</button>
            </form>
        </div>
    `;
    document.body.appendChild(overlay);
    setupLocationAutocomplete("apCitySearch", "apCityDropdown", "apCityId");

    document.getElementById("addPropertyForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const errDiv = document.getElementById("addPropertyError");
        errDiv.style.display = "none";
        try {
            const payload = {
                name: document.getElementById("apName").value,
                property_type: document.getElementById("apType").value,
                city_id: document.getElementById("apCityId").value || null,
                address: document.getElementById("apAddress").value || null,
                description: document.getElementById("apDescription").value || null,
                latitude: parseFloat(document.getElementById("apLat").value) || null,
                longitude: parseFloat(document.getElementById("apLng").value) || null,
            };
            await API.post("/api/hotels", payload);
            closeRepModal();
            initDashboard();
        } catch (err) {
            errDiv.textContent = err.message;
            errDiv.style.display = "block";
        }
    });
}

// ── Edit Property Modal ─────────────────────────────────────────────────
async function openEditPropertyModal(propertyId) {
    closeRepModal();
    try {
        const p = await API.get(`/api/hotels/${propertyId}`);
        const overlay = document.createElement("div");
        overlay.id = "repModalOverlay";
        overlay.className = "modal-overlay";
        overlay.style.display = "flex";
        overlay.innerHTML = `
            <div class="modal modal-wide">
                <button class="close-modal" onclick="closeRepModal()">&times;</button>
                <h3>Edit Property</h3>
                <div id="editPropertyError" class="error-msg"></div>
                <form id="editPropertyForm">
                    <div class="form-group">
                        <label>Property Name *</label>
                        <input type="text" id="epName" required maxlength="255" value="${escapeHtml(p.name)}">
                    </div>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
                        <div class="form-group">
                            <label>Type</label>
                            <select id="epType">
                                ${["hotel","villa","homestay","resort","heritage","hostel"].map(t =>
                                    `<option value="${t}" ${p.property_type === t ? "selected" : ""}>${t.charAt(0).toUpperCase() + t.slice(1)}</option>`
                                ).join("")}
                            </select>
                        </div>
                        <div class="form-group">
                            <label>City</label>
                            <div class="autocomplete-wrapper">
                                <input type="text" id="epCitySearch" value="${escapeHtml(p.city || "")}" placeholder="Search city..." autocomplete="off">
                                <input type="hidden" id="epCityId" value="${p.city_id || ""}">
                                <div class="autocomplete-dropdown" id="epCityDropdown"></div>
                            </div>
                        </div>
                    </div>
                    <div class="form-group">
                        <label>Address</label>
                        <input type="text" id="epAddress" value="${escapeHtml(p.address || "")}">
                    </div>
                    <div class="form-group">
                        <label>Description</label>
                        <textarea id="epDescription" rows="3">${escapeHtml(p.description || "")}</textarea>
                    </div>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
                        <div class="form-group">
                            <label>Latitude</label>
                            <input type="number" id="epLat" step="any" value="${p.latitude || ""}">
                        </div>
                        <div class="form-group">
                            <label>Longitude</label>
                            <input type="number" id="epLng" step="any" value="${p.longitude || ""}">
                        </div>
                    </div>
                    <button type="submit" class="btn btn-primary btn-full">Save Changes</button>
                </form>
            </div>
        `;
        document.body.appendChild(overlay);
        setupLocationAutocomplete("epCitySearch", "epCityDropdown", "epCityId");

        document.getElementById("editPropertyForm").addEventListener("submit", async (e) => {
            e.preventDefault();
            const errDiv = document.getElementById("editPropertyError");
            errDiv.style.display = "none";
            try {
                const payload = {
                    name: document.getElementById("epName").value,
                    property_type: document.getElementById("epType").value,
                    city_id: document.getElementById("epCityId").value || null,
                    address: document.getElementById("epAddress").value || null,
                    description: document.getElementById("epDescription").value || null,
                    latitude: parseFloat(document.getElementById("epLat").value) || null,
                    longitude: parseFloat(document.getElementById("epLng").value) || null,
                };
                await API.put(`/api/hotels/${propertyId}`, payload);
                closeRepModal();
                initDashboard();
            } catch (err) {
                errDiv.textContent = err.message;
                errDiv.style.display = "block";
            }
        });
    } catch (err) {
        alert("Failed to load property: " + err.message);
    }
}

// ── Add Room Modal ──────────────────────────────────────────────────────
function openAddRoomModal(propertyId) {
    closeRepModal();
    const overlay = document.createElement("div");
    overlay.id = "repModalOverlay";
    overlay.className = "modal-overlay";
    overlay.style.display = "flex";
    overlay.innerHTML = `
        <div class="modal">
            <button class="close-modal" onclick="closeRepModal()">&times;</button>
            <h3>Add Room Type</h3>
            <div id="addRoomError" class="error-msg"></div>
            <form id="addRoomForm">
                <div class="form-group">
                    <label>Room Type *</label>
                    <input type="text" id="arType" required maxlength="100" placeholder="e.g. Deluxe Double, Suite">
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
                    <div class="form-group">
                        <label>Base Price (₹/night) *</label>
                        <input type="number" id="arPrice" required min="1" step="any" placeholder="e.g. 2500">
                    </div>
                    <div class="form-group">
                        <label>Total Rooms *</label>
                        <input type="number" id="arQty" required min="1" placeholder="e.g. 10">
                    </div>
                </div>
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
                    <div class="form-group">
                        <label>Adult Capacity</label>
                        <input type="number" id="arAdults" min="1" value="2">
                    </div>
                    <div class="form-group">
                        <label>Child Capacity</label>
                        <input type="number" id="arChildren" min="0" value="1">
                    </div>
                </div>
                <button type="submit" class="btn btn-primary btn-full">Create Room</button>
            </form>
        </div>
    `;
    document.body.appendChild(overlay);

    document.getElementById("addRoomForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const errDiv = document.getElementById("addRoomError");
        errDiv.style.display = "none";
        try {
            await API.post(`/api/hotels/${propertyId}/rooms`, {
                room_type: document.getElementById("arType").value,
                base_price: parseFloat(document.getElementById("arPrice").value),
                total_quantity: parseInt(document.getElementById("arQty").value),
                capacity_adults: parseInt(document.getElementById("arAdults").value) || 2,
                capacity_children: parseInt(document.getElementById("arChildren").value) || 0,
            });
            closeRepModal();
            loadPropertyRooms(propertyId);
        } catch (err) {
            errDiv.textContent = err.message;
            errDiv.style.display = "block";
        }
    });
}

// ── Edit Room Modal ─────────────────────────────────────────────────────
async function openEditRoomModal(propertyId, roomId) {
    closeRepModal();
    try {
        const rooms = await API.get(`/api/hotels/${propertyId}/rooms`);
        const r = rooms.find(rm => rm.id === roomId);
        if (!r) throw new Error("Room not found");
        const overlay = document.createElement("div");
        overlay.id = "repModalOverlay";
        overlay.className = "modal-overlay";
        overlay.style.display = "flex";
        overlay.innerHTML = `
            <div class="modal">
                <button class="close-modal" onclick="closeRepModal()">&times;</button>
                <h3>Edit Room</h3>
                <div id="editRoomError" class="error-msg"></div>
                <form id="editRoomForm">
                    <div class="form-group">
                        <label>Room Type *</label>
                        <input type="text" id="erType" required maxlength="100" value="${escapeHtml(r.room_type)}">
                    </div>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
                        <div class="form-group">
                            <label>Base Price (₹/night) *</label>
                            <input type="number" id="erPrice" required min="1" step="any" value="${r.base_price}">
                        </div>
                        <div class="form-group">
                            <label>Total Rooms *</label>
                            <input type="number" id="erQty" required min="1" value="${r.total_quantity}">
                        </div>
                    </div>
                    <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
                        <div class="form-group">
                            <label>Adult Capacity</label>
                            <input type="number" id="erAdults" min="1" value="${r.capacity_adults}">
                        </div>
                        <div class="form-group">
                            <label>Child Capacity</label>
                            <input type="number" id="erChildren" min="0" value="${r.capacity_children}">
                        </div>
                    </div>
                    <button type="submit" class="btn btn-primary btn-full">Save Changes</button>
                </form>
            </div>
        `;
        document.body.appendChild(overlay);

        document.getElementById("editRoomForm").addEventListener("submit", async (e) => {
            e.preventDefault();
            const errDiv = document.getElementById("editRoomError");
            errDiv.style.display = "none";
            try {
                await API.put(`/api/hotels/${propertyId}/rooms/${roomId}`, {
                    room_type: document.getElementById("erType").value,
                    base_price: parseFloat(document.getElementById("erPrice").value),
                    total_quantity: parseInt(document.getElementById("erQty").value),
                    capacity_adults: parseInt(document.getElementById("erAdults").value) || 2,
                    capacity_children: parseInt(document.getElementById("erChildren").value) || 0,
                });
                closeRepModal();
                loadPropertyRooms(propertyId);
            } catch (err) {
                errDiv.textContent = err.message;
                errDiv.style.display = "block";
            }
        });
    } catch (err) {
        alert("Failed to load room: " + err.message);
    }
}

async function deleteRoom(propertyId, roomId, roomType) {
    if (!confirm(`Delete room type "${roomType}"? This cannot be undone.`)) return;
    try {
        await API.del(`/api/hotels/${propertyId}/rooms/${roomId}`);
        loadPropertyRooms(propertyId);
    } catch (err) {
        alert(err.message);
    }
}

// ── Property Images Modal ───────────────────────────────────────────────
async function openPropertyImagesModal(propertyId, propertyName) {
    closeRepModal();
    const overlay = document.createElement("div");
    overlay.id = "repModalOverlay";
    overlay.className = "modal-overlay";
    overlay.style.display = "flex";
    overlay.innerHTML = `
        <div class="modal modal-wide">
            <button class="close-modal" onclick="closeRepModal()">&times;</button>
            <h3>Images — ${escapeHtml(propertyName)}</h3>
            <div id="propImagesError" class="error-msg"></div>
            <div id="propImagesGrid" class="image-gallery" style="margin-bottom:16px;"></div>
            <div class="image-upload-area">
                <input type="file" id="propImageInput" multiple accept=".jpg,.jpeg,.png,.webp" style="display:none;" onchange="uploadPropertyImages('${propertyId}')">
                <button class="btn btn-outline btn-small" onclick="document.getElementById('propImageInput').click()">+ Upload Images</button>
                <div style="font-size:0.78rem; color:var(--ink-faint); margin-top:6px;">JPG, PNG, WebP · Max 5 MB each</div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    await refreshPropertyImages(propertyId);
}

async function refreshPropertyImages(propertyId) {
    const grid = document.getElementById("propImagesGrid");
    if (!grid) return;
    try {
        const p = await API.get(`/api/hotels/${propertyId}`);
        const images = p.images || [];
        if (images.length === 0) {
            grid.innerHTML = `<div class="empty-state" style="padding:20px;">No images uploaded yet.</div>`;
        } else {
            grid.innerHTML = images.map((url, i) => `
                <div class="image-thumb">
                    <img src="${escapeHtml(url)}" alt="Property image ${i + 1}">
                    <button class="image-thumb-remove" onclick="deletePropertyImage('${propertyId}', ${i})" title="Remove">&times;</button>
                </div>
            `).join("");
        }
    } catch {
        grid.innerHTML = `<div class="empty-state" style="padding:16px;">Could not load images.</div>`;
    }
}

async function uploadPropertyImages(propertyId) {
    const input = document.getElementById("propImageInput");
    const errDiv = document.getElementById("propImagesError");
    if (!input.files.length) return;
    errDiv.style.display = "none";
    try {
        const form = new FormData();
        for (const file of input.files) form.append("files", file);
        const res = await fetch(`/api/hotels/${propertyId}/images`, {
            method: "POST",
            credentials: "include",
            body: form,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Upload failed");
        input.value = "";
        await refreshPropertyImages(propertyId);
    } catch (err) {
        errDiv.textContent = err.message;
        errDiv.style.display = "block";
    }
}

async function deletePropertyImage(propertyId, index) {
    if (!confirm("Remove this image?")) return;
    try {
        await API.del(`/api/hotels/${propertyId}/images/${index}`);
        await refreshPropertyImages(propertyId);
    } catch (err) {
        alert(err.message);
    }
}

// ── Room Images Modal ───────────────────────────────────────────────────
async function openRoomImagesModal(propertyId, roomId, roomType) {
    closeRepModal();
    const overlay = document.createElement("div");
    overlay.id = "repModalOverlay";
    overlay.className = "modal-overlay";
    overlay.style.display = "flex";
    overlay.innerHTML = `
        <div class="modal modal-wide">
            <button class="close-modal" onclick="closeRepModal()">&times;</button>
            <h3>Images — ${escapeHtml(roomType)}</h3>
            <div id="roomImagesError" class="error-msg"></div>
            <div id="roomImagesGrid" class="image-gallery" style="margin-bottom:16px;"></div>
            <div class="image-upload-area">
                <input type="file" id="roomImageInput" multiple accept=".jpg,.jpeg,.png,.webp" style="display:none;" onchange="uploadRoomImages('${propertyId}', '${roomId}')">
                <button class="btn btn-outline btn-small" onclick="document.getElementById('roomImageInput').click()">+ Upload Images</button>
                <div style="font-size:0.78rem; color:var(--ink-faint); margin-top:6px;">JPG, PNG, WebP · Max 5 MB each</div>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    await refreshRoomImages(propertyId, roomId);
}

async function refreshRoomImages(propertyId, roomId) {
    const grid = document.getElementById("roomImagesGrid");
    if (!grid) return;
    try {
        const rooms = await API.get(`/api/hotels/${propertyId}/rooms`);
        const r = rooms.find(rm => rm.id === roomId);
        const images = r ? (r.images || []) : [];
        if (images.length === 0) {
            grid.innerHTML = `<div class="empty-state" style="padding:20px;">No images uploaded yet.</div>`;
        } else {
            grid.innerHTML = images.map((url, i) => `
                <div class="image-thumb">
                    <img src="${escapeHtml(url)}" alt="Room image ${i + 1}">
                    <button class="image-thumb-remove" onclick="deleteRoomImage('${propertyId}', '${roomId}', ${i})" title="Remove">&times;</button>
                </div>
            `).join("");
        }
    } catch {
        grid.innerHTML = `<div class="empty-state" style="padding:16px;">Could not load images.</div>`;
    }
}

async function uploadRoomImages(propertyId, roomId) {
    const input = document.getElementById("roomImageInput");
    const errDiv = document.getElementById("roomImagesError");
    if (!input.files.length) return;
    errDiv.style.display = "none";
    try {
        const form = new FormData();
        for (const file of input.files) form.append("files", file);
        const res = await fetch(`/api/hotels/${propertyId}/rooms/${roomId}/images`, {
            method: "POST",
            credentials: "include",
            body: form,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Upload failed");
        input.value = "";
        await refreshRoomImages(propertyId, roomId);
    } catch (err) {
        errDiv.textContent = err.message;
        errDiv.style.display = "block";
    }
}

async function deleteRoomImage(propertyId, roomId, index) {
    if (!confirm("Remove this image?")) return;
    try {
        await API.del(`/api/hotels/${propertyId}/rooms/${roomId}/images/${index}`);
        await refreshRoomImages(propertyId, roomId);
    } catch (err) {
        alert(err.message);
    }
}

// ── Documents Modal ─────────────────────────────────────────────────────
async function openPropertyDocsModal(propertyId, propertyName) {
    closeRepModal();
    const overlay = document.createElement("div");
    overlay.id = "repModalOverlay";
    overlay.className = "modal-overlay";
    overlay.style.display = "flex";
    overlay.innerHTML = `
        <div class="modal modal-wide">
            <button class="close-modal" onclick="closeRepModal()">&times;</button>
            <h3>Documents — ${escapeHtml(propertyName)}</h3>
            <div id="propDocsError" class="error-msg"></div>
            <div id="propDocsList" style="margin-bottom:16px;"></div>
            <hr style="border:0; border-top:1px solid var(--line-soft); margin:16px 0;">
            <h4 style="margin-bottom:12px;">Upload New Document</h4>
            <form id="uploadDocForm">
                <div style="display:grid; grid-template-columns:1fr 1fr; gap:16px;">
                    <div class="form-group">
                        <label>Title *</label>
                        <input type="text" id="docTitle" required maxlength="255" placeholder="e.g. Cancellation Policy">
                    </div>
                    <div class="form-group">
                        <label>Type</label>
                        <select id="docType">
                            <option value="cancellation_policy">Cancellation Policy</option>
                            <option value="house_rules">House Rules</option>
                            <option value="transportation">Transportation</option>
                            <option value="local_guide">Local Guide</option>
                            <option value="other">Other</option>
                        </select>
                    </div>
                </div>
                <div class="form-group">
                    <label>Summary (optional)</label>
                    <textarea id="docSummary" rows="2" placeholder="Brief summary of the document..."></textarea>
                </div>
                <div class="form-group">
                    <label>File *</label>
                    <input type="file" id="docFile" required accept=".pdf,.txt,.doc,.docx">
                    <div style="font-size:0.78rem; color:var(--ink-faint); margin-top:4px;">PDF, TXT, DOC, DOCX · Max 5 MB</div>
                </div>
                <button type="submit" class="btn btn-primary btn-full">Upload Document</button>
            </form>
        </div>
    `;
    document.body.appendChild(overlay);
    await refreshPropertyDocs(propertyId);

    document.getElementById("uploadDocForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        const errDiv = document.getElementById("propDocsError");
        errDiv.style.display = "none";
        try {
            const form = new FormData();
            form.append("title", document.getElementById("docTitle").value);
            form.append("doc_type", document.getElementById("docType").value);
            form.append("summary", document.getElementById("docSummary").value);
            form.append("file", document.getElementById("docFile").files[0]);
            const res = await fetch(`/api/hotels/${propertyId}/documents`, {
                method: "POST",
                credentials: "include",
                body: form,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || "Upload failed");
            document.getElementById("docTitle").value = "";
            document.getElementById("docSummary").value = "";
            document.getElementById("docFile").value = "";
            await refreshPropertyDocs(propertyId);
        } catch (err) {
            errDiv.textContent = err.message;
            errDiv.style.display = "block";
        }
    });
}

async function refreshPropertyDocs(propertyId) {
    const container = document.getElementById("propDocsList");
    if (!container) return;
    try {
        const docs = await API.get(`/api/hotels/${propertyId}/documents`);
        if (docs.length === 0) {
            container.innerHTML = `<div class="empty-state" style="padding:16px;">No documents uploaded yet.</div>`;
        } else {
            container.innerHTML = docs.map(d => `
                <div style="display:flex; justify-content:space-between; align-items:center; padding:10px 14px; border:1px solid var(--line-soft); border-radius:var(--radius-sm); margin-bottom:8px; background:var(--surface);">
                    <div>
                        <strong style="font-size:0.9rem;">${escapeHtml(d.title)}</strong>
                        <div style="font-size:0.78rem; color:var(--ink-faint);">${escapeHtml(d.doc_type)} · ${d.created_at ? new Date(d.created_at).toLocaleDateString() : ""}</div>
                    </div>
                    <button class="btn btn-danger btn-small" style="padding:4px 10px; font-size:0.65rem;" onclick="deletePropertyDoc('${propertyId}', '${d.id}')">Delete</button>
                </div>
            `).join("");
        }
    } catch {
        container.innerHTML = `<div class="empty-state" style="padding:16px;">Could not load documents.</div>`;
    }
}

async function deletePropertyDoc(propertyId, docId) {
    if (!confirm("Delete this document?")) return;
    try {
        await API.del(`/api/hotels/${propertyId}/documents/${docId}`);
        await refreshPropertyDocs(propertyId);
    } catch (err) {
        alert(err.message);
    }
}

// ── Reviews Modal ───────────────────────────────────────────────────────
async function viewPropertyReviews(propertyId) {
    closeRepModal();
    const overlay = document.createElement("div");
    overlay.id = "repModalOverlay";
    overlay.className = "modal-overlay";
    overlay.style.display = "flex";
    overlay.innerHTML = `
        <div class="modal modal-wide">
            <button class="close-modal" onclick="closeRepModal()">&times;</button>
            <h3>Reviews</h3>
            <div id="repReviewsContent"><div class="empty-state" style="padding:20px;">Loading reviews...</div></div>
        </div>
    `;
    document.body.appendChild(overlay);

    const content = document.getElementById("repReviewsContent");
    try {
        const reviews = await API.get(`/api/reviews/property/${propertyId}`);
        if (reviews.length === 0) {
            content.innerHTML = `<div class="empty-state" style="padding:20px;">No reviews yet.</div>`;
            return;
        }
        content.innerHTML = reviews.map(r => `
            <div style="border:1px solid var(--line-soft); border-radius:var(--radius-sm); padding:14px; margin-bottom:10px; background:var(--surface);">
                <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                    <div>
                        <strong style="font-size:0.9rem;">${escapeHtml(r.customer_name || "Guest")}</strong>
                        <span style="font-size:0.8rem; color:var(--ink-faint); margin-left:8px;">${new Date(r.created_at).toLocaleDateString()}</span>
                    </div>
                    <span style="color:var(--gold); font-size:1.1rem;">${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</span>
                </div>
                ${r.comment ? `<p style="font-size:0.88rem; color:var(--ink-soft); margin:8px 0;">${escapeHtml(r.comment)}</p>` : ""}
                ${r.rep_response
                    ? `<div style="background:var(--gold-tint); padding:10px 12px; border-radius:var(--radius-sm); margin-top:8px; font-size:0.85rem;"><strong>Your response:</strong> ${escapeHtml(r.rep_response)}</div>`
                    : `<div style="margin-top:8px;">
                        <div style="display:flex; gap:6px;">
                            <input type="text" id="reviewResp_${r.id}" placeholder="Write a response..." style="flex:1; padding:8px 12px; border:1px solid var(--line); border-radius:var(--radius-sm); font-size:0.85rem;">
                            <button class="btn btn-primary btn-small" onclick="respondToReview('${r.id}', '${propertyId}')">Reply</button>
                        </div>
                    </div>`}
            </div>
        `).join("");
    } catch (err) {
        content.innerHTML = `<div class="empty-state" style="padding:20px; color:var(--bad);">Failed to load reviews: ${escapeHtml(err.message)}</div>`;
    }
}

async function respondToReview(reviewId, propertyId) {
    const input = document.getElementById(`reviewResp_${reviewId}`);
    if (!input || !input.value.trim()) return;
    try {
        await API.post(`/api/reviews/${reviewId}/respond`, { response: input.value.trim() });
        await viewPropertyReviews(propertyId);
    } catch (err) {
        alert(err.message);
    }
}

// ── Bookings ────────────────────────────────────────────────────────────
async function renderRepBookings(bookings) {
    const container = document.getElementById("repBookingsList");
    if (!container) return;
    if (!bookings || bookings.length === 0) {
        container.innerHTML = `<div class="empty-state">No bookings yet.</div>`;
        return;
    }
    container.innerHTML = bookings.map(b => `
        <div class="card" style="margin-bottom:10px; padding:14px;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
                <div>
                    <strong>${escapeHtml(b.customer_name || "Guest")}</strong>
                    <div style="font-size:0.85rem; color:var(--ink-soft);">
                        ${escapeHtml(b.property_name)} · ${escapeHtml(b.room_type)} · ${b.check_in} → ${b.check_out}
                    </div>
                    <div style="font-size:0.8rem; color:var(--ink-faint);">
                        Guests: ${b.num_adults || 0}A ${b.num_children || 0}C · ₹${b.total_price || "—"}
                    </div>
                </div>
                <span class="badge badge-${b.status}">${b.status}</span>
            </div>
        </div>
    `).join("");
}

// ── Location autocomplete helper ────────────────────────────────────────
function setupLocationAutocomplete(inputId, dropdownId, hiddenId) {
    const input = document.getElementById(inputId);
    const dropdown = document.getElementById(dropdownId);
    const hidden = document.getElementById(hiddenId);
    if (!input || !dropdown || !hidden) return;
    let timer = null;

    input.addEventListener("input", () => {
        hidden.value = "";
        clearTimeout(timer);
        const q = input.value.trim();
        if (q.length < 2) { dropdown.classList.remove("open"); return; }
        timer = setTimeout(async () => {
            try {
                const results = await API.get(`/api/hotels/locations/search?q=${encodeURIComponent(q)}`);
                if (!results.length) { dropdown.classList.remove("open"); return; }
                dropdown.innerHTML = results.map(r =>
                    `<div class="autocomplete-item" data-id="${r.id}" data-name="${escapeHtml(r.name)}">
                        <span>${escapeHtml(r.name)}</span>
                        <span class="location-type">${escapeHtml(r.type)}</span>
                    </div>`
                ).join("");
                dropdown.classList.add("open");
                dropdown.querySelectorAll(".autocomplete-item").forEach(item => {
                    item.addEventListener("click", () => {
                        input.value = item.dataset.name;
                        hidden.value = item.dataset.id;
                        dropdown.classList.remove("open");
                    });
                });
            } catch { dropdown.classList.remove("open"); }
        }, 300);
    });

    input.addEventListener("blur", () => {
        setTimeout(() => dropdown.classList.remove("open"), 200);
    });
}

// ── Close any rep modal ─────────────────────────────────────────────────
function closeRepModal() {
    const existing = document.getElementById("repModalOverlay");
    if (existing) existing.remove();
}
