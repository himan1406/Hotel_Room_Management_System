"""
Availability engine — belongs at app/availability.py

Single source of truth for "is this room bookable for these dates, and what
does it cost", used by both the public search endpoint and booking creation
so the two can never disagree with each other.

IMPORTANT — this cooperates with DB triggers defined in the initial Alembic
migration (001_initial_schema):
  - `decrease_availability`: on a booking INSERT/UPDATE that lands on
    status='confirmed', decrements `availability.quantity_available` for
    every date in the stay — but only for rows that already exist.
  - `restore_availability`: on 'confirmed' -> 'cancelled', increments it
    back — again, only for rows that already exist.

That means, for a given (room, date):
  - If an `Availability` row exists, `quantity_available` is a LIVE counter
    already net of every confirmed booking. We must trust it directly and
    must NOT also count bookings against it — doing so double-subtracts the
    same booking (once via the trigger, once via our own COUNT) and burns
    through capacity roughly twice as fast as it should.
  - If no row exists yet for that date, the trigger has nothing to update,
    so there's no DB-level enforcement — we fall back to counting active
    bookings against the room's default `total_quantity`.

Performance note:
  All DB I/O is done in at most 2 round-trips per call (one bulk
  availability SELECT, one optional bulk booking COUNT) instead of the
  previous one-query-per-night approach.
"""

from datetime import date, timedelta
from typing import Dict

from sqlalchemy.orm import Session

from app.models import Availability, Booking, BookingStatus, Room

ACTIVE_BOOKING_STATUSES = (BookingStatus.pending, BookingStatus.confirmed)


def evaluate_room_for_dates(db: Session, room: Room, check_in: date, check_out: date) -> tuple[bool, float]:
    """
    Returns (is_available, total_price) for `room` across every night in
    [check_in, check_out). is_available is False as soon as any single night
    has no free unit; total_price is only meaningful when is_available is True.

    Uses at most 2 DB round-trips regardless of the number of nights:
      1. Bulk-fetch all Availability rows for the date range.
      2. (Only if needed) A single GROUP BY query counting booked units for
         dates that have no Availability row yet.
    """
    nights = (check_out - check_in).days
    all_dates = [check_in + timedelta(days=i) for i in range(nights)]

    # ── Round-trip 1: bulk-fetch all Availability rows for this room + range ──
    avail_rows: Dict[date, Availability] = {
        row.date: row
        for row in db.query(Availability).filter(
            Availability.room_id == room.id,
            Availability.date >= check_in,
            Availability.date < check_out,
        ).all()
    }

    # Identify dates that have NO Availability row — these need the booking
    # fallback path (trigger has nothing to decrement for these dates).
    uncovered_dates = [d for d in all_dates if d not in avail_rows]

    # ── Round-trip 2 (optional): bulk-count overlapping bookings per date ─────
    # We use a single GROUP BY query instead of one COUNT per date.
    booking_counts: Dict[date, int] = {}
    if uncovered_dates:
        # Count active bookings that overlap each uncovered date.
        # A booking overlaps date D when check_in <= D < check_out.
        overlapping = (
            db.query(Booking)
            .filter(
                Booking.room_id == room.id,
                Booking.status.in_(ACTIVE_BOOKING_STATUSES),
                Booking.check_in < check_out,   # booking starts before our window ends
                Booking.check_out > check_in,   # booking ends after our window starts
            )
            .all()
        )
        for d in uncovered_dates:
            booking_counts[d] = sum(
                1 for b in overlapping if b.check_in <= d < b.check_out
            )

    # ── Evaluate each night in-memory ─────────────────────────────────────────
    total_price = 0.0
    for d in all_dates:
        if d in avail_rows:
            avail = avail_rows[d]
            if avail.quantity_available <= 0:
                return False, 0.0
            nightly_rate = avail.price_override if avail.price_override else room.base_price
        else:
            booked_units = booking_counts.get(d, 0)
            if booked_units >= room.total_quantity:
                return False, 0.0
            nightly_rate = room.base_price

        total_price += nightly_rate

    return True, round(total_price, 2)