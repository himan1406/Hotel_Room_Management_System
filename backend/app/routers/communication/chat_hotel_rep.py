import logging
from datetime import date as date_type

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.db_models import (
    Property, Room, Booking, Review, User, UserRole, Availability, BookingStatus,
)

logger = logging.getLogger(__name__)


# ── Hotel rep system prompt ────────────────────────────────────────────────

HOTEL_REP_PROMPT = """
=== Hotel Representative Dashboard Context ===
{hotel_rep_context}

You are assisting a hotel representative with managing their properties. Follow these rules:

1. Use ONLY the Dashboard Context above to answer questions about this rep's own properties, rooms, bookings, reviews, and availability. Do NOT use the Property Listings section — those are customer-facing search results from all properties in the system, not this rep's data.

2. When asked about room availability (e.g. "how many rooms are available today?"), use the "Room availability today" section from the Dashboard Context. It contains real-time data from the Availability table for today's date.

3. You can help them understand booking trends, occupancy, revenue estimates (based on room prices × bookings), and review sentiment.

4. When they ask about a specific property or location, check if it exists in the Dashboard Context first. If no property in the Dashboard Context matches (e.g. they ask about "gurugram" but have no property there), say so directly — do NOT pull results from Property Listings as a substitute.

5. You can answer questions about policies, amenities, and local attractions using the Document Excerpts.

6. Be helpful and proactive — suggest actions they could take (e.g. "You have 5 pending bookings for Grand Plaza this week" or "Your Sarovar property has a 3.8 rating — consider responding to recent reviews").

7. Do NOT make up data. Only use what is provided in the Dashboard Context above.
"""


# ── Context builder ────────────────────────────────────────────────────────

