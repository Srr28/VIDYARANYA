import json
from types import SimpleNamespace

import pytest

from app.services import grading_service, groq_limiter


class FakeCompletions:
    def __init__(self, content: str) -> None:
        self.content = content
        self.calls = []

    def create(self, **kwargs):
        self.calls.append(kwargs)
        message = SimpleNamespace(content=self.content)
        return SimpleNamespace(choices=[SimpleNamespace(message=message)])


class FakeClient:
    def __init__(self, content: str) -> None:
        self.completions = FakeCompletions(content)
        self.chat = SimpleNamespace(completions=self.completions)


def test_grade_makes_one_call_and_builds_reference_feedback(monkeypatch):
    model_result = {
        "breakdown": [
            {
                "criterion": "Nested parallelism",
                "score": 0,
                "max_points": 35,
                "feedback": "No nested parallel region was found.",
                "evidence": [],
                "missing": ["Nested parallelism implementation", "Set OMP_MAX_ACTIVE_LEVELS=2"],
                "why_it_matters": "Nested regions are needed to demonstrate the required parallel levels.",
                "next_steps": ["Enable nested parallelism and add an inner parallel region."],
            },
            {
                "criterion": "Code snippets",
                "score": 28,
                "max_points": 35,
                "feedback": "The FFT snippets are useful but incomplete.",
                "evidence": ["Provided an FFT step function and timing utility."],
                "missing": ["A complete OpenMP program skeleton"],
                "why_it_matters": "The full program is needed to verify the implementation compiles and runs.",
                "next_steps": ["Add the includes, main function, and nested loops."],
            },
        ],
        "depth_score": 4,
        "depth_label": "evaluative",
        "general_feedback": "You provided useful FFT implementation and timing evidence.",
    }
    client = FakeClient(json.dumps(model_result))
    monkeypatch.setattr(grading_service, "GROQ_CLIENT", client)

    result = grading_service.grade(
        "#pragma omp parallel for\nvoid fft_step() {}",
        [
            {"criterion": "Nested parallelism", "max_points": 35},
            {"criterion": "Code snippets", "max_points": 35},
        ],
        reference_solution="Expected OpenMP structure",
        topics_list=["OpenMP", "FFT performance"],
        course_context=[{"topic": "OpenMP", "source": "note:abc", "text": "Nested regions use OMP_MAX_ACTIVE_LEVELS."}],
    )

    assert len(client.completions.calls) == 1
    assert client.completions.calls[0]["response_format"] == {"type": "json_object"}
    assert result["total_score"] == 28
    assert result["max_score"] == 70
    assert result["depth_score"] == 4
    assert result["depth_label"] == "evaluative"
    assert result["breakdown"][1]["coverage_score"] == 8
    assert result["breakdown"][1]["evidence"] == ["Provided an FFT step function and timing utility."]
    assert "## What You Did Well" in result["general_feedback"]
    assert "## Conceptual Gaps & Misconceptions" in result["general_feedback"]
    assert "## Targeted Action Plan" in result["general_feedback"]
    assert "## Specific Items to Review" in result["general_feedback"]
    assert "[note:abc]" in result["general_feedback"]


def test_grade_rejects_incomplete_rubric_results(monkeypatch):
    client = FakeClient(json.dumps({
        "breakdown": [],
        "depth_score": 1,
        "depth_label": "surface",
        "general_feedback": "Incomplete.",
    }))
    monkeypatch.setattr(grading_service, "GROQ_CLIENT", client)

    with pytest.raises(ValueError, match="rubric results"):
        grading_service.grade("Some answer", [{"criterion": "Correctness", "max_points": 10}])


def test_pacer_enforces_configured_calls_per_minute(monkeypatch):
    now = [100.0]
    waits = []
    monkeypatch.setattr(groq_limiter.settings, "GROQ_MAX_CALLS_PER_MINUTE", 2)
    monkeypatch.setattr(groq_limiter.time, "monotonic", lambda: now[0])

    def fake_sleep(seconds):
        waits.append(seconds)
        now[0] += seconds

    monkeypatch.setattr(groq_limiter.time, "sleep", fake_sleep)
    with groq_limiter._LOCK:
        groq_limiter._CALL_TIMES.clear()
        groq_limiter._LAST_CALL_AT = 0.0
        groq_limiter._COOLDOWN_UNTIL = 0.0

    for _ in range(3):
        groq_limiter.pace_groq_call()

    assert len(waits) == 2
    assert all(wait == pytest.approx(30.0) for wait in waits)


def test_pacer_honors_shared_provider_cooldown(monkeypatch):
    now = [200.0]
    waits = []
    monkeypatch.setattr(groq_limiter.time, "monotonic", lambda: now[0])

    def fake_sleep(seconds):
        waits.append(seconds)
        now[0] += seconds

    monkeypatch.setattr(groq_limiter.time, "sleep", fake_sleep)
    with groq_limiter._LOCK:
        groq_limiter._CALL_TIMES.clear()
        groq_limiter._LAST_CALL_AT = 0.0
        groq_limiter._COOLDOWN_UNTIL = 0.0

    groq_limiter.set_groq_cooldown(12)
    groq_limiter.pace_groq_call()

    assert waits == [12.0]
