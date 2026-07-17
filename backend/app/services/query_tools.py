"""
Query Tools — registry of all executable tools available to the Planner LLM.

Each tool has:
  - A unique name (used by the Planner LLM in its JSON plan)
  - A description (shown to the Planner LLM so it knows when to use it)
  - A params_schema (defines what parameters the tool accepts)
  - allowed_roles (which user roles can invoke this tool)
  - A handler function (the actual Python logic)
The Query Executor uses this registry to validate and execute the plan.
"""

import logging
import uuid
from datetime import date as date_type

from sqlalchemy import text
from sqlalchemy.orm import Session

from app.models.db_models import (
    Availability, Booking, BookingStatus, DocType, Property,
    PropertyDocument, Review, Room, User, UserRole,
    PendingHotelRegistration, PendingStatus,
)
from app.core.embeddings import embed_text

logger = logging.getLogger(__name__)

SIMILARITY_THRESHOLD = 0.3
VALID_DOC_TYPES = {t.value for t in DocType}


# ═══════════════════════════════════════════════════════════════
# 1.  TOOL REGISTRY
# ═══════════════════════════════════════════════════════════════

TOOL_REGISTRY = {
    "VECTOR_SEARCH": {
        "description": (
            "Semantic search across property documents (cancellation policies, "
            "house rules, local guides, transportation info, etc.). "
            "Use this for unstructured questions about policies, rules, amenities, "
            "local attractions — anything found in uploaded documents."
        ),
        "params_schema": {
            "query": {
                "type": "string",
                "required": True,
                "description": "The search query in natural language",
            },
            "property_ids": {
                "type": "list[string]",
                "required": False,
                "description": "Filter by specific property UUIDs",
            },
            "doc_type": {
                "type": "string",
                "required": False,
                "description": (
                    f"Filter by document type: {', '.join(sorted(VALID_DOC_TYPES))}"
                ),
            },
            "limit": {
                "type": "integer",
                "required": False,
                "default": 6,
                "min": 1,
                "max": 20,
            },
        },
        "allowed_roles": ["customer", "hotel_rep", "admin", None],  # None = guest
    },
    "MUTATION_APPROVE_HOTEL": {
        "description": (
            "Approve a pending hotel registration. Creates a User account "
            "for the registrant and marks the registration as approved. "
            "Requires confirmation before execution."
        ),
        "params_schema": {
            "registration_id": {
                "type": "string",
                "required": True,
                "description": "UUID of the pending hotel registration",
            },
        },
        "allowed_roles": ["admin"],
        "requires_confirmation": True,
    },
    "MUTATION_REJECT_HOTEL": {
        "description": (
            "Reject a pending hotel registration. Marks it as rejected "
            "so it can be revisited later. Requires confirmation before execution."
        ),
        "params_schema": {
            "registration_id": {
                "type": "string",
                "required": True,
                "description": "UUID of the pending hotel registration",
            },
        },
        "allowed_roles": ["admin"],
        "requires_confirmation": True,
    },
    "MUTATION_ACTIVATE_REP": {
        "description": (
            "Activate a deactivated hotel representative. "
            "Requires confirmation before execution."
        ),
        "params_schema": {
            "user_id": {
                "type": "string",
                "required": True,
                "description": "UUID of the hotel rep user",
            },
        },
        "allowed_roles": ["admin"],
        "requires_confirmation": True,
    },
    "MUTATION_DEACTIVATE_REP": {
        "description": (
            "Deactivate an active hotel representative. "
            "Requires confirmation before execution."
        ),
        "params_schema": {
            "user_id": {
                "type": "string",
                "required": True,
                "description": "UUID of the hotel rep user",
            },
        },
        "allowed_roles": ["admin"],
        "requires_confirmation": True,
    },

    # ────────────────────────────────────────────────────────────────
    # HOTEL REP TOOLS (auto-scoped to the rep's own properties)
    # ────────────────────────────────────────────────────────────────

    "REP_PROPERTIES": {
        "description": (
            "List your own properties with room types, prices, amenities, "
            "ratings, and approval status. Use this when the hotel rep asks "
            "about 'my properties', 'my hotels', or 'list my places'."
        ),
        "params_schema": {},
        "allowed_roles": ["hotel_rep"],
    },
    "REP_AVAILABILITY_TODAY": {
        "description": (
            "Get today's room availability across all your properties. "
            "Shows total rooms, available rooms, and occupancy per room type. "
            "Use this for questions like 'how many rooms are available today?'"
        ),
        "params_schema": {},
        "allowed_roles": ["hotel_rep"],
    },
    "REP_BOOKINGS": {
        "description": (
            "Get booking statistics for your properties — total bookings, "
            "counts by status (confirmed, pending, completed, cancelled), and "
            "estimated revenue. Also returns the most recent bookings with "
            "customer names, dates, and amounts. Use this for questions about "
            "'my bookings', 'recent bookings', or 'booking revenue'."
        ),
        "params_schema": {
            "limit": {
                "type": "integer",
                "required": False,
                "default": 10,
                "min": 1,
                "max": 50,
                "description": "Number of recent bookings to include",
            },
        },
        "allowed_roles": ["hotel_rep"],
    },
    "REP_REVIEWS": {
        "description": (
            "Get review summary for your properties — average rating, review "
            "count, and number of unanswered reviews per property. "
            "Use this for questions about 'my reviews', 'guest feedback', "
            "or 'unanswered reviews'."
        ),
        "params_schema": {},
        "allowed_roles": ["hotel_rep"],
    },
    "REP_DOCUMENTS": {
        "description": (
            "List uploaded documents (cancellation policies, house rules, "
            "local guides, etc.) for each of your properties. "
            "Use this for questions about 'my documents', 'uploaded policies', "
            "or 'what documents do I have'."
        ),
        "params_schema": {},
        "allowed_roles": ["hotel_rep"],
    },

    # ────────────────────────────────────────────────────────────────
    # CUSTOMER TOOLS (scoped to the customer's own data)
    # ────────────────────────────────────────────────────────────────

    "CUSTOMER_BOOKINGS": {
        "description": (
            "Get your own booking history — lists your bookings with "
            "property name, room type, check-in/check-out dates, number of "
            "guests, booking status, and total price. Optionally filter by "
            "status. Use this for questions like 'my bookings', "
            "'my reservations', 'booking history', or 'my upcoming stays'."
        ),
        "params_schema": {
            "status": {
                "type": "string",
                "required": False,
                "description": (
                    "Optional filter by status: pending, confirmed, "
                    "cancelled, or completed"
                ),
            },
            "limit": {
                "type": "integer",
                "required": False,
                "default": 10,
                "min": 1,
                "max": 50,
                "description": "Max number of bookings to return",
            },
        },
        "allowed_roles": ["customer"],
    },

    # ────────────────────────────────────────────────────────────────
    # ADMIN QUERY TOOLS (platform-level data)
    # ────────────────────────────────────────────────────────────────

    "ADMIN_PENDING_REGISTRATIONS": {
        "description": (
            "List pending hotel registrations that need admin approval. "
            "Each registration includes UUID, full name, email, and "
            "submission date. Use this when the admin asks about "
            "'pending registrations', 'pending hotels', or 'approvals'."
        ),
        "params_schema": {},
        "allowed_roles": ["admin"],
    },
    "ADMIN_STATISTICS": {
        "description": (
            "Get platform-wide statistics — total properties, total rooms, "
            "total hotel representatives, total customers, and number of "
            "properties per city. Use this when the admin asks about "
            "'platform statistics', 'how many properties', 'total rooms', "
            "or 'properties by city'."
        ),
        "params_schema": {},
        "allowed_roles": ["admin"],
    },
    "ADMIN_REP_LIST": {
        "description": (
            "List all hotel representatives with their UUID, full name, "
            "email, and account status (active/inactive). "
            "Use this when the admin asks about 'hotel reps', "
            "'list representatives', or before activating/deactivating "
            "a rep to find their UUID."
        ),
        "params_schema": {
            "include_inactive": {
                "type": "boolean",
                "required": False,
                "default": True,
                "description": "If True, include both active and inactive reps. If False, only active.",
            },
        },
        "allowed_roles": ["admin"],
    },
}

