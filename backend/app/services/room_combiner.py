"""
Room Combiner — computes optimal room combinations for a booking request.

Given a property, date range, and guest counts, finds feasible room
combinations and returns the cheapest and recommended options.
"""

import logging
from datetime import date
from itertools import product as iterproduct

from sqlalchemy.orm import Session

from app.models.db_models import Room
from app.services.availability import evaluate_room_for_dates

logger = logging.getLogger(__name__)


def _get_available_rooms(
    db: Session,
    property_id,
    check_in: date,
    check_out: date,
) -> list[dict]:
    """Fetch all active rooms and check availability for the date range.

    Returns a list of room option dicts with availability info.
    """
    rooms = (
        db.query(Room)
        .filter(
            Room.property_id == property_id,
            Room.is_active == True,  # noqa: E712
        )
        .order_by(Room.base_price)
        .all()
    )

    options = []
    for room in rooms:
        available, total_price = evaluate_room_for_dates(db, room, check_in, check_out)
        if not available:
            continue

        nights = (check_out - check_in).days
        # total_price from evaluate_room_for_dates is the price for ONE unit
        # across all nights (base_price * nights or sum of overrides).
        # Dividing by nights gives the per-unit-per-night rate.
        price_per_unit = total_price / nights if nights > 0 else room.base_price

        options.append({
            "room_id": str(room.id),
            "room_type": room.room_type,
            "capacity_adults": room.capacity_adults,
            "capacity_children": room.capacity_children,
            "total_quantity": room.total_quantity,
            "base_price": room.base_price,
            "price_per_unit_per_night": round(price_per_unit, 2),
        })

    return options


def _find_combinations(
    room_options: list[dict],
    num_adults: int,
    num_children: int,
    nights: int,
) -> list[dict]:
    """Enumerate feasible room combinations that accommodate all guests.

    Uses bounded enumeration over room types. For each combination of
    room quantities, checks capacity constraints and computes total price
    for the full stay duration (nights).

    Returns a list of valid combinations sorted by total_price ascending.
    """
    if not room_options:
        return []

    # For each room type, the max quantity we'd ever need is bounded by:
    # - available quantity (total_quantity)
    # - guest needs (can't use more rooms than guests)
    max_qty_per_type = []
    for opt in room_options:
        max_adult_needed = (num_adults + opt["capacity_adults"] - 1) // opt["capacity_adults"] if opt["capacity_adults"] > 0 else num_adults
        max_child_needed = (num_children + opt["capacity_children"] - 1) // opt["capacity_children"] if opt["capacity_children"] > 0 else num_children
        max_by_guests = max(max_adult_needed, max_child_needed)
        max_qty = min(opt["total_quantity"], max_by_guests, 10)  # cap at 10 for tractability
        max_qty_per_type.append(max_qty)

    # Enumerate all combinations of quantities
    ranges = [range(0, mq + 1) for mq in max_qty_per_type]
    valid_combinations = []

    for qty_combo in iterproduct(*ranges):
        # Skip all-zero combination
        if all(q == 0 for q in qty_combo):
            continue

        total_adult_cap = 0
        total_child_cap = 0
        total_price = 0.0
        rooms_used = []

        for i, qty in enumerate(qty_combo):
            if qty == 0:
                continue
            opt = room_options[i]
            adult_cap = qty * opt["capacity_adults"]
            child_cap = qty * opt["capacity_children"]
            total_adult_cap += adult_cap
            total_child_cap += child_cap
            # Multiply by nights to get full stay cost (not just per-night)
            subtotal = round(opt["price_per_unit_per_night"] * qty * nights, 2)
            total_price += subtotal
            rooms_used.append({
                "room_type": opt["room_type"],
                "room_id": opt["room_id"],
                "qty": qty,
                "price_per_night": opt["price_per_unit_per_night"],
                "subtotal": subtotal,
            })

        # Check capacity constraints
        if total_adult_cap >= num_adults and total_child_cap >= num_children:
            valid_combinations.append({
                "rooms": rooms_used,
                "total_price": round(total_price, 2),
                "num_rooms": sum(qty_combo),
            })

    return valid_combinations


def compute_booking_options(
    db: Session,
    property_id,
    check_in: date,
    check_out: date,
    num_adults: int,
    num_children: int,
) -> dict:
    """Compute the cheapest and recommended room combinations.

    Args:
        db: Database session.
        property_id: The property UUID.
        check_in: Check-in date.
        check_out: Check-out date.
        num_adults: Number of adult guests.
        num_children: Number of child guests.

    Returns:
        dict with keys: cheapest, recommended, nights, check_in, check_out,
        num_adults, num_children. Each combination has rooms, total_price,
        num_rooms. Returns None for a combination if no feasible option exists.
    """
    nights = (check_out - check_in).days

    if nights <= 0:
        return {"cheapest": None, "recommended": None}

    room_options = _get_available_rooms(db, property_id, check_in, check_out)

    if not room_options:
        return {"cheapest": None, "recommended": None}

    combinations = _find_combinations(room_options, num_adults, num_children, nights)

    if not combinations:
        return {"cheapest": None, "recommended": None}

    # Cheapest: sort by total_price
    by_price = sorted(combinations, key=lambda c: c["total_price"])
    cheapest = by_price[0]

    # Recommended: minimize rooms, then prefer higher base_price, then cheaper
    by_quality = sorted(
        combinations,
        key=lambda c: (
            c["num_rooms"],
            -sum(r["price_per_night"] * r["qty"] for r in c["rooms"]),
            c["total_price"],
        ),
    )
    recommended = by_quality[0]

    # If cheapest and recommended are the same, pick the second-best for
    # recommended if available
    if recommended["total_price"] == cheapest["total_price"] and len(by_price) > 1:
        # Find a different combination for recommended
        for combo in by_quality:
            if combo["total_price"] != cheapest["total_price"]:
                recommended = combo
                break

    return {
        "cheapest": cheapest,
        "recommended": recommended,
        "nights": nights,
        "check_in": check_in.isoformat(),
        "check_out": check_out.isoformat(),
        "num_adults": num_adults,
        "num_children": num_children,
    }
