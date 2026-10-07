import uuid
from datetime import datetime, timezone
import pytest
from sqlalchemy import create_engine
from sqlalchemy.orm import sessionmaker

from app.core.database import Base
from app.models.user import User
from app.models.course import Course
from app.models.enrollment import Enrollment
from app.models.note import Note
from app.models.assignment import Assignment
from app.models.assignment_attachment import AssignmentAttachment
from app.models.submission import Submission
from app.models.submission_text import SubmissionText
from app.models.submission_comment import SubmissionComment
from app.models.announcement import Announcement
from app.models.chat import ChatMessage
from app.models.analytics_report import AnalyticsReport
from app.models.progress_report import ProgressReport
from app.api.submissions import _compute_mastery_level


@pytest.fixture
def db_session():
    # Use in-memory SQLite database with foreign keys enabled
    engine = create_engine("sqlite:///:memory:")
    with engine.connect() as conn:
        conn.exec_driver_sql("PRAGMA foreign_keys = ON;")
    
    Base.metadata.create_all(bind=engine)
    Session = sessionmaker(bind=engine)
    session = Session()
    yield session
    session.close()
    Base.metadata.drop_all(bind=engine)


def test_uuid_primary_keys_and_model_aliases(db_session):
    # 1. Create User with name/picture aliases
    faculty = User(
        email="faculty@vidyaranya.edu",
        name="Prof. Shankara",
        picture="https://example.com/avatar.png",
        role="faculty",
    )
    db_session.add(faculty)
    db_session.commit()
    db_session.refresh(faculty)

    assert isinstance(faculty.id, uuid.UUID)
    assert faculty.full_name == "Prof. Shankara"
    assert faculty.name == "Prof. Shankara"
    assert faculty.avatar_url == "https://example.com/avatar.png"
    assert faculty.picture == "https://example.com/avatar.png"
    assert faculty.role == "faculty"

    # 2. Create Course with faculty_id & teacher_id alias
    course = Course(
        name="Data Structures & Algorithms",
        subject="Computer Science",
        section="CS-A",
        description="Core algorithms and complexity analysis",
        teacher_id=faculty.id,
        join_code="DSA101",
    )
    db_session.add(course)
    db_session.commit()
    db_session.refresh(course)

    assert isinstance(course.id, uuid.UUID)
    assert course.faculty_id == faculty.id
    assert course.teacher_id == faculty.id
    assert course.subject == "Computer Science"

    # 3. Create Student
    student = User(
        email="student@vidyaranya.edu",
        full_name="Arjun Varma",
        role="student",
    )
    db_session.add(student)
    db_session.commit()
    db_session.refresh(student)

    # 4. Create Enrollment
    enrollment = Enrollment(
        course_id=course.id,
        student_id=student.id,
        status="active",
    )
    db_session.add(enrollment)
    db_session.commit()
    db_session.refresh(enrollment)
    assert isinstance(enrollment.id, uuid.UUID)
    assert enrollment.status == "active"

    # 5. Create Note with file_key, file_type, chroma_indexed, chunk_count
    note = Note(
        course_id=course.id,
        title="Lecture 1: Binary Search Trees",
        file_key="courses/dsa/notes/bst.pdf",
        file_type="pdf",
        chroma_indexed=True,
        chunk_count=14,
    )
    db_session.add(note)
    db_session.commit()
    db_session.refresh(note)
    assert isinstance(note.id, uuid.UUID)
    assert note.file_key == "courses/dsa/notes/bst.pdf"
    assert note.file_path == "courses/dsa/notes/bst.pdf"
    assert note.chroma_indexed is True
    assert note.is_indexed is True
    assert note.chunk_count == 14

    # 6. Create Assignment with topics_list, rubric, reference_note_id, max_marks
    assignment = Assignment(
        course_id=course.id,
        title="BST Implementation Lab",
        description="Implement insert, delete, and traversal in BST",
        topics_list=["BST", "Recursion", "Tree Traversal"],
        rubric=[
            {"criterion": "Correctness", "max_points": 50},
            {"criterion": "Complexity", "max_points": 30},
            {"criterion": "Edge Cases", "max_points": 20},
        ],
        reference_note_id=note.id,
        ai_eval_enabled=True,
        max_marks=100,
    )
    db_session.add(assignment)
    db_session.commit()
    db_session.refresh(assignment)
    assert isinstance(assignment.id, uuid.UUID)
    assert assignment.max_marks == 100
    assert assignment.max_score == 100
    assert assignment.reference_note_id == note.id
    assert "BST" in assignment.topics_list

    # 7. Create Submission and SubmissionText
    submission = Submission(
        assignment_id=assignment.id,
        student_id=student.id,
        file_key="submissions/bst/arjun.pdf",
        status="graded",
        ai_score=85.0,
        final_score=88.0,
        mastery_level="Advanced",
        topic_scores=[{"topic": "BST", "score": 9}],
        feedback_text="Excellent implementation of recursive deletion.",
        integrity_score=0.98,
        plagiarism_flag=False,
        faculty_note="Good work!",
    )
    db_session.add(submission)
    db_session.commit()
    db_session.refresh(submission)
    assert isinstance(submission.id, uuid.UUID)
    assert submission.file_key == "submissions/bst/arjun.pdf"
    assert submission.mastery_level == "Advanced"
    assert submission.teacher_comment == "Good work!"

    sub_text = SubmissionText(
        submission_id=submission.id,
        raw_text="def insert(root, val): ...",
    )
    db_session.add(sub_text)
    db_session.commit()
    db_session.refresh(sub_text)
    assert sub_text.submission_id == submission.id

    # 8. Create AnalyticsReport
    analytics = AnalyticsReport(
        course_id=course.id,
        assignment_id=assignment.id,
        report_type="class_summary",
        weak_topics=[{"topic": "Tree Traversal", "average": 52.0}],
        at_risk_students=[{"student_id": str(student.id), "reason": "Edge Cases"}],
        narrative="Overall the class performed well on insertion but struggled with deletion edge cases.",
        grade_distribution={"A": 15, "B": 8, "C": 4, "F": 1},
    )
    db_session.add(analytics)
    db_session.commit()
    db_session.refresh(analytics)
    assert isinstance(analytics.id, uuid.UUID)
    assert analytics.report_type == "class_summary"

    # 9. Create ProgressReport
    progress = ProgressReport(
        student_id=student.id,
        course_id=course.id,
        narrative="Arjun shows consistent improvement in recursive algorithmic thinking.",
        mastery_snapshot={"BST": "Advanced", "Complexity": "Proficient"},
        rank=3,
    )
    db_session.add(progress)
    db_session.commit()
    db_session.refresh(progress)
    assert isinstance(progress.id, uuid.UUID)
    assert progress.rank == 3


