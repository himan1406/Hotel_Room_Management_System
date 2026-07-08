import uuid
from datetime import date, datetime, timezone

from fastapi import APIRouter, Depends, HTTPException, Request
from sqlalchemy.orm import Session

from app.database import get_db
from app.models import Booking, BookingStatus, Property, Review, User, UserRole
from app.routers.auth import get_current_user, require_role, hash_token
from app.schemas import ReviewCreate, ReviewUpdate, ReviewRespond, ReviewResponse
from app.models import Session as SessionModel

router = APIRouter(prefix="/api/reviews", tags=["reviews"])
customer_required = require_role(UserRole.customer)


def _recalc_property_rating(prop: Property, db: Session) -> None:
    """Recalculate avg_rating and review_count for a property from scratch."""
    all_reviews = db.query(Review).filter(Review.property_id == prop.id).all()
    if all_reviews:
        prop.avg_rating = round(sum(r.rating for r in all_reviews) / len(all_reviews), 1)
        prop.review_count = len(all_reviews)
    else:
        prop.avg_rating = 0.0
        prop.review_count = 0


@router.post("")
def create_review(
    req: ReviewCreate,
    user: User = Depends(customer_required),
    db: Session = Depends(get_db),
):
    booking = db.query(Booking).filter(
        Booking.id == req.booking_id,
        Booking.customer_id == user.id,
    ).first()
    if not booking:
        raise HTTPException(status_code=404, detail="Booking not found")
    if booking.status == BookingStatus.completed:
        pass
    elif booking.status == BookingStatus.confirmed and booking.check_out < date.today():
        pass
    else:
        raise HTTPException(
            status_code=400,
            detail="You can only review completed stays (check-out date has passed).",
        )

    existing = db.query(Review).filter(Review.booking_id == req.booking_id).first()
    if existing:
        raise HTTPException(status_code=400, detail="You have already reviewed this booking")

    review = Review(
        booking_id=booking.id,
        customer_id=user.id,
        property_id=booking.room.property_id,
        rating=req.rating,
        comment=req.comment,
    )
    db.add(review)

    prop = db.query(Property).filter(Property.id == booking.room.property_id).first()
    if prop:
        _recalc_property_rating(prop, db)

    db.commit()
    db.refresh(review)
    data = ReviewResponse.model_validate(review).model_dump()
    data["is_mine"] = True
    return data


def _resolve_current_user(request: Request, db: Session) -> User | None:
    """Try to extract the current user from cookies — returns None if not logged in."""
    token = request.cookies.get("access_token")
    if not token:
        return None
    session = db.query(SessionModel).filter(
        SessionModel.token_hash == hash_token(token),
        SessionModel.expires_at > datetime.now(timezone.utc),
    ).first()
    if not session:
        return None
    return db.query(User).filter(User.id == session.user_id).first()


@router.get("/property/{property_id}")
def list_property_reviews(
    property_id: uuid.UUID,
    request: Request,
    db: Session = Depends(get_db),
):
    prop = db.query(Property).filter(Property.id == property_id).first()
    if not prop:
        raise HTTPException(status_code=404, detail="Property not found")

    current_user = _resolve_current_user(request, db)

    reviews = (
        db.query(Review)
        .filter(Review.property_id == property_id)
        .order_by(Review.created_at.desc())
        .all()
    )
    result = []
    for r in reviews:
        customer = db.query(User).filter(User.id == r.customer_id).first()
        data = ReviewResponse.model_validate(r).model_dump()
        data["customer_name"] = customer.full_name if customer else "Anonymous"
        data["is_mine"] = current_user is not None and current_user.id == r.customer_id
        result.append(data)
    return result


@router.put("/{review_id}")
def update_review(
    review_id: uuid.UUID,
    req: ReviewUpdate,
    user: User = Depends(customer_required),
    db: Session = Depends(get_db),
):
    review = db.query(Review).filter(Review.id == review_id).first()
    if not review:
        raise HTTPException(status_code=404, detail="Review not found")
    if review.customer_id != user.id:
        raise HTTPException(status_code=403, detail="You can only edit your own reviews")

    review.rating = req.rating
    review.comment = req.comment

    prop = db.query(Property).filter(Property.id == review.property_id).first()
    if prop:
        _recalc_property_rating(prop, db)

    db.commit()
    db.refresh(review)
    data = ReviewResponse.model_validate(review).model_dump()
    data["is_mine"] = True
    return data


@router.delete("/{review_id}")
def delete_review(
    review_id: uuid.UUID,
    user: User = Depends(customer_required),
    db: Session = Depends(get_db),
):
    review = db.query(Review).filter(Review.id == review_id).first()
    if not review:
        raise HTTPException(status_code=404, detail="Review not found")
    if review.customer_id != user.id:
        raise HTTPException(status_code=403, detail="You can only delete your own reviews")

    prop = db.query(Property).filter(Property.id == review.property_id).first()

    db.delete(review)

    if prop:
        _recalc_property_rating(prop, db)

    db.commit()
    return {"message": "Review deleted"}


@router.post("/{review_id}/respond")
def respond_to_review(
    review_id: uuid.UUID,
    req: ReviewRespond,
    user: User = Depends(require_role(UserRole.hotel_rep)),
    db: Session = Depends(get_db),
):
    review = db.query(Review).filter(Review.id == review_id).first()
    if not review:
        raise HTTPException(status_code=404, detail="Review not found")

    prop = db.query(Property).filter(
        Property.id == review.property_id,
        Property.owner_rep_id == user.id,
    ).first()
    if not prop:
        raise HTTPException(status_code=403, detail="You can only respond to reviews for your own properties")

    review.rep_response = req.response
    review.responded_at = datetime.now(timezone.utc)
    db.commit()
    return {"message": "Response submitted"}
