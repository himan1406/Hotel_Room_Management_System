import secrets
import hashlib
import hmac
import bcrypt
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Response, Request
from sqlalchemy.orm import Session

from app.config import PEPPER, ACCESS_TOKEN_EXPIRE_MINUTES, REFRESH_TOKEN_EXPIRE_DAYS

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
        samesite="lax",
        max_age=ACCESS_TOKEN_EXPIRE_MINUTES * 60,
        path="/",
    )


def _set_refresh_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key="refresh_token",
        value=token,
        httponly=True,
        samesite="lax",
        max_age=REFRESH_TOKEN_EXPIRE_DAYS * 86400,
        path="/api/auth/refresh",   # only sent to the refresh endpoint
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
        SessionModel.expires_at > datetime.utcnow()
    ).first()
    if not session:
        raise HTTPException(status_code=401, detail="Invalid or expired session")
    user = db.query(User).filter(User.id == session.user_id).first()
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="User not found or inactive")
    return user


def require_role(role: UserRole):
    def checker(user: User = Depends(get_current_user)) -> User:
        if user.role != role:
            raise HTTPException(status_code=403, detail="Insufficient permissions")
        return user
    return checker


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
    db.commit()
    return {"message": "Account created successfully", "role": "customer"}


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
        expires_at=datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
    )
    db.add(session)

    # Issue refresh token (7 days)
    refresh_token = generate_token()
    rt = RefreshToken(
        user_id=user.id,
        token_hash=hash_token(refresh_token),
        expires_at=datetime.utcnow() + timedelta(days=REFRESH_TOKEN_EXPIRE_DAYS),
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
    Exchange a valid refresh token cookie for a new access token cookie.
    Called automatically by the frontend when a 401 is received.
    """
    token = request.cookies.get("refresh_token")
    if not token:
        raise HTTPException(status_code=401, detail="No refresh token")

    token_hash = hash_token(token)
    rt = db.query(RefreshToken).filter(
        RefreshToken.token_hash == token_hash,
        RefreshToken.expires_at > datetime.utcnow()
    ).first()
    if not rt:
        raise HTTPException(status_code=401, detail="Invalid or expired refresh token")

    user = db.query(User).filter(User.id == rt.user_id).first()
    if not user or not user.is_active:
        raise HTTPException(status_code=401, detail="User not found or inactive")

    # Rotate: delete old access sessions for this user, issue a new one
    db.query(SessionModel).filter(SessionModel.user_id == user.id).delete()
    new_access_token = generate_token()
    session = SessionModel(
        user_id=user.id,
        token_hash=hash_token(new_access_token),
        expires_at=datetime.utcnow() + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES),
    )
    db.add(session)
    db.commit()

    _set_access_cookie(response, new_access_token)
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
    response.delete_cookie(key="refresh_token", path="/api/auth/refresh")
    return {"message": "Logged out"}


@router.get("/me")
def me(user: User = Depends(get_current_user)):
    return UserResponse.model_validate(user).model_dump()
