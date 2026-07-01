import os
import uuid

from fastapi import APIRouter, Depends, HTTPException, UploadFile, File
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import (
    PendingHotelRegistration, PendingStatus, User, UserRole,
)
from app.routers.auth import require_role, get_current_user
from app.schemas import PendingHotelResponse, ApproveRejectRequest
from app.config import UPLOAD_DIR

router = APIRouter(prefix="/api/admin", tags=["admin"])
admin_required = require_role(UserRole.admin)


@router.get("/pending-hotels")
def list_pending_hotels(
    db: Session = Depends(get_db),
    user: User = Depends(admin_required),
):
    pendings = db.query(PendingHotelRegistration).filter(
        PendingHotelRegistration.status == PendingStatus.pending
    ).order_by(PendingHotelRegistration.created_at.desc()).all()
    return [PendingHotelResponse.model_validate(p).model_dump() for p in pendings]


@router.get("/pending-hotels/all")
def list_all_hotels(
    db: Session = Depends(get_db),
    user: User = Depends(admin_required),
):
    pendings = db.query(PendingHotelRegistration).order_by(
        PendingHotelRegistration.created_at.desc()
    ).all()
    return [PendingHotelResponse.model_validate(p).model_dump() for p in pendings]


@router.post("/approve-hotel")
def approve_hotel(
    req: ApproveRejectRequest,
    db: Session = Depends(get_db),
    user: User = Depends(admin_required),
):
    pending = db.query(PendingHotelRegistration).filter(
        PendingHotelRegistration.id == req.id,
        PendingHotelRegistration.status == PendingStatus.pending
    ).first()
    if not pending:
        raise HTTPException(status_code=404, detail="Pending registration not found")
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
    return {"message": f"Hotel rep {pending.email} approved and account created"}


@router.post("/reject-hotel")
def reject_hotel(
    req: ApproveRejectRequest,
    db: Session = Depends(get_db),
    user: User = Depends(admin_required),
):
    pending = db.query(PendingHotelRegistration).filter(
        PendingHotelRegistration.id == req.id
    ).first()
    if not pending:
        raise HTTPException(status_code=404, detail="Registration not found")
    pending.status = PendingStatus.rejected
    db.commit()
    return {"message": f"Registration for {pending.email} rejected"}


@router.post("/upload-doc/{pending_id}")
async def upload_doc(
    pending_id: uuid.UUID,
    file: UploadFile = File(...),
    db: Session = Depends(get_db),
    user: User = Depends(get_current_user),
):
    pending = db.query(PendingHotelRegistration).filter(
        PendingHotelRegistration.id == pending_id
    ).first()
    if not pending:
        raise HTTPException(status_code=404, detail="Registration not found")
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    ext = os.path.splitext(file.filename)[1] if file.filename else ".pdf"
    filename = f"{pending_id}{ext}"
    filepath = os.path.join(UPLOAD_DIR, filename)
    content = await file.read()
    with open(filepath, "wb") as f:
        f.write(content)
    pending.doc_url = f"/uploads/{filename}"
    db.commit()
    return {"message": "Document uploaded", "url": pending.doc_url}


@router.get("/hotel-reps")
def list_hotel_reps(
    db: Session = Depends(get_db),
    user: User = Depends(admin_required),
):
    reps = db.query(User).filter(User.role == UserRole.hotel_rep).order_by(User.created_at.desc()).all()
    return [
        {
            "id": str(r.id),
            "email": r.email,
            "full_name": r.full_name,
            "phone": r.phone,
            "is_active": r.is_active,
            "created_at": r.created_at.isoformat() if r.created_at else None,
        }
        for r in reps
    ]


@router.post("/toggle-rep/{rep_id}")
def toggle_rep_status(
    rep_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(admin_required),
):
    rep = db.query(User).filter(User.id == rep_id, User.role == UserRole.hotel_rep).first()
    if not rep:
        raise HTTPException(status_code=404, detail="Hotel rep not found")
    rep.is_active = not rep.is_active
    db.commit()
    return {"message": f"Hotel rep {'activated' if rep.is_active else 'deactivated'}"}
