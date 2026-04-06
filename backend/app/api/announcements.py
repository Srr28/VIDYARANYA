from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db
from app.models.announcement import Announcement
from app.models.course import Course
from app.models.enrollment import Enrollment
from app.models.user import User

router = APIRouter(prefix="/announcements", tags=["announcements"])


class AnnouncementCreate(BaseModel):
    course_id: int
    content: str


def _can_access_course(db: Session, current_user: User, course: Course) -> bool:
    if course.teacher_id == current_user.id:
        return True
    enrollment = (
        db.query(Enrollment)
        .filter(Enrollment.course_id == course.id, Enrollment.student_id == current_user.id)
        .first()
    )
    return enrollment is not None


@router.get("/{course_id}")
def list_announcements(
    course_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[dict]:
    course = db.query(Course).filter(Course.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="Course not found")
    if not _can_access_course(db, current_user, course):
        raise HTTPException(status_code=403, detail="No access to this course")

    rows = (
        db.query(Announcement)
        .filter(Announcement.course_id == course_id)
        .order_by(Announcement.id.desc())
        .all()
    )

    return [
        {
            "id": item.id,
            "course_id": item.course_id,
            "author_id": item.author_id,
            "author_name": item.author.name if item.author else "User",
            "author_picture": item.author.picture if item.author else None,
            "content": item.content,
            "created_at": item.created_at,
        }
        for item in rows
    ]


@router.post("")
def create_announcement(
    payload: AnnouncementCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict:
    course = db.query(Course).filter(Course.id == payload.course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="Course not found")
    if course.teacher_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the classroom owner can post announcements")

    content = payload.content.strip()
    if not content:
        raise HTTPException(status_code=400, detail="Announcement content is required")

    row = Announcement(
        course_id=payload.course_id,
        author_id=current_user.id,
        content=content,
    )
    db.add(row)
    db.commit()
    db.refresh(row)

    return {
        "id": row.id,
        "course_id": row.course_id,
        "author_id": row.author_id,
        "author_name": current_user.name,
        "author_picture": current_user.picture,
        "content": row.content,
        "created_at": row.created_at,
    }
