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

        // Auto-refresh on 401 — but skip for auth endpoints (they handle their own 401s),
        // EXCEPT /api/auth/me which needs refresh to detect logged-in state on page load.
        if (res.status === 401 && !_isRetry && (!path.startsWith("/api/auth/") || path === "/api/auth/me")) {
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

// Proactively refresh the access token every 15 minutes (before its 20-min expiry)
// so API calls never hit a stale token.  Silently no-ops if not logged in.
setInterval(() => API._tryRefresh(), 15 * 60 * 1000);

// ==================== HTML Escaping ====================
function escapeHtml(str) {
    if (!str) return "";
    const div = document.createElement("div");
    div.textContent = str;
    return div.innerHTML;
}
