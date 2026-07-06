"""
belongs at app/routers/bookings.py
"""

import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Booking, BookingStatus, Property, Room, User, UserRole
from app.routers.auth import require_role
from app.schemas import BookingCreate
from app.availability import evaluate_room_for_dates

router = APIRouter(prefix="/api/bookings", tags=["bookings"])
customer_required = require_role(UserRole.customer)


def _serialize(b: Booking) -> dict:
    return {
        "id": str(b.id),
        "room_id": str(b.room_id),
        "property_id": str(b.room.property_id),
        "property_name": b.room.property.name,
        "room_type": b.room.room_type,
        "check_in": b.check_in.isoformat(),
        "check_out": b.check_out.isoformat(),
        "num_adults": b.num_adults,
        "num_children": b.num_children,
        "status": b.status.value,
        "total_price": b.total_price,
        "created_at": b.created_at.isoformat() if b.created_at else None,
    }


@router.post("")
def create_booking(
    req: BookingCreate,
    user: User = Depends(customer_required),
    db: Session = Depends(get_db),
):
    if req.check_out <= req.check_in:
        raise HTTPException(status_code=400, detail="Check-out must be after check-in")
    if req.check_in < date.today():
        raise HTTPException(status_code=400, detail="Check-in cannot be in the past")

    # Idempotency: if the client retried a request that already succeeded
    # (e.g. after a timeout), hand back the original booking instead of
    # creating a duplicate.
    if req.idempotency_key:
        existing = db.query(Booking).filter(Booking.idempotency_key == req.idempotency_key).first()
        if existing:
            return _serialize(existing)

    # Lock the room row for the rest of this transaction. Two requests
    # racing for the last unit will now be serialized here instead of both
    # reading "1 free unit" and both succeeding.
    room = (
        db.query(Room)
        .filter(Room.id == req.room_id, Room.is_active == True)  # noqa: E712
        .with_for_update()
        .first()
    )
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")

    prop = db.query(Property).filter(
        Property.id == room.property_id,
        Property.is_approved == True,  # noqa: E712
        Property.is_active == True,  # noqa: E712
    ).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not available")

    total_guests = req.num_adults + req.num_children
    if req.num_adults > room.capacity_adults or total_guests > (room.capacity_adults + room.capacity_children):
        raise HTTPException(status_code=400, detail="This room can't accommodate that many guests")

    is_available, total_price = evaluate_room_for_dates(db, room, req.check_in, req.check_out)
    if not is_available:
        raise HTTPException(status_code=409, detail="This room is no longer available for the selected dates")

    booking = Booking(
        customer_id=user.id,
        room_id=room.id,
        check_in=req.check_in,
        check_out=req.check_out,
        num_adults=req.num_adults,
        num_children=req.num_children,
        status=BookingStatus.confirmed,
        total_price=total_price,
        idempotency_key=req.idempotency_key,
    )
    db.add(booking)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        if req.idempotency_key:
            existing = db.query(Booking).filter(Booking.idempotency_key == req.idempotency_key).first()
            if existing:
                return _serialize(existing)
        raise HTTPException(status_code=409, detail="Booking conflict, please try again")

    # ── Update trending score ─────────────────────────────────────────────────
    # Increment the property's trending score each time a booking is confirmed
    # so that the search ordering reflects actual booking activity.
    prop.trending_score = (prop.trending_score or 0) + 1
    db.commit()

    db.refresh(booking)
    return _serialize(booking)


@router.get("")
def list_my_bookings(
    user: User = Depends(customer_required),
    db: Session = Depends(get_db),
):
    bookings = (
        db.query(Booking)
        .filter(Booking.customer_id == user.id)
        .order_by(Booking.created_at.desc())
        .all()
    )
    return [_serialize(b) for b in bookings]


@router.post("/cancel-all")
def cancel_all_bookings(
    user: User = Depends(customer_required),
    db: Session = Depends(get_db),
):
    bookings = (
        db.query(Booking)
        .filter(
            Booking.customer_id == user.id,
            Booking.status.in_([BookingStatus.pending, BookingStatus.confirmed]),
            Booking.check_in >= date.today(),
        )
        .all()
    )
    count = len(bookings)
    if count == 0:
        raise HTTPException(status_code=400, detail="No active bookings to cancel")
    for b in bookings:
        b.status = BookingStatus.cancelled
    db.commit()
    return {"message": f"Cancelled {count} booking(s)"}


@router.post("/{booking_id}/cancel")
def cancel_booking(
    booking_id: uuid.UUID,
    user: User = Depends(customer_required),
    db: Session = Depends(get_db),
):
    booking = db.query(Booking).filter(
        Booking.id == booking_id,
        Booking.customer_id == user.id,
    ).first()
    if not booking:
        raise HTTPException(status_code=404, detail="Booking not found")
    if booking.status not in (BookingStatus.pending, BookingStatus.confirmed):
        raise HTTPException(status_code=400, detail="This booking can't be cancelled")
    if booking.check_in < date.today():
        raise HTTPException(status_code=400, detail="Can't cancel a booking that has already started")

    booking.status = BookingStatus.cancelled
    db.commit()
    return {"message": "Booking cancelled"}