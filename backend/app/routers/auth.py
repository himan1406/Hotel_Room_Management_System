import secrets
import hashlib
import hmac
import bcrypt
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Response, Request
from sqlalchemy.orm import Session

from app.config import PEPPER, SESSION_EXPIRE_HOURS

from app.database import get_db
from app.models import User, UserRole, Session as SessionModel, PendingHotelRegistration, PendingStatus
from app.schemas import SignupRequest, LoginRequest, HotelRegisterRequest, UserResponse

router = APIRouter(prefix="/api/auth", tags=["auth"])


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



def generate_token() -> str:
    return secrets.token_urlsafe(48)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode()).hexdigest()


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    token = request.cookies.get("session")
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
    token = generate_token()
    token_hash = hash_token(token)
    session = SessionModel(
        user_id=user.id,
        token_hash=token_hash,
        expires_at=datetime.utcnow() + timedelta(hours=SESSION_EXPIRE_HOURS),
    )
    db.add(session)
    db.commit()
    response.set_cookie(
        key="session",
        value=token,
        httponly=True,
        samesite="lax",
        max_age=SESSION_EXPIRE_HOURS * 3600,
        path="/",
    )
    return {
        "message": "Logged in",
        "role": user.role.value,
        "user": UserResponse.model_validate(user).model_dump(),
    }


@router.post("/logout")
def logout(response: Response, request: Request, db: Session = Depends(get_db)):
    token = request.cookies.get("session")
    if token:
        token_hash = hash_token(token)
        db.query(SessionModel).filter(SessionModel.token_hash == token_hash).delete()
        db.commit()
    response.delete_cookie(key="session", path="/")
    return {"message": "Logged out"}


@router.get("/me")
def me(user: User = Depends(get_current_user)):
    return UserResponse.model_validate(user).model_dump()
