import os

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.routers import auth, admin, hotels, properties, bookings, messages, reviews
from app import ws
from app.pages import router as pages_router
from app.seed import seed_admin, seed_locations

app = FastAPI(title="HRMS - Hotel Room Management System")

# ── Static files ──────────────────────────────────────────
_base = os.path.dirname(__file__)

app.mount("/static", StaticFiles(directory=os.path.join(_base, "static")), name="static")

_uploads = os.path.join(os.path.dirname(_base), "uploads")
if os.path.exists(_uploads):
    app.mount("/uploads", StaticFiles(directory=_uploads), name="uploads")

# ── Routers ───────────────────────────────────────────────
app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(hotels.router)
app.include_router(properties.router)
app.include_router(bookings.router)
app.include_router(messages.router)
app.include_router(reviews.router)
app.include_router(ws.router)
app.include_router(pages_router)

# ── Startup ───────────────────────────────────────────────
app.add_event_handler("startup", seed_admin)
app.add_event_handler("startup", seed_locations)