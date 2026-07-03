import os
import uuid

from fastapi import APIRouter, Depends, HTTPException, Query, UploadFile, File
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import (
    PendingHotelRegistration, PendingStatus, User, UserRole, Property, Location,
)
from app.routers.auth import require_role, get_current_user
from app.schemas import PendingHotelResponse, ApproveRejectRequest
from app.config import UPLOAD_DIR

# ── Upload constraints ─────────────────────────────────────────────────────────
MAX_UPLOAD_BYTES = 5 * 1024 * 1024            # 5 MB hard cap
ALLOWED_EXTENSIONS = {".pdf", ".jpg", ".jpeg", ".png"}

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
    if pending.status == PendingStatus.approved:
        raise HTTPException(
            status_code=400,
            detail="Cannot reject an already-approved registration. Deactivate the user account instead.",
        )
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

    # ── Authorisation ──────────────────────────────────────────────────────
    # Only the registrant (matched by email) or an admin may upload a document.
    is_owner = pending.email == user.email
    is_admin = user.role == UserRole.admin
    if not (is_owner or is_admin):
        raise HTTPException(status_code=403, detail="Not authorised to upload for this registration")

    # ── File validation ────────────────────────────────────────────────────
    # Read once (so we can check size before touching the filesystem).
    content = await file.read()
    if len(content) > MAX_UPLOAD_BYTES:
        raise HTTPException(
            status_code=413,
            detail=f"File too large. Maximum allowed size is {MAX_UPLOAD_BYTES // (1024*1024)} MB.",
        )

    # Validate the extension against a strict allowlist.  Do NOT use the raw
    # client-supplied filename — extract only the suffix and lower-case it.
    raw_ext = os.path.splitext(file.filename or "")[1].lower()
    if raw_ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=415,
            detail=f"Unsupported file type '{raw_ext}'. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}.",
        )

    # ── Persist ───────────────────────────────────────────────────────────
    # Build filename from the UUID + validated extension only — never trust the
    # original client filename (avoids path-traversal and injection attacks).
    os.makedirs(UPLOAD_DIR, exist_ok=True)
    filename = f"{pending_id}{raw_ext}"
    filepath = os.path.join(UPLOAD_DIR, filename)
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


# ── Property management ─────────────────────────────────────────────────────


@router.get("/properties")
def list_properties(
    status: str = Query("all", regex="^(all|pending|approved)$"),
    q: str = Query("", max_length=200),
    rep_id: uuid.UUID = None,
    db: Session = Depends(get_db),
    user: User = Depends(admin_required),
):
    qry = db.query(Property).outerjoin(Location, Property.city_id == Location.id)
    if status == "pending":
        qry = qry.filter(Property.is_approved == False)  # noqa: E712
    elif status == "approved":
        qry = qry.filter(Property.is_approved == True)  # noqa: E712
    if q:
        like = f"%{q}%"
        qry = qry.filter(or_(
            Property.name.ilike(like),
            Property.address.ilike(like),
            Location.name.ilike(like),
        ))
    if rep_id:
        qry = qry.filter(Property.owner_rep_id == rep_id)
    props = qry.order_by(Property.created_at.desc()).all()
    return [
        {
            "id": str(p.id),
            "name": p.name,
            "property_type": p.property_type.value if p.property_type else None,
            "owner_name": p.owner.full_name if p.owner else None,
            "owner_email": p.owner.email if p.owner else None,
            "city": p.city.name if p.city else None,
            "district": p.district.name if p.district else None,
            "address": p.address,
            "is_approved": p.is_approved,
            "created_at": p.created_at.isoformat() if p.created_at else None,
        }
        for p in props
    ]


@router.post("/properties/{property_id}/approve")
def approve_property(
    property_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(admin_required),
):
    prop = db.query(Property).filter(Property.id == property_id).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")
    prop.is_approved = True
    db.commit()
    return {"message": f"Property '{prop.name}' approved"}


@router.post("/properties/{property_id}/reject")
def reject_property(
    property_id: uuid.UUID,
    db: Session = Depends(get_db),
    user: User = Depends(admin_required),
):
    prop = db.query(Property).filter(Property.id == property_id).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")
    prop.is_approved = False
    db.commit()
    return {"message": f"Property '{prop.name}' unapproved"}
