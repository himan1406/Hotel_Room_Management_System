"""
belongs at app/routers/properties.py
"""

import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_
from sqlalchemy.orm import Session, aliased

from app.database import get_db
from app.models import Location, Property, Room, User, PropertyDocument
from app.availability import evaluate_room_for_dates

router = APIRouter(prefix="/api/properties", tags=["properties"])


@router.get("/search")
def search_properties(
    location: str | None = Query(None, description="City, district, property name or address"),
    check_in: date | None = Query(None),
    check_out: date | None = Query(None),
    adults: int = Query(1, ge=1),
    children: int = Query(0, ge=0),
    property_type: str | None = Query(None, regex="^(hotel|villa|homestay|resort)$"),
    amenities: list[str] = Query([], description="Required amenities (e.g. wifi, pool)"),
    min_price: float | None = Query(None, ge=0, description="Minimum room price per night"),
    max_price: float | None = Query(None, ge=0, description="Maximum room price per night"),
    min_rating: float | None = Query(None, ge=0, le=5, description="Minimum average rating"),
    sort_by: str = Query("trending", regex="^(trending|price_asc|price_desc|rating_desc)$"),
    skip: int = Query(0, ge=0, description="Number of results to skip (for pagination)"),
    limit: int = Query(20, ge=1, le=100, description="Maximum number of results to return"),
    db: Session = Depends(get_db),
):
    if bool(check_in) != bool(check_out):
        raise HTTPException(status_code=400, detail="Provide both check-in and check-out, or neither")
    if check_in and check_out:
        if check_out <= check_in:
            raise HTTPException(status_code=400, detail="Check-out must be after check-in")
        if check_in < date.today():
            raise HTTPException(status_code=400, detail="Check-in cannot be in the past")

    city = aliased(Location)
    district = aliased(Location)

    q = (
        db.query(Property)
        .outerjoin(city, Property.city_id == city.id)
        .outerjoin(district, Property.district_id == district.id)
        .filter(Property.is_approved == True, Property.is_active == True)  # noqa: E712
    )

    if location:
        like = f"%{location.strip()}%"
        q = q.filter(or_(
            Property.name.ilike(like),
            Property.address.ilike(like),
            city.name.ilike(like),
            district.name.ilike(like),
        ))

    if property_type:
        q = q.filter(Property.property_type == property_type)

    if amenities:
        for amenity in amenities:
            q = q.filter(Property.amenities[amenity].astext == "true")

    if min_rating is not None:
        q = q.filter(Property.avg_rating >= min_rating)

    if min_price is not None or max_price is not None:
        room_subq = db.query(Room.property_id).filter(Room.is_active == True)
        if min_price is not None:
            room_subq = room_subq.filter(Room.base_price >= min_price)
        if max_price is not None:
            room_subq = room_subq.filter(Room.base_price <= max_price)
        q = q.filter(Property.id.in_(room_subq.subquery()))

    if sort_by == "rating_desc":
        q = q.order_by(Property.avg_rating.desc())
    elif sort_by == "trending":
        q = q.order_by(Property.trending_score.desc())

    properties = q.all()

    if sort_by == "price_asc" or sort_by == "price_desc":
        def min_room_price(pid):
            rooms = db.query(Room).filter(Room.property_id == pid, Room.is_active == True).all()
            return min((r.base_price for r in rooms), default=0)
        properties.sort(key=lambda p: min_room_price(p.id), reverse=(sort_by == "price_desc"))

    results = []
    for prop in properties:
        rooms = db.query(Room).filter(
            Room.property_id == prop.id,
            Room.is_active == True,  # noqa: E712
            Room.capacity_adults >= adults,
            (Room.capacity_adults + Room.capacity_children) >= (adults + children),
        ).all()

        matching_rooms = []
        for room in rooms:
            if check_in and check_out:
                available, total_price = evaluate_room_for_dates(db, room, check_in, check_out)
                if not available:
                    continue
                nights = (check_out - check_in).days
            else:
                total_price = room.base_price
                nights = None

            matching_rooms.append({
                "id": str(room.id),
                "room_type": room.room_type,
                "base_price": room.base_price,
                "capacity_adults": room.capacity_adults,
                "capacity_children": room.capacity_children,
                "images": room.images or [],
                "total_price": total_price,
                "nights": nights,
            })

        if not matching_rooms:
            continue

        matching_rooms.sort(key=lambda r: r["total_price"])

        # â”€â”€ Thumbnail & photo count â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
        # Prefer a property-level photo (uploaded by the rep for the property
        # as a whole) and only fall back to a room photo if the property has
        # none. photo_count lets the UI show "12 photos" on the card so
        # travelers know there's more to see before opening the gallery.
        prop_images = prop.images or []
        thumbnail = prop_images[0] if prop_images else next(
            (r["images"][0] for r in matching_rooms if r["images"]), None
        )
        photo_count = len(prop_images) + sum(len(r["images"]) for r in matching_rooms)

        results.append({
            "id": str(prop.id),
            "name": prop.name,
            "description": prop.description,
            "property_type": prop.property_type.value if prop.property_type else None,
            "city": prop.city.name if prop.city else None,
            "district": prop.district.name if prop.district else None,
            "address": prop.address,
            "avg_rating": prop.avg_rating,
            "review_count": prop.review_count,
            "from_price": matching_rooms[0]["total_price"],
            "thumbnail": thumbnail,
            "photo_count": photo_count,
            "rooms": matching_rooms,
        })

    results.sort(key=lambda p: p["from_price"])
    return results[skip : skip + limit]


