"""Typed state shared by the Phase 4 evaluation graph."""

from typing import Any, TypedDict


class EvaluationState(TypedDict, total=False):
    submission_id: str
    assignment_id: str
    course_id: str
    assignment_title: str
    assignment_description: str
    raw_text: str
    rubric: list[dict[str, Any]]
    reference_solution: str
    reference_note_id: str | None
    reference_note_context: str
    assignment_attachment_context: str
    topics_list: list[str]
    max_score: float
    integrity_embedding: list[float]
    integrity_score: float
    plagiarism_flag: bool
    plagiarism_matches: list[dict[str, Any]]
    topic_coverage: list[dict[str, Any]]
    depth_result: dict[str, Any]
    mastery_result: dict[str, Any]
    retrieved_chunks: dict[str, list[dict[str, Any]]]
    feedback_markdown: str
    execution_plan: list[str]
    execution_step: int
    final_status: str
    error: str | None
