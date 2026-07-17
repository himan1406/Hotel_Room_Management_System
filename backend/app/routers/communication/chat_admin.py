import uuid

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.db_models import (
    User, UserRole, PendingHotelRegistration, PendingStatus,
)
from app.routers.auth.auth import require_role

router = APIRouter(tags=["chat"])


# ── Request model ──────────────────────────────────────────────────────────

class AdminActionRequest(BaseModel):
    action: str = Field(..., pattern="^(approve_hotel|reject_hotel|deactivate_hotel_rep|activate_hotel_rep)$")
    id: uuid.UUID


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
