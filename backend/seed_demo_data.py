"""
Fills the database with realistic, fully-approved demo data so the app
doesn't feel empty: hotel reps, customers, properties (with photos), rooms
(with 180 days of availability), bookings (past + upcoming), reviews, a
couple of pending/rejected hotel registrations for the admin panel, and a
few sample messages.

Run inside the API container:

    docker compose exec api python seed_demo_data.py

Safe to re-run — if it finds the demo reps already exist it does nothing
rather than creating duplicates. To start over, drop the demo users/
properties first (or just reset the `db` volume) and run again.

All demo accounts share one password so you can log in and poke around:

    Hotel reps:  rep1@demo.com  ... rep6@demo.com
    Customers:   customer1@demo.com ... customer20@demo.com
    Password:    Demo@1234
"""

import base64
import random
import struct
import zlib
from datetime import date, datetime, timedelta, timezone

from app.database import SessionLocal
from app.models import (
    Availability,
    Booking,
    BookingStatus,
    Location,
    LocationType,
    Message,
    PendingHotelRegistration,
    PendingStatus,
    Property,
    PropertyType,
    Review,
    Room,
    User,
    UserRole,
)
from app.routers.auth import hash_password
from app.seed import seed_locations

random.seed(42)  # reproducible demo data across runs

DEMO_PASSWORD = "Demo@1234"
NUM_REPS = 6
NUM_CUSTOMERS = 20
AVAILABILITY_DAYS = 180


# ─────────────────────────────────────────────────────────────────────────
# Tiny placeholder photos — generated on the fly (no network / asset files
# needed) so property & room galleries aren't empty. Solid-color PNGs are
# enough to demo the upload/gallery/delete UI.
# ─────────────────────────────────────────────────────────────────────────
def _make_png(width: int, height: int, rgb: tuple) -> bytes:
    def chunk(tag: bytes, data: bytes) -> bytes:
        c = tag + data
        return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

    sig = b"\x89PNG\r\n\x1a\n"
    ihdr = struct.pack(">IIBBBBB", width, height, 8, 2, 0, 0, 0)  # 8-bit truecolor
    row = b"\x00" + bytes(rgb) * width  # filter byte + RGB triples
    raw = row * height
    idat = zlib.compress(raw)
    return sig + chunk(b"IHDR", ihdr) + chunk(b"IDAT", idat) + chunk(b"IEND", b"")


def _placeholder_data_uri(rgb: tuple) -> str:
    b64 = base64.b64encode(_make_png(320, 200, rgb)).decode("ascii")
    return f"data:image/png;base64,{b64}"


PALETTE = [
    (243, 175, 196), (156, 144, 232), (241, 231, 212),
    (168, 213, 186), (250, 208, 141), (163, 201, 227),
    (230, 190, 138), (200, 160, 210),
]


def sample_images(n: int) -> list:
    colors = random.sample(PALETTE, k=min(n, len(PALETTE)))
    while len(colors) < n:
        colors.append(random.choice(PALETTE))
    return [_placeholder_data_uri(c) for c in colors[:n]]


# ─────────────────────────────────────────────────────────────────────────
# Content pools
# ─────────────────────────────────────────────────────────────────────────
REP_NAMES = [
    "Anil Malhotra", "Priya Sharma", "Rohit Kapoor", "Sneha Iyer",
    "Vikram Chauhan", "Neha Bansal",
]
CUSTOMER_NAMES = [
    "Aditya Rao", "Kavya Nair", "Arjun Mehta", "Ishita Gupta", "Karan Singh",
    "Riya Desai", "Siddharth Joshi", "Ananya Pillai", "Rahul Verma", "Meera Pillai",
    "Varun Khanna", "Pooja Reddy", "Aman Tiwari", "Divya Menon", "Nikhil Saxena",
    "Tanvi Agarwal", "Yash Choudhary", "Simran Kaur", "Abhishek Jain", "Nandini Rao",
]
NAME_TEMPLATES = [
    "The {city} Grand", "{city} Heritage Resort", "Cozy {city} Homestay",
    "{city} Palm Villa", "The {city} Residency", "{city} Riverside Inn",
    "{city} Boutique Stay", "Hotel {city} Continental", "{city} Garden Retreat",
    "The {city} Serai",
]
DESCRIPTIONS = [
    "A relaxed stay with easy access to the city's best spots, warm service and comfortable rooms.",
    "Modern comfort meets local charm — ideal for both business trips and weekend getaways.",
    "Quiet, well-kept rooms and attentive staff, just minutes from the main attractions.",
    "A favorite among returning travelers for its friendly hosts and spotless rooms.",
    "Thoughtfully designed spaces with all the essentials, in a convenient location.",
]
PROPERTY_AMENITY_KEYS = ["wifi", "parking", "pool", "gym", "ac", "bar", "restaurant", "spa"]
ROOM_AMENITY_KEYS = ["wifi", "ac", "tv", "minibar", "balcony", "bathtub", "room_service", "safe"]
ROOM_TYPES = [
    ("Standard Room", 1800, 2500, 2, 0),
    ("Deluxe Room", 2800, 4200, 2, 1),
    ("Executive Suite", 4500, 7000, 2, 2),
    ("Family Room", 3200, 4800, 3, 2),
    ("Premium Room with Balcony", 3800, 5500, 2, 1),
]
REVIEW_COMMENTS = [
    "Great location and the staff went out of their way to help us.",
    "Room was clean and comfortable, would definitely stay again.",
    "Good value for money, though the wifi was a bit patchy.",
    "Loved the breakfast and the quiet surroundings — very relaxing stay.",
    "Check-in was smooth and the room matched the photos exactly.",
    "Decent stay overall, a couple of minor maintenance issues in the bathroom.",
    "One of the better stays we've had this year, highly recommend.",
    "Comfortable beds and a great view, but the AC was a bit noisy.",
]
REP_RESPONSES = [
    "Thank you for the kind words — we hope to host you again soon!",
    "We're glad you enjoyed your stay. Really appreciate the feedback on the wifi, we're looking into it.",
    "Thanks for flagging the maintenance issue, we've had it looked at right away.",
]
MESSAGE_BODIES = [
    "Hi, is early check-in possible around 9 AM?",
    "Sure, we can try to arrange that — please let us know your flight timing.",
    "Does the room have an extra bed option for a child?",
    "Yes, we can add an extra bed for a small additional charge.",
    "What time is checkout on the last day?",
]


