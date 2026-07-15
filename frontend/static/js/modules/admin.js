// ==================== Admin Panel ====================
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
            else if (btn.dataset.tab === "properties") renderPropertiesTab();
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

async function renderPropertiesTab(statusFilter, searchQuery) {
    const container = document.getElementById("adminTabContent");
    container.innerHTML = `<div class="empty-state">Loading properties...</div>`;

    const activeStatus = statusFilter || "all";
    const activeQuery = searchQuery || "";

    try {
        let url = `/api/admin/properties?status=${activeStatus}`;
        if (activeQuery) url += `&q=${encodeURIComponent(activeQuery)}`;
        const props = await API.get(url);

        let html = `<h3>All Properties (${props.length})</h3>`;

        html += `
        <div class="admin-properties-toolbar" style="display:flex; gap:10px; align-items:center; flex-wrap:wrap; margin-bottom:20px; padding:14px 16px; background:var(--surface); border:1px solid var(--line); border-radius:var(--radius-md);">
            <div class="form-group autocomplete-wrapper" style="flex:1; min-width:200px; margin:0;" id="adminPropSearchWrapper">
                <input type="text" id="adminPropSearch" placeholder="Search by name, address or location…"
                    value="${escapeHtml(activeQuery)}" autocomplete="off"
                    style="width:100%; height:38px; padding:0 12px; border:1px solid var(--line); border-radius:var(--radius-sm); font-family:inherit; font-size:0.85rem; box-sizing:border-box;">
                <div id="adminPropSearchDropdown" class="autocomplete-dropdown"></div>
            </div>
            <div class="form-group" style="min-width:140px; margin:0;">
                <select id="adminPropStatusFilter"
                    style="width:100%; height:38px; padding:0 12px; border:1px solid var(--line); border-radius:var(--radius-sm); font-family:inherit; font-size:0.85rem; box-sizing:border-box; background:var(--surface);">
                    <option value="all" ${activeStatus === "all" ? "selected" : ""}>All statuses</option>
                    <option value="pending" ${activeStatus === "pending" ? "selected" : ""}>Pending</option>
                    <option value="approved" ${activeStatus === "approved" ? "selected" : ""}>Approved</option>
                </select>
            </div>
            <button class="btn btn-primary btn-small" onclick="adminPropSearch()" style="height:38px; margin:0; white-space:nowrap;">Search</button>
            <button class="btn btn-outline btn-small" onclick="adminPropResetSearch()" style="height:38px; margin:0; white-space:nowrap;">Reset</button>
        </div>`;

        if (props.length === 0) {
            html += `<div class="empty-state">No properties match your filters.</div>`;
        } else {
            html += `<div class="table-container"><table>
                <thead><tr><th>Name</th><th>Owner</th><th>City</th><th>Status</th><th>Actions</th></tr></thead>
                <tbody>
            `;
            for (const p of props) {
                html += `<tr>
                    <td>${escapeHtml(p.name)}</td>
                    <td>${escapeHtml(p.owner_name || "—")}</td>
                    <td>${escapeHtml(p.city || "—")}</td>
                    <td><span class="badge badge-${p.is_approved ? "approved" : "pending"}">${p.is_approved ? "Approved" : "Pending"}</span></td>
                    <td>
                        ${!p.is_approved ? `<button class="btn btn-success btn-small" onclick="approveProperty('${p.id}')">Approve</button>` : ""}
                        ${p.is_approved ? `<button class="btn btn-danger btn-small" onclick="rejectProperty('${p.id}')">Deactivate</button>` : ""}
                    </td>
                </tr>`;
            }
            html += `</tbody></table></div>`;
        }
        container.innerHTML = html;
        initAdminPropAutocomplete();
    } catch (err) {
        container.innerHTML = `<div class="empty-state" style="color:var(--bad)">Failed to load properties.</div>`;
    }
}

function initAdminPropAutocomplete() {
    const input = document.getElementById("adminPropSearch");
    const dropdown = document.getElementById("adminPropSearchDropdown");
    if (!input || !dropdown) return;
    let debounceTimer;

    async function fetchAndRender(q) {
        try {
            const locations = await API.get(`/api/hotels/locations/search?q=${encodeURIComponent(q)}`);
            dropdown.innerHTML = "";
            if (locations.length === 0) {
                dropdown.innerHTML = `<div class="autocomplete-empty">No locations found</div>`;
                dropdown.classList.add("open");
                return;
            }
            locations.forEach(loc => {
                const item = document.createElement("div");
                item.className = "autocomplete-item";
                const typeLabel = loc.type === "property" ? "property" : loc.type;
                item.innerHTML = `${escapeHtml(loc.name)}<span class="location-type">${escapeHtml(typeLabel)}</span>`;
                item.addEventListener("click", () => {
                    input.value = loc.name;
                    dropdown.classList.remove("open");
                    adminPropSearch();
                });
                dropdown.appendChild(item);
            });
            dropdown.classList.add("open");
        } catch {
            dropdown.classList.remove("open");
        }
    }

    input.addEventListener("input", () => {
        clearTimeout(debounceTimer);
        const val = input.value.trim();
        if (val.length < 1) { dropdown.classList.remove("open"); return; }
        debounceTimer = setTimeout(() => fetchAndRender(val), 250);
    });

    input.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            dropdown.classList.remove("open");
            adminPropSearch();
        }
    });

    document.addEventListener("click", (e) => {
        if (!e.target.closest("#adminPropSearchWrapper")) {
            dropdown.classList.remove("open");
        }
    });
}

function adminPropSearch() {
    const q = document.getElementById("adminPropSearch")?.value.trim() || "";
    const status = document.getElementById("adminPropStatusFilter")?.value || "all";
    renderPropertiesTab(status, q);
}

function adminPropResetSearch() {
    document.getElementById("adminPropSearch").value = "";
    document.getElementById("adminPropStatusFilter").value = "all";
    renderPropertiesTab("all", "");
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
    await API.post("/api/admin/toggle-rep", { id });
    renderRepsTab();
}

async function approveProperty(id) {
    await API.post(`/api/admin/properties/${id}/approve`);
    renderPropertiesTab(document.getElementById("adminPropStatusFilter")?.value || "all",
                        document.getElementById("adminPropSearch")?.value.trim() || "");
}

async function rejectProperty(id) {
    await API.post(`/api/admin/properties/${id}/reject`);
    renderPropertiesTab(document.getElementById("adminPropStatusFilter")?.value || "all",
                        document.getElementById("adminPropSearch")?.value.trim() || "");
}
