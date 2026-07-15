from contextlib import asynccontextmanager
from fastapi import FastAPI


@asynccontextmanager
async def lifespan(app: FastAPI):
    # Startup: auto-prune chat sessions older than 90 days
    from app.core.database import SessionLocal
    from app.routers.communication.chat import prune_old_sessions
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
