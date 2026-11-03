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