# Tools that require explicit confirmation before execution
CONFIRMATION_TOOLS = {
    name for name, cfg in TOOL_REGISTRY.items()
    if cfg.get("requires_confirmation")
}


# ═══════════════════════════════════════════════════════════════
# 2.  HELPER: available tools descriptions for the Planner prompt
# ═══════════════════════════════════════════════════════════════

def get_tools_for_role(role: str | None) -> dict[str, dict]:
    """Return the subset of tools a given role can use.

    Args:
        role: The user's role string (from UserRole enum), or None for guests.

    Returns:
        Dict of tool name → tool config.
    """
    available = {}
    for name, cfg in TOOL_REGISTRY.items():
        allowed = cfg["allowed_roles"]
        if role in allowed or None in allowed:
            available[name] = cfg
    return available


def format_tools_for_planner(role: str | None) -> str:
    """Format the available tools as readable text for the Planner prompt.

    Args:
        role: The user's role string, or None for guests.

    Returns:
        Formatted string describing each available tool with its params.
    """
    tools = get_tools_for_role(role)
    if not tools:
        return "(No tools available for this role.)"

    lines = []
    for name, cfg in tools.items():
        lines.append(f"  - {name}")
        lines.append(f"    {cfg['description']}")

        # Parameter listing
        params = cfg["params_schema"]
        if params:
            for p_name, p_cfg in params.items():
                req = "REQUIRED" if p_cfg.get("required") else "optional"
                default = f" (default: {p_cfg.get('default')})" if "default" in p_cfg else ""
                lines.append(f"      {p_name}: {p_cfg.get('type', 'unknown')} [{req}]{default}")

        if cfg.get("requires_confirmation"):
            lines.append("      ⚠️  Requires user confirmation before executing")

        lines.append("")

    return "\n".join(lines)


# ═══════════════════════════════════════════════════════════════
# 3.  HANDLER: Vector Search
# ═══════════════════════════════════════════════════════════════

