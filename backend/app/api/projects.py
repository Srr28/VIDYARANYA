import requests

from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session, joinedload

from app.api.deps import get_current_user, get_db
from app.models.benchmark import Benchmark
from app.models.course import Course
from app.models.enrollment import Enrollment
from app.models.evaluation import Evaluation
from app.models.project import Project
from app.models.project_submission import ProjectSubmission
from app.models.user import User
from app.schemas.project import (
    EvaluationHistoryOut,
    EvaluationOut,
    ProjectCreate,
    ProjectOut,
    ProjectSubmissionCreate,
    ProjectSubmissionResultOut,
)
from app.services.evaluation_service import evaluate_submission

router = APIRouter(prefix="/projects", tags=["projects"])


def _get_project_or_404(db: Session, project_id: int) -> Project:
    project = (
        db.query(Project)
        .options(joinedload(Project.benchmarks), joinedload(Project.course))
        .filter(Project.id == project_id)
        .first()
    )
    if not project:
        raise HTTPException(status_code=404, detail="Project not found")
    return project


def _is_enrolled(db: Session, course_id: int, student_id: int) -> bool:
    enrollment = (
        db.query(Enrollment)
        .filter(Enrollment.course_id == course_id, Enrollment.student_id == student_id)
        .first()
    )
    return enrollment is not None


def _serialize_evaluation(evaluation: Evaluation) -> EvaluationOut:
    return EvaluationOut(
        id=evaluation.id,
        submission_id=evaluation.submission_id,
        alignment_score=round(evaluation.alignment_score, 2),
        benchmark_score=round(evaluation.benchmark_score, 2),
        benchmark_scores=evaluation.benchmark_scores,
        progress_score=round(evaluation.progress_score, 2),
        final_score=round(evaluation.final_score, 2),
        drift=evaluation.drift,
        feedback=evaluation.feedback,
        created_at=evaluation.created_at,
    )


@router.post("/", response_model=ProjectOut)
def create_project(
    payload: ProjectCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> Project:
    course = db.query(Course).filter(Course.id == payload.course_id).first()
    if not course:
        raise HTTPException(status_code=404, detail="Course not found")
    if course.teacher_id != current_user.id:
        raise HTTPException(status_code=403, detail="Only the course teacher can create projects")
    if not payload.benchmarks:
        raise HTTPException(status_code=400, detail="At least one benchmark is required")
    benchmark_titles = [item.title.strip() for item in payload.benchmarks]
    if len(set(benchmark_titles)) != len(benchmark_titles):
        raise HTTPException(status_code=400, detail="Benchmark titles must be unique within a project")

    project = Project(
        course_id=payload.course_id,
        teacher_id=current_user.id,
        title=payload.title.strip(),
        description=payload.description.strip(),
    )
    db.add(project)
    db.flush()

    for item in payload.benchmarks:
        db.add(
            Benchmark(
                project_id=project.id,
                title=item.title.strip(),
                description=item.description.strip(),
                weight=item.weight,
                expected_stage=item.expected_stage,
            )
        )

    db.commit()
    db.refresh(project)
    return (
        db.query(Project)
        .options(joinedload(Project.benchmarks))
        .filter(Project.id == project.id)
        .first()
    )


@router.post("/{project_id}/submit", response_model=ProjectSubmissionResultOut)
def submit_project_work(
    project_id: int,
    payload: ProjectSubmissionCreate,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> ProjectSubmissionResultOut:
    project = _get_project_or_404(db, project_id)
    if project.teacher_id == current_user.id:
        raise HTTPException(status_code=403, detail="Project owner cannot submit student work")
    if not _is_enrolled(db, project.course_id, current_user.id):
        raise HTTPException(status_code=403, detail="You are not enrolled in this course")
    if not project.benchmarks:
        raise HTTPException(status_code=400, detail="Project has no benchmarks configured")

    submission = ProjectSubmission(
        project_id=project.id,
        student_id=current_user.id,
        stage=payload.stage,
        submission_text=payload.submission_text,
    )
    db.add(submission)
    db.flush()

    try:
        evaluation = evaluate_submission(db, submission)
        db.commit()
    except ValueError as exc:
        db.rollback()
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except requests.HTTPError as exc:  # type: ignore[name-defined]
        db.rollback()
        raise HTTPException(status_code=502, detail="LLM evaluation request failed") from exc
    except RuntimeError as exc:
        db.rollback()
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    except Exception as exc:
        db.rollback()
        raise HTTPException(status_code=500, detail="Project evaluation failed") from exc

    db.refresh(submission)
    db.refresh(evaluation)

    return ProjectSubmissionResultOut(
        submission_id=submission.id,
        project_id=project.id,
        student_id=current_user.id,
        stage=submission.stage,
        created_at=submission.created_at,
        evaluation=_serialize_evaluation(evaluation),
    )


@router.get("/{project_id}/evaluation/{student_id}", response_model=EvaluationHistoryOut)
def get_evaluation_history(
    project_id: int,
    student_id: int,
    db: Session = Depends(get_db),
    current_user: User = Depends(get_current_user),
) -> EvaluationHistoryOut:
    project = _get_project_or_404(db, project_id)
    can_view = project.teacher_id == current_user.id or current_user.id == student_id
    if not can_view:
        raise HTTPException(status_code=403, detail="No access")
    if current_user.id == student_id and not _is_enrolled(db, project.course_id, student_id):
        raise HTTPException(status_code=403, detail="No access")

    submissions = (
        db.query(ProjectSubmission)
        .options(joinedload(ProjectSubmission.evaluations))
        .filter(
            ProjectSubmission.project_id == project_id,
            ProjectSubmission.student_id == student_id,
        )
        .order_by(ProjectSubmission.stage.asc(), ProjectSubmission.created_at.asc(), ProjectSubmission.id.asc())
        .all()
    )

    items = []
    latest_final_score = None
    latest_progress_score = None
    for submission in submissions:
        if not submission.evaluations:
            continue
        evaluation = sorted(
            submission.evaluations,
            key=lambda item: (item.created_at, item.id),
        )[-1]
        latest_final_score = round(evaluation.final_score, 2)
        latest_progress_score = round(evaluation.progress_score, 2)
        items.append(
            {
                "submission_id": submission.id,
                "stage": submission.stage,
                "submission_text": submission.submission_text,
                "created_at": submission.created_at,
                "evaluation": _serialize_evaluation(evaluation),
            }
        )

    return EvaluationHistoryOut(
        project_id=project_id,
        student_id=student_id,
        latest_final_score=latest_final_score,
        latest_progress_score=latest_progress_score,
        evaluations=items,
    )
