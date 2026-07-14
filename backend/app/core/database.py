from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker, declarative_base

from app.core.config import DATABASE_URL

engine = create_engine(
    DATABASE_URL,
    pool_size=10,          # keep up to 10 persistent connections
    max_overflow=20,       # allow 20 extra connections under burst load
    pool_pre_ping=True,    # validate connections before use (handles DB restarts)
    pool_recycle=1800,     # recycle connections every 30 min to avoid stale sockets
)
SessionLocal = sessionmaker(autocommit=False, autoflush=False, bind=engine)
Base = declarative_base()


def get_db():
    db = SessionLocal()
    try:
        yield db
    finally:
        db.close()
