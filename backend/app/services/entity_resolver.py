from sqlalchemy import cast, or_, String
from sqlalchemy.orm import Session, aliased

from app.models.db_models import DocType, Location, Property


_STOPWORDS = {
    "a", "an", "the", "this", "that", "each", "few", "other", "own", "same",
    "i", "we", "they", "he", "she", "it",
    "my", "our", "your", "his", "her", "its", "their", "them", "me", "you",
    "is", "are", "was", "were", "be", "been", "being",
    "has", "have", "had", "do", "does", "did", "done",
    "will", "would", "could", "should", "can",
    "give", "show", "find", "need", "want", "looking",
    "please", "recommendations", "recs",
    "know", "tell", "see", "think",
    "of", "in", "on", "at", "to", "from", "by", "for", "with",
    "as", "via", "per", "into", "through",
    "and", "or", "but", "if", "so", "than",
    "because", "until", "while", "about",
    "very", "really", "just", "also", "too",
    "such", "only", "not", "no",
    "before", "after", "during", "again", "then", "once",
    "when", "where", "what", "which", "how", "why",
    "above", "below", "between", "under",
    "further", "here", "there",
    "many", "some", "any", "more", "most",
}

# Valid document types that can be used as filters
VALID_DOC_TYPES = {t.value for t in DocType}


def _strip_query(name: str) -> list[str]:
    """Extract meaningful search terms from a name, removing stopwords.

    "Lemon Tree Hotel in Gurugram" → ["lemon", "tree", "hotel", "gurugram"]
    """
    words = name.lower().split()
    terms = [
        w.strip(".,!?;:'\"")
        for w in words
        if w.strip(".,!?;:'\"") not in _STOPWORDS and len(w.strip(".,!?;:'\"")) > 1
    ]
    return terms if terms else [name.strip().lower()]


def _compute_score(name: str, query: str) -> float:
    """Compute a relevance score between a database name and a user query.

    - Exact match (case-insensitive): 1.0
    - Name starts with query:        0.85
    - Name contains query:           0.6
    - Partial word match:            0.4
    - No match:                      0.0
    """
    name_lower = name.lower().strip()
    query_lower = query.lower().strip()

    if not query_lower:
        return 0.0

    if name_lower == query_lower:
        return 1.0
    if name_lower.startswith(query_lower):
        return 0.85
    if query_lower in name_lower:
        return 0.6

    # Check if any query word appears in the name
    query_terms = query_lower.split()
    name_terms = name_lower.split()
    matching = sum(1 for qt in query_terms if any(qt in nt for nt in name_terms))
    if matching > 0:
        return round(0.3 + (0.3 * matching / max(len(query_terms), 1)), 3)

    return 0.0


def resolve_property_names(
    db: Session,
    names: list[str],
    *,
    include_unapproved: bool = False,
    min_score: float = 0.3,
    limit: int = 5,
) -> list[dict]:

    if not names:
        return []

    LocationParent = aliased(Location)
    results: list[dict] = []
    seen_ids: set[str] = set()

    for original_query in names:
        terms = _strip_query(original_query)
        if not terms:
            continue

        # Build ILIKE conditions for each term against property name,
        # property type, and location names (city + state).
        ilike_conditions = []
        for term in terms:
            like = f"%{term}%"
            ilike_conditions.append(Property.name.ilike(like))
            ilike_conditions.append(cast(Property.property_type, String).ilike(like))
            ilike_conditions.append(Location.name.ilike(like))
            ilike_conditions.append(LocationParent.name.ilike(like))

        query = (
            db.query(Property)
            .join(Location, Property.city_id == Location.id, isouter=True)
            .outerjoin(LocationParent, Location.parent_id == LocationParent.id)
            .filter(or_(*ilike_conditions))
            .order_by(Property.trending_score.desc())
            .limit(limit)
        )

        if not include_unapproved:
            query = query.filter(
                Property.is_approved == True,  # noqa: E712
                Property.is_active == True,    # noqa: E712
            )

        for prop in query.all():
            prop_id = str(prop.id)
            if prop_id in seen_ids:
                continue
            seen_ids.add(prop_id)

            city_name = prop.city.name if prop.city else None
            state_name = (
                prop.city.parent.name
                if prop.city and prop.city.parent
                else None
            )

            score = _compute_score(prop.name, original_query)

            # Skip results below confidence threshold
            if score < min_score:
                continue

            results.append({
                "id": prop_id,
                "name": prop.name,
                "property_type": (
                    prop.property_type.value if prop.property_type else None
                ),
                "city": city_name,
                "state": state_name,
                "avg_rating": prop.avg_rating,
                "score": round(score, 3),
                "original_query": original_query,
            })

    # Sort by score descending for each query group
    results.sort(key=lambda r: (-r["score"], r["name"]))
    return results


