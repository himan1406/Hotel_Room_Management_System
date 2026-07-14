// ==================== Customer Dashboard: search + book + history ====================
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

        <div class="card filter-panel" id="filterPanel" style="margin-top:16px; display:none;">
            <div style="display:flex; gap:16px; align-items:center; flex-wrap:wrap;">
                <div class="form-group" style="flex:1; min-width:200px;">
                    <label for="filterPriceRange">Max price per night: &#8377;<span id="filterPriceLabel">5000</span></label>
                    <input type="range" id="filterPriceRange" min="0" max="20000" step="500" value="5000" style="width:100%;">
                </div>
                <div class="form-group" style="min-width:150px;">
                    <label for="filterMinRating">Min rating</label>
                    <select id="filterMinRating">
                        <option value="">Any</option>
                        <option value="1">1+</option>
                        <option value="2">2+</option>
                        <option value="3">3+</option>
                        <option value="4">4+</option>
                        <option value="4.5">4.5+</option>
                    </select>
                </div>
                <div class="form-group" style="min-width:130px;">
                    <label for="filterPropertyType">Property type</label>
                    <select id="filterPropertyType">
                        <option value="">All types</option>
                        <option value="hotel">Hotel</option>
                        <option value="villa">Villa</option>
                        <option value="homestay">Homestay</option>
                        <option value="resort">Resort</option>
                    </select>
                </div>
                <div class="form-group" style="min-width:120px;">
                    <label for="filterSortBy">Sort by</label>
                    <select id="filterSortBy">
                        <option value="trending">Trending</option>
                        <option value="price_asc">Price: Low to High</option>
                        <option value="price_desc">Price: High to Low</option>
                        <option value="rating_desc">Rating: High to Low</option>
                    </select>
                </div>
                <button class="btn btn-primary btn-small" onclick="applyFilters()" style="margin-top:18px;">Apply Filters</button>
                <button class="btn btn-outline btn-small" onclick="resetFilters()" style="margin-top:18px;">Reset</button>
            </div>
            <div style="display:flex; gap:12px; flex-wrap:wrap; margin-top:10px;">
                <label class="amenity-checkbox-label"><input type="checkbox" name="filterAmenity" value="wifi"> WiFi</label>
                <label class="amenity-checkbox-label"><input type="checkbox" name="filterAmenity" value="parking"> Parking</label>
                <label class="amenity-checkbox-label"><input type="checkbox" name="filterAmenity" value="pool"> Pool</label>
                <label class="amenity-checkbox-label"><input type="checkbox" name="filterAmenity" value="ac"> A/C</label>
                <label class="amenity-checkbox-label"><input type="checkbox" name="filterAmenity" value="gym"> Gym</label>
                <label class="amenity-checkbox-label"><input type="checkbox" name="filterAmenity" value="restaurant"> Restaurant</label>
                <label class="amenity-checkbox-label"><input type="checkbox" name="filterAmenity" value="spa"> Spa</label>
            </div>
        </div>

        <div id="searchResults"></div>
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

    document.getElementById("filterPriceRange").addEventListener("input", () => {
        document.getElementById("filterPriceLabel").textContent = document.getElementById("filterPriceRange").value;
    });

    initSearchAutocomplete();

    // Restore search state from URL params (survives page refresh)
    const urlParams = new URLSearchParams(window.location.search);
    if (urlParams.get("searched") === "1") {
        const locVal = urlParams.get("location") || "";
        if (locVal) document.getElementById("searchLocation").value = locVal;

        const checkIn = urlParams.get("check_in");
        const checkOut = urlParams.get("check_out");
        if (checkIn) document.getElementById("searchCheckIn").value = checkIn;
        if (checkOut) document.getElementById("searchCheckOut").value = checkOut;

        const adults = urlParams.get("adults");
        if (adults) document.getElementById("searchAdults").value = adults;
        const children = urlParams.get("children");
        if (children) document.getElementById("searchChildren").value = children;

        // Filters
        const maxPrice = urlParams.get("max_price");
        if (maxPrice) {
            document.getElementById("filterPriceRange").value = maxPrice;
            document.getElementById("filterPriceLabel").textContent = maxPrice;
        }
        const minRating = urlParams.get("min_rating");
        if (minRating) document.getElementById("filterMinRating").value = minRating;
        const propType = urlParams.get("property_type");
        if (propType) document.getElementById("filterPropertyType").value = propType;
        const sortBy = urlParams.get("sort_by");
        if (sortBy) document.getElementById("filterSortBy").value = sortBy;
        const amenities = urlParams.getAll("amenities");
        if (amenities.length) {
            document.querySelectorAll('input[name="filterAmenity"]').forEach(cb => {
                cb.checked = amenities.includes(cb.value);
            });
        }

        // Show filters and re-run the search automatically
        document.getElementById("filterPanel").style.display = "block";
        runPropertySearch();
    }
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

    // Filters
    const maxPrice = document.getElementById("filterPriceRange").value;
    if (maxPrice && maxPrice !== "5000") params.set("max_price", maxPrice);

    const minRating = document.getElementById("filterMinRating").value;
    if (minRating) params.set("min_rating", minRating);

    const propType = document.getElementById("filterPropertyType").value;
    if (propType) params.set("property_type", propType);

    const sortBy = document.getElementById("filterSortBy").value;
    if (sortBy && sortBy !== "trending") params.set("sort_by", sortBy);

    const amenityCbs = document.querySelectorAll('input[name="filterAmenity"]:checked');
    amenityCbs.forEach(cb => params.append("amenities", cb.value));

    // Persist search state in the URL so a page refresh restores the results
    params.set("searched", "1");
    const newUrl = new URL(window.location);
    newUrl.search = params.toString();
    window.history.replaceState({}, "", newUrl);

    resultsDiv.innerHTML = `<div class="empty-state">Searching…</div>`;

    // Show filter panel on first search
    document.getElementById("filterPanel").style.display = "block";

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

