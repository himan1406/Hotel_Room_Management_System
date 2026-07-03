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

// ==================== Nav (mobile toggle) ====================
function initNavToggle() {
    const toggle = document.getElementById("navToggle");
    const links = document.getElementById("navLinks");
    if (!toggle || !links) return;

    toggle.addEventListener("click", () => {
        const isOpen = links.classList.toggle("open");
        toggle.setAttribute("aria-expanded", isOpen ? "true" : "false");
    });

    // Close the mobile menu after picking a link
    links.querySelectorAll("a").forEach(a => {
        a.addEventListener("click", () => {
            links.classList.remove("open");
            toggle.setAttribute("aria-expanded", "false");
        });
    });
}

// ==================== Login ====================
document.addEventListener("DOMContentLoaded", () => {
    initNavToggle();

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
    const eyebrow = document.getElementById("dashboardEyebrow");
    const heading = document.getElementById("dashboardHeading");

    if (user.role === "customer") {
        if (eyebrow) eyebrow.textContent = "Traveler Dashboard";
        if (heading) heading.textContent = "Find your next stay";
        renderCustomerDashboard(view, user);
        return;
    }

    if (user.role === "admin") {
        if (eyebrow) eyebrow.textContent = "Platform Admin";
        if (heading) heading.textContent = "Dashboard";
        view.innerHTML = `<div class="card"><p>Go to the <a href="/admin">Admin Panel</a> to manage registrations.</p></div>`;
        return;
    }

    // Hotel Rep Dashboard
    if (eyebrow) eyebrow.textContent = "Hotel Rep Dashboard";
    if (heading) heading.textContent = "Your Properties";
    renderHotelRepDashboard(view, user);
}

// ==================== Customer Dashboard: search + book + history ====================
let lastSearchResults = [];

async function renderCustomerDashboard(container, user) {
    container.innerHTML = `
        <div class="card search-panel">
            <p class="eyebrow" style="margin-bottom:10px">Search stays</p>
            <form id="searchForm" class="search-form">
                <div class="form-group search-location autocomplete-wrapper">
                    <label for="searchLocation">Where to?</label>
                    <input type="text" id="searchLocation" placeholder="City, region or hotel name" autocomplete="off">
                    <div id="searchLocationDropdown" class="autocomplete-dropdown"></div>
                </div>
                <div class="form-group">
                    <label for="searchCheckIn">Check-in</label>
                    <input type="date" id="searchCheckIn" required>
                </div>
                <div class="form-group">
                    <label for="searchCheckOut">Check-out</label>
                    <input type="date" id="searchCheckOut" required>
                </div>
                <div class="form-group">
                    <label for="searchAdults">Adults</label>
                    <input type="number" id="searchAdults" min="1" value="2">
                </div>
                <div class="form-group">
                    <label for="searchChildren">Children</label>
                    <input type="number" id="searchChildren" min="0" value="0">
                </div>
                <button type="submit" class="btn btn-primary">Search</button>
            </form>
            <div id="searchError" class="error-msg"></div>
        </div>

        <div id="searchResults"></div>

        <div class="section-header" style="margin-top:44px">
            <h3>My Bookings</h3>
        </div>
        <div id="myBookings"><div class="empty-state">Loading your bookings…</div></div>
    `;

    // Sensible defaults so the form is bookable with zero typing
    const in1 = new Date(); in1.setDate(in1.getDate() + 1);
    const in2 = new Date(); in2.setDate(in2.getDate() + 2);
    const todayStr = new Date().toISOString().slice(0, 10);
    const in1Str = in1.toISOString().slice(0, 10);
    const in2Str = in2.toISOString().slice(0, 10);

    const checkInEl = document.getElementById("searchCheckIn");
    const checkOutEl = document.getElementById("searchCheckOut");
    checkInEl.value = in1Str;
    checkOutEl.value = in2Str;
    checkInEl.min = todayStr;
    checkOutEl.min = in1Str;

    // Keep check-out after check-in as the person edits check-in
    checkInEl.addEventListener("change", () => {
        checkOutEl.min = checkInEl.value;
        if (checkOutEl.value <= checkInEl.value) {
            const next = new Date(checkInEl.value);
            next.setDate(next.getDate() + 1);
            checkOutEl.value = next.toISOString().slice(0, 10);
        }
    });

    document.getElementById("searchForm").addEventListener("submit", (e) => {
        e.preventDefault();
        runPropertySearch();
    });

    initSearchAutocomplete();
    loadMyBookings();
}

function initSearchAutocomplete() {
    const input = document.getElementById("searchLocation");
    const dropdown = document.getElementById("searchLocationDropdown");
    if (!input || !dropdown) return;
    let debounceTimer, selectedIndex = -1, selectedLocation = null;

    async function fetchAndRender(q) {
        try {
            const locations = await API.get(`/api/hotels/locations/search?q=${encodeURIComponent(q)}`);
            dropdown.innerHTML = "";
            if (locations.length === 0) {
                dropdown.innerHTML = `<div class="autocomplete-empty">No locations found</div>`;
                dropdown.classList.add("open");
                return;
            }
            locations.forEach((loc, i) => {
                const item = document.createElement("div");
                item.className = "autocomplete-item";
                const typeLabel = loc.type === "property" ? "property" : loc.type;
                item.innerHTML = `${escapeHtml(loc.name)}<span class="location-type">${escapeHtml(typeLabel)}</span>`;
                item.addEventListener("click", () => {
                    selectedLocation = loc;
                    input.value = loc.name;
                    dropdown.classList.remove("open");
                    input.focus();
                });
                item.addEventListener("mouseenter", () => {
                    document.querySelectorAll(".autocomplete-item").forEach((el, j) => el.classList.toggle("highlighted", j === i));
                    selectedIndex = i;
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
        selectedLocation = null;
        const val = input.value.trim();
        if (val.length < 1) { dropdown.classList.remove("open"); return; }
        debounceTimer = setTimeout(() => fetchAndRender(val), 250);
    });

    input.addEventListener("focus", () => {
        const val = input.value.trim();
        if (val.length >= 1 && !selectedLocation) fetchAndRender(val);
    });

    input.addEventListener("keydown", (e) => {
        const items = dropdown.querySelectorAll(".autocomplete-item");
        if (e.key === "ArrowDown") { e.preventDefault(); selectedIndex = Math.min(selectedIndex + 1, items.length - 1); items.forEach((el, i) => el.classList.toggle("highlighted", i === selectedIndex)); }
        else if (e.key === "ArrowUp") { e.preventDefault(); selectedIndex = Math.max(selectedIndex - 1, -1); items.forEach((el, i) => el.classList.toggle("highlighted", i === selectedIndex)); }
        else if (e.key === "Enter" && selectedIndex >= 0) { e.preventDefault(); items[selectedIndex]?.click(); }
        else if (e.key === "Escape") { dropdown.classList.remove("open"); selectedIndex = -1; input.blur(); }
    });

    document.addEventListener("click", (e) => {
        if (!input.closest(".autocomplete-wrapper")?.contains(e.target)) {
            dropdown.classList.remove("open");
        }
    });
}

async function runPropertySearch() {
    const resultsDiv = document.getElementById("searchResults");
    const errDiv = document.getElementById("searchError");
    errDiv.style.display = "none";

    const params = new URLSearchParams({
        check_in: document.getElementById("searchCheckIn").value,
        check_out: document.getElementById("searchCheckOut").value,
        adults: document.getElementById("searchAdults").value || "1",
        children: document.getElementById("searchChildren").value || "0",
    });
    const location = document.getElementById("searchLocation").value.trim();
    if (location) params.set("location", location);

    resultsDiv.innerHTML = `<div class="empty-state">Searching…</div>`;
    try {
        const properties = await API.get(`/api/properties/search?${params.toString()}`);
        lastSearchResults = properties;
        renderSearchResults(properties);
    } catch (err) {
        errDiv.style.display = "block";
        errDiv.textContent = err.message;
        resultsDiv.innerHTML = "";
    }
}

function renderSearchResults(properties) {
    const resultsDiv = document.getElementById("searchResults");
    if (properties.length === 0) {
        resultsDiv.innerHTML = `<div class="empty-state">No stays match those dates yet. Try a different location or date range.</div>`;
        return;
    }

    resultsDiv.innerHTML = `<div class="property-list">` + properties.map(p => `
        <div class="property-card">
            <h4>${escapeHtml(p.name)}</h4>
            <div class="prop-type">${escapeHtml([p.city, p.district].filter(Boolean).join(", ") || "Location N/A")}${p.property_type ? " · " + escapeHtml(p.property_type) : ""}</div>
            ${p.description ? `<p>${escapeHtml(p.description.slice(0, 110))}${p.description.length > 110 ? "…" : ""}</p>` : ""}
            <p style="font-family:'Space Mono',monospace; font-size:0.78rem; color:var(--ink-soft); margin:10px 0 14px;">From ₹${p.from_price} total &middot; ${p.review_count} review${p.review_count === 1 ? "" : "s"}</p>
            <div class="room-pick-list">
                ${p.rooms.map(r => `
                    <div class="room-item">
                        <h5>${escapeHtml(r.room_type)}</h5>
                        <div class="room-details">
                            <span>₹${r.base_price}/night</span>
                            <span>Adults: ${r.capacity_adults}</span>
                            <span>Children: ${r.capacity_children}</span>
                            ${r.nights ? `<span>${r.nights} night${r.nights === 1 ? "" : "s"}</span>` : ""}
                        </div>
                        <button class="btn btn-secondary btn-small" onclick="openBookingModal('${p.id}', '${r.id}')">Book — ₹${r.total_price}</button>
                    </div>
                `).join("")}
            </div>
        </div>
    `).join("") + `</div>`;
}

function openBookingModal(propertyId, roomId) {
    const prop = lastSearchResults.find(p => p.id === propertyId);
    if (!prop) return;
    const room = prop.rooms.find(r => r.id === roomId);
    if (!room) return;

    const checkIn = document.getElementById("searchCheckIn").value;
    const checkOut = document.getElementById("searchCheckOut").value;
    const adults = parseInt(document.getElementById("searchAdults").value || "1");
    const children = parseInt(document.getElementById("searchChildren").value || "0");

    const modal = document.createElement("div");
    modal.className = "modal-overlay";
    modal.innerHTML = `
        <div class="modal">
            <button class="close-modal" onclick="this.closest('.modal-overlay').remove()">&times;</button>
            <h3>Confirm Booking</h3>
            <p style="font-weight:600; margin-bottom:4px;">${escapeHtml(prop.name)}</p>
            <p style="color:var(--ink-soft); margin-bottom:18px;">${escapeHtml(room.room_type)} &middot; ${checkIn} → ${checkOut}</p>
            <div class="room-details" style="margin-bottom:20px;">
                <span>Adults: ${adults}</span>
                <span>Children: ${children}</span>
                <span>Nights: ${room.nights ?? "—"}</span>
                <span>Total: ₹${room.total_price}</span>
            </div>
            <div id="bookingError" class="error-msg"></div>
            <button id="confirmBookingBtn" class="btn btn-primary btn-full">Confirm &amp; Book</button>
        </div>
    `;
    document.body.appendChild(modal);

    const confirmBtn = document.getElementById("confirmBookingBtn");
    confirmBtn.addEventListener("click", async () => {
        const errDiv = document.getElementById("bookingError");
        errDiv.style.display = "none";
        confirmBtn.disabled = true;
        try {
            await API.post("/api/bookings", {
                room_id: roomId,
                check_in: checkIn,
                check_out: checkOut,
                num_adults: adults,
                num_children: children,
                idempotency_key: (window.crypto && crypto.randomUUID)
                    ? crypto.randomUUID()
                    : `${roomId}-${checkIn}-${Date.now()}`,
            });
            modal.remove();
            loadMyBookings();
            runPropertySearch(); // refresh availability now that a unit is taken
        } catch (err) {
            errDiv.style.display = "block";
            errDiv.textContent = err.message;
            confirmBtn.disabled = false;
        }
    });
}

async function loadMyBookings() {
    const container = document.getElementById("myBookings");
    if (!container) return;
    try {
        const bookings = await API.get("/api/bookings");
        renderMyBookings(bookings);
    } catch (err) {
        container.innerHTML = `<div class="empty-state">Couldn't load your bookings.</div>`;
    }
}

function renderMyBookings(bookings) {
    const container = document.getElementById("myBookings");
    if (bookings.length === 0) {
        container.innerHTML = `<div class="empty-state">No bookings yet. Search above to plan your next stay.</div>`;
        return;
    }

    const statusBadge = { confirmed: "approved", pending: "pending", cancelled: "rejected", completed: "approved" };

    container.innerHTML = `<div class="table-container"><table>
        <thead><tr><th>Property</th><th>Room</th><th>Dates</th><th>Guests</th><th>Status</th><th>Total</th><th></th></tr></thead>
        <tbody>
        ${bookings.map(b => `
            <tr>
                <td>${escapeHtml(b.property_name)}</td>
                <td>${escapeHtml(b.room_type)}</td>
                <td>${b.check_in} → ${b.check_out}</td>
                <td>${b.num_adults} adult${b.num_adults === 1 ? "" : "s"}${b.num_children ? `, ${b.num_children} child${b.num_children === 1 ? "" : "ren"}` : ""}</td>
                <td><span class="badge badge-${statusBadge[b.status] || "pending"}">${b.status}</span></td>
                <td>${b.total_price != null ? "₹" + b.total_price : "—"}</td>
                <td>${(b.status === "pending" || b.status === "confirmed") && new Date(b.check_in) > new Date() ? `<button class="btn btn-danger btn-small" onclick="cancelBooking('${b.id}')">Cancel</button>` : ""}</td>
            </tr>
        `).join("")}
        </tbody>
    </table></div>`;
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

async function renderHotelRepDashboard(container, user) {
    const [properties, locations] = await Promise.all([
        API.get("/api/hotels"),
        API.get("/api/hotels/locations"),
    ]);

    let html = `
        <div class="section-header">
            <h3>My Properties</h3>
            <button class="btn btn-primary btn-small" onclick="showAddPropertyModal()">+ Add Property</button>
            <button class="btn btn-outline btn-small" onclick="renderRepBookings()">View Bookings</button>
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
    html += `<div id="repBookingsSection" style="display:none"></div>`;
    container.innerHTML = html;
}

async function renderRepBookings() {
    const section = document.getElementById("repBookingsSection");
    const detailDiv = document.getElementById("propertyDetail");
    detailDiv.innerHTML = "";
    section.style.display = "block";
    section.innerHTML = `<div class="section-header"><h3>My Bookings</h3><button class="btn btn-outline btn-small" onclick="document.getElementById('repBookingsSection').style.display='none'">Close</button></div><div class="empty-state">Loading…</div>`;
    try {
        const bookings = await API.get("/api/hotels/bookings");
        let html = `<div class="section-header"><h3>My Bookings</h3><button class="btn btn-outline btn-small" onclick="document.getElementById('repBookingsSection').style.display='none'">Close</button></div>`;
        if (bookings.length === 0) {
            html += `<div class="empty-state">No bookings for your properties yet.</div>`;
            section.innerHTML = html;
            return;
        }
        html += `<div class="table-container"><table>
            <thead><tr>
                <th>Property</th><th>Room</th><th>Guest</th><th>Check In</th><th>Check Out</th><th>Guests</th><th>Total</th><th>Status</th><th>Booked On</th>
            </tr></thead>
            <tbody>
        `;
        for (const b of bookings) {
            html += `<tr>
                <td><strong>${escapeHtml(b.property_name)}</strong></td>
                <td>${escapeHtml(b.room_type)}</td>
                <td>${escapeHtml(b.customer_name || "—")}<br><small style="color:var(--ink-faint)">${escapeHtml(b.customer_email)}</small></td>
                <td>${b.check_in}</td>
                <td>${b.check_out}</td>
                <td>${b.num_adults}A ${b.num_children}C</td>
                <td>₹${b.total_price}</td>
                <td><span class="badge badge-${b.status === "confirmed" ? "approved" : b.status}">${b.status}</span></td>
                <td>${new Date(b.created_at).toLocaleDateString()}</td>
            </tr>`;
        }
        html += `</tbody></table></div>`;
        section.innerHTML = html;
    } catch (err) {
        const msg = typeof err === "object" && err !== null ? (err.message || JSON.stringify(err)) : String(err);
        section.innerHTML = `<div class="section-header"><h3>My Bookings</h3><button class="btn btn-outline btn-small" onclick="this.closest('#repBookingsSection').style.display='none'">Close</button></div><div class="empty-state" style="color:var(--bad)">${escapeHtml(msg)}</div>`;
    }
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
                    <label>City</label>
                    <select id="propCity"><option value="">Select city...</option></select>
                </div>
                <div class="form-group">
                    <label>District</label>
                    <select id="propDistrict"><option value="">Select district...</option></select>
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

    // Load cities
    (async () => {
        try {
            const cities = await API.get("/api/hotels/locations?type=city");
            const sel = document.getElementById("propCity");
            cities.forEach(c => {
                const opt = document.createElement("option");
                opt.value = c.id;
                opt.textContent = c.name;
                sel.appendChild(opt);
            });
        } catch {}
    })();

    // When city changes, load districts
    document.getElementById("propCity").addEventListener("change", async () => {
        const cityId = document.getElementById("propCity").value;
        const districtSel = document.getElementById("propDistrict");
        districtSel.innerHTML = `<option value="">Select district...</option>`;
        districtSel.disabled = !cityId;
        if (!cityId) return;
        try {
            const districts = await API.get(`/api/hotels/locations?type=district&parent_id=${cityId}`);
            districts.forEach(d => {
                const opt = document.createElement("option");
                opt.value = d.id;
                opt.textContent = d.name;
                districtSel.appendChild(opt);
            });
        } catch {}
    });

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
                city_id: document.getElementById("propCity").value || null,
                district_id: document.getElementById("propDistrict").value || null,
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
            const roomImagesHtml = (r.images && r.images.length > 0)
                ? `<div class="image-gallery" style="margin-bottom:10px">${r.images.map((url, i) => `
                    <div class="image-thumb">
                        <img src="${escapeHtml(url)}" alt="Room image">
                        <button type="button" class="image-thumb-remove" onclick="deleteRoomImage('${propertyId}','${r.id}',${i})">&times;</button>
                    </div>`).join("")}</div>`
                : "";
            html += `
                <div class="room-item">
                    <h5>${escapeHtml(r.room_type)}</h5>
                    <div class="room-details">
                        <span>₹${r.base_price}/night</span>
                        <span>Adults: ${r.capacity_adults}</span>
                        <span>Children: ${r.capacity_children}</span>
                        <span>Total: ${r.total_quantity}</span>
                        <span>Avail today: ${r.available_today}</span>
                    </div>
                    ${r.room_amenities && Object.keys(r.room_amenities).length > 0 ? `
                        <div class="room-amenity-tags" style="margin-bottom: 15px; display: flex; flex-wrap: wrap; gap: 5px;">
                            ${Object.keys(r.room_amenities).filter(k => r.room_amenities[k]).map(k => `<span class="badge badge-pending" style="background:#e3f2fd; color:#0d47a1; text-transform: capitalize;">${k.replace('_', ' ')}</span>`).join('')}
                        </div>
                    ` : ''}
                    ${roomImagesHtml}
                    <div class="image-upload-area" style="margin-bottom:10px">
                        <input type="file" accept="image/jpeg,image/png,image/webp" multiple hidden id="roomUpload_${r.id}">
                        <button class="btn btn-outline btn-small" onclick="document.getElementById('roomUpload_${r.id}').click()">+ Upload Room Images</button>
                    </div>
                    <button class="btn btn-danger btn-small" onclick="deleteRoom('${propertyId}', '${r.id}')">Delete</button>
                </div>
            `;
        }
    }
    detailDiv.innerHTML = html;

    // Bind room image uploads
    for (const r of rooms) {
        const input = document.getElementById(`roomUpload_${r.id}`);
        if (input) {
            input.addEventListener("change", async (e) => {
                const files = e.target.files;
                if (!files.length) return;
                try {
                    const form = new FormData();
                    for (const f of files) form.append("files", f);
                    const res = await fetch(`/api/hotels/${propertyId}/rooms/${r.id}/images`, {
                        method: "POST", credentials: "include", body: form,
                    });
                    const data = await res.json();
                    if (!res.ok) throw new Error(data.detail || "Upload failed");
                    viewProperty(propertyId);
                } catch (err) { alert(err.message); }
            });
        }
    }
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
                    <label>City</label>
                    <select id="editPropCity"><option value="">Select city...</option></select>
                </div>
                <div class="form-group">
                    <label>District</label>
                    <select id="editPropDistrict"><option value="">Select district...</option></select>
                </div>
                <div class="form-group">
                    <label>Address</label>
                    <textarea id="propAddress" rows="2">${escapeHtml(prop.address || "")}</textarea>
                </div>
                <div class="form-group">
                    <label>Property Images</label>
                    <div id="editPropImages" class="image-gallery"></div>
                    <div class="image-upload-area">
                        <input type="file" id="editPropImageInput" accept="image/jpeg,image/png,image/webp" multiple hidden>
                        <button type="button" class="btn btn-outline btn-small" onclick="document.getElementById('editPropImageInput').click()">+ Upload Images</button>
                    </div>
                </div>
                <button type="submit" class="btn btn-primary btn-full">Save Changes</button>
            </form>
        </div>
    `;
    document.body.appendChild(modal);
    const citySel = document.getElementById("editPropCity");
    const districtSel = document.getElementById("editPropDistrict");

    // Load cities
    try {
        const cities = await API.get("/api/hotels/locations?type=city");
        cities.forEach(c => {
            const opt = document.createElement("option");
            opt.value = c.id;
            opt.textContent = c.name;
            if (c.id === prop.city_id) opt.selected = true;
            citySel.appendChild(opt);
        });
    } catch {}

    // Load districts for the current city
    if (prop.city_id) {
        try {
            const districts = await API.get(`/api/hotels/locations?type=district&parent_id=${prop.city_id}`);
            districts.forEach(d => {
                const opt = document.createElement("option");
                opt.value = d.id;
                opt.textContent = d.name;
                if (d.id === prop.district_id) opt.selected = true;
                districtSel.appendChild(opt);
            });
        } catch {}
    }

    // ── Property images ──────────────────────────────────────────────────
    function renderPropImages() {
        const container = document.getElementById("editPropImages");
        container.innerHTML = "";
        (prop.images || []).forEach((url, i) => {
            const div = document.createElement("div");
            div.className = "image-thumb";
            div.innerHTML = `
                <img src="${escapeHtml(url)}" alt="Property image">
                <button type="button" class="image-thumb-remove" data-index="${i}">&times;</button>
            `;
            div.querySelector(".image-thumb-remove").addEventListener("click", async () => {
                try {
                    const result = await API.del(`/api/hotels/${propertyId}/images/${i}`);
                    prop.images = result.images;
                    renderPropImages();
                } catch (err) { alert(err.message); }
            });
            container.appendChild(div);
        });
    }
    renderPropImages();

    document.getElementById("editPropImageInput").addEventListener("change", async (e) => {
        const files = e.target.files;
        if (!files.length) return;
        try {
            const form = new FormData();
            for (const f of files) form.append("files", f);
            const res = await fetch(`/api/hotels/${propertyId}/images`, {
                method: "POST", credentials: "include", body: form,
            });
            const data = await res.json();
            if (!res.ok) throw new Error(data.detail || "Upload failed");
            prop.images = data.images;
            renderPropImages();
        } catch (err) { alert(err.message); }
        e.target.value = "";
    });

    // When city changes, reload districts
    citySel.addEventListener("change", async () => {
        const cityId = citySel.value;
        districtSel.innerHTML = `<option value="">Select district...</option>`;
        districtSel.disabled = !cityId;
        if (!cityId) return;
        try {
            const districts = await API.get(`/api/hotels/locations?type=district&parent_id=${cityId}`);
            districts.forEach(d => {
                const opt = document.createElement("option");
                opt.value = d.id;
                opt.textContent = d.name;
                districtSel.appendChild(opt);
            });
        } catch {}
    });

    document.getElementById("editPropertyForm").addEventListener("submit", async (e) => {
        e.preventDefault();
        try {
            await API.put(`/api/hotels/${propertyId}`, {
                name: document.getElementById("propName").value,
                description: document.getElementById("propDesc").value,
                property_type: document.getElementById("propType").value,
                city_id: citySel.value || null,
                district_id: districtSel.value || null,
                address: document.getElementById("propAddress").value,
            });
            modal.remove();
            initDashboard();
        } catch (err) {
            alert(err.message);
        }
    });
}

async function deleteRoomImage(propertyId, roomId, imageIndex) {
    try {
        await API.del(`/api/hotels/${propertyId}/rooms/${roomId}/images/${imageIndex}`);
        viewProperty(propertyId);
    } catch (err) { alert(err.message); }
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

// ── Properties tab ──────────────────────────────────────────────────────────

let propFilterTimer;

async function renderPropertiesTab() {
    const container = document.getElementById("adminTabContent");
    const status = document.getElementById("propFilterStatus")?.value || "pending";
    const q = document.getElementById("propFilterQ")?.value || "";
    const params = new URLSearchParams({ status, q: q || "" });
    container.innerHTML = `
        <h3>All Properties</h3>
        <div style="display:flex; gap:12px; align-items:center; flex-wrap:wrap; margin-bottom:18px;">
            <select id="propFilterStatus" onchange="renderPropertiesTab()">
                <option value="pending" ${status === "pending" ? "selected" : ""}>Pending</option>
                <option value="approved" ${status === "approved" ? "selected" : ""}>Approved</option>
                <option value="all" ${status === "all" ? "selected" : ""}>All</option>
            </select>
            <input type="text" id="propFilterQ" placeholder="Search name / address / city" value="${escapeHtml(q)}" style="flex:1;min-width:200px;padding:8px 12px;border:2px solid var(--sand-deep);border-radius:var(--radius-sm);font-family:inherit;">
            <span class="loader" id="propLoader" style="display:none"></span>
        </div>
        <div id="propTableWrap"></div>
    `;

    document.getElementById("propFilterQ").addEventListener("input", () => {
        clearTimeout(propFilterTimer);
        propFilterTimer = setTimeout(renderPropertiesTab, 350);
    });

    const wrap = document.getElementById("propTableWrap");
    wrap.innerHTML = `<div class="empty-state">Loading…</div>`;
    try {
        const props = await API.get(`/api/admin/properties?${params.toString()}`);
        if (props.length === 0) {
            wrap.innerHTML = `<div class="empty-state">No properties match those filters.</div>`;
            return;
        }
        wrap.innerHTML = `<div class="table-container"><table>
            <thead><tr>
                <th>Name</th><th>Type</th><th>Owner</th><th>City</th><th>Address</th><th>Status</th><th>Actions</th>
            </tr></thead>
            <tbody>
        `;
        for (const p of props) {
            wrap.innerHTML += `<tr>
                <td><strong>${escapeHtml(p.name)}</strong></td>
                <td>${escapeHtml(p.property_type || "—")}</td>
                <td>${escapeHtml(p.owner_name || "—")}<br><small style="color:var(--ink-faint)">${escapeHtml(p.owner_email || "")}</small></td>
                <td>${escapeHtml(p.city || "—")}</td>
                <td style="max-width:240px;word-break:break-word">${escapeHtml(p.address || "—")}</td>
                <td><span class="badge badge-${p.is_approved ? "approved" : "pending"}">${p.is_approved ? "Approved" : "Pending"}</span></td>
                <td>
                    ${p.is_approved
                        ? `<button class="btn btn-danger btn-small" onclick="rejectProperty('${p.id}','${escapeHtml(p.name)}')">Unapprove</button>`
                        : `<button class="btn btn-success btn-small" onclick="approveProperty('${p.id}','${escapeHtml(p.name)}')">Approve</button>`
                    }
                </td>
            </tr>`;
        }
        wrap.innerHTML += `</tbody></table></div>`;
    } catch (err) {
        wrap.innerHTML = `<div class="empty-state" style="color:var(--bad)">${escapeHtml(err.message)}</div>`;
    }
}

async function approveProperty(id, name) {
    if (!confirm(`Approve "${name}"?`)) return;
    await API.post(`/api/admin/properties/${id}/approve`);
    renderPropertiesTab();
}

async function rejectProperty(id, name) {
    if (!confirm(`Unapprove "${name}"?`)) return;
    await API.post(`/api/admin/properties/${id}/reject`);
    renderPropertiesTab();
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