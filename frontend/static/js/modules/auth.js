// ==================== Auth ====================
async function checkAuth() {
    try {
        const user = await API.get("/api/auth/me");
        updateNav(user);
        connectWebSocket();
        return user;
    } catch {
        updateNav(null);
        disconnectWebSocket();
        return null;
    }
}

function updateNav(user) {
    const loginLink = document.getElementById("navLogin");
    const signupLink = document.getElementById("navSignup");
    const dashLink = document.getElementById("navDashboard");
    const adminLink = document.getElementById("navAdmin");
    const navMessages = document.getElementById("navMessages");
    const navHotelSetup = document.getElementById("navHotelSetup");
    const navbar = document.querySelector(".navbar");
    const navAccount = document.getElementById("navAccount");
    const navAccountAvatar = document.getElementById("navAccountAvatar");
    const navUserName = document.getElementById("navUserName");
    const navAccountMenu = document.getElementById("navAccountMenu");

    if (user) {
        loginLink.style.display = "none";
        signupLink.style.display = "none";
        dashLink.style.display = user.role === "admin" ? "none" : "inline";
        adminLink.style.display = user.role === "admin" ? "inline" : "none";
        navMessages.style.display = "inline-flex";
        navHotelSetup.style.display = "none";
        navbar.classList.add("navbar-compact");

        if (navAccount) {
            const displayName = user.full_name || user.email;
            navAccount.style.display = "inline-flex";
            navAccountAvatar.textContent = displayName.charAt(0).toUpperCase();
            navUserName.textContent = displayName;

            const menuItems = [];
            if (user.role === "customer") {
                menuItems.push(`<button type="button" onclick="openBookingsModal()">Past Bookings</button>`);
            }
            menuItems.push(user.role === "admin" ? `<a href="/admin">Admin Panel</a>` : `<a href="/dashboard">Dashboard</a>`);
            menuItems.push(`<button type="button" class="nav-account-logout" onclick="logout()">Logout</button>`);
            navAccountMenu.innerHTML = menuItems.join("");
        }
    } else {
        loginLink.style.display = "inline";
        signupLink.style.display = "inline";
        dashLink.style.display = "none";
        adminLink.style.display = "none";
        navMessages.style.display = "none";
        navHotelSetup.style.display = "inline";
        navbar.classList.remove("navbar-compact");
        if (navAccount) navAccount.style.display = "none";
    }
}

async function logout() {
    disconnectWebSocket();
    localStorage.removeItem("ai_chat_session_id");
    await API.post("/api/auth/logout");
    window.location.href = "/";
}
