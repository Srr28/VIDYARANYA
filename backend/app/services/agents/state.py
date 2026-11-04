"""Typed state shared by the Phase 4 evaluation graph."""

from typing import Any, TypedDict


class EvaluationState(TypedDict, total=False):
    submission_id: str
    assignment_id: str
    course_id: str
    raw_text: str
    rubric: list[dict[str, Any]]
    reference_solution: str
    reference_digest: str
    compact_rubric: str
    submission_chunks: list[str]
    topics_list: list[str]
    max_score: float
    integrity_score: float
    plagiarism_flag: bool
    plagiarism_matches: list[dict[str, Any]]
    topic_coverage: list[dict[str, Any]]
    mastery_result: dict[str, Any]
    retrieved_chunks: dict[str, list[dict[str, Any]]]
    feedback_markdown: str
    feedback_draft: str
    feedback_mode: str
    course_material_count: int
    llm_stats: dict[str, Any]
    execution_plan: list[str]
    execution_step: int
    final_status: str
    error: str | None
