import uuid
import enum

from sqlalchemy import (
    Column, String, Boolean, DateTime, Date, Float, Integer,
    Enum, ForeignKey, Text, UniqueConstraint, CheckConstraint,
)
from sqlalchemy.dialects.postgresql import UUID, JSONB
from sqlalchemy.orm import relationship
from sqlalchemy.sql import func

from app.database import Base


class UserRole(str, enum.Enum):
    admin = "admin"
    hotel_rep = "hotel_rep"
    customer = "customer"


class LocationType(str, enum.Enum):
    country = "country"
    state = "state"
    city = "city"
    district = "district"


class PropertyType(str, enum.Enum):
    hotel = "hotel"
    villa = "villa"
    homestay = "homestay"
    resort = "resort"


class BookingStatus(str, enum.Enum):
    pending = "pending"
    confirmed = "confirmed"
    cancelled = "cancelled"
    completed = "completed"


class DocType(str, enum.Enum):
    cancellation_policy = "cancellation_policy"
    house_rules = "house_rules"
    local_guide = "local_guide"
    other = "other"


class PendingStatus(str, enum.Enum):
    pending = "pending"
    approved = "approved"
    rejected = "rejected"


class Location(Base):
    __tablename__ = "locations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(100), nullable=False)
    type = Column(Enum(LocationType), nullable=False)
    parent_id = Column(UUID(as_uuid=True), ForeignKey("locations.id"))
    code = Column(String(2))

    parent = relationship("Location", remote_side=[id], backref="children")

    __table_args__ = (UniqueConstraint("name", "parent_id"),)


class User(Base):
    __tablename__ = "users"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(String(255), unique=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    role = Column(Enum(UserRole), nullable=False)
    full_name = Column(String(255))
    phone = Column(String(20))
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class Session(Base):
    __tablename__ = "sessions"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    token_hash = Column(String(255), unique=True, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    created_at = Column(DateTime, server_default=func.now())

    user = relationship("User")


class RefreshToken(Base):
    __tablename__ = "refresh_tokens"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    user_id = Column(UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False)
    token_hash = Column(String(255), unique=True, nullable=False)
    expires_at = Column(DateTime, nullable=False)
    created_at = Column(DateTime, server_default=func.now())

    user = relationship("User")


class PendingHotelRegistration(Base):
    __tablename__ = "pending_hotel_registrations"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    email = Column(String(255), unique=True, nullable=False)
    password_hash = Column(String(255), nullable=False)
    full_name = Column(String(255))
    phone = Column(String(20))
    doc_url = Column(String(500))
    status = Column(Enum(PendingStatus), default=PendingStatus.pending)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class Property(Base):
    __tablename__ = "properties"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    name = Column(String(255), nullable=False)
    description = Column(Text)
    owner_rep_id = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    property_type = Column(Enum(PropertyType))
    city_id = Column(UUID(as_uuid=True), ForeignKey("locations.id"))
    district_id = Column(UUID(as_uuid=True), ForeignKey("locations.id"))
    address = Column(Text)
    latitude = Column(Float)
    longitude = Column(Float)
    amenities = Column(JSONB, default=dict)
    avg_rating = Column(Float, default=0)
    review_count = Column(Integer, default=0)
    trending_score = Column(Float, default=0)
    is_approved = Column(Boolean, default=False)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    owner = relationship("User", foreign_keys=[owner_rep_id])
    city = relationship("Location", foreign_keys=[city_id])
    district = relationship("Location", foreign_keys=[district_id])


class Room(Base):
    __tablename__ = "rooms"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    property_id = Column(UUID(as_uuid=True), ForeignKey("properties.id", ondelete="CASCADE"), nullable=False)
    room_type = Column(String(100), nullable=False)
    base_price = Column(Float, nullable=False)
    capacity_adults = Column(Integer, default=1)
    capacity_children = Column(Integer, default=0)
    total_quantity = Column(Integer, nullable=False)
    room_amenities = Column(JSONB, default=dict)
    images = Column(JSONB, default=list)
    extra_details = Column(JSONB, default=dict)
    is_active = Column(Boolean, default=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    property = relationship("Property", backref="rooms")

    __table_args__ = (UniqueConstraint("property_id", "room_type"),)


class Availability(Base):
    __tablename__ = "availability"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    room_id = Column(UUID(as_uuid=True), ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False)
    date = Column(Date, nullable=False)
    quantity_available = Column(Integer, nullable=False)
    price_override = Column(Float)

    room = relationship("Room", backref="availability")

    __table_args__ = (UniqueConstraint("room_id", "date"),)


class Booking(Base):
    __tablename__ = "bookings"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    customer_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    room_id = Column(UUID(as_uuid=True), ForeignKey("rooms.id"), nullable=False)
    check_in = Column(Date, nullable=False)
    check_out = Column(Date, nullable=False)
    num_adults = Column(Integer, nullable=False)
    num_children = Column(Integer, default=0)
    status = Column(Enum(BookingStatus), default=BookingStatus.pending)
    total_price = Column(Float)
    idempotency_key = Column(String(255), unique=True)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())

    customer = relationship("User", foreign_keys=[customer_id])
    room = relationship("Room")

    __table_args__ = (CheckConstraint("check_out > check_in"),)


class PropertyDocument(Base):
    __tablename__ = "property_documents"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # nullable=True — pending hotel reps submit docs before having an approved property
    property_id = Column(UUID(as_uuid=True), ForeignKey("properties.id", ondelete="CASCADE"), nullable=True)
    uploaded_by = Column(UUID(as_uuid=True), ForeignKey("users.id"))
    doc_type = Column(Enum(DocType), default=DocType.other)
    title = Column(String(255))
    file_url = Column(String(500))
    summary_text = Column(Text)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class Review(Base):
    __tablename__ = "reviews"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    booking_id = Column(UUID(as_uuid=True), ForeignKey("bookings.id"), unique=True, nullable=False)
    customer_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    property_id = Column(UUID(as_uuid=True), ForeignKey("properties.id"), nullable=False)
    rating = Column(Integer, nullable=False)
    comment = Column(Text)
    rep_response = Column(Text)
    responded_at = Column(DateTime)
    created_at = Column(DateTime, server_default=func.now())
    updated_at = Column(DateTime, server_default=func.now(), onupdate=func.now())


class Message(Base):
    __tablename__ = "messages"

    id = Column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    sender_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    receiver_id = Column(UUID(as_uuid=True), ForeignKey("users.id"), nullable=False)
    property_id = Column(UUID(as_uuid=True), ForeignKey("properties.id"))
    body = Column(Text, nullable=False)
    is_read = Column(Boolean, default=False)
    created_at = Column(DateTime, server_default=func.now())