def handle_vector_search(
    db: Session,
    user: User | None,
    query: str,
    property_ids: list[str] | None = None,
    doc_type: str | None = None,
    limit: int = 6,
) -> dict:
    """Semantic search across property document chunks.

    Uses the same pgvector similarity search as the current _search_docs()
    in chat.py, but as a standalone handler callable by the Query Executor.

    Args:
        db: Database session.
        user: Current user (used for role scoping).
        query: Natural language search query.
        property_ids: Optional list of property UUIDs to scope the search.
        doc_type: Optional document type filter.
        limit: Max results (1-20).

    Returns:
        Dict with keys: success (bool), results (list of chunk dicts),
        formatted (str for LLM context), error (str if failed).
    """
    try:
        # Validate doc_type if provided
        if doc_type is not None and doc_type not in VALID_DOC_TYPES:
            return {
                "success": False,
                "data": [],
                "formatted": f"(Invalid doc_type '{doc_type}')",
                "error": f"Invalid doc_type '{doc_type}'. Must be one of: {', '.join(sorted(VALID_DOC_TYPES))}",
            }

        # Validate property_ids if provided
        validated_pids = None
        if property_ids:
            validated_pids = []
            for pid in property_ids:
                try:
                    uuid.UUID(pid)
                    validated_pids.append(pid)
                except ValueError:
                    logger.warning(f"Invalid property_id in vector search: '{pid}'")
            if not validated_pids:
                validated_pids = None

        query_vec = embed_text(query)

        # Build WHERE clause dynamically
        conditions = ["dc.embedding IS NOT NULL"]
        params: dict = {"query_vec": query_vec, "limit": min(limit, 20)}

        if validated_pids:
            placeholders = ", ".join(
                [f"CAST(:pid_{i} AS uuid)" for i in range(len(validated_pids))]
            )
            conditions.append(f"dc.property_id IN ({placeholders})")
            for i, pid in enumerate(validated_pids):
                params[f"pid_{i}"] = pid

        if doc_type is not None:
            conditions.append("pd.doc_type::text = :doc_type")
            params["doc_type"] = doc_type

        where_clause = " AND ".join(conditions)

        sql = text(f"""
            SELECT
                dc.content, dc.document_id, dc.property_id,
                pd.title AS doc_title,
                pd.doc_type::text AS doc_type_str,
                dc.embedding <=> CAST(:query_vec AS vector) AS distance
            FROM document_chunks dc
            INNER JOIN property_documents pd ON dc.document_id = pd.id
            WHERE {where_clause}
            ORDER BY distance
            LIMIT :limit
        """)

        rows = db.execute(sql, params).fetchall()

        results = []
        for row in rows:
            score = round(1.0 - row.distance, 3)
            if score < SIMILARITY_THRESHOLD:
                continue
            results.append({
                "content": row.content,
                "score": score,
                "source": row.doc_title or "Unknown",
                "doc_type": row.doc_type_str or "other",
                "property_id": str(row.property_id) if row.property_id else None,
            })

        # Enrich results with property names (batch query, avoids N+1)
        prop_ids = list(set(
            d["property_id"] for d in results
            if d.get("property_id")
        ))
        prop_name_map: dict[str, str] = {}
        if prop_ids:
            try:
                prop_rows = db.query(Property.id, Property.name).filter(
                    Property.id.in_([uuid.UUID(pid) for pid in prop_ids])
                ).all()
                prop_name_map = {str(r.id): r.name for r in prop_rows}
            except Exception:
                logger.warning("Failed to fetch property names for card markers", exc_info=True)

        # Format for LLM context — with [PropertyCard: uuid] markers
        if not results:
            formatted = "(No document excerpts matched the query.)"
        else:
            parts = []
            for i, d in enumerate(results, 1):
                pid = d.get("property_id", "")
                marker = f"[PropertyCard: {pid}]" if pid else ""
                prop_name = prop_name_map.get(pid, "")
                source_label = f"{d['source']}"
                if prop_name:
                    source_label = f"{prop_name} — {d['source']}"
                parts.append(
                    f"[{i}] {marker} "
                    f"(source: {source_label}, "
                    f"type: {d.get('doc_type', 'unknown')}, "
                    f"relevance: {d['score']:.2f})\n{d['content']}"
                )
            formatted = "\n\n".join(parts)

        return {
            "success": True,
            "data": results,
            "formatted": formatted,
            "error": None,
        }

    except Exception as e:
        logger.error(f"Vector search failed: {e}", exc_info=True)
        return {
            "success": False,
            "data": [],
            "formatted": "(Vector search encountered an error.)",
            "error": str(e),
        }


# ═══════════════════════════════════════════════════════════════
# 4.  HANDLER: Mutations (Admin Actions)
# ═══════════════════════════════════════════════════════════════

def handle_mutation_approve_hotel(
    db: Session,
    user: User,
    registration_id: str,
) -> dict:
    """Approve a pending hotel registration. Creates the User account."""
    try:
        rid = uuid.UUID(registration_id)
    except ValueError:
        return {"success": False, "message": f"Invalid registration_id format: '{registration_id}'"}

    pending = db.query(PendingHotelRegistration).filter(
        PendingHotelRegistration.id == rid,
        PendingHotelRegistration.status == PendingStatus.pending,
    ).first()

    if not pending:
        return {"success": False, "message": "Pending registration not found or already processed"}

    if db.query(User).filter(User.email == pending.email).first():
        return {"success": False, "message": "User with this email already exists"}

    new_user = User(
        email=pending.email,
        password_hash=pending.password_hash,
        role=UserRole.hotel_rep,
        full_name=pending.full_name,
        phone=pending.phone,
        is_active=True,
    )
    db.add(new_user)
    pending.status = PendingStatus.approved
    db.commit()

    return {
        "success": True,
        "message": f"Hotel rep {pending.full_name or pending.email} approved and account created",
    }


