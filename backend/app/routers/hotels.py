import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Property, Room, User, UserRole, Location
from app.routers.auth import get_current_user, require_role
from app.schemas import PropertyCreate, PropertyResponse, RoomCreate, RoomResponse

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


@router.get("")
def list_my_properties(
    user: User = Depends(hotel_rep),
    db: Session = Depends(get_db),
):
    props = db.query(Property).filter(Property.owner_rep_id == user.id).all()
    return [PropertyResponse.model_validate(p).model_dump() for p in props]


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
    db.add(prop)
    db.commit()
    db.refresh(prop)
    return PropertyResponse.model_validate(prop).model_dump()


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
    db.commit()
    db.refresh(prop)
    return PropertyResponse.model_validate(prop).model_dump()


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
    return [RoomResponse.model_validate(r).model_dump() for r in rooms]


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
