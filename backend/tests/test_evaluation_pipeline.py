from app.services.agents import eval_graph


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


def test_single_chunk_uses_one_grade_call_and_returns_mastery_shape(monkeypatch):
    calls = []

    def ask(model, system, user):
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

    def ask(model, system, user):
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
