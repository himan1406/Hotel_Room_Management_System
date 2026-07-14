import sys
import time

from app.core.database import SessionLocal
from app.models.db_models import Property, Review
from app.core.llm import ask_llm

SYSTEM_PROMPT = (
    "You are a terse copywriter for a hotel booking platform. "
    "Write 1-2 short phrases (max 80 characters total) highlighting what "
    "stands out about this property. Mention specific amenities, experiences, "
    "or qualities. Vary your phrasing — never start with 'Guests rave' or "
    "'Guests love' or 'Guests adore'. "
    "Examples of good output: 'Rooftop pool with city views · farm-to-table dining' "
    "or 'Heritage walks, rooftop stargazing, authentic home-cooked meals' "
    "or 'Steps from the Taj · sunset views from every suite'. "
    "Do not use quotes or markdown. Output only the text."
)


def build_user_message(prop_name, description, reviews):
    parts = [f"Property: {prop_name}"]
    if description:
        parts.append(f"Description: {description[:500]}")
    if reviews:
        parts.append("Guest reviews:")
        for r in reviews[:5]:
            comment = r.comment.strip() if r.comment else ""
            if comment:
                parts.append(f'- "{comment}" (Rating: {r.rating}/5)')
    return "\n".join(parts)


def generate_highlight(prop_name, description, reviews):
    user_msg = build_user_message(prop_name, description, reviews)
    reply, _ = ask_llm(SYSTEM_PROMPT, [{"role": "user", "content": user_msg}],
                    temperature=0.7, max_tokens=200)
    if not reply or "API_KEY" in reply or "unavailable" in reply or "configured" in reply:
        return None
    return reply.strip().rstrip(".").strip()[:200]


def update_property_highlight(property_id):
    db = SessionLocal()
    try:
        prop = db.query(Property).filter(Property.id == property_id).first()
        if not prop:
            return
        reviews = (
            db.query(Review)
            .filter(Review.property_id == property_id, Review.comment.isnot(None))
            .order_by(Review.rating.desc(), Review.created_at.desc())
            .limit(5)
            .all()
        )
        highlight = generate_highlight(prop.name, prop.description, reviews)
        if highlight:
            prop.ai_highlight = highlight
            db.commit()
    finally:
        db.close()


def main():
    db = SessionLocal()
    try:
        properties = db.query(Property).all()
        total = len(properties)
        print(f"Generating highlights for {total} properties ...")

        for i, prop in enumerate(properties, 1):
            reviews = (
                db.query(Review)
                .filter(Review.property_id == prop.id, Review.comment.isnot(None))
                .order_by(Review.rating.desc(), Review.created_at.desc())
                .limit(5)
                .all()
            )

            highlight = generate_highlight(prop.name, prop.description, reviews)
            if highlight:
                prop.ai_highlight = highlight
                db.commit()
                print(f"  [{i}/{total}] {prop.name} -> {highlight}")
            else:
                print(f"  [{i}/{total}] {prop.name} -> SKIPPED (LLM error)")

            time.sleep(0.5)

        print("\nDone!")
    finally:
        db.close()


if __name__ == "__main__":
    main()
