import logging
import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.db_models import (
    Location, Property, Room, User,
    UserRole, PendingHotelRegistration, PendingStatus,
)
from app.routers.auth.auth import require_role

logger = logging.getLogger(__name__)

router = APIRouter(tags=["chat"])


# ── Request model ──────────────────────────────────────────────────────────

class AdminActionRequest(BaseModel):
    action: str = Field(..., pattern="^(approve_hotel|reject_hotel|deactivate_hotel_rep|activate_hotel_rep)$")
    id: uuid.UUID


# ── Admin system prompt ────────────────────────────────────────────────────

ADMIN_PROMPT = """
=== Admin Dashboard Context ===
{admin_context}

You have SPECIAL ADMIN capabilities. Follow these additional rules:

1. When the user asks about platform statistics (how many properties, rooms, registrations, etc.), use the Admin Dashboard Context above. Answer directly without any citation tags like [from Admin Dashboard].

2. When the user asks to "show pending registrations", "pending hotels", or similar, list each pending registration and include the exact markup `[PendingHotel: <uuid> | <name> | <email>]` for each one. The system will render interactive approve/deny buttons for each registration.

3. When the user asks to "approve" or "reject" a specific pending registration by name, include the exact markup `[Action: approve_hotel | <uuid> | <name>]` or `[Action: reject_hotel | <uuid> | <name>]`. The system will show a confirmation dialog before executing.

4. When the user asks to "deactivate" or "disable" a hotel rep, find their UUID from the Hotel Representatives list above and include the exact markup `[Action: deactivate_hotel_rep | <uuid> | <name>]`. The system will show a confirmation dialog before executing. Only use UUIDs that appear in the list — NEVER make up or guess UUIDs.

5. When the user asks to "activate" or "enable" a hotel rep, find their UUID from the Hotel Representatives list above and include the exact markup `[Action: activate_hotel_rep | <uuid> | <name>]`. The system will show a confirmation dialog before executing. Only use UUIDs that appear in the list — NEVER make up or guess UUIDs.

6. For questions about properties by city/region, use the statistics in the Admin Dashboard Context. Answer directly.

7. Always confirm before performing any action (approve/reject/deactivate/activate). State clearly what you are about to do before including the action markup.

8. You can combine admin answers with regular property/policy questions.
"""


# ── Context builder ────────────────────────────────────────────────────────

def _build_admin_context(db: Session) -> str:
    """Build admin dashboard context for injection into the system prompt."""
    total_properties = db.query(Property).count()
    total_rooms = db.query(Room).count()

    city_rows = db.execute(text("""
        SELECT l.name, COUNT(p.id) as cnt
        FROM properties p
        JOIN locations l ON p.city_id = l.id
        GROUP BY l.name
        ORDER BY cnt DESC
        LIMIT 10
    """)).fetchall()

    pending = db.query(PendingHotelRegistration).filter(
        PendingHotelRegistration.status == PendingStatus.pending
    ).order_by(PendingHotelRegistration.created_at.desc()).all()

    from sqlalchemy import func as sa_func
    role_counts = db.query(User.role, sa_func.count(User.id)).group_by(User.role).all()
    role_dict = {r.value: c for r, c in role_counts}

    lines = []
    lines.append(f"Total properties registered: {total_properties}")
    lines.append(f"Total rooms across all properties: {total_rooms}")
    lines.append(f"Total hotel representatives: {role_dict.get('hotel_rep', 0)}")
    lines.append(f"Total customers: {role_dict.get('customer', 0)}")

    if city_rows:
        lines.append("\nProperties by city:")
        for name, cnt in city_rows:
            lines.append(f"  - {name}: {cnt} properties")

    if pending:
        lines.append(f"\nPending hotel registrations ({len(pending)}):")
        for p in pending:
            lines.append(f"  - UUID: {p.id} | Name: {p.full_name or 'N/A'} | Email: {p.email} | Submitted: {p.created_at.strftime('%Y-%m-%d') if p.created_at else 'N/A'}")
    else:
        lines.append("\nNo pending hotel registrations.")

    reps = db.query(User).filter(User.role == UserRole.hotel_rep).order_by(User.created_at.desc()).all()
    if reps:
        lines.append(f"\nHotel Representatives ({len(reps)}):")
        for r in reps:
            status = "active" if r.is_active else "inactive"
            lines.append(f"  - UUID: {r.id} | Name: {r.full_name or 'N/A'} | Email: {r.email} | Status: {status}")
    else:
        lines.append("\nNo hotel representatives registered yet.")

    return "\n".join(lines)


def build_admin_prompt_for_user(db: Session, user) -> str:
    """Return the formatted admin prompt for admin users, empty string otherwise."""
    if not user or user.role != UserRole.admin:
        return ""
    try:
        admin_context = _build_admin_context(db)
        return ADMIN_PROMPT.format(admin_context=admin_context)
    except Exception:
        logger.warning("Failed to build admin context for chat", exc_info=True)
        return ""


# ── Admin action endpoint ──────────────────────────────────────────────────

@router.post("/api/chat/admin-action")
def admin_chat_action(
    req: AdminActionRequest,
    db: Session = Depends(get_db),
    user: User = Depends(require_role(UserRole.admin)),
):
    """Execute an admin action from the chatbot."""
    # Hotel rep actions (operate on User)
    if req.action in ("deactivate_hotel_rep", "activate_hotel_rep"):
        rep = db.query(User).filter(
            User.id == req.id,
            User.role == UserRole.hotel_rep,
        ).first()
        if not rep:
            raise HTTPException(status_code=404, detail="Hotel rep not found")

        if req.action == "deactivate_hotel_rep":
            if not rep.is_active:
                raise HTTPException(status_code=400, detail=f"{rep.full_name or rep.email} is already inactive")
            rep.is_active = False
            db.commit()
            return {"message": f"Hotel rep {rep.full_name or rep.email} deactivated"}

        elif req.action == "activate_hotel_rep":
            if rep.is_active:
                raise HTTPException(status_code=400, detail=f"{rep.full_name or rep.email} is already active")
            rep.is_active = True
            db.commit()
            return {"message": f"Hotel rep {rep.full_name or rep.email} activated"}

    # Pending registration actions (operate on PendingHotelRegistration)
    pending = db.query(PendingHotelRegistration).filter(
        PendingHotelRegistration.id == req.id
    ).first()
    if not pending:
        raise HTTPException(status_code=404, detail="Registration not found")

    if req.action == "approve_hotel":
        if pending.status == PendingStatus.approved:
            raise HTTPException(status_code=400, detail="Registration is already approved")
        if pending.status == PendingStatus.rejected:
            raise HTTPException(status_code=400, detail="Registration was already rejected")
        if db.query(User).filter(User.email == pending.email).first():
            raise HTTPException(status_code=400, detail="User with this email already exists")
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
        return {"message": f"Hotel rep {pending.full_name or pending.email} approved and account created"}

    elif req.action == "reject_hotel":
        if pending.status == PendingStatus.approved:
            raise HTTPException(
                status_code=400,
                detail="Cannot reject an already-approved registration. Deactivate the user account instead.",
            )
        if pending.status == PendingStatus.rejected:
            raise HTTPException(status_code=400, detail="Registration is already rejected")
        pending.status = PendingStatus.rejected
        db.commit()
        return {"message": f"Registration for {pending.full_name or pending.email} rejected"}
