import hashlib
import hmac
import bcrypt

from app.database import SessionLocal
from app.models import User, UserRole, Location, LocationType
from app.config import ADMIN_EMAIL, ADMIN_PASSWORD, ADMIN_FULL_NAME, PEPPER

LOCATIONS = {
    "India": {"type": "country", "children": {
        "Delhi": {"type": "state", "children": {
            "Delhi": {"type": "city", "children": {
                "Central Delhi": None, "New Delhi": None, "South Delhi": None,
                "East Delhi": None, "West Delhi": None, "North Delhi": None,
            }},
        }},
        "Haryana": {"type": "state", "children": {
            "Gurugram": {"type": "city", "children": {
                "Sector 14": None, "Sector 28": None, "Sector 29": None,
                "Sector 38": None, "Sector 56": None, "DLF Phase 1": None,
                "DLF Phase 2": None, "DLF Phase 5": None, "Golf Course Road": None,
                "MG Road": None, "Sohna Road": None, "Cyber City": None,
            }},
            "Faridabad": {"type": "city", "children": {
                "Sector 16": None, "Sector 21": None, "Old Faridabad": None,
            }},
        }},
        "Uttar Pradesh": {"type": "state", "children": {
            "Noida": {"type": "city", "children": {
                "Sector 62": None, "Sector 63": None, "Sector 18": None,
                "Sector 15": None, "Sector 44": None,
            }},
            "Lucknow": {"type": "city", "children": {
                "Gomti Nagar": None, "Hazratganj": None, "Aliganj": None,
            }},
            "Agra": {"type": "city", "children": {
                "Tajganj": None, "Rakabganj": None,
            }},
            "Varanasi": {"type": "city", "children": {
                "Cantonment": None, "Assi": None, "Lanka": None,
            }},
        }},
        "Rajasthan": {"type": "state", "children": {
            "Jaipur": {"type": "city", "children": {
                "C Scheme": None, "Vaishali Nagar": None, "Malviya Nagar": None,
                "Bani Park": None, "Sanganer": None,
            }},
            "Udaipur": {"type": "city", "children": {
                "Pichola": None, "Fateh Sagar": None, "Hiran Magri": None,
            }},
            "Jodhpur": {"type": "city", "children": {
                "Paota": None, "Sardarpura": None, "Ratanada": None,
            }},
            "Jaisalmer": {"type": "city", "children": {
                "Fort Area": None, "Sam": None,
            }},
        }},
        "Maharashtra": {"type": "state", "children": {
            "Mumbai": {"type": "city", "children": {
                "Colaba": None, "Andheri": None, "Bandra": None,
                "Juhu": None, "Marine Drive": None,
            }},
            "Pune": {"type": "city", "children": {
                "Koregaon Park": None, "Shivaji Nagar": None, "Hinjewadi": None,
            }},
            "Lonavala": {"type": "city", "children": {}},
        }},
        "Karnataka": {"type": "state", "children": {
            "Bangalore": {"type": "city", "children": {
                "MG Road": None, "Indiranagar": None, "Koramangala": None,
                "Whitefield": None, "Electronic City": None,
            }},
            "Mysore": {"type": "city", "children": {
                "Mysore Palace Area": None, "Gokulam": None,
            }},
        }},
        "Tamil Nadu": {"type": "state", "children": {
            "Chennai": {"type": "city", "children": {
                "T Nagar": None, "Mylapore": None, "Kodambakkam": None,
                "Velachery": None, "Adyar": None,
            }},
            "Ooty": {"type": "city", "children": {}},
        }},
        "West Bengal": {"type": "state", "children": {
            "Kolkata": {"type": "city", "children": {
                "Park Street": None, "Salt Lake": None, "Howrah": None,
            }},
            "Darjeeling": {"type": "city", "children": {}},
        }},
        "Gujarat": {"type": "state", "children": {
            "Ahmedabad": {"type": "city", "children": {
                "Navrangpura": None, "SG Highway": None, "Maninagar": None,
            }},
            "Vadodara": {"type": "city", "children": {}},
        }},
        "Punjab": {"type": "state", "children": {
            "Amritsar": {"type": "city", "children": {
                "Golden Temple Area": None, "Ranjit Avenue": None,
            }},
            "Chandigarh": {"type": "city", "children": {
                "Sector 17": None, "Sector 22": None, "Sector 35": None,
            }},
        }},
        "Himachal Pradesh": {"type": "state", "children": {
            "Shimla": {"type": "city", "children": {
                "Mall Road": None, "Kufri": None,
            }},
            "Manali": {"type": "city", "children": {
                "Old Manali": None, "Mall Road": None,
            }},
            "Dharamshala": {"type": "city", "children": {
                "McLeod Ganj": None, "Bhagsu": None,
            }},
        }},
        "Uttarakhand": {"type": "state", "children": {
            "Dehradun": {"type": "city", "children": {
                "Rajpur Road": None,
            }},
            "Mussoorie": {"type": "city", "children": {}},
            "Nainital": {"type": "city", "children": {}},
            "Rishikesh": {"type": "city", "children": {
                "Tapovan": None, "Laxman Jhula": None,
            }},
        }},
    }},
}


def _insert_location(db, parent, name, type) -> Location:
    loc = Location(name=name, type=type, parent_id=parent.id if parent else None)
    db.add(loc)
    db.flush()
    return loc


def _seed_children(db, parent, children: dict):
    if children is None:
        return
    for name, info in children.items():
        if info is None:
            # Leaf node — district with no further children
            child = Location(name=name, type=LocationType.district, parent_id=parent.id)
            db.add(child)
            db.flush()
        else:
            child = _insert_location(db, parent, name, LocationType(info["type"]))
            if info.get("children"):
                _seed_children(db, child, info["children"])


def seed_locations() -> None:
    """Seed India's states, cities, and districts on first boot if the locations table is empty."""
    db = SessionLocal()
    try:
        if db.query(Location).first():
            return  # already seeded

        india = _insert_location(db, None, "India", LocationType.country)
        _seed_children(db, india, LOCATIONS["India"]["children"])
        db.commit()
        print(f"Locations seeded: India with states, cities & districts.")
    finally:
        db.close()


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