def handle_mutation_reject_hotel(
    db: Session,
    user: User,
    registration_id: str,
) -> dict:
    """Reject a pending hotel registration."""
    try:
        rid = uuid.UUID(registration_id)
    except ValueError:
        return {"success": False, "message": f"Invalid registration_id format: '{registration_id}'"}

    pending = db.query(PendingHotelRegistration).filter(
        PendingHotelRegistration.id == rid,
    ).first()

    if not pending:
        return {"success": False, "message": "Registration not found"}

    if pending.status == PendingStatus.approved:
        return {
            "success": False,
            "message": "Cannot reject an already-approved registration. Deactivate the user account instead.",
        }
    if pending.status == PendingStatus.rejected:
        return {"success": False, "message": "Registration is already rejected"}

    pending.status = PendingStatus.rejected
    db.commit()

    return {
        "success": True,
        "message": f"Registration for {pending.full_name or pending.email} rejected",
    }


def handle_mutation_activate_rep(
    db: Session,
    user: User,
    user_id: str,
) -> dict:
    """Activate a deactivated hotel representative."""
    try:
        uid = uuid.UUID(user_id)
    except ValueError:
        return {"success": False, "message": f"Invalid user_id format: '{user_id}'"}

    rep = db.query(User).filter(
        User.id == uid,
        User.role == UserRole.hotel_rep,
    ).first()

    if not rep:
        return {"success": False, "message": "Hotel rep not found"}

    if rep.is_active:
        return {"success": False, "message": f"{rep.full_name or rep.email} is already active"}

    rep.is_active = True
    db.commit()

    return {
        "success": True,
        "message": f"Hotel rep {rep.full_name or rep.email} activated",
    }


def handle_mutation_deactivate_rep(
    db: Session,
    user: User,
    user_id: str,
) -> dict:
    """Deactivate an active hotel representative."""
    try:
        uid = uuid.UUID(user_id)
    except ValueError:
        return {"success": False, "message": f"Invalid user_id format: '{user_id}'"}

    rep = db.query(User).filter(
        User.id == uid,
        User.role == UserRole.hotel_rep,
    ).first()

    if not rep:
        return {"success": False, "message": "Hotel rep not found"}

    if not rep.is_active:
        return {"success": False, "message": f"{rep.full_name or rep.email} is already inactive"}

    rep.is_active = False
    db.commit()

    return {
        "success": True,
        "message": f"Hotel rep {rep.full_name or rep.email} deactivated",
    }


# ═══════════════════════════════════════════════════════════════
# 5.  HANDLER: Hotel Rep — Properties
# ═══════════════════════════════════════════════════════════════

def _get_rep_property_ids(db: Session, user: User) -> list[str]:
    """Get UUIDs of all properties owned by this rep."""
    rows = db.query(Property.id).filter(Property.owner_rep_id == user.id).all()
    return [str(r.id) for r in rows]


def handle_rep_properties(
    db: Session,
    user: User,
) -> dict:
    """List the hotel rep's own properties with room details."""
    properties = (
        db.query(Property)
        .filter(Property.owner_rep_id == user.id)
        .order_by(Property.created_at.desc())
        .all()
    )

    if not properties:
        return {
            "success": True,
            "data": {"properties": []},
            "formatted": "You have no properties registered yet.",
        }

    prop_ids = [p.id for p in properties]

    # Batch-fetch rooms for all properties
    all_rooms = (
        db.query(Room)
        .filter(Room.property_id.in_(prop_ids))
        .order_by(Room.property_id, Room.base_price)
        .all()
    )
    rooms_by_prop: dict[str, list] = {}
    for r in all_rooms:
        pid = str(r.property_id)
        rooms_by_prop.setdefault(pid, []).append(r)

    lines = [f"You have {len(properties)} propert{'y' if len(properties) == 1 else 'ies'}:"]
    data_props = []

    for p in properties:
        city = p.city.name if p.city else "Unknown"
        status = "Approved" if p.is_approved else "Pending approval"
        prop_rooms = rooms_by_prop.get(str(p.id), [])

        room_types = ", ".join(sorted(set(r.room_type for r in prop_rooms))) if prop_rooms else "No rooms"
        prices = [r.base_price for r in prop_rooms]
        price_range = f"₹{min(prices):,.0f}-₹{max(prices):,.0f}/night" if prices else "N/A"
        amenities = [k.replace("_", " ") for k, v in (p.amenities or {}).items() if v]

        lines.append(
            f"  - {p.name} [PropertyCard: {p.id}] | {city} | "
            f"{p.property_type.value if p.property_type else 'hotel'} | "
            f"{len(prop_rooms)} rooms ({room_types}) | {price_range} | "
            f"{p.avg_rating or 0}★ ({p.review_count or 0} reviews) | "
            f"{status}"
        )

        data_props.append({
            "id": str(p.id),
            "name": p.name,
            "property_type": p.property_type.value if p.property_type else None,
            "city": city,
            "room_count": len(prop_rooms),
            "avg_rating": p.avg_rating,
            "review_count": p.review_count,
            "is_approved": p.is_approved,
        })

    return {
        "success": True,
        "data": {"properties": data_props},
        "formatted": "\n".join(lines),
    }


# ═══════════════════════════════════════════════════════════════
# 6.  HANDLER: Hotel Rep — Availability Today
# ═══════════════════════════════════════════════════════════════

