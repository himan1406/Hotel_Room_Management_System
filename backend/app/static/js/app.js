// ==================== API Layer ====================
const API = {
    _refreshing: null,   // deduplicate concurrent refresh calls

    async request(method, path, body, _isRetry = false) {
        const opts = {
            method,
            headers: { "Content-Type": "application/json" },
            credentials: "include",
        };
        if (body && method !== "GET") {
            opts.body = JSON.stringify(body);
        }
        const res = await fetch(path, opts);

        // Auto-refresh on 401 — but NEVER for auth endpoints (they handle their own 401s)
        if (res.status === 401 && !_isRetry && !path.startsWith("/api/auth/")) {
            const refreshed = await API._tryRefresh();
            if (refreshed) {
                // Retry the original request once with the new access token
                return API.request(method, path, body, true);
            } else {
                // Only force-redirect if we're on a protected page (not login/signup)
                const authPages = ["/login", "/signup", "/hotel-register"];
                const onAuthPage = authPages.some(p => window.location.pathname.startsWith(p));
                if (!onAuthPage) {
                    window.location.href = "/login";
                }
                throw new Error("Session expired. Please log in again.");
            }
        }

        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Request failed");
        return data;
    },

    async _tryRefresh() {
        // Deduplicate: if a refresh is already in-flight, wait for it
        if (API._refreshing) return API._refreshing;
        API._refreshing = (async () => {
            try {
                const res = await fetch("/api/auth/refresh", {
                    method: "POST",
                    credentials: "include",
                });
                return res.ok;
            } catch {
                return false;
            } finally {
                API._refreshing = null;
            }
        })();
        return API._refreshing;
    },

    get(path) { return this.request("GET", path); },
    post(path, body) { return this.request("POST", path, body); },
    put(path, body) { return this.request("PUT", path, body); },
    del(path) { return this.request("DELETE", path); },

    async uploadFile(path, file) {
        const form = new FormData();
        form.append("file", file);
        const res = await fetch(path, {
            method: "POST",
            credentials: "include",
            body: form,
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.detail || "Upload failed");
        return data;
    },
};

// ==================== Auth ====================
async function checkAuth() {
    try {
        const user = await API.get("/api/auth/me");
        updateNav(user);
        return user;
    } catch {
        updateNav(null);
        return null;
    }
}

function updateNav(user) {
    const loginLink = document.getElementById("navLogin");
    const signupLink = document.getElementById("navSignup");
    const dashLink = document.getElementById("navDashboard");
    const adminLink = document.getElementById("navAdmin");
    const logoutLink = document.getElementById("navLogout");
    const navUser = document.getElementById("navUser");

    if (user) {
        loginLink.style.display = "none";
        signupLink.style.display = "none";
        dashLink.style.display = "inline";
        logoutLink.style.display = "inline";
        navUser.style.display = "inline";
        navUser.textContent = `Hi, ${user.full_name || user.email}`;
        if (user.role === "admin") {
            adminLink.style.display = "inline";
        } else {
            adminLink.style.display = "none";
        }
    } else {
        loginLink.style.display = "inline";
        signupLink.style.display = "inline";
        dashLink.style.display = "none";
        adminLink.style.display = "none";
        logoutLink.style.display = "none";
        navUser.style.display = "none";
    }
}

async function logout() {
    await API.post("/api/auth/logout");
    window.location.href = "/";
}

// ==================== Login ====================
document.addEventListener("DOMContentLoaded", () => {
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

    // Nav update
    checkAuth();
});

// ==================== Dashboard ====================
async function initDashboard() {
    const user = await checkAuth();
    if (!user) {
        window.location.href = "/login";
        return;
    }

    const view = document.getElementById("dashboardView");

    if (user.role === "customer") {
        view.innerHTML = `<div class="card"><h3>Welcome, ${user.full_name || user.email}!</h3><p>Customer dashboard coming soon. You'll be able to search and book hotels here.</p></div>`;
        return;
    }

    if (user.role === "admin") {
        view.innerHTML = `<div class="card"><p>Go to the <a href="/admin">Admin Panel</a> to manage registrations.</p></div>`;
        return;
    }

    // Hotel Rep Dashboard
    renderHotelRepDashboard(view, user);
}

async function renderHotelRepDashboard(container, user) {
    const [properties, locations] = await Promise.all([
        API.get("/api/hotels"),
        API.get("/api/hotels/locations"),
    ]);

    let html = `
        <div class="section-header">
            <h3>My Properties</h3>
            <button class="btn btn-primary btn-small" onclick="showAddPropertyModal()">+ Add Property</button>
        </div>
    `;

    if (properties.length === 0) {
        html += `<div class="empty-state">No properties yet. Click "Add Property" to get started.</div>`;
    } else {
        html += `<div class="property-list">`;
        for (const p of properties) {
            html += `
                <div class="property-card">
                    <h4>${escapeHtml(p.name)}</h4>
                    <div class="prop-type">${p.property_type || "N/A"} ${p.is_approved ? '<span class="badge badge-approved">Approved</span>' : '<span class="badge badge-pending">Pending</span>'}</div>
                    <p>${escapeHtml(p.description || "")}</p>
                    ${p.amenities && Object.keys(p.amenities).length > 0 ? `
                        <div class="property-amenity-tags" style="margin-bottom: 15px; display: flex; flex-wrap: wrap; gap: 5px;">
                            ${Object.keys(p.amenities).filter(k => p.amenities[k]).map(k => `<span class="badge badge-pending" style="background:#e8f5e9; color:#1b5e20; text-transform: capitalize;">${k.replace('_', ' ')}</span>`).join('')}
                        </div>
                    ` : ''}
                    <div class="prop-actions">
                        <button class="btn btn-secondary btn-small" onclick="viewProperty('${p.id}')">Manage Rooms</button>
                        <button class="btn btn-outline btn-small" onclick="editProperty('${p.id}')">Edit</button>
                    </div>
                </div>
            `;
        }
        html += `</div>`;
    }

    html += `<div id="propertyDetail"></div>`;
    container.innerHTML = html;
}

function showAddPropertyModal() {
    const modal = document.createElement("div");
    modal.className = "modal-overlay";
    modal.innerHTML = `
        <div class="modal">
            <button class="close-modal" onclick="this.closest('.modal-overlay').remove()">&times;</button>
            <h3>Add Property</h3>
            <form id="addPropertyForm">
                <div class="form-group">
                    <label>Property Name</label>
                    <input type="text" id="propName" required>
                </div>
                <div class="form-group">
                    <label>Description</label>
                    <textarea id="propDesc" rows="3"></textarea>
                </div>
                <div class="form-group">
                    <label>Type</label>
                    <select id="propType">
                        <option value="hotel">Hotel</option>
                        <option value="villa">Villa</option>
                        <option value="homestay">Homestay</option>
                        <option value="resort">Resort</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Address</label>
                    <textarea id="propAddress" rows="2"></textarea>
                </div>
                <div class="form-group">
                    <label>Amenities</label>
                    <div class="amenities-grid">
                        <label class="amenity-checkbox-label"><input type="checkbox" name="propAmenity" value="wifi"> WiFi</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="propAmenity" value="parking"> Parking</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="propAmenity" value="pool"> Swimming Pool</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="propAmenity" value="gym"> Gym / Fitness</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="propAmenity" value="ac"> Air Conditioning</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="propAmenity" value="bar"> Bar / Lounge</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="propAmenity" value="restaurant"> Restaurant</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="propAmenity" value="spa"> Spa / Wellness</label>
                    </div>
                </div>
                <button type="submit" class="btn btn-primary btn-full">Create Property</button>
            </form>
        </div>
    `;
    document.body.appendChild(modal);

    document.getElementById("addPropertyForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
            const checkedBoxes = document.querySelectorAll("input[name='propAmenity']:checked");
            const amenities = {};
            checkedBoxes.forEach(cb => {
                amenities[cb.value] = true;
            });
            await API.post("/api/hotels", {
                name: document.getElementById("propName").value,
                description: document.getElementById("propDesc").value,
                property_type: document.getElementById("propType").value,
                address: document.getElementById("propAddress").value,
                amenities: amenities,
            });
            modal.remove();
            initDashboard();
        } catch (err) {
            alert(err.message);
        }
    });
}

