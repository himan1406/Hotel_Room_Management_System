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

async function renderPropertiesTab() {
    const container = document.getElementById("adminTabContent");
    container.innerHTML = `<div class="empty-state">Loading properties...</div>`;
    try {
        const props = await API.get("/api/admin/all-properties");
        let html = `<h3>All Properties (${props.length})</h3>`;
        if (props.length === 0) {
            html += `<div class="empty-state">No properties registered yet.</div>`;
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
                    <td><span class="badge badge-${p.is_active ? "approved" : "pending"}">${p.is_active ? "Active" : "Inactive"}</span></td>
                    <td>
                        ${!p.is_active ? `<button class="btn btn-success btn-small" onclick="activateProperty('${p.id}')">Activate</button>` : ""}
                        <button class="btn btn-danger btn-small" onclick="deactivateProperty('${p.id}')">Deactivate</button>
                    </td>
                </tr>`;
            }
            html += `</tbody></table></div>`;
        }
        container.innerHTML = html;
    } catch (err) {
        container.innerHTML = `<div class="empty-state" style="color:var(--bad)">Failed to load properties.</div>`;
    }
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

async function activateProperty(id) {
    await API.post(`/api/admin/properties/${id}/activate`);
    renderPropertiesTab();
}

async function deactivateProperty(id) {
    await API.post(`/api/admin/properties/${id}/deactivate`);
    renderPropertiesTab();
}
