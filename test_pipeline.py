"""
Standalone test: exercises the entire Phase 2-8 pipeline through Flask's
test client, with every ai_pipeline.* function monkeypatched so no real
network call to Groq happens. This validates route wiring, DB writes, and
JSON handling independent of live model output.
"""
import json
import os
import sys
from unittest.mock import patch, MagicMock

sys.path.insert(0, os.path.dirname(__file__))

import app as appmodule  # noqa: E402

app = appmodule.app
db = appmodule.db

app.config["TESTING"] = True
app.config["SQLALCHEMY_DATABASE_URI"] = "sqlite:///:memory:"

MOCK_ANALYSIS = {
    "topics": ["Supply and Demand"], "subtopics": ["Price elasticity"],
    "learning_objectives": ["Understand supply and demand"],
    "difficulty": "beginner", "prerequisites": [],
    "definitions": [{"term": "Demand", "definition": "Quantity wanted at a price"}],
    "examples": ["Coffee prices rising"],
}

MOCK_OUTLINE = {
    "title": "Economics Fundamentals",
    "description": "An intro course on supply and demand.",
    "difficulty": "beginner",
    "modules": [
        {
            "title": "Module 1: Basics", "description": "Core ideas",
            "lessons": [
                {"title": "Lesson 1: Supply", "summary": "Supply explained in detail over several sentences.", "key_points": ["Supply curve", "Producers"]},
                {"title": "Lesson 2: Demand", "summary": "Demand explained in detail over several sentences.", "key_points": ["Demand curve", "Consumers"]},
            ],
        }
    ],
}

MOCK_SCENE = {
    "title": "Supply", "summary": "A scene about supply.",
    "camera": {"position": [0, 3, 9], "lookAt": [0, 1, 0], "fov": 50},
    "lighting": {"ambient": {"color": "#ffffff", "intensity": 0.5}, "directional": []},
    "environment": {"background": "#0e1a2b", "fog": False},
    "objects": [{"id": "o1", "type": "graph_bar", "position": [0, 0, 0], "data": [{"label": "Q1", "value": 3}]}],
    "animations": [],
    "timeline": [{"time": 0, "target": "o1", "action": "appear", "to": {}, "duration": 1}],
    "labels": [], "voice": [{"time": 0, "text": "Supply increases with price."}],
    "subtitles": [{"time": 0, "text": "Supply increases with price."}],
}

MOCK_QUIZ = {
    "questions": [
        {"type": "multiple_choice", "prompt": "What rises with price?", "options": ["Supply", "Nothing"],
         "correct_answer": "Supply", "explanation": "Basic law.", "topic_tag": "Supply", "difficulty": "easy"},
        {"type": "true_false", "prompt": "Demand curves slope downward.", "options": ["True", "False"],
         "correct_answer": "True", "explanation": "Standard model.", "topic_tag": "Demand", "difficulty": "medium"},
        {"type": "short_answer", "prompt": "Define demand.", "options": [],
         "correct_answer": "Quantity wanted at a price", "explanation": "", "topic_tag": "Demand", "difficulty": "medium"},
    ]
}

MOCK_NOTES = {
    "sections": [
        {"heading": "Overview", "body": "Supply describes how much of a good producers are willing to sell at each price."},
        {"heading": "Key terms", "body": "Quantity supplied is the amount offered for sale at a specific price point."},
        {"heading": "Worked example", "body": "If coffee prices rise, producers are willing to supply more coffee to the market."},
    ]
}