async function viewProperty(propertyId) {
    const user = await checkAuth();
    const [prop, rooms] = await Promise.all([
        API.get(`/api/hotels/${propertyId}`),
        API.get(`/api/hotels/${propertyId}/rooms`),
    ]);

    const detailDiv = document.getElementById("propertyDetail");
    let html = `
        <div class="section-header" style="margin-top:30px">
            <h3>${escapeHtml(prop.name)} — Rooms</h3>
            <button class="btn btn-primary btn-small" onclick="showAddRoomModal('${propertyId}')">+ Add Room</button>
            <button class="btn btn-outline btn-small" onclick="document.getElementById('propertyDetail').innerHTML=''">Close</button>
        </div>
    `;

    if (rooms.length === 0) {
        html += `<div class="empty-state">No rooms yet. Click "Add Room" to add one.</div>`;
    } else {
        for (const r of rooms) {
            html += `
                <div class="room-item">
                    <h5>${escapeHtml(r.room_type)}</h5>
                    <div class="room-details">
                        <span>₹${r.base_price}/night</span>
                        <span>Adults: ${r.capacity_adults}</span>
                        <span>Children: ${r.capacity_children}</span>
                        <span>Qty: ${r.total_quantity}</span>
                    </div>
                    ${r.room_amenities && Object.keys(r.room_amenities).length > 0 ? `
                        <div class="room-amenity-tags" style="margin-bottom: 15px; display: flex; flex-wrap: wrap; gap: 5px;">
                            ${Object.keys(r.room_amenities).filter(k => r.room_amenities[k]).map(k => `<span class="badge badge-pending" style="background:#e3f2fd; color:#0d47a1; text-transform: capitalize;">${k.replace('_', ' ')}</span>`).join('')}
                        </div>
                    ` : ''}
                    <button class="btn btn-danger btn-small" onclick="deleteRoom('${propertyId}', '${r.id}')">Delete</button>
                </div>
            `;
        }
    }
    detailDiv.innerHTML = html;
}