def handle_rep_availability_today(
    db: Session,
    user: User,
) -> dict:
    """Get today's room availability across all the rep's properties."""
    properties = (
        db.query(Property)
        .filter(Property.owner_rep_id == user.id)
        .all()
    )

    if not properties:
        return {
            "success": True,
            "data": {"total_rooms": 0, "available": 0, "rooms": []},
            "formatted": "You have no properties registered yet.",
        }

    prop_ids = [p.id for p in properties]
    all_rooms = (
        db.query(Room)
        .filter(Room.property_id.in_(prop_ids))
        .all()
    )

    if not all_rooms:
        return {
            "success": True,
            "data": {"total_rooms": 0, "available": 0, "rooms": []},
            "formatted": "Your properties have no rooms set up yet.",
        }

    today = date_type.today()
    room_ids = [r.id for r in all_rooms]
    room_id_strs = [str(r.id) for r in all_rooms]

    # Fetch availability rows for today
    avail_rows = (
        db.query(Availability)
        .filter(
            Availability.room_id.in_(room_ids),
            Availability.date == today,
        )
        .all()
    )
    avail_map = {str(a.room_id): a.quantity_available for a in avail_rows}

    # Fallback for rooms without availability rows
    uncovered = [r for r in all_rooms if str(r.id) not in avail_map]
    if uncovered:
        booking_counts = db.execute(text("""
            SELECT b.room_id, COUNT(b.id) as cnt
            FROM bookings b
            WHERE b.room_id = ANY(:room_ids)
              AND b.status IN ('pending', 'confirmed')
              AND b.check_in <= :today
              AND b.check_out > :today
            GROUP BY b.room_id
        """), {"room_ids": [str(r.id) for r in uncovered], "today": today}).fetchall()

        booked_map = {str(row[0]): row[1] for row in booking_counts}
        for r in uncovered:
            avail_map[str(r.id)] = max(0, r.total_quantity - booked_map.get(str(r.id), 0))

    total_rooms = len(all_rooms)
    total_available = sum(avail_map.get(str(r.id), r.total_quantity) for r in all_rooms)
    date_str = today.strftime("%b %d, %Y")

    lines = [f"Room availability for {date_str}:"]
    lines.append(f"  Total: {total_available}/{total_rooms} available | {total_rooms - total_available} occupied")

    data_rooms = []
    for room in all_rooms:
        avail = avail_map.get(str(room.id), room.total_quantity)
        lines.append(f"  - {room.room_type} ({room.property.name}): {avail}/{room.total_quantity} available")
        data_rooms.append({
            "room_id": str(room.id),
            "room_type": room.room_type,
            "property_name": room.property.name,
            "property_id": str(room.property_id),
            "total": room.total_quantity,
            "available": avail,
        })

    return {
        "success": True,
        "data": {
            "date": today.isoformat(),
            "total_rooms": total_rooms,
            "total_available": total_available,
            "rooms": data_rooms,
        },
        "formatted": "\n".join(lines),
    }


# ═══════════════════════════════════════════════════════════════
# 7.  HANDLER: Hotel Rep — Bookings Summary
# ═══════════════════════════════════════════════════════════════

def handle_rep_bookings(
    db: Session,
    user: User,
    limit: int = 10,
) -> dict:
    """Get booking statistics and recent bookings for the rep's properties."""
    prop_ids = _get_rep_property_ids(db, user)
    if not prop_ids:
        return {
            "success": True,
            "data": {"bookings": [], "recent": []},
            "formatted": "You have no properties registered yet.",
        }

    # Booking counts by status + revenue
    booking_rows = db.execute(text("""
        SELECT
            b.status,
            COUNT(b.id) as cnt,
            COALESCE(SUM(b.total_price), 0) as revenue
        FROM bookings b
        JOIN rooms r ON b.room_id = r.id
        WHERE r.property_id IN :prop_ids
        GROUP BY b.status
    """), {"prop_ids": tuple(prop_ids)}).fetchall()

    status_counts = {}
    total_revenue = 0
    for row in booking_rows:
        status_counts[row.status] = row.cnt
        if row.status in ("confirmed", "completed"):
            total_revenue += row.revenue

    total_bookings = sum(status_counts.values())

    # Recent bookings
    recent = db.execute(text("""
        SELECT
            u.full_name AS customer_name,
            p.name AS property_name,
            rm.room_type,
            b.check_in,
            b.check_out,
            b.num_adults,
            b.num_children,
            b.status,
            b.total_price,
            b.created_at
        FROM bookings b
        JOIN rooms rm ON b.room_id = rm.id
        JOIN properties p ON rm.property_id = p.id
        LEFT JOIN users u ON b.customer_id = u.id
        WHERE p.owner_rep_id = :rep_id
        ORDER BY b.created_at DESC
        LIMIT :lim
    """), {"rep_id": str(user.id), "lim": min(limit, 50)}).fetchall()

    lines = [
        f"Total bookings: {total_bookings}",
        f"  {status_counts.get('confirmed', 0)} confirmed | "
        f"{status_counts.get('completed', 0)} completed | "
        f"{status_counts.get('pending', 0)} pending | "
        f"{status_counts.get('cancelled', 0)} cancelled",
        f"Estimated revenue (confirmed + completed): ₹{total_revenue:,.0f}",
    ]

    data_recent = []
    if recent:
        lines.append(f"\nRecent bookings (last {len(recent)}):")
        for rb in recent:
            check_in = rb.check_in.strftime("%b %d") if rb.check_in else "?"
            check_out = rb.check_out.strftime("%b %d") if rb.check_out else "?"
            guests = f"{rb.num_adults}A"
            if rb.num_children:
                guests += f"+{rb.num_children}C"
            lines.append(
                f"  - {rb.customer_name or 'Guest'} → {rb.property_name}, "
                f"{rb.room_type}, {check_in}-{check_out} ({guests}), "
                f"{rb.status}, ₹{rb.total_price:,.0f}"
            )
            data_recent.append({
                "customer_name": rb.customer_name or "Guest",
                "property_name": rb.property_name,
                "room_type": rb.room_type,
                "check_in": rb.check_in.isoformat() if rb.check_in else None,
                "check_out": rb.check_out.isoformat() if rb.check_out else None,
                "status": rb.status,
                "total_price": float(rb.total_price) if rb.total_price else 0,
            })

    return {
        "success": True,
        "data": {
            "totals": {
                "total": total_bookings,
                "confirmed": status_counts.get("confirmed", 0),
                "completed": status_counts.get("completed", 0),
                "pending": status_counts.get("pending", 0),
                "cancelled": status_counts.get("cancelled", 0),
            },
            "revenue": total_revenue,
            "recent": data_recent,
        },
        "formatted": "\n".join(lines),
    }


