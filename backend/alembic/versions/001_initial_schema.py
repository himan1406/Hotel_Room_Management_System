"""initial schema

Revision ID: 001
Revises:
Create Date: 2026-07-01
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSONB, ENUM

revision: str = "001"
down_revision: Union[str, None] = None
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def create_enums():
    op.execute("CREATE TYPE user_role AS ENUM ('admin', 'hotel_rep', 'customer')")
    op.execute("CREATE TYPE location_type AS ENUM ('country', 'state', 'city', 'district')")
    op.execute("CREATE TYPE property_type AS ENUM ('hotel', 'villa', 'homestay', 'resort')")
    op.execute("CREATE TYPE booking_status AS ENUM ('pending', 'confirmed', 'cancelled', 'completed')")
    op.execute("CREATE TYPE doc_type AS ENUM ('cancellation_policy', 'house_rules', 'local_guide', 'other')")
    op.execute("CREATE TYPE pending_status AS ENUM ('pending', 'approved', 'rejected')")


def drop_enums():
    op.execute("DROP TYPE IF EXISTS pending_status")
    op.execute("DROP TYPE IF EXISTS doc_type")
    op.execute("DROP TYPE IF EXISTS booking_status")
    op.execute("DROP TYPE IF EXISTS property_type")
    op.execute("DROP TYPE IF EXISTS location_type")
    op.execute("DROP TYPE IF EXISTS user_role")


def create_triggers():
    op.execute("""
        CREATE OR REPLACE FUNCTION update_updated_at()
        RETURNS TRIGGER AS $$
        BEGIN
            NEW.updated_at = now();
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
    """)

    for table in [
        "users", "properties", "rooms", "bookings", "reviews",
        "pending_hotel_registrations", "property_documents",
    ]:
        op.execute(f"""
            CREATE TRIGGER trg_{table}_updated_at
            BEFORE UPDATE ON {table}
            FOR EACH ROW EXECUTE FUNCTION update_updated_at()
        """)

    op.execute("""
        CREATE OR REPLACE FUNCTION check_location_types()
        RETURNS TRIGGER AS $$
        BEGIN
            IF NEW.city_id IS NOT NULL THEN
                IF (SELECT type FROM locations WHERE id = NEW.city_id) != 'city' THEN
                    RAISE EXCEPTION 'city_id must reference a location of type city';
                END IF;
            END IF;
            IF NEW.district_id IS NOT NULL THEN
                IF (SELECT type FROM locations WHERE id = NEW.district_id) != 'district' THEN
                    RAISE EXCEPTION 'district_id must reference a location of type district';
                END IF;
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
    """)

    op.execute("""
        CREATE TRIGGER enforce_location_types
        BEFORE INSERT OR UPDATE ON properties
        FOR EACH ROW EXECUTE FUNCTION check_location_types()
    """)

    op.execute("""
        CREATE OR REPLACE FUNCTION update_property_rating()
        RETURNS TRIGGER AS $$
        BEGIN
            UPDATE properties
            SET
                avg_rating = (
                    SELECT ROUND(AVG(rating)::numeric, 1)
                    FROM reviews
                    WHERE property_id = COALESCE(NEW.property_id, OLD.property_id)
                ),
                review_count = (
                    SELECT COUNT(*)
                    FROM reviews
                    WHERE property_id = COALESCE(NEW.property_id, OLD.property_id)
                )
            WHERE id = COALESCE(NEW.property_id, OLD.property_id);
            RETURN COALESCE(NEW, OLD);
        END;
        $$ LANGUAGE plpgsql
    """)

    op.execute("""
        CREATE TRIGGER trigger_update_rating
        AFTER INSERT OR UPDATE OR DELETE ON reviews
        FOR EACH ROW EXECUTE FUNCTION update_property_rating()
    """)

    op.execute("""
        CREATE OR REPLACE FUNCTION decrease_availability()
        RETURNS TRIGGER AS $$
        BEGIN
            IF NEW.status = 'confirmed' AND (OLD IS NULL OR OLD.status != 'confirmed') THEN
                UPDATE availability a
                SET quantity_available = a.quantity_available - 1
                WHERE a.room_id = NEW.room_id
                  AND a.date >= NEW.check_in
                  AND a.date < NEW.check_out
                  AND a.quantity_available > 0;
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
    """)

    op.execute("""
        CREATE TRIGGER trigger_decrease_availability
        AFTER UPDATE OF status OR INSERT ON bookings
        FOR EACH ROW EXECUTE FUNCTION decrease_availability()
    """)

    op.execute("""
        CREATE OR REPLACE FUNCTION restore_availability()
        RETURNS TRIGGER AS $$
        BEGIN
            IF NEW.status = 'cancelled' AND OLD.status = 'confirmed' THEN
                UPDATE availability a
                SET quantity_available = a.quantity_available + 1
                WHERE a.room_id = NEW.room_id
                  AND a.date >= NEW.check_in
                  AND a.date < NEW.check_out;
            END IF;
            RETURN NEW;
        END;
        $$ LANGUAGE plpgsql
    """)

    op.execute("""
        CREATE TRIGGER trigger_restore_availability
        AFTER UPDATE OF status ON bookings
        FOR EACH ROW EXECUTE FUNCTION restore_availability()
    """)


def drop_triggers():
    for table in [
        "users", "properties", "rooms", "bookings", "reviews",
        "pending_hotel_registrations", "property_documents",
    ]:
        op.execute(f"DROP TRIGGER IF EXISTS trg_{table}_updated_at ON {table}")
    op.execute("DROP TRIGGER IF EXISTS enforce_location_types ON properties")
    op.execute("DROP TRIGGER IF EXISTS trigger_update_rating ON reviews")
    op.execute("DROP TRIGGER IF EXISTS trigger_decrease_availability ON bookings")
    op.execute("DROP TRIGGER IF EXISTS trigger_restore_availability ON bookings")
    op.execute("DROP FUNCTION IF EXISTS update_updated_at")
    op.execute("DROP FUNCTION IF EXISTS check_location_types")
    op.execute("DROP FUNCTION IF EXISTS update_property_rating")
    op.execute("DROP FUNCTION IF EXISTS decrease_availability")
    op.execute("DROP FUNCTION IF EXISTS restore_availability")


def upgrade() -> None:
    create_enums()

    op.create_table(
        "locations",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", sa.String(100), nullable=False),
        sa.Column("type", ENUM("country", "state", "city", "district", name="location_type", create_type=False), nullable=False),
        sa.Column("parent_id", UUID(as_uuid=True), sa.ForeignKey("locations.id")),
        sa.Column("code", sa.String(2)),
        sa.UniqueConstraint("name", "parent_id"),
    )

    op.create_table(
        "users",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("email", sa.String(255), unique=True, nullable=False),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("role", ENUM("admin", "hotel_rep", "customer", name="user_role", create_type=False), nullable=False),
        sa.Column("full_name", sa.String(255)),
        sa.Column("phone", sa.String(20)),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()")),
    )

    op.create_table(
        "sessions",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("user_id", UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("token_hash", sa.String(255), unique=True, nullable=False),
        sa.Column("expires_at", sa.DateTime(), nullable=False),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()")),
    )

    op.create_table(
        "pending_hotel_registrations",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("email", sa.String(255), unique=True, nullable=False),
        sa.Column("password_hash", sa.String(255), nullable=False),
        sa.Column("full_name", sa.String(255)),
        sa.Column("phone", sa.String(20)),
        sa.Column("doc_url", sa.String(500)),
        sa.Column("status", ENUM("pending", "approved", "rejected", name="pending_status", create_type=False), server_default=sa.text("'pending'")),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()")),
    )

    op.create_table(
        "properties",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("name", sa.String(255), nullable=False),
        sa.Column("description", sa.Text()),
        sa.Column("owner_rep_id", UUID(as_uuid=True), sa.ForeignKey("users.id")),
        sa.Column("property_type", ENUM("hotel", "villa", "homestay", "resort", name="property_type", create_type=False)),
        sa.Column("city_id", UUID(as_uuid=True), sa.ForeignKey("locations.id")),
        sa.Column("district_id", UUID(as_uuid=True), sa.ForeignKey("locations.id")),
        sa.Column("address", sa.Text()),
        sa.Column("latitude", sa.Float()),
        sa.Column("longitude", sa.Float()),
        sa.Column("amenities", JSONB(), server_default=sa.text("'{}'::jsonb")),
        sa.Column("avg_rating", sa.Float(), server_default=sa.text("0")),
        sa.Column("review_count", sa.Integer(), server_default=sa.text("0")),
        sa.Column("trending_score", sa.Float(), server_default=sa.text("0")),
        sa.Column("is_approved", sa.Boolean(), server_default=sa.text("false")),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()")),
        sa.CheckConstraint("avg_rating >= 0 AND avg_rating <= 5", name="ck_properties_avg_rating"),
    )

    op.create_table(
        "rooms",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("property_id", UUID(as_uuid=True), sa.ForeignKey("properties.id", ondelete="CASCADE"), nullable=False),
        sa.Column("room_type", sa.String(100), nullable=False),
        sa.Column("base_price", sa.Float(), nullable=False),
        sa.Column("capacity_adults", sa.Integer(), server_default=sa.text("1")),
        sa.Column("capacity_children", sa.Integer(), server_default=sa.text("0")),
        sa.Column("total_quantity", sa.Integer(), nullable=False),
        sa.Column("room_amenities", JSONB(), server_default=sa.text("'{}'::jsonb")),
        sa.Column("images", JSONB(), server_default=sa.text("'[]'::jsonb")),
        sa.Column("extra_details", JSONB(), server_default=sa.text("'{}'::jsonb")),
        sa.Column("is_active", sa.Boolean(), server_default=sa.text("true")),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()")),
        sa.UniqueConstraint("property_id", "room_type"),
        sa.CheckConstraint("capacity_adults > 0", name="ck_rooms_capacity_adults"),
        sa.CheckConstraint("total_quantity > 0", name="ck_rooms_total_quantity"),
    )

    op.create_table(
        "availability",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("room_id", UUID(as_uuid=True), sa.ForeignKey("rooms.id", ondelete="CASCADE"), nullable=False),
        sa.Column("date", sa.Date(), nullable=False),
        sa.Column("quantity_available", sa.Integer(), nullable=False),
        sa.Column("price_override", sa.Float()),
        sa.UniqueConstraint("room_id", "date"),
        sa.CheckConstraint("quantity_available >= 0", name="ck_availability_quantity"),
    )

    op.create_table(
        "bookings",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("customer_id", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("room_id", UUID(as_uuid=True), sa.ForeignKey("rooms.id"), nullable=False),
        sa.Column("check_in", sa.Date(), nullable=False),
        sa.Column("check_out", sa.Date(), nullable=False),
        sa.Column("num_adults", sa.Integer(), nullable=False),
        sa.Column("num_children", sa.Integer(), server_default=sa.text("0")),
        sa.Column("status", ENUM("pending", "confirmed", "cancelled", "completed", name="booking_status", create_type=False), server_default=sa.text("'pending'")),
        sa.Column("total_price", sa.Float()),
        sa.Column("idempotency_key", sa.String(255), unique=True),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()")),
        sa.CheckConstraint("check_out > check_in", name="ck_bookings_dates"),
        sa.CheckConstraint("num_adults > 0", name="ck_bookings_adults"),
        sa.CheckConstraint("num_children >= 0", name="ck_bookings_children"),
    )

    op.create_table(
        "property_documents",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        # nullable=True — pending hotel reps submit docs before having an approved property
        sa.Column("property_id", UUID(as_uuid=True), sa.ForeignKey("properties.id", ondelete="CASCADE"), nullable=True),
        sa.Column("uploaded_by", UUID(as_uuid=True), sa.ForeignKey("users.id")),
        sa.Column("doc_type", ENUM("cancellation_policy", "house_rules", "local_guide", "other", name="doc_type", create_type=False), server_default=sa.text("'other'")),
        sa.Column("title", sa.String(255)),
        sa.Column("file_url", sa.String(500)),
        sa.Column("summary_text", sa.Text()),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()")),
    )

    op.create_table(
        "reviews",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("booking_id", UUID(as_uuid=True), sa.ForeignKey("bookings.id"), unique=True, nullable=False),
        sa.Column("customer_id", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("property_id", UUID(as_uuid=True), sa.ForeignKey("properties.id"), nullable=False),
        sa.Column("rating", sa.Integer(), nullable=False),
        sa.Column("comment", sa.Text()),
        sa.Column("rep_response", sa.Text()),
        sa.Column("responded_at", sa.DateTime()),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()")),
        sa.Column("updated_at", sa.DateTime(), server_default=sa.text("now()")),
        sa.CheckConstraint("rating >= 1 AND rating <= 5", name="ck_reviews_rating"),
    )

    op.create_table(
        "messages",
        sa.Column("id", UUID(as_uuid=True), primary_key=True, server_default=sa.text("gen_random_uuid()")),
        sa.Column("sender_id", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("receiver_id", UUID(as_uuid=True), sa.ForeignKey("users.id"), nullable=False),
        sa.Column("property_id", UUID(as_uuid=True), sa.ForeignKey("properties.id")),
        sa.Column("body", sa.Text(), nullable=False),
        sa.Column("is_read", sa.Boolean(), server_default=sa.text("false")),
        sa.Column("created_at", sa.DateTime(), server_default=sa.text("now()")),
    )

    # Indexes
    op.create_index("idx_locations_parent", "locations", ["parent_id"])
    op.create_index("idx_locations_type", "locations", ["type"])
    op.create_index("idx_properties_owner", "properties", ["owner_rep_id"])
    op.create_index("idx_properties_city", "properties", ["city_id"])
    op.create_index("idx_properties_district", "properties", ["district_id"])
    op.create_index("idx_properties_amenities", "properties", ["amenities"], postgresql_using="gin")
    op.create_index("idx_properties_trending", "properties", [sa.text("trending_score DESC")])
    op.create_index("idx_availability_room_date", "availability", ["room_id", "date"])
    op.create_index("idx_rooms_property", "rooms", ["property_id"])
    op.create_index("idx_bookings_customer", "bookings", ["customer_id"])
    op.create_index("idx_bookings_room_dates", "bookings", ["room_id", "check_in", "check_out"])
    op.create_index("idx_bookings_idempotency", "bookings", ["idempotency_key"])
    op.create_index("idx_reviews_property", "reviews", ["property_id"])
    op.create_index("idx_messages_receiver", "messages", ["receiver_id", "is_read"])

    # Triggers
    create_triggers()

    # ── Backfill ratings ────────────────────────────────────────────────────────
    # The update_property_rating trigger only fires on future INSERT/UPDATE/DELETE
    # on reviews. If any review data was loaded before this migration ran (e.g.
    # via a data import or seed), avg_rating and review_count would stay at their
    # default zeros forever. Recompute them once right now to bootstrap correctly.
    op.execute("""
        UPDATE properties p
        SET
            avg_rating = COALESCE((
                SELECT ROUND(AVG(rating)::numeric, 1)
                FROM reviews
                WHERE property_id = p.id
            ), 0),
            review_count = COALESCE((
                SELECT COUNT(*)
                FROM reviews
                WHERE property_id = p.id
            ), 0)
    """)


def downgrade() -> None:
    drop_triggers()

    op.drop_table("messages")
    op.drop_table("reviews")
    op.drop_table("property_documents")
    op.drop_table("bookings")
    op.drop_table("availability")
    op.drop_table("rooms")
    op.drop_table("properties")
    op.drop_table("pending_hotel_registrations")
    op.drop_table("sessions")
    op.drop_table("users")
    op.drop_table("locations")

    drop_enums()
