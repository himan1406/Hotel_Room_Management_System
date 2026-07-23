import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, joinedload

from app.core.database import get_db
from app.models.db_models import Booking, BookingGroup, BookingStatus, Property, Room, User, UserRole
from app.routers.auth.auth import require_role
from app.models.schemas import BookingCreate, BulkBookingRequest
from app.services.availability import evaluate_room_for_dates

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
        "room_adults": b.room_adults,
        "room_children": b.room_children,
        "group_id": str(b.group_id) if b.group_id else None,
        "status": b.status.value,
        "total_price": b.total_price,
        "created_at": b.created_at.isoformat() if b.created_at else None,
    }


def _serialize_group(g: BookingGroup, bookings: list[Booking]) -> dict:
    return {
        "id": str(g.id),
        "property_id": str(g.property_id),
        "property_name": g.property.name,
        "check_in": g.check_in.isoformat(),
        "check_out": g.check_out.isoformat(),
        "num_adults": g.num_adults,
        "num_children": g.num_children,
        "room_count": len(bookings),
        "total_price": g.total_price,
        "status": bookings[0].status.value if bookings else "unknown",
        "created_at": g.created_at.isoformat() if g.created_at else None,
        "bookings": [
            {
                "room_type": b.room.room_type if b.room else "Room",
                "num_adults": b.room_adults,
                "num_children": b.room_children,
                "total_price": float(b.total_price) if b.total_price else None,
            }
            for b in bookings
        ],
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
    if req.idempotency_key:
        existing = db.query(Booking).filter(Booking.idempotency_key == req.idempotency_key).first()
        if existing:
            return _serialize(existing)
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
        .options(joinedload(Booking.room).joinedload(Room.property))
        .filter(Booking.customer_id == user.id)
        .order_by(Booking.created_at.desc())
        .all()
    )

    # Separate grouped vs ungrouped bookings
    grouped = {}
    ungrouped = []
    for b in bookings:
        if b.group_id:
            gid = str(b.group_id)
            if gid not in grouped:
                grouped[gid] = {"group": b.group, "bookings": []}
            grouped[gid]["bookings"].append(b)
        else:
            ungrouped.append(b)

    groups = [
        _serialize_group(info["group"], info["bookings"])
        for info in grouped.values()
        if info["group"]
    ]

    return {
        "bookings": [_serialize(b) for b in ungrouped],
        "groups": groups,
    }


@router.post("/bulk")
def bulk_booking(
    req: BulkBookingRequest,
    user: User = Depends(customer_required),
    db: Session = Depends(get_db),
):
    if req.check_out <= req.check_in:
        raise HTTPException(status_code=400, detail="Check-out must be after check-in")
    if req.check_in < date.today():
        raise HTTPException(status_code=400, detail="Check-in cannot be in the past")
    if not req.rooms:
        raise HTTPException(status_code=400, detail="At least one room is required")

    prop = db.query(Property).filter(
        Property.id == req.property_id,
        Property.is_approved == True,  # noqa: E712
        Property.is_active == True,  # noqa: E712
    ).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not available")

    # Check for existing group with this idempotency key
    if req.idempotency_key:
        existing_group = db.query(BookingGroup).filter(
            BookingGroup.idempotency_key == req.idempotency_key
        ).first()
        if existing_group:
            existing_bookings = db.query(Booking).filter(Booking.group_id == existing_group.id).all()
            return {
                "group_id": str(existing_group.id),
                "bookings": [_serialize(b) for b in existing_bookings],
                "total_price": existing_group.total_price,
            }

    # Create group
    group = BookingGroup(
        customer_id=user.id,
        property_id=req.property_id,
        check_in=req.check_in,
        check_out=req.check_out,
        num_adults=sum(item.adults_per_room[i] for item in req.rooms for i in range(len(item.adults_per_room))),
        num_children=sum(item.children_per_room[i] for item in req.rooms for i in range(len(item.children_per_room))),
        idempotency_key=req.idempotency_key,
    )
    db.add(group)
    db.flush()  # Get group.id

    created_bookings = []
    total_price = 0.0

    for item in req.rooms:
        room = (
            db.query(Room)
            .filter(Room.id == item.room_id, Room.is_active == True)  # noqa: E712
            .with_for_update()
            .first()
        )
        if not room:
            db.rollback()
            raise HTTPException(status_code=400, detail=f"Room {item.room_id} not found")

        if str(room.property_id) != str(req.property_id):
            db.rollback()
            raise HTTPException(status_code=400, detail="Room does not belong to this property")

        available, room_price = evaluate_room_for_dates(db, room, req.check_in, req.check_out)
        if not available:
            db.rollback()
            raise HTTPException(status_code=409, detail=f"Room {room.room_type} is no longer available")

        qty = item.quantity
        adults_list = item.adults_per_room if item.adults_per_room else [room.capacity_adults] * qty
        children_list = item.children_per_room if item.children_per_room else [0] * qty

        for i in range(qty):
            room_adults = adults_list[i] if i < len(adults_list) else 1
            room_children = children_list[i] if i < len(children_list) else 0

            if room_adults > room.capacity_adults:
                db.rollback()
                raise HTTPException(status_code=400, detail=f"Too many adults for {room.room_type}")
            total_guests = room_adults + room_children
            if total_guests > room.capacity_adults + room.capacity_children:
                db.rollback()
                raise HTTPException(status_code=400, detail=f"Too many guests for {room.room_type}")

            # room_price from evaluate_room_for_dates is the full-stay price
            # for ONE room unit (base_price * nights). Each booking gets this
            # full-stay price — do NOT divide by qty.
            per_room_price = round(room_price, 2)
            idem_key = f"{req.idempotency_key}_{room.id}_{i}" if req.idempotency_key else None

            if idem_key:
                existing = db.query(Booking).filter(Booking.idempotency_key == idem_key).first()
                if existing:
                    created_bookings.append(existing)
                    total_price += existing.total_price or 0
                    continue

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
            created_bookings.append(booking)
            total_price += per_room_price

    group.total_price = round(total_price, 2)

    # Update trending score
    prop.trending_score = (prop.trending_score or 0) + 1

    db.commit()

    for b in created_bookings:
        db.refresh(b)

    return {
        "group_id": str(group.id),
        "bookings": [_serialize(b) for b in created_bookings],
        "total_price": round(total_price, 2),
    }


@router.post("/group/{group_id}/cancel")
def cancel_group(
    group_id: uuid.UUID,
    user: User = Depends(customer_required),
    db: Session = Depends(get_db),
):
    group = db.query(BookingGroup).filter(
        BookingGroup.id == group_id,
        BookingGroup.customer_id == user.id,
    ).first()
    if not group:
        raise HTTPException(status_code=404, detail="Booking group not found")

    bookings = db.query(Booking).filter(
        Booking.group_id == group.id,
        Booking.status.in_([BookingStatus.pending, BookingStatus.confirmed]),
    ).all()
    if not bookings:
        raise HTTPException(status_code=400, detail="No active bookings in this group")

    for b in bookings:
        b.status = BookingStatus.cancelled
    db.commit()
    return {"message": f"Cancelled {len(bookings)} booking(s) in group"}


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

    booking.status = BookingStatus.cancelled
    db.commit()
    return {"message": "Booking cancelled"}