def test_cascade_delete_course(db_session):
    # Setup course with related items
    faculty = User(email="prof@vidyaranya.edu", full_name="Prof", role="faculty")
    student = User(email="stud@vidyaranya.edu", full_name="Student", role="student")
    db_session.add_all([faculty, student])
    db_session.commit()

    course = Course(name="Physics", teacher_id=faculty.id, join_code="PHY001")
    db_session.add(course)
    db_session.commit()

    note = Note(course_id=course.id, title="Quantum Intro", file_key="notes/q.pdf")
    assignment = Assignment(course_id=course.id, title="Problem Set 1", max_marks=50)
    db_session.add_all([note, assignment])
    db_session.commit()

    submission = Submission(assignment_id=assignment.id, student_id=student.id, file_key="sub/1.pdf")
    db_session.add(submission)
    db_session.commit()

    sub_text = SubmissionText(submission_id=submission.id, raw_text="Quantum mechanics...")
    analytics = AnalyticsReport(course_id=course.id, assignment_id=assignment.id, report_type="topic_gap")
    progress = ProgressReport(student_id=student.id, course_id=course.id, rank=1)
    db_session.add_all([sub_text, analytics, progress])
    db_session.commit()

    course_id = course.id
    assignment_id = assignment.id
    submission_id = submission.id

    # Verify everything exists
    assert db_session.query(Course).filter(Course.id == course_id).first() is not None
    assert db_session.query(Assignment).filter(Assignment.id == assignment_id).first() is not None
    assert db_session.query(Submission).filter(Submission.id == submission_id).first() is not None

    # Delete Course -> should cascade to Note, Assignment, Submission, SubmissionText, Analytics, Progress
    db_session.delete(course)
    db_session.commit()

    assert db_session.query(Course).filter(Course.id == course_id).first() is None
    assert db_session.query(Note).filter(Note.course_id == course_id).first() is None
    assert db_session.query(Assignment).filter(Assignment.course_id == course_id).first() is None
    assert db_session.query(Submission).filter(Submission.id == submission_id).first() is None
    assert db_session.query(SubmissionText).filter(SubmissionText.submission_id == submission_id).first() is None
    assert db_session.query(AnalyticsReport).filter(AnalyticsReport.course_id == course_id).first() is None
    assert db_session.query(ProgressReport).filter(ProgressReport.course_id == course_id).first() is None


def test_mastery_level_computation():
    assert _compute_mastery_level(35, 100) == "Beginner"
    assert _compute_mastery_level(39.9, 100) == "Beginner"
    assert _compute_mastery_level(40, 100) == "Developing"
    assert _compute_mastery_level(59.9, 100) == "Developing"
    assert _compute_mastery_level(60, 100) == "Proficient"
    assert _compute_mastery_level(79.9, 100) == "Proficient"
    assert _compute_mastery_level(80, 100) == "Advanced"
    assert _compute_mastery_level(95, 100) == "Advanced"