def make_email(prefix: str, i: int) -> str:
    return f"{prefix}{i}@demo.com"


def seed_users(db):
    reps, customers = [], []
    for i in range(1, NUM_REPS + 1):
        email = make_email("rep", i)
        user = User(
            email=email,
            password_hash=hash_password(DEMO_PASSWORD),
            role=UserRole.hotel_rep,
            full_name=REP_NAMES[(i - 1) % len(REP_NAMES)],
            phone=f"9{random.randint(100000000, 999999999)}",
            is_active=True,
        )
        db.add(user)
        reps.append(user)

    for i in range(1, NUM_CUSTOMERS + 1):
        email = make_email("customer", i)
        user = User(
            email=email,
            password_hash=hash_password(DEMO_PASSWORD),
            role=UserRole.customer,
            full_name=CUSTOMER_NAMES[(i - 1) % len(CUSTOMER_NAMES)],
            phone=f"8{random.randint(100000000, 999999999)}",
            is_active=True,
        )
        db.add(user)
        customers.append(user)

    db.flush()
    return reps, customers


def seed_pending_registrations(db):
    """A few rows so the admin panel isn't empty either."""
    samples = [
        ("pending1@demo.com", "Farhan Sheikh", PendingStatus.pending),
        ("pending2@demo.com", "Lakshmi Venkatesh", PendingStatus.pending),
        ("rejected1@demo.com", "Old Fort Stays", PendingStatus.rejected),
    ]
    for email, name, status in samples:
        db.add(PendingHotelRegistration(
            email=email,
            password_hash=hash_password(DEMO_PASSWORD),
            full_name=name,
            phone=f"7{random.randint(100000000, 999999999)}",
            status=status,
        ))
    db.flush()


def seed_properties_and_rooms(db, reps):
    cities = db.query(Location).filter(Location.type == LocationType.city).all()
    if not cities:
        raise RuntimeError("No cities found — location seed didn't run correctly.")

    properties = []
    for rep in reps:
        for _ in range(random.randint(2, 3)):
            city = random.choice(cities)
            districts = db.query(Location).filter(
                Location.parent_id == city.id, Location.type == LocationType.district
            ).all()
            district = random.choice(districts) if districts else None

            ptype = random.choice(list(PropertyType))
            name = random.choice(NAME_TEMPLATES).format(city=city.name)
            amenities = {k: True for k in random.sample(PROPERTY_AMENITY_KEYS, k=random.randint(3, 6))}

            prop = Property(
                name=name,
                description=random.choice(DESCRIPTIONS),
                owner_rep_id=rep.id,
                property_type=ptype,
                city_id=city.id,
                district_id=district.id if district else None,
                address=f"{random.randint(1, 200)}, {district.name if district else city.name} Road, {city.name}",
                amenities=amenities,
                images=sample_images(random.randint(2, 4)),
                is_approved=True,
                is_active=True,
                trending_score=random.uniform(0, 20),
            )
            db.add(prop)
            db.flush()
            properties.append(prop)

            room_specs = random.sample(ROOM_TYPES, k=random.randint(2, 4))
            for room_type, lo, hi, adults, children in room_specs:
                room = Room(
                    property_id=prop.id,
                    room_type=room_type,
                    base_price=float(random.randint(lo, hi)),
                    capacity_adults=adults,
                    capacity_children=children,
                    total_quantity=random.randint(3, 8),
                    room_amenities={k: True for k in random.sample(ROOM_AMENITY_KEYS, k=random.randint(3, 6))},
                    images=sample_images(random.randint(1, 3)),
                    is_active=True,
                )
                db.add(room)
                db.flush()

                today = date.today()
                db.bulk_insert_mappings(Availability, [
                    {
                        "room_id": room.id,
                        "date": today + timedelta(days=i),
                        "quantity_available": room.total_quantity,
                    }
                    for i in range(AVAILABILITY_DAYS)
                ])
    db.commit()
    return properties


