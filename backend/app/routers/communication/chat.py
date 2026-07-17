import logging
import uuid
from datetime import datetime, timedelta

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.core.database import get_db
from app.models.db_models import (
    ChatMessage, ChatSession, DocumentChunk, User, UserRole,
)
from app.routers.auth.auth import get_current_user_optional, require_role
from app.services.query_executor import run_pipeline

logger = logging.getLogger(__name__)

router = APIRouter(prefix="/api/chat", tags=["chat"])


class ChatRequest(BaseModel):
    message: str = Field(..., min_length=1, max_length=2000)
    session_id: str | None = None
    # Retained for backward compatibility — the pipeline handles scoping
    # via the Planner LLM's entity resolution instead.
    property_id: str | None = None
    doc_type: str | None = None


class ChatResponse(BaseModel):
    reply: str
    session_id: str
    conversation_title: str | None = None


# ═══════════════════════════════════════════════════════════════════════════
# KB STATUS
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/kb-status")
def kb_status(db: Session = Depends(get_db)):
    count = db.query(DocumentChunk).count()
    return {"indexed": count > 0, "chunk_count": count}


# ═══════════════════════════════════════════════════════════════════════════
# CHAT HISTORY
# ═══════════════════════════════════════════════════════════════════════════

@router.get("/history")
def chat_history(
    session_id: str = Query(...),
    db: Session = Depends(get_db),
):
    try:
        sid = uuid.UUID(session_id)
    except ValueError:
        raise HTTPException(status_code=400, detail="Invalid session_id")
    msgs = (
        db.query(ChatMessage)
        .filter(ChatMessage.session_id == sid)
        .order_by(ChatMessage.created_at)
        .all()
    )
    return {
        "messages": [
            {
                "role": m.role,
                "content": m.content,
                "sources": m.sources,
                "created_at": m.created_at.isoformat() if m.created_at else None,
            }
            for m in msgs
        ]
    }


# ═══════════════════════════════════════════════════════════════════════════
# SESSION PRUNING
# ═══════════════════════════════════════════════════════════════════════════

def prune_old_sessions(db: Session, days: int = 90) -> int:
    """Delete chat sessions not updated in the last `days` days.

    Uses a single bulk DELETE — the CASCADE on chat_messages.session_id
    deletes all associated messages at the DB level. Runs in one transaction.
    """
    cutoff = datetime.utcnow() - timedelta(days=days)
    count = (
        db.query(ChatSession)
        .filter(ChatSession.updated_at < cutoff)
        .delete(synchronize_session=False)
    )
    db.commit()
    return count


@router.post("/prune")
def prune_chat_endpoint(
    days: int = Query(90, ge=1, le=365, description="Delete sessions inactive for this many days"),
    db: Session = Depends(get_db),
    user: User = Depends(require_role(UserRole.admin)),
):
    """Admin-only: delete chat sessions not updated in `days` days.

    Messages are cascade-deleted automatically. Call this endpoint
    periodically (e.g. via a cron job) to keep the chat_messages
    table from growing unboundedly.
    """
    count = prune_old_sessions(db, days)
    return {"message": f"Pruned {count} chat sessions inactive for more than {days} days"}


# ═══════════════════════════════════════════════════════════════════════════
# CHAT ENDPOINT (uses the new 3-phase RAG pipeline)
# ═══════════════════════════════════════════════════════════════════════════

@router.post("")
def chat(
    req: ChatRequest,
    user: User | None = Depends(get_current_user_optional),
    db: Session = Depends(get_db),
) -> ChatResponse:
    # ── 1. Resolve or create session ──────────────────────────────────────
    session: ChatSession | None = None
    if req.session_id:
        try:
            sid = uuid.UUID(req.session_id)
            session = db.query(ChatSession).filter(ChatSession.id == sid).first()
            # If this session belongs to a specific logged-in user but the current
            # user is different, don't reuse it — force a new session instead.
            # This prevents cross-user chat history leaks after login/logout.
            if session and session.user_id and user and session.user_id != user.id:
                session = None
        except ValueError:
            pass

    is_new = False
    if not session:
        session = ChatSession(
            user_id=user.id if user else None,
            guest_id=None if user else str(uuid.uuid4()),
            title=req.message[:60],
        )
        db.add(session)
        db.flush()
        is_new = True

    # ── 2. Save user message ─────────────────────────────────────────────
    user_msg = ChatMessage(
        session_id=session.id,
        role="user",
        content=req.message,
    )
    db.add(user_msg)
    db.flush()

    # ── 3. Build conversation history ─────────────────────────────────────
    history_orm = (
        db.query(ChatMessage)
        .filter(ChatMessage.session_id == session.id)
        .order_by(ChatMessage.created_at)
        .all()
    )
    messages = []
    for m in history_orm:
        entry = {"role": m.role, "content": m.content}
        if m.role == "assistant" and m.sources:
            if isinstance(m.sources, dict):
                rd = m.sources.get("reasoning_details")
            else:
                rd = None
            if rd:
                entry["reasoning_details"] = rd
        messages.append(entry)

    # ── 4. Run the 3-phase pipeline ──────────────────────────────────────
    # Pass property_id context if the user is viewing a specific property
    # page — the pipeline injects it into the resolved entities so tools
    # like VECTOR_SEARCH are scoped to that property.
    result = run_pipeline(
        db=db,
        user=user,
        message=req.message,
        history=messages,
        context_property_id=req.property_id,
    )

    reply = result["reply"]
    sources = result["sources"]

    # ── 5. Save assistant message ─────────────────────────────────────────
    assistant_msg = ChatMessage(
        session_id=session.id,
        role="assistant",
        content=reply,
        sources=sources if sources else None,
    )
    db.add(assistant_msg)
    db.commit()

    # ── 6. Return response ───────────────────────────────────────────────
    return ChatResponse(
        reply=reply,
        session_id=str(session.id),
        conversation_title=session.title if is_new else None,
    )
