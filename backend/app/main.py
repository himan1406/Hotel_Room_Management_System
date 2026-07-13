import os

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.routers import auth, admin, hotels, properties, bookings, messages, reviews, rag, chat
from app import ws
from app.pages import router as pages_router

app = FastAPI(title="HRMS - Hotel Room Management System")

_app_dir = os.path.dirname(__file__)          # /app/app
_container_root = os.path.dirname(_app_dir)   # /app
_frontend_dir = os.path.join(_container_root, "frontend")

app.mount("/static", StaticFiles(directory=os.path.join(_frontend_dir, "static")), name="static")


# ── Routers ───────────────────────────────────────────────
app.include_router(auth.router)
app.include_router(admin.router)
app.include_router(hotels.router)
app.include_router(properties.router)
app.include_router(bookings.router)
app.include_router(messages.router)
app.include_router(reviews.router)
app.include_router(rag.router)
app.include_router(chat.router)
app.include_router(ws.router)
app.include_router(pages_router)