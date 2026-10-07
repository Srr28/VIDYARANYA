import json
import re

from groq import Groq

from app.core.config import settings

try:
    GROQ_CLIENT = Groq(api_key=settings.GROQ_API_KEY)
except Exception:
    GROQ_CLIENT = None


def _extract_json_block(text: str) -> str:
    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if match:
        return match.group(0)
    return text


def grade(submission_text: str, rubric: list) -> dict:
    if GROQ_CLIENT is None:
        max_score = sum(int(item.get("max_points", 0)) for item in rubric if isinstance(item, dict))
        return {
            "total_score": 0,
            "max_score": max_score,
            "breakdown": [],
            "general_feedback": "AI grading is temporarily unavailable due to model client configuration.",
        }

    rubric_json = json.dumps(rubric)
    prompt = (
        "You are a strict academic grader.\n"
        "Your task is to grade the student's submission based STRICTLY on the provided rubric.\n"
        "You must return a valid JSON object. Do not include markdown formatting (like ```json).\n\n"
        f"Rubric: {rubric_json}\n\n"
        "Student Submission:\n"
        f"{submission_text}\n\n"
        "Required JSON Format:\n"
        "{\n"
        '  "total_score": <integer>,\n'
        '  "max_score": <integer>,\n'
        '  "breakdown": [\n'
        "    {\n"
        '      "criterion": "<name>",\n'
        '      "score": <integer>,\n'
        '      "max_points": <integer>,\n'
        '      "feedback": "<specific comment>"\n'
        "    }\n"
        "  ],\n"
        '  "general_feedback": "<summary of performance>"\n'
        "}"
    )

    completion = GROQ_CLIENT.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "system", "content": prompt}],
    )

    content = completion.choices[0].message.content.strip()
    try:
        return json.loads(content)
    except json.JSONDecodeError:
        return json.loads(_extract_json_block(content))
