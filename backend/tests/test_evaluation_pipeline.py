import fnmatch
import json
import logging
from types import SimpleNamespace

import pytest

from app.services.agents import eval_graph
from app.services.agents import context_cache


@pytest.fixture(autouse=True)
def memory_checkpoint_redis(monkeypatch):
    class MemoryRedis:
        def __init__(self):
            self.values = {}

        def get(self, key):
            return self.values.get(key)

        def set(self, key, value, ex=None):
            self.values[key] = value
            return True

        def scan_iter(self, match):
            return (key for key in self.values if fnmatch.fnmatch(key, match))

        def delete(self, *keys):
            for key in keys:
                self.values.pop(key, None)

    memory = MemoryRedis()
    monkeypatch.setattr(eval_graph, "_groq_redis", lambda: memory)
    return memory


def test_mastery_matches_criterion_with_extra_whitespace_and_case(monkeypatch):
    result = eval_graph._build_mastery(
        {"rubric": [{"criterion": "  BST   SEARCH ", "max_points": 10}]},
        [{
            "topic": "bst search", "score": 8,
            "evidence": ["The search follows the correct branch."], "missing": [],
        }],
        {"score": 4, "label": "analytical"},
    )

    topic = result["topic_scores"][0]
    assert topic["coverage_score"] == 8
    assert topic["score"] == 8
    assert topic["evidence"] == ["The search follows the correct branch."]


def test_prepare_selects_rag_feedback_without_llm_when_course_material_exists(monkeypatch):
    class Collection:
        def count(self):
            return 3

    monkeypatch.setattr(eval_graph.CHROMA_CLIENT, "get_collection", lambda **_kwargs: Collection())
    monkeypatch.setattr(
        eval_graph,
        "_ask_json",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("prepare must not call Groq")),
    )

    result = eval_graph.prepare_node(
        {"submission_id": "sub-1", "assignment_id": "assignment-1", "course_id": "course-1", "raw_text": "answer"}
    )

    assert result["execution_plan"] == ["integrity", "grade", "rag_feedback"]


def test_prepare_selects_rubric_feedback_when_course_material_is_missing(monkeypatch):
    def missing_collection(**_kwargs):
        raise ValueError("collection missing")

    monkeypatch.setattr(eval_graph.CHROMA_CLIENT, "get_collection", missing_collection)
    monkeypatch.setattr(
        eval_graph,
        "_ask_json",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("prepare must not call Groq")),
    )

    result = eval_graph.prepare_node(
        {"submission_id": "sub-1", "assignment_id": "assignment-1", "course_id": "course-1", "raw_text": "answer"}
    )

    assert result["execution_plan"] == ["integrity", "grade", "rubric_feedback"]


def test_langgraph_runs_integrity_and_grade_in_parallel_before_feedback():
    graph = eval_graph.build_evaluation_graph()
    edges = {(edge.source, edge.target) for edge in graph.get_graph().edges}
    assert ("prepare", "integrity") in edges
    assert ("prepare", "grade") in edges
    assert ("integrity", "feedback") in edges
    assert ("grade", "feedback") in edges
    assert ("feedback", "finalize") in edges


def test_parallel_graph_merges_integrity_and_grade_before_feedback(monkeypatch):
    monkeypatch.setattr(eval_graph, "prepare_node", lambda _state: {
        "execution_plan": ["integrity", "grade", "rubric_feedback"],
        "execution_step": 0,
        "feedback_mode": "rubric",
    })
    monkeypatch.setattr(eval_graph, "integrity_node", lambda _state: {
        "integrity_score": 0.91, "plagiarism_flag": False, "plagiarism_matches": []
    })
    monkeypatch.setattr(eval_graph, "grade_node", lambda _state: {
        "topic_coverage": [], "mastery_result": {"total_score": 8}
    })
    monkeypatch.setattr(eval_graph, "feedback_node", lambda state: {
        "feedback_markdown": f"score={state['mastery_result']['total_score']}; integrity={state['integrity_score']}"
    })
    monkeypatch.setattr(eval_graph, "finalize_node", lambda _state: {"final_status": "graded"})
    monkeypatch.setattr(eval_graph, "EVALUATION_GRAPH", eval_graph.build_evaluation_graph())
    monkeypatch.setattr(eval_graph, "_read_daily_token_usage", lambda: None)

    result = eval_graph.run_evaluation_graph({"submission_id": "sub-graph"})
    assert result["feedback_markdown"] == "score=8; integrity=0.91"
    assert result["final_status"] == "graded"


def test_single_chunk_uses_one_grade_call_and_returns_mastery_shape(monkeypatch):
    calls = []

    def ask(model, system, user, **_kwargs):
        calls.append((system, user))
        return {"c": [{"t": "BST Search", "s": 8, "e": ["Correct branch traversal"], "m": []}],
                "b": {"s": 4, "l": "analytical"}}

    monkeypatch.setattr(eval_graph, "_ask_json", ask)
    result = eval_graph.grade_node({
        "submission_id": "sub-1", "raw_text": "answer",
        "rubric": [{"criterion": "BST Search", "max_points": 10}], "max_score": 10,
    })

    assert len(calls) == 1
    assert set(result["mastery_result"]) == {
        "total_score", "max_score", "mastery_level", "topic_scores", "depth_score", "depth_label"
    }
    assert result["mastery_result"]["total_score"] == 8


