from app.services.agents import eval_graph


def test_mastery_matches_criterion_with_extra_whitespace_and_case(monkeypatch):
    monkeypatch.setattr(
        eval_graph,
        "_ask_json",
        lambda *_args, **_kwargs: {"score": 4, "label": "analytical"},
    )

    result = eval_graph.mastery_node(
        {
            "rubric": [{"criterion": "  BST   SEARCH ", "max_points": 10}],
            "topic_coverage": [
                {
                    "topic": "bst search",
                    "score": 8,
                    "evidence": ["The search follows the correct branch."],
                    "missing": [],
                }
            ],
        }
    )

    topic = result["mastery_result"]["topic_scores"][0]
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

    assert result["execution_plan"] == ["integrity", "coverage", "mastery", "rag_feedback"]


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

    assert result["execution_plan"] == ["integrity", "coverage", "mastery", "rubric_feedback"]