@router.get("/{property_id}")
def get_property_public(property_id: uuid.UUID, db: Session = Depends(get_db)):
    prop = db.query(Property).filter(
        Property.id == property_id,
        Property.is_approved == True,  # noqa: E712
        Property.is_active == True,  # noqa: E712
    ).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")

    rooms = db.query(Room).filter(Room.property_id == prop.id, Room.is_active == True).all()  # noqa: E712

    rep = db.query(User).filter(User.id == prop.owner_rep_id).first()

    return {
        "id": str(prop.id),
        "name": prop.name,
        "description": prop.description,
        "property_type": prop.property_type.value if prop.property_type else None,
        "city": prop.city.name if prop.city else None,
        "district": prop.district.name if prop.district else None,
        "address": prop.address,
        "amenities": prop.amenities or {},
        "images": prop.images or [],
        "avg_rating": prop.avg_rating,
        "review_count": prop.review_count,
        "owner_rep_id": str(prop.owner_rep_id) if prop.owner_rep_id else None,
        "owner_name": rep.full_name if rep else None,
        "rooms": [
            {
                "id": str(r.id),
                "room_type": r.room_type,
                "base_price": r.base_price,
                "capacity_adults": r.capacity_adults,
                "capacity_children": r.capacity_children,
                "room_amenities": r.room_amenities or {},
                "images": r.images or [],
            }
            for r in rooms
        ],
    }


@router.get("/{property_id}/rep")
def get_property_rep(property_id: uuid.UUID, db: Session = Depends(get_db)):
    prop = db.query(Property).filter(
        Property.id == property_id,
        Property.is_approved == True,
        Property.is_active == True,
    ).first()
    if not prop or not prop.owner_rep_id:
        raise HTTPException(status_code=404, detail="Property not found")
    rep = db.query(User).filter(User.id == prop.owner_rep_id).first()
    if not rep:
        raise HTTPException(status_code=404, detail="Property representative not found")
    return {
        "id": str(rep.id),
        "full_name": rep.full_name or "Host",
        "email": rep.email,
    }


@router.get("/{property_id}/documents")
def list_property_documents_public(property_id: uuid.UUID, db: Session = Depends(get_db)):
    prop = db.query(Property).filter(
        Property.id == property_id,
        Property.is_approved == True,
        Property.is_active == True,
    ).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")

    docs = db.query(PropertyDocument).filter(
        PropertyDocument.property_id == property_id,
    ).order_by(PropertyDocument.created_at.desc()).all()

    return [
        {
            "id": str(d.id),
            "title": d.title,
            "doc_type": d.doc_type.value if d.doc_type else "other",
            "summary_text": d.summary_text,
            "created_at": d.created_at.isoformat() if d.created_at else None,
        }
        for d in docs
    ]