def resolve_location_names(
    db: Session,
    names: list[str],
    *,
    min_score: float = 0.3,
    limit: int = 3,
) -> list[dict]:
    """Resolve location names to database records.

    Searches the locations table for cities, states, countries, and districts
    matching the given names, and builds the full location hierarchy chain.

    Args:
        db: Database session.
        names: List of location names to resolve (e.g. ["Gurugram", "Goa", "India"]).
        min_score: Minimum similarity score (0.0-1.0). Results below this are excluded.
        limit: Max results per query term.

    Returns:
        List of dicts with id, name, type, parent_id, parent_name, parent_type,
        hierarchy (list from specific to broad), score, and original_query.
    """
    if not names:
        return []

    results: list[dict] = []
    seen_ids: set[str] = set()

    for original_query in names:
        like = f"%{original_query.strip()}%"

        locations = (
            db.query(Location)
            .filter(Location.name.ilike(like))
            .order_by(Location.type)
            .limit(limit)
            .all()
        )

        for loc in locations:
            loc_id = str(loc.id)
            if loc_id in seen_ids:
                continue
            seen_ids.add(loc_id)

            # Walk up the parent chain to build hierarchy
            hierarchy = [loc.name]
            parent = loc.parent
            top_parent_name = None
            top_parent_type = None
            while parent:
                hierarchy.append(parent.name)
                top_parent_name = parent.name
                top_parent_type = parent.type.value if parent.type else None
                parent = parent.parent

            score = _compute_score(loc.name, original_query)

            # Skip results below confidence threshold
            if score < min_score:
                continue

            results.append({
                "id": loc_id,
                "name": loc.name,
                "type": loc.type.value if loc.type else None,
                "parent_id": str(loc.parent_id) if loc.parent_id else None,
                "parent_name": top_parent_name,
                "parent_type": top_parent_type,
                "hierarchy": hierarchy,
                "score": round(score, 3),
                "original_query": original_query,
            })

    results.sort(key=lambda r: (-r["score"], r["type"] or ""))
    return results


def resolve_doc_types(
    names: list[str],
) -> list[dict]:
    """Validate document type names against the DocType enum.

    Supports partial matching — e.g. "cancel" or "cancellation" matches
    "cancellation_policy".

    Args:
        names: List of document type names to validate
               (e.g. ["cancellation_policy", "house_rules", "invalid_type"]).

    Returns:
        List of dicts with value (the canonical name), valid (bool),
        and original_query (str).
    """
    if not names:
        return []

    results = []
    for original_query in names:
        cleaned = original_query.strip().lower().replace(" ", "_")

        # Direct match first
        if cleaned in VALID_DOC_TYPES:
            results.append({
                "value": cleaned,
                "valid": True,
                "original_query": original_query,
            })
            continue

        # Partial match — try to find a doc type that contains the query
        # e.g. "cancel" → "cancellation_policy"
        matched = None
        for valid_type in VALID_DOC_TYPES:
            if cleaned in valid_type or valid_type in cleaned:
                matched = valid_type
                break

        if matched:
            results.append({
                "value": matched,
                "valid": True,
                "original_query": original_query,
            })
        else:
            results.append({
                "value": original_query,
                "valid": False,
                "original_query": original_query,
            })

    return results


def resolve_all(
    db: Session,
    property_names: list[str] | None = None,
    locations: list[str] | None = None,
    doc_types: list[str] | None = None,
    *,
    include_unapproved: bool = False,
    min_score: float = 0.3,
) -> dict:
    """Run all resolvers and return a combined result.

    This is the main entry point used by the Query Executor.

    Args:
        db: Database session.
        property_names: Property names to resolve.
        locations: Location names to resolve.
        doc_types: Document types to validate.
        include_unapproved: If True, include unapproved properties (admin use).
        min_score: Minimum similarity score (0.0-1.0). Results below this are excluded.

    Returns:
        dict with keys: properties (list), locations (list), doc_types (list).
    """
    properties = resolve_property_names(
        db, property_names or [],
        include_unapproved=include_unapproved,
        min_score=min_score,
    )
    locations = resolve_location_names(
        db, locations or [],
        min_score=min_score,
    )
    doc_types = resolve_doc_types(
        doc_types or [],
    )

    return {
        "properties": properties,
        "property_ids": [p["id"] for p in properties],
        "locations": locations,
        "location_ids": [l["id"] for l in locations],
        "doc_types": doc_types,
        "valid_doc_types": [d["value"] for d in doc_types if d["valid"]],
    }
