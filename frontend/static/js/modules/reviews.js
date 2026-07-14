// ==================== Reviews ====================
async function openReviewModal(bookingId) {
    const existing = document.getElementById("reviewModalOverlay");
    if (existing) existing.remove();
    const overlay = document.createElement("div");
    overlay.id = "reviewModalOverlay";
    overlay.className = "modal-overlay";
    overlay.style.display = "flex";
    overlay.innerHTML = `
        <div class="modal" style="max-width:440px">
            <span class="close-modal" onclick="closeReviewModal()">&times;</span>
            <h3>Write a Review</h3>
            <input type="hidden" id="reviewBookingId" value="${bookingId}">
            <div class="form-group">
                <label>Rating</label>
                <div style="font-size:1.6rem;cursor:pointer;color:var(--sand-deep);">
                    ${[1,2,3,4,5].map(i => `<span class="review-star" data-value="${i}" onmouseenter="hoverStar(${i})" onmouseleave="resetStars()" onclick="setRating(${i})" style="transition:color var(--fast) var(--ease);">&#9733;</span>`).join("")}
                </div>
            </div>
            <div class="form-group">
                <label for="reviewComment">Comment (optional)</label>
                <textarea id="reviewComment" rows="4" placeholder="Share your experience..." style="width:100%;padding:10px 14px;border:2px solid var(--sand-deep);border-radius:var(--radius-sm);font-family:'Inter',sans-serif;font-size:0.9rem;resize:vertical;background:var(--paper);color:var(--ink);"></textarea>
            </div>
            <div id="reviewError" style="display:none;color:var(--bad);font-size:0.88rem;margin-bottom:12px;"></div>
            <div style="display:flex;gap:10px;justify-content:flex-end;">
                <button class="btn btn-secondary" onclick="closeReviewModal()">Cancel</button>
                <button class="btn btn-primary" onclick="submitReview()">Submit Review</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
}

function closeReviewModal() {
    const modal = document.getElementById("reviewModalOverlay");
    if (modal) modal.remove();
}

function hoverStar(val) {
    document.querySelectorAll(".review-star").forEach(s => {
        s.style.color = parseInt(s.dataset.value) <= val ? "var(--lilac-deep)" : "var(--sand-deep)";
    });
}

function resetStars() {
    document.querySelectorAll(".review-star").forEach(s => {
        s.style.color = parseInt(s.dataset.value) <= selectedRating ? "var(--lilac-deep)" : "var(--sand-deep)";
    });
}

function setRating(val) {
    selectedRating = val;
    resetStars();
}

async function submitReview() {
    const bookingId = document.getElementById("reviewBookingId").value;
    const comment = document.getElementById("reviewComment").value.trim();
    const errDiv = document.getElementById("reviewError");
    errDiv.style.display = "none";
    if (selectedRating === 0) {
        errDiv.textContent = "Please select a rating.";
        errDiv.style.display = "block";
        return;
    }
    try {
        await API.post("/api/reviews", { booking_id: bookingId, rating: selectedRating, comment: comment || null });
        closeReviewModal();
        loadMyBookings();
    } catch (err) {
        errDiv.textContent = err.message;
        errDiv.style.display = "block";
    }
}