# ═══════════════════════════════════════════════════════════════
# 8.  HANDLER: Hotel Rep — Reviews Summary
# ═══════════════════════════════════════════════════════════════

def handle_rep_reviews(
    db: Session,
    user: User,
) -> dict:
    """Get review summary for the rep's properties."""
    review_rows = db.execute(text("""
        SELECT
            p.name AS property_name,
            ROUND(AVG(r.rating)::numeric, 1) AS avg_rating,
            COUNT(r.id) AS review_count,
            SUM(CASE WHEN r.rep_response IS NULL THEN 1 ELSE 0 END) AS unanswered
        FROM reviews r
        JOIN properties p ON r.property_id = p.id
        WHERE p.owner_rep_id = :rep_id
        GROUP BY p.name, p.id
        ORDER BY avg_rating DESC
    """), {"rep_id": str(user.id)}).fetchall()

    if not review_rows:
        return {
            "success": True,
            "data": {"properties": []},
            "formatted": "Your properties have no reviews yet.",
        }

    lines = ["Review summary:"]
    data_props = []
    for rr in review_rows:
        unanswered = f" ({rr.unanswered} unanswered)" if rr.unanswered else ""
        lines.append(f"  - {rr.property_name}: {rr.avg_rating}★ ({rr.review_count} reviews){unanswered}")
        data_props.append({
            "property_name": rr.property_name,
            "avg_rating": float(rr.avg_rating) if rr.avg_rating else 0,
            "review_count": rr.review_count,
            "unanswered": rr.unanswered,
        })

    return {
        "success": True,
        "data": {"properties": data_props},
        "formatted": "\n".join(lines),
    }


# ═══════════════════════════════════════════════════════════════
# 9.  HANDLER: Hotel Rep — Uploaded Documents
# ═══════════════════════════════════════════════════════════════

def handle_rep_documents(
    db: Session,
    user: User,
) -> dict:
    """List uploaded documents per property for the rep."""
    prop_ids = _get_rep_property_ids(db, user)
    if not prop_ids:
        return {
            "success": True,
            "data": {"documents": []},
            "formatted": "You have no properties registered yet.",
        }

    properties = (
        db.query(Property)
        .filter(Property.owner_rep_id == user.id)
        .order_by(Property.created_at.desc())
        .all()
    )

    documents = (
        db.query(PropertyDocument)
        .filter(PropertyDocument.property_id.in_(prop_ids))
        .order_by(PropertyDocument.property_id, PropertyDocument.doc_type)
        .all()
    )

    docs_by_prop: dict[str, list] = {}
    for doc in documents:
        pid = str(doc.property_id)
        docs_by_prop.setdefault(pid, []).append(doc)

    lines = ["Uploaded documents:"]
    data_docs = []

    for p in properties:
        prop_docs = docs_by_prop.get(str(p.id), [])
        if prop_docs:
            doc_list = ", ".join(f'"{d.title}" ({d.doc_type.value})' for d in prop_docs)
            lines.append(f"  - {p.name}: {doc_list}")
            for d in prop_docs:
                data_docs.append({
                    "property_name": p.name,
                    "property_id": str(p.id),
                    "title": d.title,
                    "doc_type": d.doc_type.value if d.doc_type else "other",
                })
        else:
            lines.append(f"  - {p.name}: (no documents uploaded)")

    if not documents:
        lines = ["You have not uploaded any documents yet."]

    return {
        "success": True,
        "data": {"documents": data_docs},
        "formatted": "\n".join(lines),
    }


# ═══════════════════════════════════════════════════════════════
# 10.  HANDLER: Admin — Pending Registrations
# ═══════════════════════════════════════════════════════════════

def handle_admin_pending_registrations(
    db: Session,
    user: User,
) -> dict:
    """List all pending hotel registrations."""
    pending = (
        db.query(PendingHotelRegistration)
        .filter(PendingHotelRegistration.status == PendingStatus.pending)
        .order_by(PendingHotelRegistration.created_at.desc())
        .all()
    )

    if not pending:
        return {
            "success": True,
            "data": {"registrations": []},
            "formatted": "No pending hotel registrations.",
        }

    lines = [f"Pending hotel registrations ({len(pending)}):"]
    data_list = []

    for p in pending:
        date_str = p.created_at.strftime("%Y-%m-%d") if p.created_at else "N/A"
        lines.append(
            f"  - UUID: {p.id} | Name: {p.full_name or 'N/A'} | "
            f"Email: {p.email} | Submitted: {date_str}"
        )
        data_list.append({
            "id": str(p.id),
            "full_name": p.full_name,
            "email": p.email,
            "created_at": p.created_at.isoformat() if p.created_at else None,
        })

    return {
        "success": True,
        "data": {"registrations": data_list},
        "formatted": "\n".join(lines),
    }