function showAddRoomModal(propertyId) {
    const modal = document.createElement("div");
    modal.className = "modal-overlay";
    modal.innerHTML = `
        <div class="modal">
            <button class="close-modal" onclick="this.closest('.modal-overlay').remove()">&times;</button>
            <h3>Add Room</h3>
            <form id="addRoomForm">
                <div class="form-group">
                    <label>Room Type</label>
                    <input type="text" id="roomType" required placeholder="e.g. Deluxe Room">
                </div>
                <div class="form-group">
                    <label>Base Price (₹ per night)</label>
                    <input type="number" id="roomPrice" required min="1">
                </div>
                <div class="form-group">
                    <label>Capacity (Adults)</label>
                    <input type="number" id="roomAdults" value="2" min="1">
                </div>
                <div class="form-group">
                    <label>Capacity (Children)</label>
                    <input type="number" id="roomChildren" value="0" min="0">
                </div>
                <div class="form-group">
                    <label>Total Quantity</label>
                    <input type="number" id="roomQty" required min="1">
                </div>
                <div class="form-group">
                    <label>Room Amenities</label>
                    <div class="amenities-grid">
                        <label class="amenity-checkbox-label"><input type="checkbox" name="roomAmenity" value="wifi"> WiFi</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="roomAmenity" value="ac"> Air Conditioning</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="roomAmenity" value="tv"> Smart TV</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="roomAmenity" value="minibar"> Minibar</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="roomAmenity" value="balcony"> Balcony / View</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="roomAmenity" value="bathtub"> Bathtub</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="roomAmenity" value="room_service"> Room Service</label>
                        <label class="amenity-checkbox-label"><input type="checkbox" name="roomAmenity" value="safe"> In-room Safe</label>
                    </div>
                </div>
                <button type="submit" class="btn btn-primary btn-full">Add Room</button>
            </form>
        </div>
    `;
    document.body.appendChild(modal);

    document.getElementById("addRoomForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
            const checkedBoxes = document.querySelectorAll("input[name='roomAmenity']:checked");
            const amenities = {};
            checkedBoxes.forEach(cb => {
                amenities[cb.value] = true;
            });
            await API.post(`/api/hotels/${propertyId}/rooms`, {
                room_type: document.getElementById("roomType").value,
                base_price: parseFloat(document.getElementById("roomPrice").value),
                capacity_adults: parseInt(document.getElementById("roomAdults").value),
                capacity_children: parseInt(document.getElementById("roomChildren").value),
                total_quantity: parseInt(document.getElementById("roomQty").value),
                room_amenities: amenities,
            });
            modal.remove();
            viewProperty(propertyId);
        } catch (err) {
            alert(err.message);
        }
    });
}