def test_three_chunks_use_one_grade_call_each_and_one_synthesis(monkeypatch):
    calls = []

    def ask(model, system, user, **_kwargs):
        calls.append(system)
        return {"c": [{"t": "Criterion", "s": 7, "e": ["support"], "m": ["detail"]}],
                "b": {"s": 3, "l": "applied"}}

    monkeypatch.setattr(eval_graph, "_ask_json", ask)
    result = eval_graph.grade_node({
        "submission_id": "sub-3", "raw_text": "unused",
        "submission_chunks": ["one", "two", "three"],
        "rubric": [{"criterion": "Criterion", "max_points": 10}], "max_score": 10,
    })

    assert len(calls) == 4
    assert calls.count(eval_graph._SYNTHESIS_SYSTEM) == 1
    assert result["mastery_result"]["topic_scores"][0]["coverage_score"] == 7


def test_fully_met_submission_skips_feedback_llm(monkeypatch):
    monkeypatch.setattr(
        eval_graph, "_ask_json",
        lambda *_args, **_kwargs: (_ for _ in ()).throw(AssertionError("fully met work must not call Groq for feedback")),
    )
    result = eval_graph.rubric_feedback_node({
        "mastery_result": {"topic_scores": [{"topic": "Criterion", "coverage_score": 10, "score": 10, "max_points": 10, "missing": []}]}
    })
    assert "What You Did Well" in result["feedback_markdown"]


def test_feedback_context_is_limited_to_three_400_char_chunks(monkeypatch):
    class Collection:
        def query(self, **_kwargs):
            return {
                "documents": [["x" * 800 for _ in range(5)]],
                "metadatas": [[{"source": "unit"} for _ in range(5)]],
            }

    monkeypatch.setattr(eval_graph.CHROMA_CLIENT, "get_collection", lambda **_kwargs: Collection())
    monkeypatch.setattr(eval_graph, "_encode_texts", lambda _texts: [[0.1, 0.2]])
    captured = []

    def ask(_model, _system, user, **_kwargs):
        captured.append(user)
        return {"feedback_markdown": "Review the concepts."}

    monkeypatch.setattr(eval_graph, "_ask_json", ask)
    eval_graph.rag_feedback_node({
        "course_id": "course-1",
        "mastery_result": {"topic_scores": [
            {"topic": f"Topic {index}", "coverage_score": 4, "score": 4, "max_points": 10, "missing": ["detail"]}
            for index in range(3)
        ]},
    })
    context = captured[0].split("Course context (max 3 chunks, 400 chars each):\n", 1)[1]
    assert context.count("[Topic ") == 3
    assert context.count("x" * 401) == 0


def test_limiter_reconciles_estimate_with_actual_usage(monkeypatch):
    eval_graph._GROQ_TOKEN_RESERVATIONS.clear()

    class RawResponse:
        headers = {}

        def parse(self):
            return SimpleNamespace(
                usage=SimpleNamespace(prompt_tokens=900, completion_tokens=300, total_tokens=1200),
                choices=[SimpleNamespace(message=SimpleNamespace(content='{"ok":true}'))],
            )

    class Completions:
        class WithRaw:
            @staticmethod
            def create(**kwargs):
                assert kwargs["reasoning_effort"] == "low"
                assert kwargs["response_format"] == {"type": "json_object"}
                return RawResponse()

        with_raw_response = WithRaw()

    monkeypatch.setattr(eval_graph, "_client", lambda: SimpleNamespace(chat=SimpleNamespace(completions=Completions())))
    monkeypatch.setattr(eval_graph, "_record_daily_token_usage", lambda _count: None)
    user = "u" * 8400  # 2,100 estimated prompt tokens + 900 output = 3,000 reserved.
    assert eval_graph._ask_json("model-a", "", user) == {"ok": True}
    reservation = list(eval_graph._GROQ_TOKEN_RESERVATIONS["model-a"])[-1]
    assert reservation.tokens == 1200


def test_daily_budget_gate_defers_at_90_percent_and_allows_50_percent(monkeypatch):
    monkeypatch.setattr(eval_graph.settings, "GROQ_DAILY_TOKEN_BUDGET", 100_000)
    monkeypatch.setattr(eval_graph, "_read_daily_token_usage", lambda: 90_000)
    with pytest.raises(eval_graph.GroqDailyBudgetDeferred):
        eval_graph._check_daily_token_budget()

    monkeypatch.setattr(eval_graph, "_read_daily_token_usage", lambda: 50_000)
    eval_graph._check_daily_token_budget()