async function openPropertyReviews(propertyId) {
    try {
        const reviews = await API.get(`/api/reviews/property/${propertyId}`);
        const existing = document.getElementById("reviewModalOverlay");
        if (existing) existing.remove();
        const overlay = document.createElement("div");
        overlay.id = "reviewModalOverlay";
        overlay.className = "modal-overlay";
        overlay.style.display = "flex";
        let bodyHtml;
        if (reviews.length === 0) {
            bodyHtml = `<div class="empty-state">No reviews yet for this property.</div>`;
        } else {
            bodyHtml = reviews.map(r => `
                <div style="border-bottom:1px solid var(--sand-deep);padding:14px 0;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                        <strong>${escapeHtml(r.customer_name || "Anonymous")}</strong>
                        <span style="color:var(--lilac-deep);font-size:1rem;">${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</span>
                    </div>
                    ${r.comment ? `<p style="margin:6px 0;font-size:0.92rem;">${escapeHtml(r.comment)}</p>` : ""}
                    <div style="display:flex;justify-content:space-between;align-items:center;font-size:0.78rem;color:var(--ink-faint);font-family:'Space Mono',monospace;margin-top:6px;">
                        <span>${new Date(r.created_at).toLocaleDateString()}</span>
                        ${r.is_mine ? `
                            <div style="display:flex;gap:6px;">
                                <button class="btn btn-outline btn-small" style="font-size:0.72rem;padding:2px 8px;" onclick="openEditReviewModal('${r.id}', ${r.rating})">Edit</button>
                                <button class="btn btn-danger btn-small" style="font-size:0.72rem;padding:2px 8px;" onclick="deleteReview('${r.id}', '${propertyId}')">Delete</button>
                            </div>
                        ` : ""}
                    </div>
                    ${r.rep_response ? `<div style="margin-top:8px;padding:10px 14px;background:var(--sand);border-radius:var(--radius-sm);font-size:0.88rem;"><strong>Host response:</strong> ${escapeHtml(r.rep_response)}</div>` : ""}
                </div>
            `).join("");
        }
        overlay.innerHTML = `
            <div class="modal" style="max-width:500px">
                <span class="close-modal" onclick="closeReviewModal()">&times;</span>
                <h3>Reviews</h3>
                <div>${bodyHtml}</div>
            </div>
        `;
        document.body.appendChild(overlay);
    } catch (err) {
        alert(err.message);
    }
}

async function openEditReviewModal(reviewId, currentRating) {
    selectedEditRating = currentRating || 0;
    const existing = document.getElementById("reviewModalOverlay");
    if (existing) existing.remove();
    const overlay = document.createElement("div");
    overlay.id = "reviewModalOverlay";
    overlay.className = "modal-overlay";
    overlay.style.display = "flex";
    overlay.innerHTML = `
        <div class="modal" style="max-width:440px">
            <span class="close-modal" onclick="closeReviewModal()">&times;</span>
            <h3>Edit Review</h3>
            <input type="hidden" id="editReviewId" value="${reviewId}">
            <div class="form-group">
                <label>Rating</label>
                <div style="font-size:1.6rem;cursor:pointer;color:var(--sand-deep);" id="editStarContainer">
                    ${[1,2,3,4,5].map(i => `<span class="edit-star" data-value="${i}" style="color:${i <= selectedEditRating ? 'var(--lilac-deep)' : 'var(--sand-deep)'};transition:color var(--fast) var(--ease);">&#9733;</span>`).join("")}
                </div>
            </div>
            <div class="form-group">
                <label for="editReviewComment">Comment (optional)</label>
                <textarea id="editReviewComment" rows="4" placeholder="Share your experience..." style="width:100%;padding:10px 14px;border:2px solid var(--sand-deep);border-radius:var(--radius-sm);font-family:'Inter',sans-serif;font-size:0.9rem;resize:vertical;background:var(--paper);color:var(--ink);"></textarea>
            </div>
            <div id="editReviewError" style="display:none;color:var(--bad);font-size:0.88rem;margin-bottom:12px;"></div>
            <div style="display:flex;gap:10px;justify-content:flex-end;">
                <button class="btn btn-secondary" onclick="closeReviewModal()">Cancel</button>
                <button class="btn btn-primary" onclick="submitEditReview()">Update Review</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);

    // Star hover/click handlers
    const container = document.getElementById("editStarContainer");
    const stars = container.querySelectorAll(".edit-star");
    function highlightUpTo(val) {
        stars.forEach(s => {
            s.style.color = parseInt(s.dataset.value) <= val ? "var(--lilac-deep)" : "var(--sand-deep)";
        });
    }
    stars.forEach(s => {
        s.addEventListener("mouseenter", () => highlightUpTo(parseInt(s.dataset.value)));
        s.addEventListener("mouseleave", () => highlightUpTo(selectedEditRating));
        s.addEventListener("click", () => { selectedEditRating = parseInt(s.dataset.value); highlightUpTo(selectedEditRating); });
    });
}