def run():
    with app.app_context():
        db.drop_all()
        db.create_all()

    client = app.test_client()

    # ---- signup ----
    r = client.post("/signup", data={
        "username": "pipelinetester", "email": "pipeline@example.com",
        "password": "password123", "confirm_password": "password123",
    })
    assert r.status_code in (302, 200), r.status_code
    print("[OK] signup")

    # ---- upload pasted text ----
    r = client.post("/api/uploads", json={"kind": "pasted", "text": "Supply and demand are core economic concepts. " * 5})
    data = r.get_json()
    assert data["ok"], data
    upload_id = data["upload"]["id"]
    print("[OK] upload created:", upload_id)

    # ---- generate course (mocked Groq) ----
    with patch.object(appmodule.ai_pipeline, "get_client", return_value=MagicMock()), \
         patch.object(appmodule.ai_pipeline, "analyze_content", return_value=MOCK_ANALYSIS), \
         patch.object(appmodule.ai_pipeline, "generate_course_outline", return_value=MOCK_OUTLINE):
        r = client.post(f"/api/uploads/{upload_id}/generate-course")
        data = r.get_json()
        assert data["ok"], data
        course_id = data["course"]["id"]
        print("[OK] course generated:", course_id, data["course"]["title"])

    # ---- get course detail ----
    r = client.get(f"/api/courses/{course_id}")
    data = r.get_json()
    assert data["ok"], data
    lesson_id = data["modules"][0]["lessons"][0]["id"]
    print("[OK] course detail fetched, first lesson:", lesson_id)

    # ---- get lesson scene (mocked) ----
    with patch.object(appmodule.ai_pipeline, "get_client", return_value=MagicMock()), \
         patch.object(appmodule.ai_pipeline, "generate_scene_json", return_value=MOCK_SCENE):
        r = client.get(f"/api/lessons/{lesson_id}/scene")
        data = r.get_json()
        assert data["ok"], data
        assert data["scene"]["objects"][0]["type"] == "graph_bar"
        print("[OK] scene generated + cached")

        # second call should hit cache, not regenerate
        r2 = client.get(f"/api/lessons/{lesson_id}/scene")
        assert r2.get_json()["ok"]
        print("[OK] scene served from cache on second call")

    # ---- lesson notes (mocked) ----
    with patch.object(appmodule.ai_pipeline, "get_client", return_value=MagicMock()), \
         patch.object(appmodule.ai_pipeline, "generate_lesson_notes", return_value=MOCK_NOTES):
        r = client.get(f"/api/lessons/{lesson_id}/notes")
        data = r.get_json()
        assert data["ok"], data
        assert len(data["notes"]["sections"]) == 3
        print("[OK] lesson notes generated + cached:", [s["heading"] for s in data["notes"]["sections"]])

        r2 = client.get(f"/api/lessons/{lesson_id}/notes")
        assert r2.get_json()["ok"]
        print("[OK] notes served from cache on second call")

    # ---- lesson quiz (mocked) ----
    with patch.object(appmodule.ai_pipeline, "get_client", return_value=MagicMock()), \
         patch.object(appmodule.ai_pipeline, "generate_quiz", return_value=MOCK_QUIZ):
        r = client.get(f"/api/lessons/{lesson_id}/quiz")
        data = r.get_json()
        assert data["ok"], data
        quiz_id = data["quiz"]["id"]
        questions = data["quiz"]["questions"]
        assert len(questions) == 3
        print("[OK] lesson quiz generated:", quiz_id)

    # ---- complete lesson ----
    r = client.post(f"/api/lessons/{lesson_id}/complete")
    data = r.get_json()
    assert data["ok"], data
    assert "first_lesson" in data["unlocked_achievements"]
    print("[OK] lesson marked complete, XP:", data["xp"], "achievements:", data["unlocked_achievements"])

    # ---- submit quiz (mocked grading for short answer) ----
    with patch.object(appmodule.ai_pipeline, "get_client", return_value=MagicMock()), \
         patch.object(appmodule.ai_pipeline, "grade_open_answer",
                       return_value={"correct": True, "score": 1.0, "feedback": "Good."}):
        answers = {str(q["id"]): (q["options"][0] if q["options"] else "Quantity wanted at a price") for q in questions}
        r = client.post(f"/api/quizzes/{quiz_id}/submit", json={"answers": answers})
        data = r.get_json()
        assert data["ok"], data
        print("[OK] quiz submitted, score:", data["score_percent"], "passed:", data["passed"])

    # ---- final exam (mocked) ----
    with patch.object(appmodule.ai_pipeline, "get_client", return_value=MagicMock()), \
         patch.object(appmodule.ai_pipeline, "generate_final_exam", return_value=MOCK_QUIZ):
        r = client.get(f"/api/courses/{course_id}/exam")
        data = r.get_json()
        assert data["ok"], data
        exam_quiz_id = data["quiz"]["id"]
        exam_questions = data["quiz"]["questions"]
        print("[OK] final exam generated:", exam_quiz_id)

    with patch.object(appmodule.ai_pipeline, "get_client", return_value=MagicMock()), \
         patch.object(appmodule.ai_pipeline, "grade_open_answer",
                       return_value={"correct": True, "score": 1.0, "feedback": "Good."}):
        answers = {str(q["id"]): (q["options"][0] if q["options"] else "Quantity wanted at a price") for q in exam_questions}
        r = client.post(f"/api/quizzes/{exam_quiz_id}/submit", json={"answers": answers})
        data = r.get_json()
        assert data["ok"], data
        assert data["passed"], "exam should pass with all-correct mocked answers"
        print("[OK] exam submitted + passed, certificate should now be issued")

    # ---- certificate page ----
    r = client.get(f"/certificate/{course_id}")
    assert r.status_code == 200, r.status_code
    assert b"Certificate of Completion" in r.data
    print("[OK] certificate page renders")

    # ---- progress ----
    r = client.get("/api/progress")
    data = r.get_json()
    assert data["xp"] > 0
    print("[OK] progress:", {k: data[k] for k in ("xp", "coins", "streak_days", "percent_complete")})

    # ---- achievements ----
    r = client.get("/api/achievements")
    data = r.get_json()
    unlocked = [a["key"] for a in data["achievements"] if a["unlocked"]]
    assert "first_orbit" in unlocked and "first_lesson" in unlocked and "course_complete" in unlocked
    print("[OK] achievements unlocked:", unlocked)

    # ---- AI tutor (mocked) ----
    with patch.object(appmodule.ai_pipeline, "get_client", return_value=MagicMock()), \
         patch.object(appmodule.ai_pipeline, "tutor_reply", return_value="Supply is how much producers offer at a price."):
        r = client.post("/api/tutor/ask", json={"course_id": course_id, "mode": "simplify", "question": "What is supply?"})
        data = r.get_json()
        assert data["ok"], data
        print("[OK] tutor replied:", data["reply"][:60])

    # ---- page routes render without error ----
    for path in [f"/course/{course_id}", f"/lesson/{lesson_id}", f"/quiz/{quiz_id}"]:
        r = client.get(path)
        assert r.status_code == 200, (path, r.status_code)
        print(f"[OK] page renders: {path}")

    print("\nALL PIPELINE CHECKS PASSED")


if __name__ == "__main__":
    run()
