from app.models.assignment import Assignment
from app.models.assignment_attachment import AssignmentAttachment
from app.models.announcement import Announcement
from app.models.benchmark import Benchmark
from app.models.chat import ChatMessage
from app.models.course import Course
from app.models.enrollment import Enrollment
from app.models.evaluation import Evaluation
from app.models.note import Note
from app.models.project import Project
from app.models.project_submission import ProjectSubmission
from app.models.submission import Submission
from app.models.submission_comment import SubmissionComment
from app.models.user import User

__all__ = [
    "User",
    "Course",
    "Enrollment",
    "Note",
    "Assignment",
    "AssignmentAttachment",
    "Announcement",
    "Project",
    "Benchmark",
    "ProjectSubmission",
    "Evaluation",
    "Submission",
    "SubmissionComment",
    "ChatMessage",
]