async function submitEditReview() {
    const reviewId = document.getElementById("editReviewId").value;
    const comment = document.getElementById("editReviewComment").value.trim();
    const errDiv = document.getElementById("editReviewError");
    errDiv.style.display = "none";
    if (selectedEditRating === 0) { errDiv.textContent = "Please select a rating."; errDiv.style.display = "block"; return; }
    try {
        await API.put(`/api/reviews/${reviewId}`, { rating: selectedEditRating, comment: comment || null });
        closeReviewModal();
    } catch (err) {
        errDiv.textContent = err.message;
        errDiv.style.display = "block";
    }
}

async function deleteReview(reviewId, propertyId) {
    if (!confirm("Delete this review?")) return;
    try {
        await API.del(`/api/reviews/${reviewId}`);
        openPropertyReviews(propertyId);
    } catch (err) {
        alert(err.message);
    }
}

async function viewPropertyReviews(propertyId) {
    try {
        const reviews = await API.get(`/api/reviews/property/${propertyId}`);
        const existing = document.getElementById("reviewModalOverlay");
        if (existing) existing.remove();
        const overlay = document.createElement("div");
        overlay.id = "reviewModalOverlay";
        overlay.className = "modal-overlay";
        overlay.style.display = "flex";
        let bodyHtml;
        if (reviews.length === 0) {
            bodyHtml = `<div class="empty-state">No reviews yet for this property.</div>`;
        } else {
            bodyHtml = reviews.map(r => `
                <div style="border-bottom:1px solid var(--sand-deep);padding:14px 0;">
                    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:4px;">
                        <strong>${escapeHtml(r.customer_name || "Anonymous")}</strong>
                        <span style="color:var(--lilac-deep);font-size:1rem;">${"★".repeat(r.rating)}${"☆".repeat(5 - r.rating)}</span>
                    </div>
                    ${r.comment ? `<p style="margin:6px 0;font-size:0.92rem;">${escapeHtml(r.comment)}</p>` : ""}
                    <div style="font-size:0.78rem;color:var(--ink-faint);font-family:'Space Mono',monospace;">${new Date(r.created_at).toLocaleDateString()}</div>
                    ${r.rep_response ? `<div style="margin-top:8px;padding:10px 14px;background:var(--sand);border-radius:var(--radius-sm);font-size:0.88rem;"><strong>Your response:</strong> ${escapeHtml(r.rep_response)}</div>` : `
                        <div style="margin-top:8px;">
                            <textarea id="reviewResponse_${r.id}" rows="2" placeholder="Write a response..." style="width:100%;padding:8px 12px;border:2px solid var(--sand-deep);border-radius:var(--radius-sm);font-family:'Inter',sans-serif;font-size:0.85rem;resize:vertical;background:var(--paper);color:var(--ink);"></textarea>
                            <button class="btn btn-primary btn-small" style="margin-top:6px;" onclick="submitReviewResponse('${r.id}')">Respond</button>
                        </div>
                    `}
                </div>
            `).join("");
        }
        overlay.innerHTML = `
            <div class="modal" style="max-width:520px">
                <span class="close-modal" onclick="closeReviewModal()">&times;</span>
                <h3>Property Reviews</h3>
                <div>${bodyHtml}</div>
            </div>
        `;
        document.body.appendChild(overlay);
    } catch (err) {
        alert(err.message);
    }
}

async function submitReviewResponse(reviewId) {
    const textarea = document.getElementById(`reviewResponse_${reviewId}`);
    const response = textarea.value.trim();
    if (!response) return;
    try {
        await API.post(`/api/reviews/${reviewId}/respond`, { response });
        closeReviewModal();
    } catch (err) {
        alert(err.message);
    }
}
