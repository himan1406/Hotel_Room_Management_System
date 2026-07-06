import os
import uuid
import base64

from datetime import date as date_type

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Property, Room, User, UserRole, Location, LocationType, Booking, BookingStatus, Availability
from app.routers.auth import get_current_user, require_role
from app.schemas import PropertyCreate, PropertyResponse, RoomCreate, RoomResponse

MAX_IMAGE_BYTES = 5 * 1024 * 1024
ALLOWED_IMAGE_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}

router = APIRouter(prefix="/api/hotels", tags=["hotels"])
hotel_rep = require_role(UserRole.hotel_rep)


@router.get("/locations")
def list_locations(
    parent_id: uuid.UUID = None,
    type: str = None,
    db: Session = Depends(get_db),
):
    q = db.query(Location)
    if parent_id:
        q = q.filter(Location.parent_id == parent_id)
    if type:
        q = q.filter(Location.type == type)
    return [
        {
            "id": str(l.id),
            "name": l.name,
            "type": l.type.value,
            "parent_id": str(l.parent_id) if l.parent_id else None,
        }
        for l in q.all()
    ]


@router.get("/locations/search")
def search_locations(
    q: str = Query(..., min_length=1, max_length=100),
    type: str = None,
    limit: int = Query(10, ge=1, le=50),
    db: Session = Depends(get_db),
):
    like = f"%{q}%"
    qry = db.query(Location).filter(Location.name.ilike(like))
    if type:
        qry = qry.filter(Location.type == type)
    locations = qry.order_by(Location.name).limit(limit).all()
    if locations:
        return [
            {
                "id": str(l.id),
                "name": l.name,
                "type": l.type.value,
                "parent_id": str(l.parent_id) if l.parent_id else None,
            }
            for l in locations
        ]

    # Fallback: no location found — search property names and addresses
    from app.models import Property as PropertyModel
    prop_q = db.query(PropertyModel).filter(
        PropertyModel.is_approved == True,  # noqa: E712
        PropertyModel.is_active == True,    # noqa: E712
    ).filter(
        PropertyModel.name.ilike(like) | PropertyModel.address.ilike(like)
    ).order_by(PropertyModel.trending_score.desc()).limit(limit).all()

    seen = set()
    results = []
    for p in prop_q:
        for field in (p.city.name if p.city else None, p.district.name if p.district else None, p.name, p.address):
            if field and q.lower() in field.lower() and field not in seen:
                seen.add(field)
                results.append({
                    "id": str(p.id),
                    "name": field,
                    "type": "property",
                    "parent_id": None,
                })
            if len(results) >= limit:
                break
        if len(results) >= limit:
            break
    return results


@router.get("")
def list_my_properties(
    user: User = Depends(hotel_rep),
    db: Session = Depends(get_db),
):
    props = db.query(Property).filter(Property.owner_rep_id == user.id).all()
    return [PropertyResponse.model_validate(p).model_dump() for p in props]


def _ensure_location_from_address(db: Session, address: str | None, prop: Property):
    """Auto-create a city location from the last comma-separated part of the address if no city_id is set."""
    if not address or prop.city_id:
        return
    parts = [p.strip() for p in address.split(",") if p.strip()]
    if not parts:
        return
    candidate = parts[-1]
    existing = db.query(Location).filter(
        Location.name.ilike(candidate),
        Location.type == LocationType.city,
    ).first()
    if existing:
        prop.city_id = existing.id
        return
    # Try to find a parent state for the new city
    # Default to India -> Haryana or just India as parent
    india = db.query(Location).filter(
        Location.name == "India", Location.type == LocationType.country
    ).first()
    if not india:
        return
    # Look for a state that matches the candidate or use a default
    state = db.query(Location).filter(
        Location.parent_id == india.id,
        Location.type == LocationType.state,
    ).first()
    if not state:
        return
    city = Location(name=candidate.title(), type=LocationType.city, parent_id=state.id)
    db.add(city)
    db.flush()
    prop.city_id = city.id


@router.post("")
def create_property(
    req: PropertyCreate,
    user: User = Depends(hotel_rep),
    db: Session = Depends(get_db),
):
    prop = Property(
        name=req.name,
        description=req.description,
        owner_rep_id=user.id,
        property_type=req.property_type,
        city_id=req.city_id,
        district_id=req.district_id,
        address=req.address,
        latitude=req.latitude,
        longitude=req.longitude,
        amenities=req.amenities or {},
    )
    _ensure_location_from_address(db, req.address, prop)
    db.add(prop)
    db.commit()
    db.refresh(prop)
    return PropertyResponse.model_validate(prop).model_dump()


