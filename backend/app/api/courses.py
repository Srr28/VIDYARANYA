import random
import string
import uuid

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from app.api.deps import get_current_user, get_db
from app.models.course import Course
from app.models.enrollment import Enrollment
from app.models.user import User
from app.schemas.course import CourseCreate, CourseJoinRequest, CourseOut

router = APIRouter(prefix="/courses", tags=["courses"])

COURSE_BANNER_COLORS = [
    "#1a73e8",
    "#188038",
    "#b06000",
    "#a142f4",
    "#c5221f",
    "#007b83",
    "#5f6368",
    "#0b8043",
]


def generate_unique_join_code(db: Session) -> str:
    while True:
        code = "".join(random.choices(string.ascii_uppercase + string.digits, k=6))
        exists = db.query(Course).filter(Course.join_code == code).first()
        if not exists:
            return code


def pick_banner_color(db: Session, teacher_id: uuid.UUID) -> str:
    used_colors = {
        item[0]
        for item in db.query(Course.banner_color)
        .filter(Course.faculty_id == teacher_id)
        .all()
        if item and item[0]
    }
    available = [color for color in COURSE_BANNER_COLORS if color not in used_colors]
    if available:
        return random.choice(available)
    return random.choice(COURSE_BANNER_COLORS)


def _is_enrolled(db: Session, user_id: uuid.UUID, course_id: uuid.UUID) -> bool:
    enrollment = (
        db.query(Enrollment)
        .filter(Enrollment.student_id == user_id, Enrollment.course_id == course_id)
        .first()
    )
    return enrollment is not None


def _can_access_course(db: Session, user: User, course: Course) -> bool:
    if course.faculty_id == user.id:
        return True
    return _is_enrolled(db, user.id, course.id)


@router.post("", response_model=CourseOut)
def create_course(
    payload: CourseCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Course:
    if current_user.role not in {"faculty", "teacher", "admin"}:
        current_user.role = "faculty"
        db.commit()
        db.refresh(current_user)

    join_code = generate_unique_join_code(db)
    course = Course(
        name=payload.name,
        subject=payload.subject,
        section=payload.section,
        description=payload.description,
        faculty_id=current_user.id,
        join_code=join_code,
        banner_color=pick_banner_color(db, current_user.id),
    )
    db.add(course)
    db.commit()
    db.refresh(course)
    return course


@router.get("", response_model=list[CourseOut])
def list_courses(
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> list[Course]:
    owned_courses = db.query(Course).filter(Course.faculty_id == current_user.id).all()
    joined_courses = (
        db.query(Course)
        .join(Enrollment, Enrollment.course_id == Course.id)
        .filter(Enrollment.student_id == current_user.id)
        .all()
    )

    merged: dict[uuid.UUID, Course] = {course.id: course for course in owned_courses}
    for course in joined_courses:
        merged[course.id] = course
    return list(merged.values())


@router.post("/join")
def join_course(
    payload: CourseJoinRequest,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, str | uuid.UUID]:
    normalized_code = payload.code.strip().upper()
    course = db.query(Course).filter(Course.join_code == normalized_code).first()
    if not course:
        raise HTTPException(status_code=404, detail="Course not found")

    if course.faculty_id == current_user.id:
        return {"message": "You are the classroom owner", "course_id": course.id}

    existing = (
        db.query(Enrollment)
        .filter(Enrollment.student_id == current_user.id, Enrollment.course_id == course.id)
        .first()
    )
    if existing:
        return {"message": "Already enrolled", "course_id": course.id}

    enrollment = Enrollment(student_id=current_user.id, course_id=course.id)
    db.add(enrollment)
    db.commit()

    return {"message": "Joined course", "course_id": course.id}


@router.get("/{course_id}/people")
def get_course_people(
    course_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, list[dict[str, uuid.UUID | str | None]]]:
    course = db.query(Course).filter(Course.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="Course not found")

    if not _can_access_course(db, current_user, course):
        raise HTTPException(status_code=403, detail="No access to this course")

    teacher = db.query(User).filter(User.id == course.faculty_id).first()
    students = (
        db.query(User)
        .join(Enrollment, Enrollment.student_id == User.id)
        .filter(Enrollment.course_id == course.id)
        .order_by(User.full_name.asc())
        .all()
    )

    return {
        "teachers": [
            {
                "id": teacher.id,
                "name": teacher.name,
                "email": teacher.email,
                "picture": teacher.picture,
            }
        ]
        if teacher
        else [],
        "students": [
            {
                "id": student.id,
                "name": student.name,
                "email": student.email,
                "picture": student.picture,
            }
            for student in students
        ],
    }


@router.delete("/{course_id}/students/{student_id}")
def remove_student_from_course(
    course_id: uuid.UUID,
    student_id: uuid.UUID,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> dict[str, str | uuid.UUID]:
    course = db.query(Course).filter(Course.id == course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="Course not found")

    if course.faculty_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the classroom owner can remove students")

    enrollment = (
        db.query(Enrollment)
        .filter(Enrollment.course_id == course_id, Enrollment.student_id == student_id)
        .first()
    )
    if not enrollment:
        raise HTTPException(status_code=404, detail="Student is not enrolled in this course")

    db.delete(enrollment)
    db.commit()

    return {
        "message": "Student removed",
        "course_id": course_id,
        "student_id": student_id,
    }
