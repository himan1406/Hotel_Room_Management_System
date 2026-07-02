import hashlib
import hmac
import bcrypt

from app.database import SessionLocal
from app.models import User, UserRole
from app.config import ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_FULL_NAME, PEPPER


def seed_admin() -> None:
    """Create the admin user on first boot if it doesn't exist."""
    if not ADMIN_EMAIL or not ADMIN_PASSWORD or not PEPPER:
        print("WARNING: ADMIN_EMAIL, ADMIN_PASSWORD, or PASSWORD_PEPPER not set — skipping admin seed.")
        return

    db = SessionLocal()
    try:
        if db.query(User).filter(User.email == ADMIN_EMAIL).first():
            return  # already exists

        peppered = hmac.new(
            PEPPER.encode("utf-8"),
            ADMIN_PASSWORD.encode("utf-8"),
            hashlib.sha256,
        ).hexdigest()
        hashed = bcrypt.hashpw(peppered.encode("utf-8"), bcrypt.gensalt()).decode("utf-8")

        db.add(User(
            email=ADMIN_EMAIL,
            password_hash=hashed,
            role=UserRole.admin,
            full_name=ADMIN_FULL_NAME,
            is_active=True,
        ))
        db.commit()
        print(f"Admin user seeded: {ADMIN_EMAIL}")
    finally:
        db.close()