async function editProperty(propertyId) {
    const prop = await API.get(`/api/hotels/${propertyId}`);
    const modal = document.createElement("div");
    modal.className = "modal-overlay";
    modal.innerHTML = `
        <div class="modal">
            <button class="close-modal" onclick="this.closest('.modal-overlay').remove()">&times;</button>
            <h3>Edit Property</h3>
            <form id="editPropertyForm">
                <div class="form-group">
                    <label>Property Name</label>
                    <input type="text" id="propName" value="${escapeHtml(prop.name)}" required>
                </div>
                <div class="form-group">
                    <label>Description</label>
                    <textarea id="propDesc" rows="3">${escapeHtml(prop.description || "")}</textarea>
                </div>
                <div class="form-group">
                    <label>Type</label>
                    <select id="propType">
                        <option value="hotel" ${prop.property_type === "hotel" ? "selected" : ""}>Hotel</option>
                        <option value="villa" ${prop.property_type === "villa" ? "selected" : ""}>Villa</option>
                        <option value="homestay" ${prop.property_type === "homestay" ? "selected" : ""}>Homestay</option>
                        <option value="resort" ${prop.property_type === "resort" ? "selected" : ""}>Resort</option>
                    </select>
                </div>
                <div class="form-group">
                    <label>Address</label>
                    <textarea id="propAddress" rows="2">${escapeHtml(prop.address || "")}</textarea>
                </div>
                <button type="submit" class="btn btn-primary btn-full">Save Changes</button>
            </form>
        </div>
    `;
    document.body.appendChild(modal);

    document.getElementById("editPropertyForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
            await API.put(`/api/hotels/${propertyId}`, {
                name: document.getElementById("propName").value,
                description: document.getElementById("propDesc").value,
                property_type: document.getElementById("propType").value,
                address: document.getElementById("propAddress").value,
            });
            modal.remove();
            initDashboard();
        } catch (err) {
            alert(err.message);
        }
    });
}

async function deleteRoom(propertyId, roomId) {
    if (!confirm("Delete this room?")) return;
    await API.del(`/api/hotels/${propertyId}/rooms/${roomId}`);
    viewProperty(propertyId);
}

