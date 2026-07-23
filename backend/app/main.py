from fastapi import FastAPI

from app.core.lifespan import lifespan
from app.routers.pages import mount_static_files
from app.routers.auth import auth
from app.routers.admin import admin
from app.routers.hotel import hotels
from app.routers.customers import properties, bookings, reviews
from app.routers.communication import messages, chat, chat_admin, chat_booking, rag
from app.routers import pages
from app.services import ws


app = FastAPI(title="HRMS - Hotel Room Management System", lifespan=lifespan)
mount_static_files(app)

# ── Routers ────────────────────────────────────────────────
app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(hotels.router)
app.include_router(properties.router)
app.include_router(bookings.router)
app.include_router(messages.router)
app.include_router(reviews.router)
app.include_router(rag.router)
app.include_router(chat.router)
app.include_router(chat_admin.router)
app.include_router(chat_booking.router)
app.include_router(ws.router)
app.include_router(pages.router)