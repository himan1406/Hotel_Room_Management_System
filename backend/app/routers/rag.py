import uuid

from fastapi import APIRouter, Depends, HTTPException, Query
from sqlalchemy import text
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import DocType, PropertyDocument, DocumentChunk, Property, User, UserRole
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


VALID_DOC_TYPES = {t.value for t in DocType}


@router.get("/search")
def search_chunks(
    q: str = Query(..., min_length=1, max_length=500),
    limit: int = Query(10, ge=1, le=50),
    property_id: str | None = Query(None, description="Filter by property UUID"),
    doc_type: str | None = Query(None, description=f"Filter by document type: {', '.join(sorted(VALID_DOC_TYPES))}"),
    db: Session = Depends(get_db),
):
    # Validate property_id format if provided
    if property_id is not None:
        try:
            uuid.UUID(property_id)
        except ValueError:
            raise HTTPException(status_code=400, detail=f"Invalid property_id format: '{property_id}'")

    if doc_type is not None and doc_type not in VALID_DOC_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid doc_type '{doc_type}'. Must be one of: {', '.join(sorted(VALID_DOC_TYPES))}"
        )

    query_vec = embed_text(q)

    # Build WHERE clause dynamically
    conditions = ["dc.embedding IS NOT NULL"]
    params: dict = {"query_vec": query_vec, "limit": limit}

    if property_id is not None:
        conditions.append("dc.property_id = CAST(:property_id AS uuid)")
        params["property_id"] = property_id

    if doc_type is not None:
        conditions.append("pd.doc_type::text = :doc_type")
        params["doc_type"] = doc_type

    where_clause = " AND ".join(conditions)

    sql = text(f"""
        SELECT
            dc.id, dc.content, dc.chunk_index,
            dc.document_id, dc.property_id,
            pd.title AS doc_title,
            pd.doc_type::text AS doc_type_str,
            dc.embedding <=> CAST(:query_vec AS vector) AS distance
        FROM document_chunks dc
        INNER JOIN property_documents pd ON dc.document_id = pd.id
        WHERE {where_clause}
        ORDER BY distance
        LIMIT :limit
    """)
    rows = db.execute(sql, params).fetchall()

    results = []
    for row in rows:
        prop = db.query(Property).filter(Property.id == row.property_id).first()
        results.append({
            "chunk_id": str(row.id),
            "content": row.content,
            "chunk_index": row.chunk_index,
            "score": round(1.0 - row.distance, 3),
            "document": {
                "id": str(row.document_id),
                "title": row.doc_title,
                "doc_type": row.doc_type_str,
            },
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
    doc_type: str | None = Query(None, description=f"Filter by document type: {', '.join(sorted(VALID_DOC_TYPES))}"),
    db: Session = Depends(get_db),
):
    prop = db.query(Property).filter(Property.id == property_id).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")

    if doc_type is not None and doc_type not in VALID_DOC_TYPES:
        raise HTTPException(
            status_code=400,
            detail=f"Invalid doc_type '{doc_type}'. Must be one of: {', '.join(sorted(VALID_DOC_TYPES))}"
        )

    query_vec = embed_text(q)

    # Build WHERE clause dynamically
    conditions = [
        "dc.property_id = CAST(:property_id AS uuid)",
        "dc.embedding IS NOT NULL",
    ]
    params: dict = {
        "query_vec": query_vec,
        "property_id": str(property_id),
        "limit": limit,
    }

    if doc_type is not None:
        conditions.append("pd.doc_type::text = :doc_type")
        params["doc_type"] = doc_type

    where_clause = " AND ".join(conditions)

    sql = text(f"""
        SELECT
            dc.id, dc.content, dc.chunk_index,
            dc.document_id,
            pd.title AS doc_title,
            pd.doc_type::text AS doc_type_str,
            dc.embedding <=> CAST(:query_vec AS vector) AS distance
        FROM document_chunks dc
        INNER JOIN property_documents pd ON dc.document_id = pd.id
        WHERE {where_clause}
        ORDER BY distance
        LIMIT :limit
    """)
    rows = db.execute(sql, params).fetchall()

    results = []
    for row in rows:
        results.append({
            "chunk_id": str(row.id),
            "content": row.content,
            "chunk_index": row.chunk_index,
            "score": round(1.0 - row.distance, 3),
            "document": {
                "id": str(row.document_id),
                "title": row.doc_title,
                "doc_type": row.doc_type_str,
            },
        })

    return results