def test_invalid_grading_json_retries_once_then_returns_safe_zero(monkeypatch):
    calls = []

    def ask(_model, _system, _user, **_kwargs):
        calls.append(True)
        return {}

    monkeypatch.setattr(eval_graph, "_ask_json", ask)
    result = eval_graph.grade_node({
        "submission_id": "sub-invalid", "raw_text": "answer",
        "rubric": [{"criterion": "Criterion", "max_points": 10}], "max_score": 10,
    })
    assert len(calls) == 2
    assert result["mastery_result"]["total_score"] == 0
    assert result["mastery_result"]["topic_scores"][0]["missing"] == ["Evaluation response could not be parsed"]


def test_rate_headers_record_remaining_tokens_and_reset(monkeypatch):
    eval_graph._GROQ_PROVIDER_LIMITS.pop("model-header", None)
    eval_graph._read_rate_headers({
        "x-ratelimit-remaining-tokens": "1200",
        "x-ratelimit-reset-tokens": "1m2.5s",
    }, "model-header")
    remaining, reset_at = eval_graph._GROQ_PROVIDER_LIMITS["model-header"]
    assert remaining == 1200
    assert reset_at > eval_graph.time.monotonic() + 60


def test_feedback_rate_limit_resumes_from_grade_checkpoint(monkeypatch):
    monkeypatch.setattr(eval_graph.CHROMA_CLIENT, "get_collection", lambda **_kwargs: (_ for _ in ()).throw(ValueError("missing")))
    monkeypatch.setattr(eval_graph, "integrity_node", lambda _state: {
        "integrity_score": 1.0, "plagiarism_flag": False, "plagiarism_matches": []
    })
    calls = {"grade": 0, "feedback": 0}

    def ask(_model, system, _user, **_kwargs):
        if system == eval_graph._GRADE_SYSTEM:
            calls["grade"] += 1
            return {
                "c": [{"t": "Criterion", "s": 5, "e": ["partial evidence"], "m": ["missing detail"]}],
                "b": {"s": 2, "l": "understanding"},
            }
        calls["feedback"] += 1
        if calls["feedback"] == 1:
            raise RuntimeError("429 rate limit")
        return {"feedback_markdown": "Review the missing detail."}

    monkeypatch.setattr(eval_graph, "_ask_json", ask)
    initial = {
        "submission_id": "sub-resume", "assignment_id": "assignment-resume",
        "course_id": "course-resume", "raw_text": "answer",
        "rubric": [{"criterion": "Criterion", "max_points": 10}], "max_score": 10,
    }
    with pytest.raises(RuntimeError, match="429"):
        eval_graph._run_sequential(initial)
    assert calls["grade"] == 1

    result = eval_graph._run_sequential(initial)
    assert calls["grade"] == 1
    assert calls["feedback"] == 2
    assert result["final_status"] == "graded"


def test_compact_rubric_and_reference_digest_are_cached(monkeypatch, memory_checkpoint_redis):
    rubric = [{
        "criterion": "Evidence", "max_points": 5, "description": "d" * 240,
    }]
    compact = context_cache.build_compact_rubric(rubric)
    assert len(compact.split(": ", 1)[1]) == 160

    calls = []

    def ask(model, system, user, **kwargs):
        calls.append((model, kwargs.get("max_completion_tokens")))
        return {"digest": "Core answer key facts."}

    monkeypatch.setattr(eval_graph, "_ask_json", ask)
    reference = "teacher reference answer"
    assert context_cache.warm_reference_digest(reference) == "Core answer key facts."
    assert context_cache.get_reference_digest(reference) == "Core answer key facts."
    assert context_cache.warm_reference_digest(reference) == "Core answer key facts."
    assert len(calls) == 1
    assert calls[0][1] == 400


def test_finalize_emits_one_structured_metrics_record(caplog):
    state = {"submission_id": "sub-metrics", "raw_text": "answer", "plagiarism_flag": False}
    eval_graph._start_evaluation_metrics(state)
    eval_graph._record_evaluation_metrics(
        "sub-metrics",
        llm_calls=2, prompt_tokens=1000, completion_tokens=300, total_tokens=1300,
        seconds_spent_waiting_on_limiter=1.25, chunks=1, checkpoint_hits=1, feedback_mode="rubric",
    )
    with caplog.at_level(logging.INFO, logger="vidyaranya.evaluation"):
        result = eval_graph.finalize_node(state)
    records = [record.message for record in caplog.records if record.message.startswith("EVALUATION_METRICS ")]
    assert len(records) == 1
    metrics = json.loads(records[0].split(" ", 1)[1])
    assert metrics["submission_id"] == "sub-metrics"
    assert metrics["llm_calls"] == 2
    assert metrics["total_tokens"] == 1300
    assert metrics["seconds_spent_waiting_on_limiter"] == 1.25
    assert result["llm_stats"]["feedback_mode"] == "rubric"
    eval_graph._clear_evaluation_metrics("sub-metrics")
