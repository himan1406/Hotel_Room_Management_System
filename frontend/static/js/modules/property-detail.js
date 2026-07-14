// ==================== Property Detail View ====================
async function renderPropertyDetailView(container, propertyId) {
    container.innerHTML = `<div class="empty-state">Loading property details...</div>`;
    try {
        const [prop, reviews] = await Promise.all([
            API.get(`/api/properties/${propertyId}`),
            API.get(`/api/reviews/property/${propertyId}`)
        ]);

        currentSelectedProperty = prop;

        const eyebrow = document.getElementById("dashboardEyebrow");
        const heading = document.getElementById("dashboardHeading");
        if (eyebrow) eyebrow.textContent = "Property Detail";
        if (heading) heading.textContent = prop.name;

        const badgesHtml = prop.avg_rating >= 4.0
            ? `<span class="prop-badge">⭐ ${prop.avg_rating} (${prop.review_count} reviews)</span>`
            : `<span>No ratings yet</span>`;

        const images = prop.images || [];
        let galleryHtml = "";
        if (images.length > 0) {
            galleryHtml = `
                <div class="property-detail-gallery">
                    <div class="gallery-main-img" onclick="openPropertyGallery('${prop.id}')" title="Click to view all photos">
                        <img src="${escapeHtml(images[0])}" alt="${escapeHtml(prop.name)}">
                    </div>
                    <div class="gallery-sub-images">
                        ${images.slice(1, 4).map(img => `
                            <div class="gallery-sub-img" onclick="openPropertyGallery('${prop.id}')">
                                <img src="${escapeHtml(img)}" alt="">
                            </div>
                        `).join("")}
                        ${images.length > 4 ? `
                            <div class="gallery-sub-img gallery-more-photos" onclick="openPropertyGallery('${prop.id}')">
                                <span>+${images.length - 4} photos</span>
                            </div>
                        ` : ""}
                    </div>
                </div>
            `;
        } else {
            galleryHtml = `<div class="thumb-placeholder" style="height: 200px; display:flex; align-items:center; justify-content:center; background: var(--gold-tint); border-radius: var(--radius-md);">No photos available</div>`;
        }

        const amenitiesList = prop.amenities ? Object.keys(prop.amenities).filter(k => prop.amenities[k]) : [];
        const amenitiesHtml = amenitiesList.length > 0
            ? `<div class="prop-amenity-tags" style="display:flex; flex-wrap:wrap; gap:8px; margin:16px 0;">
                ${amenitiesList.map(a => `<span class="badge badge-pending" style="background:#e3f2fd; color:#0d47a1; text-transform: capitalize; padding: 6px 12px; font-size:0.85rem;">${escapeHtml(a.replace('_', ' '))}</span>`).join("")}
               </div>`
            : `<p style="color:var(--ink-soft);">No amenities specified.</p>`;

        let reviewsHtml = "";
        if (reviews.length === 0) {
            reviewsHtml = `<div class="empty-state">No reviews yet for this property.</div>`;
        } else {
            reviewsHtml = `
                <div class="reviews-list-inline" style="margin-top: 20px; max-height: 400px; overflow-y: auto; padding-right: 8px;">
                    ${reviews.map(r => `
                        <div style="border-bottom:1px solid var(--line-soft); padding:14px 0;">
                            <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:4px;">
                                <strong>${escapeHtml(r.customer_name || "Anonymous")}</strong>
                                <span style="color:var(--accent); font-size:1rem;">${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</span>
                            </div>
                            ${r.comment ? `<p style="margin:6px 0; font-size:0.92rem;">${escapeHtml(r.comment)}</p>` : ""}
                            <div style="display:flex; justify-content:space-between; align-items:center; font-size:0.78rem; color:var(--ink-faint); font-family:'Space Mono',monospace; margin-top:6px;">
                                <span>${new Date(r.created_at).toLocaleDateString()}</span>
                            </div>
                            ${r.rep_response ? `<div style="margin-top:8px; padding:10px 14px; background:var(--gold-tint); border-radius:var(--radius-sm); font-size:0.88rem;"><strong>Host response:</strong> ${escapeHtml(r.rep_response)}</div>` : ""}
                        </div>
                    `).join("")}
                </div>
            `;
        }

        let roomsHtml = "";
        if (!prop.rooms || prop.rooms.length === 0) {
            roomsHtml = `<div class="empty-state">No rooms available at this property.</div>`;
        } else {
            roomsHtml = `
                <div class="room-pick-list" style="margin-top: 15px;">
                    ${prop.rooms.map(r => `
                        <div class="room-item">
                            <div class="room-item-header">
                                ${r.images && r.images.length > 0
                                    ? `<div class="room-item-thumb" onclick="openPropertyGallery('${prop.id}', '${r.id}')" title="View photos"><img src="${escapeHtml(r.images[0])}" alt="${escapeHtml(r.room_type)}"></div>`
                                    : `<div class="room-item-thumb placeholder">🛏️</div>`}
                                <div style="flex:1">
                                    <h5 style="margin-bottom:2px">${escapeHtml(r.room_type)}</h5>
                                    <div class="room-details" style="margin-bottom:0">
                                        <span>₹${r.base_price}/night</span>
                                        <span>Capacity: ${r.capacity_adults} Adults ${r.capacity_children ? `, ${r.capacity_children} Children` : ""}</span>
                                    </div>
                                    ${r.room_amenities && Object.keys(r.room_amenities).length > 0 ? `
                                        <div class="room-amenity-tags" style="margin-top: 8px; display: flex; flex-wrap: wrap; gap: 5px;">
                                            ${Object.keys(r.room_amenities).filter(k => r.room_amenities[k]).map(k => `<span class="badge badge-pending" style="background:#e3f2fd; color:#0d47a1; text-transform: capitalize; font-size:0.72rem; padding: 2px 6px;">${escapeHtml(k.replace('_', ' '))}</span>`).join('')}
                                        </div>
                                    ` : ''}
                                </div>
                            </div>
                            <button class="btn btn-secondary btn-small" onclick="openBookingModal('${prop.id}', '${r.id}')">Book Room</button>
                        </div>
                    `).join("")}
                </div>
            `;
        }

        const backBtnHtml = comparisonContext
            ? `<button class="btn btn-outline btn-small" onclick="goBackToComparison()">&larr; Back to Comparison</button>`
            : `<button class="btn btn-outline btn-small" onclick="goBackToDashboard()">&larr; Back to Search</button>`;

        const isComparing = selectedCompareIds.includes(prop.id);
        const compareToggleHtml = `
            <button class="compare-toggle-btn ${isComparing ? 'compare-toggle-active' : ''}" onclick="toggleCompareFromDetail('${prop.id}')">
                ${isComparing ? '&#10003; Comparing' : '&#43; Compare'}
            </button>`;

        container.innerHTML = `
            <div class="property-detail-container" style="display:flex; flex-direction:column; gap:24px; margin-top:20px;">
                <div style="display:flex; justify-content:space-between; align-items:center; flex-wrap:wrap; gap:12px;">
                    ${backBtnHtml}
                    <div style="display:flex; align-items:center; gap:10px;">
                        ${compareToggleHtml}
                        ${badgesHtml}
                    </div>
                </div>

                ${galleryHtml}

                <div class="property-detail-body" style="display:grid; grid-template-columns: 2fr 1fr; gap:32px; min-width:0;">
                    <div class="detail-main-col">
                        <section class="card" style="margin-bottom:20px; padding: 24px;">
                            <h3>About the Property</h3>
                            <p style="line-height:1.6; margin-top:12px;">${escapeHtml(prop.description || "No description provided.")}</p>
                            <h4 style="margin-top:24px;">Address & Location</h4>
                            <p style="color:var(--ink-soft); margin-top:8px;">📍 ${escapeHtml(prop.address)}</p>
                        </section>

                        <section class="card" style="padding: 24px;">
                            <h3>Available Rooms</h3>
                            ${roomsHtml}
                        </section>
                    </div>

                    <div class="detail-side-col">
                        <section class="card" style="margin-bottom:20px; padding: 20px;">
                            <h3>Amenities</h3>
                            ${amenitiesHtml}
                        </section>

                        <section class="card" style="padding: 20px;">
                            <h3>Guest Reviews</h3>
                            ${reviewsHtml}
                        </section>
                    </div>
                </div>
            </div>
        `;

    } catch (err) {
        container.innerHTML = `<div class="empty-state" style="color:var(--bad)">Failed to load property details: ${escapeHtml(err.message)}</div>`;
    }
}
