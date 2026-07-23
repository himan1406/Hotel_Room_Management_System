from datetime import date, datetime
from typing import Optional
from uuid import UUID

from pydantic import BaseModel, Field


class SignupRequest(BaseModel):
    email: str = Field(..., min_length=5, max_length=255)
    password: str = Field(..., min_length=6)
    full_name: Optional[str] = None
    phone: Optional[str] = None


class LoginRequest(BaseModel):
    email: str
    password: str


class HotelRegisterRequest(BaseModel):
    email: str = Field(..., min_length=5, max_length=255)
    password: str = Field(..., min_length=6)
    full_name: str = Field(..., min_length=2)
    phone: Optional[str] = None


class UserResponse(BaseModel):
    id: UUID
    email: str
    role: str
    full_name: Optional[str]
    phone: Optional[str]
    is_active: bool

    class Config:
        from_attributes = True


class PendingHotelResponse(BaseModel):
    id: UUID
    email: str
    full_name: Optional[str]
    phone: Optional[str]
    doc_url: Optional[str]
    status: str
    created_at: datetime

    class Config:
        from_attributes = True


class ApproveRejectRequest(BaseModel):
    id: UUID


class PropertyCreate(BaseModel):
    name: str
    description: Optional[str] = None
    property_type: str = "hotel"
    city_id: Optional[UUID] = None
    district_id: Optional[UUID] = None
    address: Optional[str] = None
    latitude: Optional[float] = None
    longitude: Optional[float] = None
    amenities: Optional[dict] = None


class PropertyResponse(BaseModel):
    id: UUID
    name: str
    description: Optional[str]
    property_type: Optional[str]
    city_id: Optional[UUID]
    district_id: Optional[UUID]
    address: Optional[str]
    latitude: Optional[float]
    longitude: Optional[float]
    amenities: Optional[dict]
    images: Optional[list] = None
    avg_rating: float
    review_count: int
    is_approved: bool
    is_active: bool
    created_at: datetime

    class Config:
        from_attributes = True


class RoomCreate(BaseModel):
    room_type: str
    base_price: float = Field(..., gt=0)
    capacity_adults: int = Field(default=1, ge=1)
    capacity_children: int = Field(default=0, ge=0)
    total_quantity: int = Field(..., gt=0)
    room_amenities: Optional[dict] = None
    images: Optional[list] = None
    extra_details: Optional[dict] = None


class RoomResponse(BaseModel):
    id: UUID
    property_id: UUID
    room_type: str
    base_price: float
    capacity_adults: int
    capacity_children: int
    total_quantity: int
    room_amenities: Optional[dict]
    images: Optional[list]
    is_active: bool

    class Config:
        from_attributes = True


class BookingCreate(BaseModel):
    room_id: UUID
    check_in: date
    check_out: date
    num_adults: int = Field(default=1, ge=1)
    num_children: int = Field(default=0, ge=0)
    idempotency_key: Optional[str] = Field(default=None, max_length=255)


class BulkRoomItem(BaseModel):
    room_id: UUID
    quantity: int = Field(..., ge=1)
    adults_per_room: list[int] = Field(default_factory=list)
    children_per_room: list[int] = Field(default_factory=list)


class BulkBookingRequest(BaseModel):
    property_id: UUID
    check_in: date
    check_out: date
    rooms: list[BulkRoomItem]
    idempotency_key: Optional[str] = Field(default=None, max_length=255)


class ReviewCreate(BaseModel):
    booking_id: UUID
    rating: int = Field(..., ge=1, le=5)
    comment: Optional[str] = None


class ReviewUpdate(BaseModel):
    rating: int = Field(..., ge=1, le=5)
    comment: Optional[str] = None


class ReviewRespond(BaseModel):
    response: str


class ReviewResponse(BaseModel):
    id: UUID
    booking_id: UUID
    customer_id: UUID
    property_id: UUID
    rating: int
    comment: Optional[str]
    customer_name: Optional[str] = None
    rep_response: Optional[str] = None
    responded_at: Optional[datetime] = None
    created_at: datetime
    is_mine: bool = False

    class Config:
        from_attributes = True


class MessageSend(BaseModel):
    receiver_id: UUID
    property_id: Optional[UUID] = None
    body: str = Field(..., min_length=1, max_length=5000)


class MessageResponse(BaseModel):
    id: UUID
    sender_id: UUID
    receiver_id: UUID
    property_id: UUID
    body: str
    is_read: bool
    sender_name: Optional[str] = None
    created_at: datetime

    class Config:
        from_attributes = True