// ==================== Admin ====================
async function initAdmin() {
    const user = await checkAuth();
    if (!user || user.role !== "admin") {
        window.location.href = "/login";
        return;
    }

    // Tab switching
    document.querySelectorAll(".tab-btn").forEach(btn => {
        btn.addEventListener("click", () => {
            document.querySelectorAll(".tab-btn").forEach(b => b.classList.remove("active"));
            btn.classList.add("active");
            if (btn.dataset.tab === "pending") renderPendingTab();
            else if (btn.dataset.tab === "reps") renderRepsTab();
        });
    });

    renderPendingTab();
}

async function renderPendingTab() {
    const container = document.getElementById("adminTabContent");
    const data = await API.get("/api/admin/pending-hotels/all");
    const pendings = data.filter(p => p.status === "pending");
    const history = data.filter(p => p.status !== "pending");

    let html = `<h3>Pending Registrations (${pendings.length})</h3>`;

    if (pendings.length === 0) {
        html += `<div class="empty-state">No pending registrations.</div>`;
    } else {
        html += `<div class="table-container"><table>
            <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Date</th><th>Actions</th></tr></thead>
            <tbody>
        `;
        for (const p of pendings) {
            html += `<tr>
                <td>${escapeHtml(p.full_name || "—")}</td>
                <td>${escapeHtml(p.email)}</td>
                <td>${escapeHtml(p.phone || "—")}</td>
                <td>${new Date(p.created_at).toLocaleDateString()}</td>
                <td>
                    <button class="btn btn-success btn-small" onclick="approveHotel('${p.id}')">Approve</button>
                    <button class="btn btn-danger btn-small" onclick="rejectHotel('${p.id}')">Reject</button>
                </td>
            </tr>`;
        }
        html += `</tbody></table></div>`;
    }

    if (history.length > 0) {
        html += `<h3 style="margin-top:30px">History</h3>
        <div class="table-container"><table>
            <thead><tr><th>Name</th><th>Email</th><th>Status</th><th>Date</th></tr></thead>
            <tbody>
        `;
        for (const p of history) {
            html += `<tr>
                <td>${escapeHtml(p.full_name || "—")}</td>
                <td>${escapeHtml(p.email)}</td>
                <td><span class="badge badge-${p.status}">${p.status}</span></td>
                <td>${new Date(p.created_at).toLocaleDateString()}</td>
            </tr>`;
        }
        html += `</tbody></table></div>`;
    }

    container.innerHTML = html;
}

async function renderRepsTab() {
    const container = document.getElementById("adminTabContent");
    const reps = await API.get("/api/admin/hotel-reps");

    let html = `<h3>Hotel Representatives</h3>`;
    if (reps.length === 0) {
        html += `<div class="empty-state">No hotel reps yet.</div>`;
    } else {
        html += `<div class="table-container"><table>
            <thead><tr><th>Name</th><th>Email</th><th>Phone</th><th>Status</th><th>Actions</th></tr></thead>
            <tbody>
        `;
        for (const r of reps) {
            html += `<tr>
                <td>${escapeHtml(r.full_name || "—")}</td>
                <td>${escapeHtml(r.email)}</td>
                <td>${escapeHtml(r.phone || "—")}</td>
                <td><span class="badge badge-${r.is_active ? "approved" : "rejected"}">${r.is_active ? "Active" : "Inactive"}</span></td>
                <td><button class="btn btn-${r.is_active ? "danger" : "success"} btn-small" onclick="toggleRep('${r.id}')">${r.is_active ? "Deactivate" : "Activate"}</button></td>
            </tr>`;
        }
        html += `</tbody></table></div>`;
    }
    container.innerHTML = html;
}

async function approveHotel(id) {
    await API.post("/api/admin/approve-hotel", { id });
    renderPendingTab();
}

async function rejectHotel(id) {
    await API.post("/api/admin/reject-hotel", { id });
    renderPendingTab();
}

async function toggleRep(id) {
    await API.post(`/api/admin/toggle-rep/${id}`);
    await checkAuth();
    renderRepsTab();
}

// ==================== Utils ====================
function escapeHtml(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}

// ==================== Init ====================
checkAuth();