@router.get("/bookings")
def list_rep_bookings(
    user: User = Depends(hotel_rep),
    db: Session = Depends(get_db),
):
    bookings = (
        db.query(Booking)
        .join(Room, Booking.room_id == Room.id)
        .join(Property, Room.property_id == Property.id)
        .filter(Property.owner_rep_id == user.id)
        .order_by(Booking.created_at.desc())
        .all()
    )
    return [
        {
            "id": str(b.id),
            "property_name": b.room.property.name,
            "room_type": b.room.room_type,
            "customer_name": b.customer.full_name,
            "customer_email": b.customer.email,
            "check_in": b.check_in.isoformat(),
            "check_out": b.check_out.isoformat(),
            "num_adults": b.num_adults,
            "num_children": b.num_children,
            "status": b.status.value,
            "total_price": b.total_price,
            "created_at": b.created_at.isoformat() if b.created_at else None,
        }
        for b in bookings
    ]


@router.get("/{property_id}")
def get_property(
    property_id: uuid.UUID,
    user: User = Depends(hotel_rep),
    db: Session = Depends(get_db),
):
    prop = db.query(Property).filter(
        Property.id == property_id,
        Property.owner_rep_id == user.id,
    ).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")
    return PropertyResponse.model_validate(prop).model_dump()


@router.put("/{property_id}")
def update_property(
    property_id: uuid.UUID,
    req: PropertyCreate,
    user: User = Depends(hotel_rep),
    db: Session = Depends(get_db),
):
    prop = db.query(Property).filter(
        Property.id == property_id,
        Property.owner_rep_id == user.id,
    ).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")
    for key, value in req.model_dump(exclude_unset=True).items():
        setattr(prop, key, value)
    _ensure_location_from_address(db, req.address, prop)
    db.commit()
    db.refresh(prop)
    return PropertyResponse.model_validate(prop).model_dump()

async def _save_image(file: UploadFile, prefix: str) -> str:
    content = await file.read()
    if len(content) > MAX_IMAGE_BYTES:
        raise HTTPException(status_code=413, detail="Image too large. Max 5 MB.")
    raw_ext = os.path.splitext(file.filename or "")[1].lower()
    if raw_ext not in ALLOWED_IMAGE_EXTENSIONS:
        raise HTTPException(status_code=415, detail=f"Unsupported format '{raw_ext}'. Allowed: {', '.join(sorted(ALLOWED_IMAGE_EXTENSIONS))}.")
    mime = {"jpg": "image/jpeg", "jpeg": "image/jpeg", "png": "image/png", "webp": "image/webp"}[raw_ext.lstrip(".")]
    b64 = base64.b64encode(content).decode("ascii")
    return f"data:{mime};base64,{b64}"


@router.post("/{property_id}/images")
async def upload_property_images(
    property_id: uuid.UUID,
    files: list[UploadFile] = File(...),
    user: User = Depends(hotel_rep),
    db: Session = Depends(get_db),
):
    prop = db.query(Property).filter(Property.id == property_id, Property.owner_rep_id == user.id).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")
    urls = [await _save_image(f, f"prop_{property_id.hex}") for f in files]
    # Reassign instead of .extend() — SQLAlchemy only tracks dirty state
    # on column reassignment, not in-place list mutation. Without this,
    # the second image onwards is silently lost on commit.
    prop.images = list(prop.images or []) + urls
    db.commit()
    return {"images": prop.images}


@router.delete("/{property_id}/images/{image_index}")
def delete_property_image(
    property_id: uuid.UUID,
    image_index: int,
    user: User = Depends(hotel_rep),
    db: Session = Depends(get_db),
):
    prop = db.query(Property).filter(Property.id == property_id, Property.owner_rep_id == user.id).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")
    if not prop.images or image_index < 0 or image_index >= len(prop.images):
        raise HTTPException(status_code=404, detail="Image not found")
    # Build a new list and reassign — same reason as the upload endpoint:
    # SQLAlchemy only marks a JSONB column dirty on reassignment, not on
    # in-place mutation. Popping directly on prop.images would return the
    # trimmed list to the client but never actually persist the delete.
    images = list(prop.images)
    images.pop(image_index)
    prop.images = images
    db.commit()
    return {"images": prop.images}


@router.get("/{property_id}/rooms")
def list_rooms(
    property_id: uuid.UUID,
    user: User = Depends(hotel_rep),
    db: Session = Depends(get_db),
):
    prop = db.query(Property).filter(
        Property.id == property_id,
        Property.owner_rep_id == user.id,
    ).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")
    rooms = db.query(Room).filter(Room.property_id == property_id).all()

    # Fetch today's availability for all rooms in one query
    today = date_type.today()
    room_ids = [r.id for r in rooms]
    avail_rows = (
        db.query(Availability)
        .filter(Availability.room_id.in_(room_ids), Availability.date == today)
        .all()
    )
    avail_map = {str(a.room_id): a.quantity_available for a in avail_rows}

    # ── Fallback for rooms with no availability rows yet ──────────────────────
    # Rooms created before the auto-seed fix won't have rows, so we can't just
    # show total_quantity — that ignores existing bookings.  Count active
    # bookings for today and subtract from total_quantity instead.
    from sqlalchemy import func as sa_func
    uncovered = [r for r in rooms if str(r.id) not in avail_map]
    if uncovered:
        booking_counts = (
            db.query(Booking.room_id, sa_func.count(Booking.id).label("cnt"))
            .filter(
                Booking.room_id.in_([r.id for r in uncovered]),
                Booking.status.in_([BookingStatus.pending, BookingStatus.confirmed]),
                Booking.check_in <= today,
                Booking.check_out > today,
            )
            .group_by(Booking.room_id)
            .all()
        )
        booked_today = {str(row.room_id): row.cnt for row in booking_counts}
        for r in uncovered:
            avail_map[str(r.id)] = max(0, r.total_quantity - booked_today.get(str(r.id), 0))

    result = []
    for r in rooms:
        data = RoomResponse.model_validate(r).model_dump()
        data["available_today"] = avail_map[str(r.id)]
        result.append(data)
    return result


