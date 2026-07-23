"""
Chat Booking — confirms booking combinations from the AI chatbot.

When a user clicks "Confirm Booking" on a BookingCard in the chat,
this endpoint creates the actual bookings.
"""

import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.db_models import (
    Booking, BookingGroup, BookingStatus, Property, Room, User, UserRole,
)
from app.routers.auth.auth import require_role
from app.services.availability import evaluate_room_for_dates
from app.services.room_combiner import compute_booking_options

router = APIRouter(tags=["chat"])
customer_required = require_role(UserRole.customer)


class BookingConfirmRequest(BaseModel):
    property_id: uuid.UUID
    check_in: date
    check_out: date
    adults: int = Field(..., ge=1)
    children: int = Field(..., ge=0)
    combination: str = Field(..., pattern="^(cheapest|recommended)$")


@router.post("/api/chat/booking-confirm")
def confirm_chat_booking(
    req: BookingConfirmRequest,
    user: User = Depends(customer_required),
    db: Session = Depends(get_db),
):
    """Confirm a booking combination from the chatbot BookingCard.

    Re-computes the room combination to get current availability and prices,
    then creates a BookingGroup and individual Booking rows for each room.
    """
    if req.check_out <= req.check_in:
        raise HTTPException(status_code=400, detail="Check-out must be after check-in")
    if req.check_in < date.today():
        raise HTTPException(status_code=400, detail="Check-in cannot be in the past")

    # Verify property
    prop = db.query(Property).filter(
        Property.id == req.property_id,
        Property.is_approved == True,  # noqa: E712
        Property.is_active == True,  # noqa: E712
    ).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")

    # Re-compute options to get fresh availability and prices
    options = compute_booking_options(
        db=db,
        property_id=req.property_id,
        check_in=req.check_in,
        check_out=req.check_out,
        num_adults=req.adults,
        num_children=req.children,
    )

    combination = options.get(req.combination)
    if not combination:
        raise HTTPException(
            status_code=400,
            detail=f"No {req.combination} combination available for these dates and guests.",
        )

    # Create a booking group for this multi-room booking
    group = BookingGroup(
        customer_id=user.id,
        property_id=req.property_id,
        check_in=req.check_in,
        check_out=req.check_out,
        num_adults=req.adults,
        num_children=req.children,
        total_price=combination["total_price"],
    )
    db.add(group)
    db.flush()  # Get group.id

    # Create bookings for each room type in the combination
    created_bookings = []

    for room_group in combination["rooms"]:
        room_id = uuid.UUID(room_group["room_id"])
        qty = room_group["qty"]

        # Lock the room row
        room = (
            db.query(Room)
            .filter(Room.id == room_id, Room.is_active == True)  # noqa: E712
            .with_for_update()
            .first()
        )
        if not room:
            db.rollback()
            raise HTTPException(status_code=400, detail=f"Room {room_group['room_type']} is no longer available")

        # Verify property still matches
        if str(room.property_id) != str(req.property_id):
            db.rollback()
            raise HTTPException(status_code=400, detail="Room does not belong to this property")

        # Check availability and get fresh price
        available, total_price = evaluate_room_for_dates(db, room, req.check_in, req.check_out)
        if not available:
            db.rollback()
            raise HTTPException(
                status_code=400,
                detail=f"Room {room.room_type} is no longer available for these dates",
            )

        # Distribute guests across rooms of this type
        adults_per_room = req.adults // qty
        children_per_room = req.children // qty
        extra_adults = req.adults % qty
        extra_children = req.children % qty

        for i in range(qty):
            room_adults = adults_per_room + (1 if i < extra_adults else 0)
            room_children = children_per_room + (1 if i < extra_children else 0)

            # Ensure we don't exceed room capacity
            room_adults = min(room_adults, room.capacity_adults)
            room_children = min(room_children, room.capacity_children)

            # Create idempotency key for this specific room
            idem_key = f"chat_{user.id}_{req.property_id}_{req.check_in}_{req.check_out}_{room.id}_{i}"

            # Check for existing booking with this idempotency key
            existing = db.query(Booking).filter(Booking.idempotency_key == idem_key).first()
            if existing:
                created_bookings.append({
                    "id": str(existing.id),
                    "room_type": room.room_type,
                    "total_price": existing.total_price,
                })
                continue

            # Compute per-room price: total_price from evaluate_room_for_dates
            # is the full-stay price for ONE room unit (base_price * nights).
            # Each booking gets this full-stay price — do NOT divide by qty.
            per_room_price = round(total_price, 2)

            booking = Booking(
                customer_id=user.id,
                room_id=room.id,
                group_id=group.id,
                check_in=req.check_in,
                check_out=req.check_out,
                num_adults=room_adults,
                num_children=room_children,
                room_adults=room_adults,
                room_children=room_children,
                status=BookingStatus.confirmed,
                total_price=per_room_price,
                idempotency_key=idem_key,
            )
            db.add(booking)
            created_bookings.append({
                "id": str(booking.id),
                "room_type": room.room_type,
                "total_price": per_room_price,
            })

    # Increment trending score
    prop.trending_score = (prop.trending_score or 0) + 1

    db.commit()

    return {
        "success": True,
        "group_id": str(group.id),
        "bookings": created_bookings,
        "total_price": combination["total_price"],
        "property_name": prop.name,
        "message": f"Successfully booked {len(created_bookings)} room(s) at {prop.name}!",
    }
