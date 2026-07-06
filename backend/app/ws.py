import uuid
from datetime import datetime, timezone

from fastapi import APIRouter, WebSocket, WebSocketDisconnect
from sqlalchemy.orm import Session

from app.database import SessionLocal
from app.models import User, Session as SessionModel
from app.routers.auth import hash_token

router = APIRouter()

connected_users: dict[uuid.UUID, WebSocket] = {}


def _get_user_from_cookies(cookies: dict) -> User | None:
    token = cookies.get("access_token")
    if not token:
        return None
    token_hash = hash_token(token)
    db: Session = SessionLocal()
    try:
        session = db.query(SessionModel).filter(
            SessionModel.token_hash == token_hash,
            SessionModel.expires_at > datetime.now(timezone.utc),
        ).first()
        if not session:
            return None
        user = db.query(User).filter(User.id == session.user_id).first()
        return user if user and user.is_active else None
    finally:
        db.close()


async def notify_user(user_id: uuid.UUID, event_data: dict) -> None:
    ws = connected_users.get(user_id)
    if ws:
        try:
            await ws.send_json(event_data)
        except Exception:
            connected_users.pop(user_id, None)


@router.websocket("/ws/chat")
async def chat_websocket(websocket: WebSocket):
    user = _get_user_from_cookies(websocket.cookies)
    if not user:
        await websocket.close(code=4001)
        return

    await websocket.accept()

    old = connected_users.get(user.id)
    if old:
        try:
            await old.close(code=1000)
        except Exception:
            pass
    connected_users[user.id] = websocket

    try:
        while True:
            data = await websocket.receive_text()
            if data == "ping":
                await websocket.send_json({"type": "pong"})
    except WebSocketDisconnect:
        pass
    finally:
        connected_users.pop(user.id, None)
