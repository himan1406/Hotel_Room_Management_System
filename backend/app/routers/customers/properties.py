"""
belongs at app/routers/properties.py
"""

import uuid
from datetime import date

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import or_
from sqlalchemy.orm import Session, aliased

from app.core.database import get_db
from app.models.db_models import DocType, Location, Property, Room, User, PropertyDocument
from app.services.availability import evaluate_room_for_dates

router = APIRouter(prefix="/api/properties", tags=["properties"])

AMENITY_BADGES = [
    ("wifi", "\U0001f4f6", "Free WiFi"),
    ("pool", "\U0001f3ca", "Pool"),
    ("parking", "\U0001f7fe\ufe0f", "Free Parking"),
    ("restaurant", "\U0001f373", "Restaurant"),
    ("gym", "\U0001f4cb\ufe0f", "Gym"),
    ("spa", "\U0001f486", "Spa"),
    ("bar", "\U0001f378", "Bar"),
    ("beach_access", "\U0001f3d6\ufe0f", "Beach Access"),
    ("garden", "\U0001f33f", "Garden"),
    ("rooftop", "\U0001f307", "Rooftop"),
    ("campfire", "\U0001f525", "Campfire"),
    ("business_center", "\U0001f3e2", "Business Center"),
    ("yoga", "\U0001f9d8", "Yoga"),
    ("kitchen", "\U0001f373", "Kitchen"),
    ("fireplace", "\U0001f525", "Fireplace"),
    ("boat_service", "\u26f5", "Boat Service"),
    ("water_sports", "\U0001f3c4", "Water Sports"),
    ("camel_safari", "\U0001f42a", "Camel Safari"),
]


def _compute_badges(prop):
    badges = []
    if prop.amenities:
        for key, icon, label in AMENITY_BADGES:
            if prop.amenities.get(key):
                badges.append({"icon": icon, "label": label})
                if len(badges) >= 5:
                    break
    if prop.avg_rating >= 4.5:
        badges.append({"icon": "\u2b50", "label": "Excellent"})
    elif prop.avg_rating >= 4.0:
        badges.append({"icon": "\u2b50", "label": "Great"})
    return badges


@router.get("/search")
def search_properties(
    location: str | None = Query(None, description="City, district, property name or address"),
    check_in: date | None = Query(None),
    check_out: date | None = Query(None),
    adults: int = Query(1, ge=1),
    children: int = Query(0, ge=0),
    property_type: str | None = Query(None, pattern="^(hotel|villa|homestay|resort)$"),
    amenities: list[str] = Query([], description="Required amenities (e.g. wifi, pool)"),
    min_price: float | None = Query(None, ge=0, description="Minimum room price per night"),
    max_price: float | None = Query(None, ge=0, description="Maximum room price per night"),
    min_rating: float | None = Query(None, ge=0, le=5, description="Minimum average rating"),
    sort_by: str = Query("trending", pattern="^(trending|price_asc|price_desc|rating_desc)$"),
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
            "badges": _compute_badges(prop),
            "ai_highlight": prop.ai_highlight,
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


@router.get("/{property_id}/booking-options")
def get_booking_options(
    property_id: uuid.UUID,
    check_in: date = Query(...),
    check_out: date = Query(...),
    adults: int = Query(1, ge=1),
    children: int = Query(0, ge=0),
    db: Session = Depends(get_db),
):
    prop = db.query(Property).filter(
        Property.id == property_id,
        Property.is_approved == True,  # noqa: E712
        Property.is_active == True,  # noqa: E712
    ).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")

    if check_out <= check_in:
        raise HTTPException(status_code=400, detail="Check-out must be after check-in")
    if check_in < date.today():
        raise HTTPException(status_code=400, detail="Check-in cannot be in the past")

    from app.services.room_combiner import compute_booking_options

    options = compute_booking_options(
        db=db,
        property_id=property_id,
        check_in=check_in,
        check_out=check_out,
        num_adults=adults,
        num_children=children,
    )

    return options


from pydantic import BaseModel
from app.core.llm import ask_llm

class CompareHighlightsRequest(BaseModel):
    property_ids: list[uuid.UUID]


@router.post("/compare/highlights")
def get_compare_highlights(req: CompareHighlightsRequest, db: Session = Depends(get_db)):
    results = {}
    for pid in req.property_ids:
        prop = db.query(Property).filter(Property.id == pid).first()
        if not prop:
            continue
        
        # Get reviews
        from app.models.db_models import Review
        reviews = db.query(Review).filter(Review.property_id == pid).limit(5).all()
        reviews_text = "\n".join([f"- Rating: {r.rating}, Comment: {r.comment}" for r in reviews])
        
        # Get property details
        city_name = prop.city.name if prop.city else "Unknown"
        amenities_list = [k.replace('_', ' ') for k, v in (prop.amenities or {}).items() if v]
        
        system = """You are an expert hospitality assistant. Extract exactly 3 or 4 compelling, distinct bullet points ("selling points" or "attributes") for the given hotel property.
These points should highlight why a traveler would want to choose this stay.
Use the property description, list of amenities, and customer reviews to find specific, accurate, and unique highlights (e.g. "Stunning mountain views", "Excellent homemade breakfast according to guest reviews", "Highly praised free high-speed WiFi", "Located in prime tourist district").
Do NOT use generic bullets. Keep each bullet point short, punchy, and under 12 words. Do not include markdown bold or numbering. Just print the lines. Make Sure that each points of a property is different from the other property's"""
        
        user_message = f"Property Name: {prop.name}\nCity: {city_name}\nDescription: {prop.description}\nAmenities: {', '.join(amenities_list)}\nReviews:\n{reviews_text}"
        
        reply, _ = ask_llm(system, [{"role": "user", "content": user_message}])
        
        bullets = [b.strip("-* ").strip() for b in reply.strip().split("\n") if b.strip()]
        if not bullets or len(bullets) < 2:
            bullets = [
                f"Rated {prop.avg_rating} stars by guests",
                f"Features {', '.join(amenities_list[:3])}",
                f"Located in beautiful {city_name}"
            ]
        results[str(pid)] = bullets[:4]
        
    return results


COMPARE_VALID_DOC_TYPES = {t.value for t in DocType}


class CompareChatRequest(BaseModel):
    property_ids: list[uuid.UUID]
    message: str
    history: list[dict] = []
    doc_type: str | None = None


@router.post("/compare/chat")
def compare_chat(req: CompareChatRequest, db: Session = Depends(get_db)):
    # Fetch the properties being compared
    properties_info = []
    for pid in req.property_ids:
        prop = db.query(Property).filter(Property.id == pid).first()
        if prop:
            properties_info.append(prop)
            
    if not properties_info:
        raise HTTPException(status_code=400, detail="No valid properties provided")

    if req.doc_type is not None and req.doc_type not in COMPARE_VALID_DOC_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid doc_type '{req.doc_type}'. Must be one of: {', '.join(sorted(COMPARE_VALID_DOC_TYPES))}"
        )

    from app.services.query_executor import run_comparison_pipeline

    result = run_comparison_pipeline(
        db=db,
        user=None,  # Comparison is customer-facing, no auth required
        message=req.message,
        history=req.history,
        property_ids=[str(pid) for pid in req.property_ids],
        doc_type=req.doc_type,
    )

    return {"reply": result["reply"], "reasoning_details": None}