@router.post("/{property_id}/rooms")
def create_room(
    property_id: uuid.UUID,
    req: RoomCreate,
    user: User = Depends(hotel_rep),
    db: Session = Depends(get_db),
):
    prop = db.query(Property).filter(
        Property.id == property_id,
        Property.owner_rep_id == user.id,
    ).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")
    existing = db.query(Room).filter(
        Room.property_id == property_id,
        Room.room_type == req.room_type,
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="Room type already exists for this property")
    room = Room(
        property_id=property_id,
        room_type=req.room_type,
        base_price=req.base_price,
        capacity_adults=req.capacity_adults,
        capacity_children=req.capacity_children,
        total_quantity=req.total_quantity,
        room_amenities=req.room_amenities or {},
        images=req.images or [],
        extra_details=req.extra_details or {},
    )
    db.add(room)
    db.commit()
    db.refresh(room)

    # ── Auto-generate 180 days of availability ────────────────────────────────
    # Without rows in the availability table the DB trigger that fires on
    # confirmed bookings (decrease_availability) finds nothing to update, so
    # the count never changes.  We seed one row per day so the trigger works
    # correctly from the moment the room is created.
    from datetime import timedelta
    today_seed = date_type.today()
    db.bulk_insert_mappings(Availability, [
        {
            "room_id": room.id,
            "date": today_seed + timedelta(days=i),
            "quantity_available": room.total_quantity,
        }
        for i in range(180)
    ])
    db.commit()

    return RoomResponse.model_validate(room).model_dump()


@router.put("/{property_id}/rooms/{room_id}")
def update_room(
    property_id: uuid.UUID,
    room_id: uuid.UUID,
    req: RoomCreate,
    user: User = Depends(hotel_rep),
    db: Session = Depends(get_db),
):
    prop = db.query(Property).filter(
        Property.id == property_id,
        Property.owner_rep_id == user.id,
    ).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")
    room = db.query(Room).filter(
        Room.id == room_id,
        Room.property_id == property_id,
    ).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    for key, value in req.model_dump(exclude_unset=True).items():
        setattr(room, key, value)
    db.commit()
    db.refresh(room)
    return RoomResponse.model_validate(room).model_dump()


@router.delete("/{property_id}/rooms/{room_id}")
def delete_room(
    property_id: uuid.UUID,
    room_id: uuid.UUID,
    user: User = Depends(hotel_rep),
    db: Session = Depends(get_db),
):
    prop = db.query(Property).filter(
        Property.id == property_id,
        Property.owner_rep_id == user.id,
    ).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")
    room = db.query(Room).filter(
        Room.id == room_id,
        Room.property_id == property_id,
    ).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    db.delete(room)
    db.commit()
    return {"message": "Room deleted"}


@router.post("/{property_id}/rooms/{room_id}/images")
async def upload_room_images(
    property_id: uuid.UUID,
    room_id: uuid.UUID,
    files: list[UploadFile] = File(...),
    user: User = Depends(hotel_rep),
    db: Session = Depends(get_db),
):
    prop = db.query(Property).filter(Property.id == property_id, Property.owner_rep_id == user.id).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")
    room = db.query(Room).filter(Room.id == room_id, Room.property_id == property_id).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    urls = [await _save_image(f, f"room_{room_id.hex}") for f in files]
    # Reassign instead of .extend() — same SQLAlchemy JSONB dirty-tracking fix.
    room.images = list(room.images or []) + urls
    db.commit()
    return {"images": room.images}


@router.delete("/{property_id}/rooms/{room_id}/images/{image_index}")
def delete_room_image(
    property_id: uuid.UUID,
    room_id: uuid.UUID,
    image_index: int,
    user: User = Depends(hotel_rep),
    db: Session = Depends(get_db),
):
    prop = db.query(Property).filter(Property.id == property_id, Property.owner_rep_id == user.id).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")
    room = db.query(Room).filter(Room.id == room_id, Room.property_id == property_id).first()
    if not room:
        raise HTTPException(status_code=404, detail="Room not found")
    if not room.images or image_index < 0 or image_index >= len(room.images):
        raise HTTPException(status_code=404, detail="Image not found")
    # Reassign instead of mutating in place — same JSONB dirty-tracking fix
    # as the property image delete above. Without this the row never
    # actually updates even though the response looks correct.
    images = list(room.images)
    images.pop(image_index)
    room.images = images
    db.commit()
    return {"images": room.images}