# ═══════════════════════════════════════════════════════════════
# 11.  HANDLER: Admin — Platform Statistics
# ═══════════════════════════════════════════════════════════════

def handle_admin_statistics(
    db: Session,
    user: User,
) -> dict:
    """Get platform-wide statistics."""
    from sqlalchemy import func as sa_func

    total_properties = db.query(Property).count()
    total_rooms = db.query(Room).count()

    # Properties by city (top 10)
    city_rows = db.execute(text("""
        SELECT l.name, COUNT(p.id) as cnt
        FROM properties p
        JOIN locations l ON p.city_id = l.id
        GROUP BY l.name
        ORDER BY cnt DESC
        LIMIT 10
    """)).fetchall()

    # User counts by role
    role_counts = (
        db.query(User.role, sa_func.count(User.id))
        .group_by(User.role)
        .all()
    )
    role_dict = {str(r.value) if hasattr(r, 'value') else str(r): c for r, c in role_counts}

    pending_count = (
        db.query(PendingHotelRegistration)
        .filter(PendingHotelRegistration.status == PendingStatus.pending)
        .count()
    )

    lines = [
        "=== Platform Statistics ===",
        f"Total properties registered: {total_properties}",
        f"Total rooms across all properties: {total_rooms}",
        f"Total hotel representatives: {role_dict.get('hotel_rep', 0)}",
        f"Total customers: {role_dict.get('customer', 0)}",
        f"Pending registrations: {pending_count}",
    ]

    if city_rows:
        lines.append("\nProperties by city:")
        for name, cnt in city_rows:
            lines.append(f"  - {name}: {cnt} properties")

    return {
        "success": True,
        "data": {
            "total_properties": total_properties,
            "total_rooms": total_rooms,
            "total_hotel_reps": role_dict.get("hotel_rep", 0),
            "total_customers": role_dict.get("customer", 0),
            "pending_registrations": pending_count,
            "properties_by_city": [
                {"city": name, "count": cnt} for name, cnt in city_rows
            ],
        },
        "formatted": "\n".join(lines),
    }


# ═══════════════════════════════════════════════════════════════
# 12.  HANDLER: Admin — Hotel Rep List
# ═══════════════════════════════════════════════════════════════

def handle_admin_rep_list(
    db: Session,
    user: User,
    include_inactive: bool = True,
) -> dict:
    """List all hotel representatives."""
    query = db.query(User).filter(User.role == UserRole.hotel_rep)

    if not include_inactive:
        query = query.filter(User.is_active == True)

    reps = query.order_by(User.created_at.desc()).all()

    if not reps:
        return {
            "success": True,
            "data": {"reps": []},
            "formatted": "No hotel representatives found.",
        }

    lines = [f"Hotel Representatives ({len(reps)}):"]
    data_list = []

    for r in reps:
        status = "Active" if r.is_active else "Inactive"
        lines.append(
            f"  - UUID: {r.id} | Name: {r.full_name or 'N/A'} | "
            f"Email: {r.email} | Status: {status}"
        )
        data_list.append({
            "id": str(r.id),
            "full_name": r.full_name,
            "email": r.email,
            "is_active": r.is_active,
        })

    return {
        "success": True,
        "data": {"reps": data_list},
        "formatted": "\n".join(lines),
    }


# ═══════════════════════════════════════════════════════════════
# 13.  HANDLER: Customer — My Bookings
# ═══════════════════════════════════════════════════════════════

