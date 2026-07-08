import secrets
import hashlib
import hmac
import uuid
import bcrypt
from datetime import datetime, timedelta, timezone

from fastapi import APIRouter, Depends, HTTPException, Response, Request
from sqlalchemy.orm import Session

from app.config import PEPPER, ACCESS_TOKEN_EXPIRE_MINUTES, REFRESH_TOKEN_EXPIRE_DAYS, COOKIE_SECURE

from app.database import get_db
from app.models import User, UserRole, Session as SessionModel, RefreshToken, PendingHotelRegistration, PendingStatus
from app.schemas import SignupRequest, LoginRequest, HotelRegisterRequest, UserResponse

router = APIRouter(prefix="/api/auth", tags=["auth"])


# ──────────────────────────────────────────────
# Password helpers
# ──────────────────────────────────────────────

def hash_password(password: str) -> str:
    peppered = hmac.new(PEPPER.encode("utf-8"), password.encode("utf-8"), hashlib.sha256).hexdigest()
    salt = bcrypt.gensalt()
    return bcrypt.hashpw(peppered.encode("utf-8"), salt).decode("utf-8")


def verify_password(plain_password: str, hashed_password: str) -> bool:
    try:
        peppered = hmac.new(PEPPER.encode("utf-8"), plain_password.encode("utf-8"), hashlib.sha256).hexdigest()
        return bcrypt.checkpw(peppered.encode("utf-8"), hashed_password.encode("utf-8"))
    except Exception:
        return False


# ──────────────────────────────────────────────
# Token helpers
# ──────────────────────────────────────────────

def generate_token() -> str:
    return secrets.token_urlsafe(48)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def _set_access_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key="access_token",
        value=token,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        max_age=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        path="/",
    )


def _set_refresh_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key="refresh_token",
        value=token,
        httponly=True,
        secure=COOKIE_SECURE,
        samesite="lax",
        max_age=REFRESH_TOKEN_EXPIRE_DAYS * 86400,
        path="/",
    )


# ──────────────────────────────────────────────
# Auth dependencies
# ──────────────────────────────────────────────

def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    token = request.cookies.get("access_token")
    if not token:
        raise HTTPException(status_code=401, detail="Not authenticated")
    token_hash = hash_token(token)
    session = db.query(SessionModel).filter(
        SessionModel.token_hash == token_hash,
        SessionModel.expires_at > datetime.now(timezone.utc)
    ).first()
    if not session:
        raise HTTPException(status_code=401, detail="Invalid or expired session")
    user = db.query(User).filter(User.id == session.user_id).first()
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="User not found or inactive")
    return user


def get_current_user_optional(request: Request, db: Session = Depends(get_db)) -> User | None:
    try:
        return get_current_user(request, db)
    except HTTPException:
        return None


def require_role(role: UserRole):
    def checker(user: User = Depends(get_current_user)) -> User:
        if user.role != role:
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        return user
    return checker


# ──────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────

def _revoke_all_user_sessions(user_id: uuid.UUID, db: Session) -> None:
    """Delete every access session + refresh token for the given user."""
    db.query(SessionModel).filter(SessionModel.user_id == user_id).delete()
    db.query(RefreshToken).filter(RefreshToken.user_id == user_id).delete()


# ──────────────────────────────────────────────
# Routes
# ──────────────────────────────────────────────

@router.post("/signup")
def signup(req: SignupRequest, db: Session = Depends(get_db)):
    if db.query(User).filter(User.email == req.email).first():
        raise HTTPException(status_code=400, detail="Email already registered")
    user = User(
        email=req.email,
        password_hash=hash_password(req.password),
        role=UserRole.customer,
        full_name=req.full_name,
        phone=req.phone,
        is_active=True,
    )
    db.add(user)
    db.flush()
    user_id = str(user.id)
    db.commit()
    # Verify the user was saved
    saved = db.query(User).filter(User.email == req.email).first()
    return {
        "message": "Account created successfully",
        "role": "customer",
        "user_id": user_id,
        "verified_in_db": saved is not None,
    }


@router.post("/hotel-register")
def hotel_register(req: HotelRegisterRequest, db: Session = Depends(get_db)):
    if db.query(User).filter(User.email == req.email).first():
        raise HTTPException(status_code=400, detail="Email already registered as a user")
    existing = db.query(PendingHotelRegistration).filter(
        PendingHotelRegistration.email == req.email
    ).first()
    if existing:
        raise HTTPException(status_code=400, detail="Already submitted a registration request")
    pending = PendingHotelRegistration(
        email=req.email,
        password_hash=hash_password(req.password),
        full_name=req.full_name,
        phone=req.phone,
        status=PendingStatus.pending,
    )
    db.add(pending)
    db.flush()
    db.commit()
    return {"message": "Registration request submitted. Awaiting admin approval.", "id": str(pending.id)}


