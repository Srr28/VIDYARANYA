"""Class-level performance analysis and teacher action recommendations."""

from __future__ import annotations

import json
import logging
from typing import Any

from app.core.config import settings

logger = logging.getLogger("vidyaranya.analytics_agent")


def _fallback_recommendations(metrics: dict[str, Any]) -> str:
    weak_topics = metrics.get("weak_topics") or []
    at_risk = metrics.get("at_risk_students") or []
    overall_score = metrics.get("overall_rubric_pct")
    has_topic_gaps = bool(weak_topics)
    actions = []
    if overall_score is not None and not has_topic_gaps:
        actions.append(
            f"The rubric reports an overall average of {overall_score}%, but it does not identify topic-specific gaps. "
            "For more targeted class insights, use separate rubric criteria for the key concepts."
        )
    if not weak_topics and not at_risk:
        if actions:
            return " ".join(actions)
        return "The class is meeting the current topic mastery thresholds. Continue with the planned lessons and monitor the next assignment."

    if weak_topics:
        topics = ", ".join(str(item.get("topic", "topic")) for item in weak_topics[:3])
        actions.append(f"Plan a short revision or worked example for {topics}.")
    if at_risk:
        actions.append(f"Check in privately with {len(at_risk)} student(s) identified for follow-up and agree on a manageable next step.")
    return " ".join(actions)


def generate_class_recommendations(metrics: dict[str, Any]) -> str:
    """Generate a concise, evidence-bound teaching recommendation narrative.

    Student names and identifiers are intentionally excluded from the LLM input.
    Deterministic metrics remain the source of truth; the model only explains next steps.
    """
    fallback = _fallback_recommendations(metrics)
    if not settings.GROQ_API_KEY:
        return fallback

    try:
        from groq import Groq

        safe_metrics = {
            "weak_topics": metrics.get("weak_topics", []),
            "at_risk_count": len(metrics.get("at_risk_students") or []),
            "grade_distribution": metrics.get("grade_distribution", {}),
            "graded_submissions": metrics.get("graded_submissions", 0),
            "assignment_count": metrics.get("assignment_count", 0),
            "overall_rubric_pct": metrics.get("overall_rubric_pct"),
        }
        response = Groq(api_key=settings.GROQ_API_KEY).chat.completions.create(
            model=settings.GROQ_MODEL,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "You are a careful teaching analytics assistant. Give 2-4 concise, actionable "
                        "class-level teaching recommendations grounded only in the supplied metrics. Treat "
                        "overall_rubric_pct as an aggregate rubric score, never as a topic or weak topic. "
                        "Do not invent causes, student identities, or evidence. If data is sparse, say so."
                    ),
                },
                {"role": "user", "content": json.dumps(safe_metrics, ensure_ascii=False)},
            ],
            temperature=0.2,
            max_tokens=220,
        )
        narrative = (response.choices[0].message.content or "").strip()
        return narrative or fallback
    except Exception as exc:  # Analytics still works when Groq is unavailable.
        logger.warning("Class analytics narrative generation failed; using metric-based guidance: %s", exc)
        return fallback