function applyFilters() {
    if (lastSearchResults.length > 0) runPropertySearch();
}

function resetFilters() {
    document.getElementById("filterPriceRange").value = "5000";
    document.getElementById("filterPriceLabel").textContent = "5000";
    document.getElementById("filterMinRating").value = "";
    document.getElementById("filterPropertyType").value = "";
    document.getElementById("filterSortBy").value = "trending";
    document.querySelectorAll('input[name="filterAmenity"]').forEach(cb => cb.checked = false);
}

function renderSearchResults(properties) {
    const resultsDiv = document.getElementById("searchResults");
    if (properties.length === 0) {
        resultsDiv.innerHTML = `<div class="empty-state">No stays match those dates yet. Try a different location or date range.</div>`;
        return;
    }

    resultsDiv.innerHTML = `<div class="property-list">` + properties.map(p => {
        const isComparing = selectedCompareIds.includes(p.id);
        const propRooms = p.rooms || [];
        const totalNights = propRooms.length > 0 && propRooms[0].nights ? propRooms[0].nights : 1;
        const availableStr = propRooms.some(r => r.free_units !== undefined)
            ? propRooms.map(r => `${r.room_type}: ${r.free_units}/${r.total_quantity} available`).join(" · ")
            : "";

        return `
        <div class="property-card ${isComparing ? 'property-card-compared' : ''}" data-property-id="${p.id}">
            <div class="property-thumb" onclick="openPropertyGallery('${p.id}')" title="View photos">
                ${p.thumbnail
                    ? `<img src="${escapeHtml(p.thumbnail)}" alt="${escapeHtml(p.name)}">`
                    : `<div class="thumb-placeholder">No photos yet</div>`}
                ${p.photo_count ? `<span class="photo-count-badge">📷 ${p.photo_count}</span>` : ""}
            </div>
            <h4>${escapeHtml(p.name)}</h4>
            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                <div class="prop-type">${escapeHtml([p.city, p.district].filter(Boolean).join(", ") || "Location N/A")}${p.property_type ? " · " + escapeHtml(p.property_type) : ""}</div>
                <button class="compare-toggle-btn ${isComparing ? 'compare-toggle-active' : ''}" data-property-id="${p.id}" onclick="toggleCompareFromSearch('${p.id}')">
                    ${isComparing ? '&#10003; Comparing' : '&#43; Compare'}
                </button>
            </div>
            ${p.description ? `<p>${escapeHtml(p.description.slice(0, 110))}${p.description.length > 110 ? "…" : ""}</p>` : ""}
            ${p.badges && p.badges.length > 0 ? `<div class="prop-badges">${p.badges.map(b => `<span class="prop-badge">${b.icon} ${b.label}</span>`).join("")}</div>` : ""}
            ${p.ai_highlight ? `<div class="prop-ai-highlight">✨ ${escapeHtml(p.ai_highlight)}</div>` : ""}
            <p style="font-family:'Space Mono',monospace; font-size:0.78rem; color:var(--ink-soft); margin:10px 0 14px;">From ₹${p.from_price} total &middot; <a href="#" onclick="event.preventDefault();openPropertyReviews('${p.id}')" style="color:var(--lilac-deep);">${p.review_count} review${p.review_count === 1 ? "" : "s"}</a></p>
            ${availableStr ? `<p style="font-size:0.75rem;color:var(--lilac-deep);margin:-4px 0 10px;">${availableStr}</p>` : ""}
            <div class="room-pick-list">
                ${propRooms.map(r => `
                    <div class="room-item">
                        <div class="room-item-header">
                            ${r.images && r.images.length > 0
                                ? `<div class="room-item-thumb" onclick="openPropertyGallery('${p.id}', '${r.id}')" title="View photos"><img src="${escapeHtml(r.images[0])}" alt="${escapeHtml(r.room_type)}"></div>`
                                : `<div class="room-item-thumb placeholder">🏛</div>`}
                            <div style="flex:1">
                                <h5 style="margin-bottom:2px">${escapeHtml(r.room_type)}</h5>
                                <div class="room-details" style="margin-bottom:0">
                                    <span>₹${r.base_price}/night</span>
                                    <span>Sleeps ${r.capacity_adults + r.capacity_children}</span>
                                    ${totalNights > 1 ? `<span>${totalNights} nights</span>` : ""}
                                </div>
                            </div>
                        </div>
                        <div style="display:flex;align-items:center;gap:10px;margin-top:8px;flex-wrap:wrap;">
                            <div class="qty-selector">
                                <button class="qty-btn" onclick="changeRoomQty('${p.id}', ${JSON.stringify(r).replace(/\"/g, "'")}, -1)">−</button>
                                <input type="number" class="qty-input" data-room="${r.id}" value="${bookingCart[`${p.id}:${r.id}`]?.qty || 0}" min="0" max="${r.free_units !== undefined ? r.free_units : r.total_quantity}" readonly>
                                <button class="qty-btn" onclick="changeRoomQty('${p.id}', ${JSON.stringify(r).replace(/\"/g, "'")}, 1)">+</button>
                            </div>
                            <div class="book-btn-container" data-room="${r.id}">
                                <span class="room-subtotal" style="${bookingCart[`${p.id}:${r.id}`] ? '' : 'color:var(--ink-soft)'}">${bookingCart[`${p.id}:${r.id}`] ? '₹' + (bookingCart[`${p.id}:${r.id}`].qty * (r.total_price || r.base_price)) : '—'}</span>
                            </div>
                        </div>
                    </div>
                `).join("")}
            </div>
            <div id="cartBar_${p.id}" class="cart-bar" style="display:${getCartCount(p.id) > 0 ? 'flex' : 'none'};">
                <span class="cart-info"><span class="cart-count">${getCartCount(p.id)}</span> room(s) selected · <span class="cart-total">₹${getCartTotal(p.id)}</span></span>
                <button class="btn btn-primary btn-small" onclick="openBulkBookingModal('${p.id}')">Book Now</button>
            </div>
            <div class="prop-actions" style="${getCartCount(p.id) > 0 ? 'margin-top:0;' : ''}">
                <button class="btn btn-outline btn-small" onclick="openPropertyGallery('${p.id}')">View Photos</button>
                <button class="btn btn-secondary btn-small" onclick="contactHost('${p.id}')">Contact Host</button>
            </div>
        </div>
        `;
    }).join("") + `</div>`;
}