def handle_customer_bookings(
    db: Session,
    user: User,
    status: str | None = None,
    limit: int = 10,
) -> dict:
    """Get the logged-in customer's own bookings.

    Returns bookings with property name, room type, dates, guest info,
    status, and total price. Automatically scoped to user.id.

    Args:
        db: Database session.
        user: The logged-in customer (must have role=customer).
        status: Optional filter by booking status.
        limit: Max results (1-50).

    Returns:
        Dict with success, data, and formatted keys.
    """
    if status is not None and status not in ("pending", "confirmed", "cancelled", "completed"):
        return {
            "success": False,
            "data": {"bookings": []},
            "formatted": f"(Invalid status filter '{status}'. Valid values: pending, confirmed, cancelled, completed)",
        }

    # Build query joining Booking → Room → Property
    query = (
        db.query(
            Booking.id,
            Booking.check_in,
            Booking.check_out,
            Booking.num_adults,
            Booking.num_children,
            Booking.status,
            Booking.total_price,
            Booking.created_at,
            Room.room_type,
            Property.name.label("property_name"),
            Property.id.label("property_id"),
        )
        .join(Room, Booking.room_id == Room.id)
        .join(Property, Room.property_id == Property.id)
        .filter(Booking.customer_id == user.id)
    )

    if status is not None:
        query = query.filter(Booking.status == status)

    rows = query.order_by(Booking.created_at.desc()).limit(min(limit, 50)).all()

    if not rows:
        msg = "You have no bookings."
        if status:
            msg = f"You have no {status} bookings."
        return {
            "success": True,
            "data": {"bookings": []},
            "formatted": msg,
        }

    data_list = []
    status_counts: dict[str, int] = {}

    for row in rows:
        status_str = row.status.value if hasattr(row.status, 'value') else str(row.status)
        status_counts[status_str] = status_counts.get(status_str, 0) + 1

        data_list.append({
            "id": str(row.id),
            "property_name": row.property_name,
            "property_id": str(row.property_id),
            "room_type": row.room_type,
            "check_in": row.check_in.isoformat() if row.check_in else None,
            "check_out": row.check_out.isoformat() if row.check_out else None,
            "num_adults": row.num_adults,
            "num_children": row.num_children or 0,
            "status": status_str,
            "total_price": float(row.total_price) if row.total_price else 0,
            "booked_at": row.created_at.isoformat() if row.created_at else None,
        })

    # Build formatted text
    summary_parts = [f"You have {len(rows)} booking{'s' if len(rows) != 1 else ''}:"]
    for key in ("confirmed", "pending", "completed", "cancelled"):
        if status_counts.get(key, 0) > 0:
            summary_parts.append(f"  - {status_counts[key]} {key}")
    summary = "\n".join(summary_parts)

    detail_lines = [f"\nYour bookings (last {len(data_list)}):"]
    for b in data_list:
        ci = b["check_in"][:10] if b["check_in"] else "?"
        co = b["check_out"][:10] if b["check_out"] else "?"
        guests = f"{b['num_adults']} adults"
        if b["num_children"]:
            guests += f", {b['num_children']} children"
        detail_lines.append(
            f"  - {b['property_name']} ({b['room_type']}) | "
            f"{ci} → {co} | {guests} | "
            f"{b['status'].title()} | ₹{b['total_price']:,.0f}"
        )

    formatted = summary + "\n" + "\n".join(detail_lines)

    return {
        "success": True,
        "data": {"bookings": data_list},
        "formatted": formatted,
    }


# ═══════════════════════════════════════════════════════════════
# 14.  HANDLER MAP: Tool name → handler function
#      (Defined here, after all handler function definitions, to
#       avoid Python forward-reference issues at module load time.)
# ═══════════════════════════════════════════════════════════════

HANDLER_MAP: dict[str, object] = {
    "VECTOR_SEARCH": handle_vector_search,
    "MUTATION_APPROVE_HOTEL": handle_mutation_approve_hotel,
    "MUTATION_REJECT_HOTEL": handle_mutation_reject_hotel,
    "MUTATION_ACTIVATE_REP": handle_mutation_activate_rep,
    "MUTATION_DEACTIVATE_REP": handle_mutation_deactivate_rep,
    "REP_PROPERTIES": handle_rep_properties,
    "REP_AVAILABILITY_TODAY": handle_rep_availability_today,
    "REP_BOOKINGS": handle_rep_bookings,
    "REP_REVIEWS": handle_rep_reviews,
    "REP_DOCUMENTS": handle_rep_documents,
    "CUSTOMER_BOOKINGS": handle_customer_bookings,
    "ADMIN_PENDING_REGISTRATIONS": handle_admin_pending_registrations,
    "ADMIN_STATISTICS": handle_admin_statistics,
    "ADMIN_REP_LIST": handle_admin_rep_list,
}


def execute_tool(
    db: Session,
    user: User | None,
    tool_name: str,
    params: dict,
) -> dict:
    """Execute a single tool by name with the given parameters.

    Validates that:
      1. The tool exists in the registry
      2. The user's role is allowed to use it
      3. Required params are provided

    Args:
        db: Database session.
        user: Current user (may be None for guests).
        tool_name: Name of the tool to execute.
        params: Parameters to pass to the handler.

    Returns:
        Dict with the handler's result.
    """
    # Check tool exists
    if tool_name not in TOOL_REGISTRY:
        return {
            "success": False,
            "error": f"Unknown tool '{tool_name}'",
        }

    cfg = TOOL_REGISTRY[tool_name]

    # Check role permission
    user_role = user.role if user else None
    allowed = cfg["allowed_roles"]
    if user_role not in allowed and None not in allowed:
        return {
            "success": False,
            "error": f"Tool '{tool_name}' is not available for your role ({user_role})",
        }

    # Validate required params and inject defaults from schema
    schema = cfg["params_schema"]
    for p_name, p_cfg in schema.items():
        if p_cfg.get("required") and p_name not in params:
            return {
                "success": False,
                "error": f"Missing required parameter '{p_name}' for tool '{tool_name}'",
            }
        # Inject default value if param not provided
        if p_name not in params and "default" in p_cfg:
            params[p_name] = p_cfg["default"]

    # Look up the handler by tool name (not by string indirection)
    handler = HANDLER_MAP.get(tool_name)

    if not handler:
        return {
            "success": False,
            "error": f"No handler registered for tool '{tool_name}'",
        }

    try:
        # Inject db and user as first args
        result = handler(db=db, user=user, **params)
        if not isinstance(result, dict):
            result = {"success": True, "data": result}
        result.setdefault("success", True)
        return result
    except Exception as e:
        logger.error(f"Tool '{tool_name}' failed: {e}", exc_info=True)
        return {
            "success": False,
            "error": f"Tool '{tool_name}' execution failed: {str(e)}",
        }
