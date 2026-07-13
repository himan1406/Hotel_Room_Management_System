import os
from contextlib import asynccontextmanager

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app.routers import auth, admin, hotels, properties, bookings, messages, reviews, rag, chat
from app import ws
from app.pages import router as pages_router


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: auto-prune chat sessions older than 90 days
    from app.database import SessionLocal
    from app.routers.chat import prune_old_sessions
    db = None
    try:
        db = SessionLocal()
        count = prune_old_sessions(db, days=90)
        if count:
            print(f"[startup] Pruned {count} stale chat sessions")
    except Exception as exc:
        print(f"[startup] Chat history pruning skipped: {exc}")
    finally:
        if db:
            db.close()
    yield
    # Shutdown: nothing to do


app = FastAPI(title="HRMS - Hotel Room Management System", lifespan=lifespan)

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