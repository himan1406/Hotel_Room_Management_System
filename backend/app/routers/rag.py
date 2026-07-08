import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import PropertyDocument, DocumentChunk, Property, User, UserRole
from app.embeddings import embed_text, embed_texts
from app.routers.auth import get_current_user, require_role

router = APIRouter(prefix="/api/rag", tags=["rag"])


def _chunk_text(text: str, chunk_size: int = 512, overlap: int = 50) -> list[str]:
    if not text:
        return []
    chunks = []
    start = 0
    while start < len(text):
        end = min(start + chunk_size, len(text))
        chunks.append(text[start:end])
        start += chunk_size - overlap
    return chunks


@router.post("/reindex")
def reindex_all(
    db: Session = Depends(get_db),
    user: User = Depends(require_role(UserRole.admin)),
):
    docs = db.query(PropertyDocument).filter(
        PropertyDocument.summary_text.isnot(None),
        PropertyDocument.summary_text != "",
        PropertyDocument.property_id.isnot(None),
    ).all()

    # Clear existing chunks
    db.query(DocumentChunk).delete()
    db.commit()

    total_chunks = 0
    for doc in docs:
        chunks = _chunk_text(doc.summary_text)
        if not chunks:
            continue
        embeddings = embed_texts(chunks)
        for i, (chunk_text, emb) in enumerate(zip(chunks, embeddings)):
            chunk = DocumentChunk(
                document_id=doc.id,
                property_id=doc.property_id,
                chunk_index=i,
                content=chunk_text,
                embedding=emb,
            )
            db.add(chunk)
            total_chunks += 1
        if total_chunks % 50 == 0:
            db.flush()

    db.commit()
    return {"message": f"Reindexed {len(docs)} documents into {total_chunks} chunks"}


@router.get("/search")
def search_chunks(
    q: str = Query(..., min_length=1, max_length=500),
    limit: int = Query(10, ge=1, le=50),
    db: Session = Depends(get_db),
):
    query_vec = embed_text(q)
    # pgvector <=> is cosine distance (0 = identical, 2 = opposite)
    sql = text("""
        SELECT
            dc.id, dc.content, dc.chunk_index,
            dc.document_id, dc.property_id,
            dc.embedding <=> CAST(:query_vec AS vector) AS distance
        FROM document_chunks dc
        WHERE dc.embedding IS NOT NULL
        ORDER BY distance
        LIMIT :limit
    """)
    rows = db.execute(sql, {"query_vec": query_vec, "limit": limit}).fetchall()

    results = []
    for row in rows:
        doc = db.query(PropertyDocument).filter(PropertyDocument.id == row.document_id).first()
        prop = db.query(Property).filter(Property.id == row.property_id).first()
        results.append({
            "chunk_id": str(row.id),
            "content": row.content,
            "chunk_index": row.chunk_index,
            "score": 1.0 - row.distance,
            "document": {
                "id": str(row.document_id),
                "title": doc.title if doc else None,
                "doc_type": doc.doc_type.value if doc and doc.doc_type else None,
            } if doc else None,
            "property": {
                "id": str(row.property_id),
                "name": prop.name if prop else None,
            } if prop else None,
        })

    return results


@router.get("/ask/{property_id}")
def ask_property(
    property_id: uuid.UUID,
    q: str = Query(..., min_length=1, max_length=500),
    limit: int = Query(5, ge=1, le=20),
    db: Session = Depends(get_db),
):
    prop = db.query(Property).filter(Property.id == property_id).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")

    query_vec = embed_text(q)
    sql = text("""
        SELECT
            dc.id, dc.content, dc.chunk_index,
            dc.document_id,
            dc.embedding <=> CAST(:query_vec AS vector) AS distance
        FROM document_chunks dc
        WHERE dc.property_id = CAST(:property_id AS uuid)
          AND dc.embedding IS NOT NULL
        ORDER BY distance
        LIMIT :limit
    """)
    rows = db.execute(sql, {
        "query_vec": query_vec,
        "property_id": str(property_id),
        "limit": limit,
    }).fetchall()

    results = []
    for row in rows:
        doc = db.query(PropertyDocument).filter(PropertyDocument.id == row.document_id).first()
        results.append({
            "chunk_id": str(row.id),
            "content": row.content,
            "chunk_index": row.chunk_index,
            "score": 1.0 - row.distance,
            "document": {
                "id": str(row.document_id),
                "title": doc.title if doc else None,
                "doc_type": doc.doc_type.value if doc and doc.doc_type else None,
            } if doc else None,
        })

    return results
