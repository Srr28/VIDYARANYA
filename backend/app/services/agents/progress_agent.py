"""Student longitudinal progress narrative and study recommendations."""

from __future__ import annotations

import json
import logging
from typing import Any

from app.core.config import settings
from app.services.groq_limiter import cool_down_after_groq_error, pace_groq_call

logger = logging.getLogger("vidyaranya.progress_agent")


def _fallback_report(metrics: dict[str, Any]) -> dict[str, Any]:
    trajectory = [
        item for item in (metrics.get("trajectory") or [])
        if item.get("status") in {"graded", "missing"}
    ]
    mastery = metrics.get("topic_mastery") or {}
    average = float(metrics.get("average_score_pct") or 0)
    topic_mastery = {
        topic: score for topic, score in mastery.items()
        if str(topic).strip().casefold() != "overall"
    }
    overall_score = next(
        (float(score) for topic, score in mastery.items() if str(topic).strip().casefold() == "overall"),
        None,
    )
    if len(trajectory) >= 2:
        first, last = float(trajectory[0].get("score_pct", 0)), float(trajectory[-1].get("score_pct", 0))
        trend = "improving" if last > first + 2 else "declining" if last < first - 2 else "steady"
    else:
        graded_count = sum(1 for item in trajectory if item.get("status") == "graded")
        trend = f"trend unavailable ({graded_count} graded assignment{'s' if graded_count != 1 else ''}; need at least 2)"

    strong = sorted(topic for topic, score in topic_mastery.items() if float(score) >= 70)
    focus = sorted(topic_mastery, key=lambda topic: float(topic_mastery[topic]))[:3]
    if not trajectory:
        narrative = "There are no released, graded assignments to summarize yet. Your report will update as results become available."
    else:
        narrative = f"Your current average is {average:.1f}%, and your recent results are {trend}."
        if strong:
            narrative += f" You are showing strength in {', '.join(strong[:3])}."
        if focus and float(topic_mastery[focus[0]]) < 70:
            narrative += f" A useful next focus is {', '.join(focus)}."
        elif overall_score is not None and not topic_mastery:
            narrative += " The available result is an overall rubric score, not a topic breakdown."

    recommendations = [f"Review one example or practice question for {topic}." for topic in focus[:3] if float(topic_mastery[topic]) < 70]
    if not recommendations and overall_score is not None and not topic_mastery and trajectory:
        recommendations = ["Review the assignment feedback and identify one specific skill to practice next."]
    if not recommendations and trajectory:
        recommendations = ["Keep practicing with the next topic and review feedback after each released assignment."]
    return {"narrative": narrative, "recommendations": recommendations, "trend": trend}


def generate_progress_narrative(metrics: dict[str, Any]) -> dict[str, Any]:
    """Summarize a student's own course metrics without sending their identity."""
    fallback = _fallback_report(metrics)
    if not settings.GROQ_API_KEY or not metrics.get("trajectory"):
        return fallback

    try:
        from groq import Groq

        safe_metrics = {
            "average_score_pct": metrics.get("average_score_pct"),
            "trend": fallback["trend"],
            "topic_mastery": {
                topic: score for topic, score in (metrics.get("topic_mastery") or {}).items()
                if str(topic).strip().casefold() != "overall"
            },
            "overall_rubric_pct": next(
                (score for topic, score in (metrics.get("topic_mastery") or {}).items()
                 if str(topic).strip().casefold() == "overall"),
                None,
            ),
            "trajectory": [
                {"assignment_title": item.get("assignment_title"), "score_pct": item.get("score_pct")}
                for item in fallback_trajectory(metrics.get("trajectory") or [])[-12:]
            ],
        }
        pace_groq_call()
        response = Groq(api_key=settings.GROQ_API_KEY).chat.completions.create(
            model=settings.GROQ_MODEL,
            messages=[
                {
                    "role": "system",
                    "content": (
                        "Write supportive, specific student progress feedback from the provided results only. "
                        "Do not infer personal traits or invent facts. Return valid JSON with keys narrative "
                        "(2-4 sentences) and recommendations (array of at most 4 short actions). A criterion "
                        "named Overall is an aggregate score, not a topic; do not describe it as a topic."
                    ),
                },
                {"role": "user", "content": json.dumps(safe_metrics, ensure_ascii=False)},
            ],
            temperature=0.2,
            max_tokens=300,
            response_format={"type": "json_object"},
        )
        parsed = json.loads(response.choices[0].message.content or "{}")
        narrative = parsed.get("narrative")
        recommendations = parsed.get("recommendations")
        if not isinstance(narrative, str) or not narrative.strip() or not isinstance(recommendations, list):
            return fallback
        return {
            "narrative": narrative.strip(),
            "recommendations": [str(item).strip() for item in recommendations[:4] if str(item).strip()],
            "trend": fallback["trend"],
        }
    except Exception as exc:
        cool_down_after_groq_error(exc)
        logger.warning("Student progress narrative generation failed; using metric-based guidance: %s", exc)
        return fallback


def fallback_trajectory(trajectory: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Keep in-progress and integrity-held work out of trend comparisons."""
    return [item for item in trajectory if item.get("status") in {"graded", "missing"}]
