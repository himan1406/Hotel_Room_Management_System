import uuid

from fastapi import APIRouter, BackgroundTasks, Depends, HTTPException, Query
from sqlalchemy import or_
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.db_models import Message, Property, User
from app.routers.auth.auth import get_current_user
from app.models.schemas import MessageSend
from app.services.ws import notify_user

router = APIRouter(prefix="/api/messages", tags=["messages"])


def _serialize(msg: Message, current_user_id: uuid.UUID) -> dict:
    sender = msg.sender
    return {
        "id": str(msg.id),
        "sender_id": str(msg.sender_id),
        "receiver_id": str(msg.receiver_id),
        "property_id": str(msg.property_id) if msg.property_id else None,
        "body": msg.body,
        "is_read": msg.is_read,
        "sender_name": sender.full_name if sender else "Unknown",
        "created_at": msg.created_at.isoformat() if msg.created_at else None,
        "is_mine": msg.sender_id == current_user_id,
    }


@router.post("")
def send_message(
    req: MessageSend,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    background_tasks: BackgroundTasks = BackgroundTasks(),
):
    if user.id == req.receiver_id:
        raise HTTPException(status_code=400, detail="Cannot message yourself")

    receiver = db.query(User).filter(User.id == req.receiver_id).first()
    if not receiver:
        raise HTTPException(status_code=404, detail="Recipient not found")

    if req.property_id:
        prop = db.query(Property).filter(Property.id == req.property_id).first()
        if not prop:
            raise HTTPException(status_code=404, detail="Property not found")

    msg = Message(
        sender_id=user.id,
        receiver_id=req.receiver_id,
        property_id=req.property_id or None,
        body=req.body,
    )
    db.add(msg)
    db.commit()
    db.refresh(msg)
    msg_data = _serialize(msg, user.id)
    background_tasks.add_task(notify_user, req.receiver_id, {"type": "new_message", **msg_data})
    background_tasks.add_task(notify_user, req.receiver_id, {"type": "conversations_updated"})
    background_tasks.add_task(notify_user, user.id, {"type": "conversations_updated"})
    return msg_data


@router.get("/conversations")
def list_conversations(
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    sub = (
        db.query(Message)
        .filter(
            or_(Message.sender_id == user.id, Message.receiver_id == user.id)
        )
        .order_by(Message.created_at.desc())
        .all()
    )

    seen = {}
    for msg in sub:
        if msg.sender_id == user.id:
            other_id = str(msg.receiver_id)
        else:
            other_id = str(msg.sender_id)

        if other_id not in seen:
            other = db.query(User).filter(User.id == other_id).first()
            prop = db.query(Property).filter(Property.id == msg.property_id).first()

            unread = (
                db.query(Message)
                .filter(
                    Message.sender_id == other_id,
                    Message.receiver_id == user.id,
                    Message.is_read == False,
                )
                .count()
            )

            seen[other_id] = {
                "other_user_id": other_id,
                "other_user_name": other.full_name if other else "Unknown",
                "other_user_role": other.role.value if other else None,
                "property_id": str(msg.property_id) if msg.property_id else None,
                "property_name": prop.name if prop else "Unknown",
                "last_message": msg.body[:100],
                "last_message_at": msg.created_at.isoformat() if msg.created_at else None,
                "unread_count": unread,
            }

    return list(seen.values())


@router.get("/conversation/{other_user_id}")
def get_conversation(
    other_user_id: uuid.UUID,
    property_id: uuid.UUID = Query(None),
    after_id: uuid.UUID = Query(None),
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    q = db.query(Message).filter(
        or_(
            (Message.sender_id == user.id) & (Message.receiver_id == other_user_id),
            (Message.sender_id == other_user_id) & (Message.receiver_id == user.id),
        )
    )
    if property_id:
        q = q.filter(Message.property_id == property_id)
    if after_id:
        after_msg = db.query(Message).filter(Message.id == after_id).first()
        if after_msg:
            q = q.filter(Message.created_at > after_msg.created_at)
    messages = q.order_by(Message.created_at.asc()).all()

    return [_serialize(m, user.id) for m in messages]


@router.put("/{message_id}/read")
def mark_read(
    message_id: uuid.UUID,
    user: User = Depends(get_current_user),
    db: Session = Depends(get_db),
):
    msg = db.query(Message).filter(
        Message.id == message_id,
        Message.receiver_id == user.id,
    ).first()
    if not msg:
        raise HTTPException(status_code=404, detail="Message not found")
    msg.is_read = True
    db.commit()
    return {"message": "Marked as read"}