def _build_hotel_rep_context(db: Session, user) -> str:
    """Build hotel rep dashboard context for injection into the system prompt."""

    # ── 1. Properties owned by this rep ──
    properties = db.query(Property).filter(
        Property.owner_rep_id == user.id
    ).order_by(Property.created_at.desc()).all()

    if not properties:
        return "This hotel representative has no properties registered yet."

    lines = []
    lines.append(f"Total properties: {len(properties)}")

    prop_ids = [p.id for p in properties]

    # ── 2. Room summary per property ──
    all_rooms = db.query(Room).filter(
        Room.property_id.in_(prop_ids),
    ).order_by(Room.property_id, Room.base_price).all()

    rooms_by_prop: dict[str, list] = {}
    for r in all_rooms:
        pid = str(r.property_id)
        if pid not in rooms_by_prop:
            rooms_by_prop[pid] = []
        rooms_by_prop[pid].append(r)

    total_rooms = len(all_rooms)
    lines.append(f"Total rooms across all properties: {total_rooms}")

    # ── 3. Room availability today (real-time) ──
    today = date_type.today()
    room_ids = [str(r.id) for r in all_rooms]
    if room_ids:
        avail_rows = db.query(Availability).filter(
            Availability.room_id.in_(room_ids),
            Availability.date == today,
        ).all()
        avail_map = {str(a.room_id): a.quantity_available for a in avail_rows}

        # Fallback for rooms without availability rows
        uncovered = [r for r in all_rooms if str(r.id) not in avail_map]
        if uncovered:
            booking_counts = db.execute(text("""
                SELECT b.room_id, COUNT(b.id) as cnt
                FROM bookings b
                WHERE b.room_id IN :room_ids
                  AND b.status IN ('pending', 'confirmed')
                  AND b.check_in <= :today
                  AND b.check_out > :today
                GROUP BY b.room_id
            """), {"room_ids": tuple(str(r.id) for r in uncovered), "today": today}).fetchall()
            booked_map = {str(row.room_id): row.cnt for row in booking_counts}
            for r in uncovered:
                avail_map[str(r.id)] = max(0, r.total_quantity - booked_map.get(str(r.id), 0))

        total_available = sum(avail_map.get(str(r.id), r.total_quantity) for r in all_rooms)
        total_booked_today = total_rooms - total_available

        lines.append(f"\nRoom availability today ({today.strftime('%b %d, %Y')}):")
        lines.append(f"  Total: {total_available}/{total_rooms} available | {total_booked_today} occupied")
        for room in all_rooms:
            avail = avail_map.get(str(room.id), room.total_quantity)
            lines.append(f"  - {room.room_type} ({room.property.name}): {avail}/{room.total_quantity} available")

    # ── 4. Booking summary ──
    booking_rows = db.execute(text("""
        SELECT
            b.status,
            COUNT(b.id) as cnt,
            COALESCE(SUM(b.total_price), 0) as revenue
        FROM bookings b
        JOIN rooms r ON b.room_id = r.id
        WHERE r.property_id IN :prop_ids
        GROUP BY b.status
    """), {"prop_ids": tuple(str(pid) for pid in prop_ids)}).fetchall()

    status_counts = {}
    total_revenue = 0
    for row in booking_rows:
        status_counts[row.status] = row.cnt
        if row.status in ("confirmed", "completed"):
            total_revenue += row.revenue

    total_bookings = sum(status_counts.values())
    lines.append(f"\nBookings: {total_bookings} total | "
                 f"{status_counts.get('confirmed', 0)} confirmed | "
                 f"{status_counts.get('completed', 0)} completed | "
                 f"{status_counts.get('pending', 0)} pending | "
                 f"{status_counts.get('cancelled', 0)} cancelled")
    lines.append(f"Estimated revenue (confirmed + completed): ₹{total_revenue:,.0f}")

    # ── 5. Recent bookings (last 10) ──
    recent_bookings = db.execute(text("""
        SELECT
            u.full_name AS customer_name,
            p.name AS property_name,
            rm.room_type,
            b.check_in,
            b.check_out,
            b.num_adults,
            b.num_children,
            b.status,
            b.total_price,
            b.created_at
        FROM bookings b
        JOIN rooms rm ON b.room_id = rm.id
        JOIN properties p ON rm.property_id = p.id
        LEFT JOIN users u ON b.customer_id = u.id
        WHERE p.owner_rep_id = :rep_id
        ORDER BY b.created_at DESC
        LIMIT 10
    """), {"rep_id": str(user.id)}).fetchall()

    if recent_bookings:
        lines.append("\nRecent bookings:")
        for rb in recent_bookings:
            check_in_str = rb.check_in.strftime('%b %d') if rb.check_in else '?'
            check_out_str = rb.check_out.strftime('%b %d') if rb.check_out else '?'
            guests = f"{rb.num_adults}A"
            if rb.num_children:
                guests += f"+{rb.num_children}C"
            lines.append(
                f"  - {rb.customer_name or 'Guest'} → {rb.property_name}, {rb.room_type}, "
                f"{check_in_str}-{check_out_str} ({guests}), {rb.status}, ₹{rb.total_price:,.0f}"
            )

    # ── 6. Review summary per property ──
    review_rows = db.execute(text("""
        SELECT
            p.name AS property_name,
            ROUND(AVG(r.rating)::numeric, 1) AS avg_rating,
            COUNT(r.id) AS review_count,
            SUM(CASE WHEN r.rep_response IS NULL THEN 1 ELSE 0 END) AS unanswered
        FROM reviews r
        JOIN properties p ON r.property_id = p.id
        WHERE p.owner_rep_id = :rep_id
        GROUP BY p.name
        ORDER BY avg_rating DESC
    """), {"rep_id": str(user.id)}).fetchall()

    if review_rows:
        lines.append("\nReview summary:")
        for rr in review_rows:
            unanswered_str = f" ({rr.unanswered} unanswered)" if rr.unanswered else ""
            lines.append(
                f"  - {rr.property_name}: {rr.avg_rating}★ ({rr.review_count} reviews){unanswered_str}"
            )

    # ── 7. Properties detail ──
    lines.append("\nProperties detail:")
    for p in properties:
        city = p.city.name if p.city else "Unknown"
        status = "Approved" if p.is_approved else "Pending approval"
        room_count = len(rooms_by_prop.get(str(p.id), []))
        prop_rooms = rooms_by_prop.get(str(p.id), [])
        if prop_rooms:
            prices = [r.base_price for r in prop_rooms]
            price_range = f"₹{min(prices):,.0f}-₹{max(prices):,.0f}" if prices else "N/A"
            room_types = ", ".join(sorted(set(r.room_type for r in prop_rooms)))
        else:
            price_range = "N/A"
            room_types = "No rooms"
        amenities = [k.replace("_", " ") for k, v in (p.amenities or {}).items() if v]
        amenities_str = ", ".join(amenities[:8]) if amenities else "None listed"

        lines.append(
            f"  - {p.name} | {city} | {p.property_type.value if p.property_type else 'hotel'} | "
            f"{room_count} rooms ({room_types}) | Price: {price_range}/night | "
            f"Rating: {p.avg_rating or 0}★ ({p.review_count or 0} reviews) | "
            f"Amenities: {amenities_str} | {status}"
        )

    return "\n".join(lines)


def build_hotel_rep_prompt_for_user(db: Session, user) -> str:
    """Return the formatted hotel rep prompt for hotel reps, empty string otherwise."""
    if not user or user.role != UserRole.hotel_rep:
        return ""
    try:
        context = _build_hotel_rep_context(db, user)
        return HOTEL_REP_PROMPT.format(hotel_rep_context=context)
    except Exception:
        logger.warning("Failed to build hotel rep context for chat", exc_info=True)
        return ""
