import os
from dotenv import load_dotenv

load_dotenv()

DATABASE_URL = os.getenv(
    "DATABASE_URL",
    "postgresql://postgres:postgres@localhost:5432/hotel_booking_db",
)
SESSION_EXPIRE_HOURS = 24
UPLOAD_DIR = os.path.join(os.path.dirname(os.path.dirname(__file__)), "uploads")
ADMIN_EMAIL = "admin@hrms.com"
ADMIN_PASSWORD = "Admin@123"
ADMIN_FULL_NAME = "System Admin"
PEPPER = os.getenv("PASSWORD_PEPPER", "SuperSecretPepperKey123!")