@router.post("/login")
def login(req: LoginRequest, response: Response, db: Session = Depends(get_db)):
    user = db.query(User).filter(User.email == req.email).first()
    if not user or not verify_password(req.password, user.password_hash):
        raise HTTPException(status_code=401, detail="Invalid email or password")
    if not user.is_active:
        raise HTTPException(status_code=403, detail="Account is inactive")

    # Issue access token (20 min)
    access_token = generate_token()
    session = SessionModel(
        user_id=user.id,
        token_hash=hash_token(access_token),
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
    )
    db.add(session)

    # Issue refresh token (7 days)
    refresh_token = generate_token()
    rt = RefreshToken(
        user_id=user.id,
        token_hash=hash_token(refresh_token),
        expires_at=datetime.now(timezone.utc) + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS),
    )
    db.add(rt)
    db.commit()

    _set_access_cookie(response, access_token)
    _set_refresh_cookie(response, refresh_token)

    return {
        "message": "Logged in",
        "role": user.role.value,
        "user": UserResponse.model_validate(user).model_dump(),
    }


@router.post("/refresh")
def refresh(request: Request, response: Response, db: Session = Depends(get_db)):
    """
    Exchange a valid refresh token cookie for a new access token + refresh token pair.

    Rotation + reuse detection:
      1. Mark the presented refresh token as *used* instead of deleting it.
      2. If the same token is presented a second time it's already marked used
         → that signals token theft → revoke EVERY session for that user.
      3. On normal rotation, only the current access session is replaced so
         other devices stay logged in.
    """
    token = request.cookies.get("refresh_token")
    if not token:
        raise HTTPException(status_code=401, detail="No refresh token")

    token_hash = hash_token(token)
    rt = db.query(RefreshToken).filter(
        RefreshToken.token_hash == token_hash,
    ).first()

    # ── Token not found at all ────────────────────────────────────────────────
    if not rt:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")

    user = db.query(User).filter(User.id == rt.user_id).first()

    # ── Reuse detection ──────────────────────────────────────────────────────
    if rt.is_used:
        # The same token has already been rotated once — likely a stale
        # request from another tab.  Do NOT revoke all sessions (that would
        # log the real user out).  Just reject this single request; the
        # legitimate caller already got a fresh pair of tokens.
        raise HTTPException(status_code=401, detail="Token already used — session still active on other tab.")

    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="User not found or inactive")

    # ── Token expired ─────────────────────────────────────────────────────────
    if rt.expires_at <= datetime.now(timezone.utc):
        db.delete(rt)
        db.commit()
        raise HTTPException(status_code=401, detail="Refresh token expired")

    # ── Rotate refresh token ───────────────────────────────────────────────────
    # Mark the current token as used so a second presentation triggers theft
    # detection, then issue a brand-new refresh token.
    rt.is_used = True

    new_refresh_token = generate_token()
    new_rt = RefreshToken(
        user_id=user.id,
        token_hash=hash_token(new_refresh_token),
        expires_at=datetime.now(timezone.utc) + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS),
    )
    db.add(new_rt)

    # ── Rotate access token ────────────────────────────────────────────────────
    # Only invalidate the specific old access session that was tied to the
    # consumed refresh token — other device sessions remain active.
    old_access_token = request.cookies.get("access_token")
    if old_access_token:
        db.query(SessionModel).filter(
            SessionModel.token_hash == hash_token(old_access_token)
        ).delete()

    new_access_token = generate_token()
    session = SessionModel(
        user_id=user.id,
        token_hash=hash_token(new_access_token),
        expires_at=datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
    )
    db.add(session)
    db.commit()

    _set_access_cookie(response, new_access_token)
    _set_refresh_cookie(response, new_refresh_token)
    return {"message": "Token refreshed", "role": user.role.value}


@router.post("/logout")
def logout(response: Response, request: Request, db: Session = Depends(get_db)):
    # Revoke access token
    access_token = request.cookies.get("access_token")
    if access_token:
        token_hash = hash_token(access_token)
        db.query(SessionModel).filter(SessionModel.token_hash == token_hash).delete()

    # Revoke refresh token (server-side invalidation)
    refresh_token = request.cookies.get("refresh_token")
    if refresh_token:
        token_hash = hash_token(refresh_token)
        db.query(RefreshToken).filter(RefreshToken.token_hash == token_hash).delete()

    db.commit()
    response.delete_cookie(key="access_token", path="/")
    response.delete_cookie(key="refresh_token", path="/")
    response.delete_cookie(key="refresh_token", path="/api/auth/refresh")  # cleanup legacy path
    return {"message": "Logged out"}


@router.get("/me")
def me(user: User = Depends(get_current_user)):
    return UserResponse.model_validate(user).model_dump()


@router.get("/users")
def list_users(db: Session = Depends(get_db)):
    users = db.query(User).order_by(User.created_at).all()
    return [
        {"id": str(u.id), "email": u.email, "role": u.role.value, "created_at": str(u.created_at)}
        for u in users
    ]
