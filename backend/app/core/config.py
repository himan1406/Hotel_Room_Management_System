import os
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/hotel_booking_db",
)
ACCESS_TOKEN_EXPIRE_MINUTES = 20
REFRESH_TOKEN_EXPIRE_DAYS = 7
COOKIE_SECURE = os.getenv("COOKIE_SECURE", "false").lower() == "true"
ADMIN_EMAIL = os.getenv("ADMIN_EMAIL")
ADMIN_PASSWORD = os.getenv("ADMIN_PASSWORD")
ADMIN_FULL_NAME = os.getenv("ADMIN_FULL_NAME", "System Admin")

PEPPER = os.getenv("PASSWORD_PEPPER")

GROQ_API_KEY = os.getenv("GROQ_API_KEY", "")
GROQ_MODEL = os.getenv("GROQ_MODEL", "llama-3.1-8b-instant")

_missing = [
    name
    for name, value in [
        ("PASSWORD_PEPPER", PEPPER),
        ("ADMIN_EMAIL", ADMIN_EMAIL),
        ("ADMIN_PASSWORD", ADMIN_PASSWORD),
    ]
    if not value
]
if _missing:
    raise ValueError(
        f"Missing required environment variable(s): {', '.join(_missing)}. "
        "Set them in your .env file before starting the application."
    )