def seed_bookings_and_reviews(db, properties, customers):
    all_rooms = []
    for prop in properties:
        rooms = db.query(Room).filter(Room.property_id == prop.id).all()
        for r in rooms:
            all_rooms.append((prop, r))

    completed_bookings = []
    today = date.today()

    # ── Past, completed stays (fuel for reviews) ──────────────────────────
    for _ in range(60):
        prop, room = random.choice(all_rooms)
        customer = random.choice(customers)
        nights = random.randint(1, 5)
        start_offset = random.randint(10, 180)
        check_in = today - timedelta(days=start_offset)
        check_out = check_in + timedelta(days=nights)
        booking = Booking(
            customer_id=customer.id,
            room_id=room.id,
            check_in=check_in,
            check_out=check_out,
            num_adults=random.randint(1, room.capacity_adults),
            num_children=random.randint(0, room.capacity_children),
            status=BookingStatus.completed,
            total_price=round(room.base_price * nights, 2),
        )
        db.add(booking)
        db.flush()
        completed_bookings.append((booking, prop, customer))

    # ── A handful of cancelled past bookings, for status variety ──────────
    for _ in range(8):
        prop, room = random.choice(all_rooms)
        customer = random.choice(customers)
        nights = random.randint(1, 3)
        check_in = today - timedelta(days=random.randint(15, 90))
        check_out = check_in + timedelta(days=nights)
        db.add(Booking(
            customer_id=customer.id,
            room_id=room.id,
            check_in=check_in,
            check_out=check_out,
            num_adults=random.randint(1, room.capacity_adults),
            num_children=0,
            status=BookingStatus.cancelled,
            total_price=round(room.base_price * nights, 2),
        ))

    # ── Upcoming, confirmed bookings (these actually decrement the live
    #    availability counters via the DB trigger, same as real bookings) ──
    for _ in range(25):
        prop, room = random.choice(all_rooms)
        customer = random.choice(customers)
        nights = random.randint(1, 4)
        check_in = today + timedelta(days=random.randint(1, 60))
        check_out = check_in + timedelta(days=nights)
        db.add(Booking(
            customer_id=customer.id,
            room_id=room.id,
            check_in=check_in,
            check_out=check_out,
            num_adults=random.randint(1, room.capacity_adults),
            num_children=random.randint(0, room.capacity_children),
            status=BookingStatus.confirmed,
            total_price=round(room.base_price * nights, 2),
        ))

    db.commit()

    # ── Reviews for ~70% of completed stays ────────────────────────────────
    # avg_rating / review_count on Property are recomputed automatically by
    # the trigger_update_rating DB trigger — no need to touch them here.
    reviewed = random.sample(completed_bookings, k=int(len(completed_bookings) * 0.7))
    for booking, prop, customer in reviewed:
        rating = random.choices([3, 4, 5], weights=[2, 4, 5])[0]
        has_response = random.random() < 0.4
        db.add(Review(
            booking_id=booking.id,
            customer_id=customer.id,
            property_id=prop.id,
            rating=rating,
            comment=random.choice(REVIEW_COMMENTS),
            rep_response=random.choice(REP_RESPONSES) if has_response else None,
            responded_at=datetime.now(timezone.utc) if has_response else None,
        ))
    db.commit()


def seed_messages(db, properties, customers):
    for prop in random.sample(properties, k=min(10, len(properties))):
        customer = random.choice(customers)
        thread = random.sample(MESSAGE_BODIES, k=random.randint(2, 4))
        for i, body in enumerate(thread):
            db.add(Message(
                sender_id=customer.id if i % 2 == 0 else prop.owner_rep_id,
                receiver_id=prop.owner_rep_id if i % 2 == 0 else customer.id,
                property_id=prop.id,
                body=body,
                is_read=True,
            ))
    db.commit()


def main():
    db = SessionLocal()
    try:
        if db.query(User).filter(User.email == make_email("rep", 1)).first():
            print("Demo data already present (rep1@demo.com exists) — skipping. "
                  "Reset the db volume if you want to reseed from scratch.")
            return

        print("Seeding locations (if needed)...")
        seed_locations()

        print("Creating hotel reps & customers...")
        reps, customers = seed_users(db)
        db.commit()

        print("Creating pending/rejected hotel registrations for the admin panel...")
        seed_pending_registrations(db)
        db.commit()

        print("Creating properties, rooms & availability...")
        properties = seed_properties_and_rooms(db, reps)

        print("Creating bookings & reviews...")
        seed_bookings_and_reviews(db, properties, customers)

        print("Creating sample messages...")
        seed_messages(db, properties, customers)

        print("\nDone.")
        print(f"  {len(reps)} hotel reps, {len(customers)} customers, {len(properties)} properties")
        print(f"  Login with any demo account + password: {DEMO_PASSWORD}")
        print("  e.g. rep1@demo.com / customer1@demo.com")
    except Exception:
        db.rollback()
        raise
    finally:
        db.close()


if __name__ == "__main__":
    main()