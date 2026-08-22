"""
Orbit — Phases 3, 4, 7: the Groq pipeline.

Every function here takes a Groq client plus plain text and returns parsed
JSON matching a fixed schema the rest of the app relies on. Groq is only
ever asked for structured JSON — never for video, audio (besides the
whisper transcription in extraction.py), or free-form prose meant for
direct display, except tutor replies which are already meant to be read
as a chat message.
"""

import json
import math
import os
import re
import time

from groq import Groq

# llama-3.3-70b-versatile and llama-3.1-8b-instant were deprecated by Groq
# on 2026-06-17. openai/gpt-oss-120b / openai/gpt-oss-20b are Groq's own
# recommended replacements — same JSON-mode + function-calling support,
# faster inference. If Groq deprecates these too, check
# https://console.groq.com/docs/deprecations for the current mapping.
TEXT_MODEL = "openai/gpt-oss-120b"
FAST_MODEL = "openai/gpt-oss-20b"

# Bumped whenever the scene JSON schema changes in a way that meaningfully
# changes rendering (new object types, new actions, environment.theme,
# shots[]) — see _validate_scene / app.py's cache check. Old cached scenes
# with a lower/missing version get regenerated instead of served stale.
SCENE_GENERATOR_VERSION = "3.0"

# Groq's free/on-demand tier caps requests at ~12,000 tokens PER MINUTE per
# model — that's input + requested output combined, shared across every
# call in that window. These budgets are sized to comfortably fit a single
# call under that ceiling (roughly 4 characters per token as a rule of thumb).
MAX_SOURCE_CHARS = 6000
MAX_ANALYSIS_SOURCE_CHARS = 5000
MAX_SCENE_SOURCE_CHARS = 2500
MAX_QUIZ_SOURCE_CHARS = 3000
MAX_NOTES_SOURCE_CHARS = 4500


def get_client() -> Groq:
    api_key = os.environ.get("GROQ_API_KEY")
    if not api_key:
        raise RuntimeError("GROQ_API_KEY is not set.")
    return Groq(api_key=api_key)


def _truncate(text: str, limit: int = MAX_SOURCE_CHARS) -> str:
    if len(text) <= limit:
        return text
    return text[:limit] + "\n\n[...truncated for length...]"


def _extract_json(raw: str) -> dict:
    """Groq sometimes wraps JSON in prose or code fences despite instructions."""
    raw = raw.strip()
    fence = re.search(r"```(?:json)?\s*([\s\S]*?)```", raw)
    if fence:
        raw = fence.group(1).strip()
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        start = raw.find("{")
        end = raw.rfind("}")
        if start != -1 and end != -1 and end > start:
            return json.loads(raw[start:end + 1])
        raise


class RateLimitedError(RuntimeError):
    """Raised when Groq's tokens-per-minute limit is hit, even after retrying."""


def _is_rate_limit_error(exc: Exception) -> bool:
    text = str(exc).lower()
    return "rate_limit" in text or "429" in text or ("413" in text and "token" in text)


def _chat_json(client: Groq, system: str, user: str, model: str = TEXT_MODEL, max_tokens: int = 1500) -> dict:
    last_exc = None
    for attempt in range(3):
        try:
            response = client.chat.completions.create(
                model=model,
                messages=[
                    {"role": "system", "content": system},
                    {"role": "user", "content": user},
                ],
                temperature=0.4,
                max_tokens=max_tokens,
                response_format={"type": "json_object"},
            )
            return _extract_json(response.choices[0].message.content)
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            if _is_rate_limit_error(exc) and attempt < 2:
                time.sleep(20 * (attempt + 1))  # Groq's window resets every 60s
                continue
            raise
    raise last_exc


# ----------------------------------------------------------------------------
# Phase 3, step 1 — content analysis
# ----------------------------------------------------------------------------

ANALYSIS_SYSTEM = """You are a curriculum analyst. Read the study material the \
user provides and extract its teaching structure. Respond ONLY with a JSON \
object — no prose, no markdown fences — matching exactly this shape:

{
  "topics": ["..."],
  "subtopics": ["..."],
  "learning_objectives": ["..."],
  "difficulty": "beginner" | "intermediate" | "advanced",
  "prerequisites": ["..."],
  "definitions": [{"term": "...", "definition": "..."}],
  "examples": ["..."]
}

Keep each list to the most important 4-10 items. Base everything strictly on \
the provided material — do not invent topics that aren't in it."""


def analyze_content(client: Groq, text: str) -> dict:
    return _chat_json(client, ANALYSIS_SYSTEM, _truncate(text, MAX_ANALYSIS_SOURCE_CHARS), max_tokens=1200)


# ----------------------------------------------------------------------------
# Phase 3, step 2 — course / module / lesson outline
# ----------------------------------------------------------------------------

COURSE_SYSTEM = """You are a course designer. Using the study material and its \
analysis, design a complete course outline. Respond ONLY with a JSON object \
matching exactly this shape:

{
  "title": "...",
  "description": "...",
  "difficulty": "beginner" | "intermediate" | "advanced",
  "modules": [
    {
      "title": "...",
      "description": "...",
      "lessons": [
        {"title": "...", "summary": "...", "key_points": ["...", "..."]}
      ]
    }
  ]
}

Rules:
- Produce 2-5 modules.
- Produce 2-4 lessons per module.
- Every lesson's "summary" must be 2-4 sentences that fully describe what it \
teaches, since this text is the only thing used to generate that lesson's \
animation and quiz later — it must stand alone.
- "key_points" is 3-6 short bullet phrases capturing the lesson's core ideas.
- Base all of this strictly on the provided material."""


def generate_course_outline(client: Groq, text: str, analysis: dict) -> dict:
    user = (
        f"ANALYSIS:\n{json.dumps(analysis, ensure_ascii=False)}\n\n"
        f"SOURCE MATERIAL:\n{_truncate(text, MAX_SOURCE_CHARS)}"
    )
    return _chat_json(client, COURSE_SYSTEM, user, max_tokens=2500)


# ----------------------------------------------------------------------------
# Phase 4 — structured 3D scene JSON per lesson
# ----------------------------------------------------------------------------

SCENE_BEAT_SYSTEM = """You are a visual director for a cinematic science/engineering \
documentary — NOT a generic 3D modeler. You are writing ONE SEGMENT of a \
longer lesson video. You NEVER generate video or images — you only write a \
structured JSON scene description that a Three.js engine will render, light, \
and animate. Respond ONLY with a JSON object matching EXACTLY this shape:

{
  "environment": {"theme": "chemistry|biology|physics|astronomy|engineering|mathematics|business|generic", "background": "#0e1a2b", "fog": false},
  "camera": {"position": [x,y,z], "lookAt": [x,y,z], "fov": 50},
  "lighting": {
    "ambient": {"color": "#ffffff", "intensity": 0.5},
    "directional": [{"color": "#ffffff", "intensity": 0.8, "position": [5,8,5]}]
  },
  "objects": [
    {
      "id": "obj1",
      "type": "box|sphere|cylinder|cone|torus|plane|arrow|line|text|graph_bar|graph_line|pie_chart|character|building|tree|terrain|robot|car|book|table|chair|icon|process_flow|molecule|beam|force_vector|cross_section|formula",
      "position": [x,y,z],
      "rotation": [x,y,z],
      "scale": [x,y,z],
      "color": "#hexcolor",
      "label": "optional short label shown above the object",
      "text": "only for type=text: the text to display",
      "data": [{"label": "...", "value": 0}]
    }
  ],
  "shots": [
    {"id": "establish", "start": 0.0, "duration": 3.5, "camera": {"action": "wideShot|pushIn|pullBack|orbit|closeUp|macro|overhead|lowAngle|focus", "focus": "obj1", "angle": 110}}
  ],
  "timeline": [
    {
      "time": 0.0,
      "target": "obj1",
      "action": "appear|move|rotate|scale|orbit|bounce|fadeIn|fadeOut|disappear|highlight|colorChange|cameraZoom|cameraRotate|cameraPan|graphGrowth|arrowFlow|flow|bondForm|bondBreak|revealCrossSection|highlightTerm|deform",
      "to": {"position": [x,y,z], "rotation": [x,y,z], "scale": [x,y,z], "color": "#hex", "target": [x,y,z], "bond": {"from": "atomId", "to": "atomId"}, "section": "crossSectionObjId", "term": "F", "mode": "bend", "amount": 6},
      "duration": 1.5
    }
  ],
  "voice": [{"time": 0.0, "text": "One sentence of narration spoken at this timestamp."}]
}

============================================================
STEP 1 — CLASSIFY THE CONCEPT BEFORE CHOOSING OBJECTS
============================================================
Before picking any object type, decide what physical/visual system actually \
represents THIS segment's idea. Pick the "environment.theme" (and let it \
guide your object choices) from: chemistry, biology, physics, astronomy, \
engineering, mathematics, business, generic. Examples: "normal stress" -> \
engineering; "water molecule" -> chemistry; "photosynthesis" -> biology; \
"supply and demand" -> business; "derivative" -> mathematics; "Newton's \
second law" -> physics. Do not default everything to chemistry or to plain \
boxes — the whole point of this step is that different lessons should look \
visually different.

============================================================
STEP 2 — SPECIALIZED OBJECT TYPES (use these over generic shapes)
============================================================

"process_flow" — stages connected by movement: water cycle, blood \
circulation, a supply chain, an electrical circuit, digestion, an ecosystem \
food web, buyers/sellers. Shape:
{
  "id": "flow1", "type": "process_flow", "position": [0,0,0],
  "cycle": true,
  "stages": [
    {"id": "ocean", "label": "Ocean", "position": [-3,0,2], "color": "#5FA08C"},
    {"id": "cloud", "label": "Cloud", "position": [-1,3,0], "color": "#B9C0CC"}
  ],
  "paths": [{"from": "ocean", "to": "cloud"}, {"from": "cloud", "to": "ocean"}]
}
Set "cycle": true only if the stages form a loop. To animate particles \
flowing along the paths, use the "flow" action targeting the process_flow's \
own id.

"molecule" — atoms and bonds for any chemistry. Shape:
{
  "id": "mol1", "type": "molecule", "position": [0,1,0],
  "atomStyle": "cinematic",
  "atoms": [
    {"id": "h1", "element": "H", "position": [-0.4,0,0]},
    {"id": "o1", "element": "O", "position": [0.4,0,0]}
  ],
  "bonds": [{"from": "h1", "to": "o1"}]
}
Use real element symbols. "atomStyle" may be "cinematic" (default, premium \
scientific look) or "electron" (adds visible electron-shell rings — use for \
lessons specifically about electron structure/bonding). To show a bond \
forming/breaking, use "bondForm"/"bondBreak" with "to": {"bond": {"from": \
"...", "to": "..."}}.

"beam" — ANY structural/mechanical member under load: a rod, column, plate, \
shaft, bridge span, bracket. This is the primary object for engineering/ \
structural lessons — prefer it over a plain cylinder/box whenever the \
lesson is actually about a physical structure carrying load. Shape:
{
  "id": "specimen", "type": "beam", "position": [0,1.5,0],
  "shape": "round", "material": "metal",
  "dimensions": {"length": 3.2, "radius": 0.32},
  "supports": false, "color": "#B9C0CC", "label": "Steel specimen"
}
"shape" is "round" or "rect" (use "dimensions": {"length","width","height"} \
for rect). "material" is any MaterialLibrary preset (metal, ceramic, rubber, \
glass, organic...). Set "supports": true only if the member visibly rests \
on fixed supports (like a bridge or simply-supported beam).

"force_vector" — a labeled, magnitude-scaled force or moment arrow. Use \
this instead of the generic "arrow" type whenever you are showing an actual \
applied force, load, moment, or reaction — it always looks like a real \
scientific-diagram vector, not a plain flow arrow. Shape:
{
  "id": "forceF", "type": "force_vector", "position": [-1.8,1.5,0],
  "direction": [1,0,0], "magnitude": 1.4, "color": "#C1633B",
  "label": "F = 40 kN"
}
"direction" is a unit-ish vector; "magnitude" (0.3-3 range) scales the \
arrow's visible length. Always give it a "label" with the actual value from \
the lesson content when known.

"cross_section" — a cut-plane revealing internal stress/strain/flow across \
an area. This is the actual payload for structural/stress lessons — use it \
whenever the lesson explains an internal effect (stress, strain, internal \
pressure, internal flow) rather than coloring the whole object red. It is \
hidden by default and revealed mid-scene with the "revealCrossSection" \
action (see below). Shape:
{
  "id": "sectionA", "type": "cross_section", "position": [0,1.5,0],
  "rotation": [0,0,90], "shape": "circle", "size": 1.1,
  "stressPattern": "uniform", "intensity": 1, "color": "#8fd0ff"
}
"stressPattern" is "uniform" (normal/axial stress — evenly distributed), \
"bending" (compression one side, tension the other), "shear" or "torsion" \
(tangential arrows around the section). "shape" is "circle" or "rect". \
Position the cross_section at the same point along the beam where the cut \
happens, and orient "rotation" so its face is perpendicular to the beam's \
long axis.

"formula" — a premium equation panel, used instead of a floating text \
label whenever the lesson introduces a real equation (σ = F/A, F = ma, \
etc). Shape:
{
  "id": "eq1", "type": "formula", "position": [0,3.2,0],
  "expression": "σ = F / A", "color": "#C9A24C"
}
Tokens are split on whitespace, so write the expression with spaces between \
symbols/operators ("σ = F / A", not "σ=F/A") — each token becomes its own \
highlightable chip. To highlight a specific term while narrating it (e.g. \
"as the force increases..."), use the "highlightTerm" action with "to": \
{"term": "F"} where "term" exactly matches one whitespace-separated token \
from "expression".

============================================================
STEP 3 — REVEALING INTERNAL STRUCTURE
============================================================
When a lesson needs to show an internal effect (stress across a section, \
flow inside a pipe, structure inside a cell), build the outer object AND a \
hidden "cross_section" (or similarly-scoped) object, then use the \
"revealCrossSection" action targeting the outer object with "to": \
{"section": "<the hidden object's id>"} — this makes the outer object \
translucent and reveals the section together, which reads as a real \
cutaway instead of a color change.

============================================================
STEP 4 — SHOTS: DIRECT THE CAMERA, DON'T JUST PLACE OBJECTS
============================================================
Write 3-6 "shots" for this segment (a full lesson typically ends up with \
5-12 shots once all segments are merged) — each is a deliberate camera \
move with a purpose, not a random position. Use "focus": "<objectId>" so \
the camera actually aims at the thing that matters right now rather than a \
fixed point. A typical segment shot sequence: wideShot/establish to show \
the whole system, then pushIn/closeUp toward whatever this segment is \
actually explaining, then orbit or overhead if there's internal structure \
to show around, then pullBack to close the segment. "start" times are \
relative to this segment (segment starts at 0) and should roughly line up \
with when the narration/timeline is talking about that thing.

============================================================
GENERAL RULES FOR THIS SEGMENT
============================================================
- Coordinates are in a room roughly 10 units wide; keep everything between -6 and 6 on x/z and 0 and 6 on y. A process_flow's own stage positions are relative to its own "position" origin and can span wider, roughly -4 to 4.
- Use 3-6 top-level objects (a process_flow, molecule, or beam+force_vectors+cross_section combo counts as the segment's main subject and is usually enough on its own).
- VARY the object types on purpose and match them to the classification from Step 1. Box/sphere/cylinder are a last resort, not a default — for engineering/structural content use beam + force_vector + cross_section + formula; for chemistry use molecule; for cyclical/staged processes use process_flow; for data/comparisons use graph_bar/graph_line/pie_chart; for people/real-world scenes use character/building/tree/car/robot.
- Every object should do something beyond just appearing — after it enters, give it at least one more beat later in the segment (move/highlight/rotate/colorChange/graphGrowth/bounce/orbit/flow/bondForm/bondBreak/revealCrossSection/highlightTerm/deform as fits its type). A scene where objects just sit there motionless after appearing is a failure.
- "voice" MUST run continuously for this whole segment with no dead air — write 6-10 short sentences (never fewer than 6), each naturally spoken in 3-6 seconds, with "time" values spaced back-to-back so there is no gap longer than 1 second between when one line finishes and the next starts. Start voice at time 0.
- Only use the listed object "type" and "action" values.
- Cover ONLY the specific focus given for this segment — do not try to cover the whole lesson, later segments handle the rest. Base everything strictly on the material provided."""


def _scene_local_duration(scene: dict) -> float:
    timeline_end = max(
        [_safe_float(e.get("time"), 0.0) + _safe_float(e.get("duration"), 1.0) for e in scene.get("timeline", [])],
        default=0,
    )
    voice_end = max(
        [_safe_float(v.get("time"), 0.0) + _estimate_speech_seconds(v.get("text", "")) for v in scene.get("voice", [])],
        default=0,
    )
    return max(timeline_end, voice_end, 3) + 1.0


def _generate_scene_beat(client: Groq, lesson_title: str, beat_title: str, beat_focus: str, content: str) -> dict:
    user = (
        f"LESSON: {lesson_title}\n"
        f"THIS SEGMENT'S TITLE: {beat_title}\n"
        f"THIS SEGMENT MUST COVER: {beat_focus}\n\n"
        f"LESSON MATERIAL TO DRAW FROM:\n{_truncate(content, MAX_SCENE_SOURCE_CHARS)}"
    )
    beat = _chat_json(client, SCENE_BEAT_SYSTEM, user, max_tokens=2600)
    return _validate_scene_beat(beat)


def _build_beat_plan(key_points: list) -> list:
    """Longer/richer lessons get more beats (more chapters, longer video);
    thin lessons don't get padded out with filler just to look long."""
    points = [p.strip() for p in (key_points or []) if p and p.strip()]

    plan = [("Introduction", "What this concept is, why it matters, and its key terms defined clearly.")]

    if points:
        n_middle = 1 if len(points) <= 2 else (2 if len(points) <= 4 else 3)
        chunk_size = max(1, math.ceil(len(points) / n_middle))
        chunks = [points[i:i + chunk_size] for i in range(0, len(points), chunk_size)][:n_middle]
        for chunk in chunks:
            title = chunk[0] if len(chunk[0]) <= 42 else chunk[0][:39] + "..."
            focus = "Explain in detail, step by step: " + "; ".join(chunk)
            plan.append((title, focus))
    else:
        plan.append(("How it works", "Walk through the mechanism or process step by step, in the order it actually happens."))

    plan.append(("Example & recap", "A concrete worked example applying the concept, then a short recap of the main takeaway."))
    return plan


def generate_scene_json(client: Groq, lesson_title: str, lesson_summary: str, key_points, source_excerpt: str) -> dict:
    content = f"{lesson_summary}\n\nKey points: " + "; ".join(key_points or []) + f"\n\n{source_excerpt}"
    fallback_text = f"{lesson_summary} " + ". ".join(key_points or [])

    beat_plan = _build_beat_plan(key_points)
    beats = []
    for beat_title, beat_focus in beat_plan:
        try:
            beats.append(_generate_scene_beat(client, lesson_title, beat_title, beat_focus, content))
        except Exception:  # noqa: BLE001 — one weak segment shouldn't sink the whole lesson
            beats.append(_validate_scene_beat({}))

    beat_titles = [t for t, _ in beat_plan]
    return _merge_beats(lesson_title, beats, fallback_text, beat_titles)


# ----------------------------------------------------------------------------
# Renderer benchmark — hand-authored demo scenes, NOT a lesson-generation
# path. These exist purely so the Three.js/engine.js side can be visually
# verified (shots, beam/force_vector/cross_section/formula, revealCrossSection,
# highlightTerm) without spending a Groq call or depending on the model
# producing good output. Do NOT wire these into real lesson generation —
# generate_scene_json() above is the only thing that should ever populate
# lesson.scene_json.
# ----------------------------------------------------------------------------

def _demo_beat_normal_stress() -> dict:
    """Primary renderer benchmark (see spec: 10-shot cinematic sequence —
    lab establish -> grips enter -> loading -> deformation -> cutaway ->
    internal stress reveal -> force/area callout -> formula -> interactive
    F/A change -> pull-back summary)."""
    return {
        "environment": {"theme": "engineering", "background": "#0d0d10", "fog": False},
        "camera": {"position": [0, 2.6, 10], "lookAt": [0, 1.8, 0], "fov": 42},
        "objects": [
            {"id": "specimen", "type": "beam", "position": [0, 1.8, 0], "shape": "round",
             "material": "metal", "dimensions": {"length": 3.4, "radius": 0.34},
             "supports": False, "color": "#B9C0CC", "label": "Steel specimen"},
            {"id": "gripLeft", "type": "box", "position": [-2.0, 1.8, 0], "scale": [0.7, 0.9, 0.9],
             "material": "metal", "color": "#5a5f66", "label": "Hydraulic grip"},
            {"id": "gripRight", "type": "box", "position": [2.0, 1.8, 0], "scale": [0.7, 0.9, 0.9],
             "material": "metal", "color": "#5a5f66", "label": "Hydraulic grip"},
            {"id": "forceLeft", "type": "force_vector", "position": [-2.7, 1.8, 0],
             "direction": [1, 0, 0], "magnitude": 1.6, "color": "#C1633B", "label": "F = 40 kN"},
            {"id": "forceRight", "type": "force_vector", "position": [2.7, 1.8, 0],
             "direction": [-1, 0, 0], "magnitude": 1.6, "color": "#C1633B", "label": "F = 40 kN"},
            {"id": "sectionA", "type": "cross_section", "position": [0, 1.8, 0], "rotation": [0, 0, 90],
             "shape": "circle", "size": 1.0, "stressPattern": "uniform", "intensity": 1, "color": "#8fd0ff"},
            {"id": "eqSigma", "type": "formula", "position": [0, 4.2, 0], "expression": "σ = F / A", "color": "#C9A24C"},
        ],
        "shots": [
            {"id": "establish", "start": 0.0, "duration": 2.5, "camera": {"action": "wideShot", "focus": "specimen"}},
            {"id": "gripsEnter", "start": 2.5, "duration": 2.0, "camera": {"action": "dollyIn", "focus": "specimen"}},
            {"id": "loading", "start": 4.5, "duration": 2.5, "camera": {"action": "pushIn", "focus": "specimen"}},
            {"id": "deform", "start": 7.0, "duration": 2.0, "camera": {"action": "closeUp", "focus": "specimen"}},
            {"id": "cutawayIn", "start": 9.0, "duration": 1.8, "camera": {"action": "rackFocus", "focus": "sectionA"}},
            {"id": "internal", "start": 10.8, "duration": 3.0, "camera": {"action": "orbit", "focus": "sectionA", "angle": 70}},
            {"id": "forceArea", "start": 13.8, "duration": 2.2, "camera": {"action": "track", "focus": "sectionA"}},
            {"id": "formula", "start": 16.0, "duration": 2.8, "camera": {"action": "closeUp", "focus": "eqSigma"}},
            {"id": "interactive", "start": 18.8, "duration": 2.6, "camera": {"action": "focus", "focus": "sectionA"}},
            {"id": "summary", "start": 21.4, "duration": 3.0, "camera": {"action": "pullBack", "focus": "specimen"}},
        ],
        "timeline": [
            {"time": 0.0, "target": "specimen", "action": "appear", "to": {}, "duration": 1.0},
            {"time": 2.5, "target": "gripLeft", "action": "appear", "to": {}, "duration": 0.6},
            {"time": 2.5, "target": "gripRight", "action": "appear", "to": {}, "duration": 0.6},
            {"time": 4.5, "target": "forceLeft", "action": "appear", "to": {}, "duration": 0.8},
            {"time": 4.5, "target": "forceRight", "action": "appear", "to": {}, "duration": 0.8},
            {"time": 6.0, "target": "forceLeft", "action": "highlight", "to": {}, "duration": 1.0},
            {"time": 6.0, "target": "forceRight", "action": "highlight", "to": {}, "duration": 1.0},
            {"time": 7.0, "target": "specimen", "action": "deform", "to": {"mode": "stretch", "amount": 2}, "duration": 1.6},
            {"time": 9.0, "target": "specimen", "action": "revealCrossSection", "to": {"section": "sectionA"}, "duration": 1.6},
            {"time": 13.8, "target": "sectionA", "action": "highlight", "to": {}, "duration": 1.2},
            {"time": 14.2, "target": "forceLeft", "action": "highlight", "to": {}, "duration": 1.0},
            {"time": 16.0, "target": "eqSigma", "action": "appear", "to": {}, "duration": 1.0},
            {"time": 17.0, "target": "eqSigma", "action": "highlightTerm", "to": {"term": "F"}, "duration": 1.0},
            {"time": 18.0, "target": "eqSigma", "action": "highlightTerm", "to": {"term": "A"}, "duration": 1.0},
            {"time": 18.8, "target": "forceLeft", "action": "colorChange", "to": {"color": "#ff8a5c"}, "duration": 1.0},
            {"time": 18.8, "target": "forceRight", "action": "colorChange", "to": {"color": "#ff8a5c"}, "duration": 1.0},
            {"time": 19.0, "target": "sectionA", "action": "colorChange", "to": {"color": "#ff5c5c"}, "duration": 1.2},
            {"time": 21.0, "target": "sectionA", "action": "colorChange", "to": {"color": "#8fd0ff"}, "duration": 1.0},
            {"time": 21.0, "target": "forceLeft", "action": "colorChange", "to": {"color": "#C1633B"}, "duration": 1.0},
            {"time": 21.0, "target": "forceRight", "action": "colorChange", "to": {"color": "#C1633B"}, "duration": 1.0},
        ],
        "voice": [
            {"time": 0.0, "text": "In the testing lab, a steel specimen waits to be pulled apart."},
            {"time": 2.5, "text": "Hydraulic grips close around each end, ready to apply a controlled load."},
            {"time": 4.5, "text": "Equal and opposite forces pull outward from both ends, stretching it along its length."},
            {"time": 7.0, "text": "Watch closely — the specimen elongates slightly under that load."},
            {"time": 9.0, "text": "Let's look inside. Cutting through the specimen reveals its internal cross-section."},
            {"time": 11.0, "text": "Every fiber across that area shares the load equally, resisting being pulled apart."},
            {"time": 13.8, "text": "That relationship — force in, area resisting it — is the whole story of normal stress."},
            {"time": 16.0, "text": "We describe it with one clean equation: sigma equals F over A."},
            {"time": 17.0, "text": "F is the applied force pulling on the specimen."},
            {"time": 18.0, "text": "A is the cross-sectional area carrying that force."},
            {"time": 18.8, "text": "Increase the force, or shrink the area, and that internal stress climbs right away."},
            {"time": 21.4, "text": "That's normal stress: force divided by area, acting straight through the material."},
        ],
    }


def _demo_beat_shear_stress() -> dict:
    return {
        "environment": {"theme": "engineering", "background": "#111214", "fog": False},
        "camera": {"position": [0, 3, 9], "lookAt": [0, 1.8, 0], "fov": 45},
        "objects": [
            {"id": "plateStack", "type": "beam", "position": [0, 1.8, 0], "shape": "rect",
             "material": "metal", "dimensions": {"length": 2.6, "width": 1.0, "height": 0.5},
             "supports": False, "color": "#B9C0CC", "label": "Bolted plates"},
            {"id": "forceUp", "type": "force_vector", "position": [0, 2.7, 0.9],
             "direction": [0, 1, 0], "magnitude": 1.3, "color": "#C1633B", "label": "V = 18 kN"},
            {"id": "forceDown", "type": "force_vector", "position": [0, 0.9, -0.9],
             "direction": [0, -1, 0], "magnitude": 1.3, "color": "#C1633B", "label": "V = 18 kN"},
            {"id": "sectionS", "type": "cross_section", "position": [0, 1.8, 0], "rotation": [90, 0, 0],
             "shape": "rect", "size": 1.0, "stressPattern": "shear", "intensity": 1, "color": "#8fd0ff"},
            {"id": "eqTau", "type": "formula", "position": [0, 4.2, 0], "expression": "τ = V / A", "color": "#C9A24C"},
        ],
        "shots": [
            {"id": "establish", "start": 0.0, "duration": 3.0, "camera": {"action": "wideShot", "focus": "plateStack"}},
            {"id": "loading", "start": 3.0, "duration": 2.5, "camera": {"action": "pushIn", "focus": "plateStack"}},
            {"id": "shearPlane", "start": 5.5, "duration": 3.0, "camera": {"action": "orbit", "focus": "sectionS", "angle": 80}},
            {"id": "formula", "start": 8.5, "duration": 2.5, "camera": {"action": "closeUp", "focus": "eqTau"}},
            {"id": "summary", "start": 11.0, "duration": 3.0, "camera": {"action": "pullBack", "focus": "plateStack"}},
        ],
        "timeline": [
            {"time": 0.0, "target": "plateStack", "action": "appear", "to": {}, "duration": 1.0},
            {"time": 0.3, "target": "forceUp", "action": "appear", "to": {}, "duration": 0.8},
            {"time": 0.3, "target": "forceDown", "action": "appear", "to": {}, "duration": 0.8},
            {"time": 2.0, "target": "forceUp", "action": "highlight", "to": {}, "duration": 1.0},
            {"time": 2.0, "target": "forceDown", "action": "highlight", "to": {}, "duration": 1.0},
            {"time": 4.0, "target": "plateStack", "action": "revealCrossSection", "to": {"section": "sectionS"}, "duration": 1.6},
            {"time": 7.5, "target": "eqTau", "action": "appear", "to": {}, "duration": 1.0},
            {"time": 8.5, "target": "eqTau", "action": "highlightTerm", "to": {"term": "V"}, "duration": 1.0},
            {"time": 10.0, "target": "eqTau", "action": "highlightTerm", "to": {"term": "A"}, "duration": 1.0},
            {"time": 11.5, "target": "sectionS", "action": "highlight", "to": {}, "duration": 1.2},
        ],
        "voice": [
            {"time": 0.0, "text": "Two plates are bolted together, and a force is applied to slide one past the other."},
            {"time": 2.0, "text": "These opposing forces don't stretch the plates — they try to slide them sideways."},
            {"time": 4.0, "text": "Cutting through the bolt itself reveals the plane where that sliding actually happens."},
            {"time": 6.0, "text": "The internal force here acts tangent to the surface, not straight through it."},
            {"time": 7.5, "text": "This is shear stress: tau equals V over A."},
            {"time": 8.5, "text": "V is the shearing force acting across that plane."},
            {"time": 10.0, "text": "A is the area of that plane resisting the slide."},
            {"time": 11.5, "text": "Unlike normal stress, shear stress runs tangentially, right across the cut."},
        ],
    }


def _demo_beat_water_molecule() -> dict:
    return {
        "environment": {"theme": "chemistry", "background": "#050912", "fog": True},
        "camera": {"position": [0, 2, 6], "lookAt": [0, 1.2, 0], "fov": 45},
        "objects": [
            {"id": "mol1", "type": "molecule", "position": [0, 1.2, 0], "atomStyle": "electron",
             "atoms": [
                 {"id": "o1", "element": "O", "position": [0, 0, 0]},
                 {"id": "h1", "element": "H", "position": [-0.7, -0.5, 0]},
                 {"id": "h2", "element": "H", "position": [0.7, -0.5, 0]},
             ],
             "bonds": [{"from": "o1", "to": "h1"}, {"from": "o1", "to": "h2"}]},
            {"id": "eqPolar", "type": "formula", "position": [0, 3.4, 0], "expression": "H2O", "color": "#6fa9ff"},
        ],
        "shots": [
            {"id": "establish", "start": 0.0, "duration": 3.0, "camera": {"action": "wideShot", "focus": "mol1"}},
            {"id": "pushIn", "start": 3.0, "duration": 3.0, "camera": {"action": "pushIn", "focus": "mol1"}},
            {"id": "orbit", "start": 6.0, "duration": 4.0, "camera": {"action": "orbit", "focus": "mol1", "angle": 140}},
            {"id": "macro", "start": 10.0, "duration": 2.5, "camera": {"action": "macro", "focus": "mol1"}},
            {"id": "pullBack", "start": 12.5, "duration": 2.5, "camera": {"action": "pullBack", "focus": "mol1"}},
        ],
        "timeline": [
            {"time": 0.0, "target": "mol1", "action": "appear", "to": {}, "duration": 1.2},
            {"time": 3.0, "target": "eqPolar", "action": "appear", "to": {}, "duration": 1.0},
            {"time": 5.0, "target": "mol1", "action": "orbit", "to": {}, "duration": 5.0},
            {"time": 10.0, "target": "mol1", "action": "highlight", "to": {}, "duration": 1.5},
        ],
        "voice": [
            {"time": 0.0, "text": "One oxygen atom, two hydrogen atoms — a single water molecule."},
            {"time": 2.5, "text": "The oxygen pulls electrons more strongly, giving it a slight negative charge."},
            {"time": 5.0, "text": "Each hydrogen ends up slightly positive, and the bent shape makes the whole molecule polar."},
            {"time": 8.5, "text": "That polarity is why water molecules stick to each other so readily."},
            {"time": 11.5, "text": "It's this one small asymmetry that gives water almost all of its unusual properties."},
        ],
    }


_DEMO_SCENE_BUILDERS = {
    "normal_stress": ("Normal Stress — Renderer Demo", _demo_beat_normal_stress),
    "shear_stress": ("Shear Stress — Renderer Demo", _demo_beat_shear_stress),
    "water_molecule": ("Water Molecule — Renderer Demo", _demo_beat_water_molecule),
}


def generate_demo_scene(topic: str) -> dict:
    """Renderer benchmark only — see module docstring above this function.
    Raises KeyError for an unknown topic; callers should list
    _DEMO_SCENE_BUILDERS.keys() to a developer rather than guess."""
    if topic not in _DEMO_SCENE_BUILDERS:
        raise KeyError(f"No demo scene for '{topic}'. Available: {sorted(_DEMO_SCENE_BUILDERS)}")
    title, builder = _DEMO_SCENE_BUILDERS[topic]
    beat = _validate_scene_beat(builder())
    return _merge_beats(title, [beat], fallback_text=title, beat_titles=[title])


def list_demo_scenes() -> list:
    """Public accessor for app.py's dev route — avoids reaching into the
    private _DEMO_SCENE_BUILDERS dict from outside this module."""
    return sorted(_DEMO_SCENE_BUILDERS)


def _beat_focus_point(beat: dict) -> list:
    """Average position of a beat's own real objects, used to aim the
    automatic camera push-in at whatever that beat is actually about."""
    positions = [_safe_vec3(o.get("position"), (0, 1, 0)) for o in beat.get("objects", [])]
    if not positions:
        return [0, 1, 0]
    n = len(positions)
    return [sum(p[0] for p in positions) / n, sum(p[1] for p in positions) / n, sum(p[2] for p in positions) / n]


def _merge_beats(lesson_title: str, beats: list, fallback_text: str, beat_titles: list = None) -> dict:
    objects, timeline, voice, shots = [], [], [], []
    offset = 0.0
    first_beat = beats[0] if beats else {}
    beat_titles = beat_titles or [f"Part {i+1}" for i in range(len(beats))]

    for i, beat in enumerate(beats):
        id_map = {}
        beat_objects = beat.get("objects", [])
        for obj in beat_objects:
            new_id = f"b{i}_{obj['id']}"
            id_map[obj["id"]] = new_id
            new_obj = dict(obj)
            new_obj["id"] = new_id
            objects.append(new_obj)

        # Cut away the previous beat's props right as this beat begins, and
        # glide the camera into this beat's framing — makes each beat read
        # as a new "shot" rather than everything piling up in one room.
        if i > 0:
            for prev_id in beats[i - 1].get("objects", []):
                timeline.append({
                    "time": round(offset, 2), "target": f"b{i-1}_{prev_id['id']}",
                    "action": "disappear", "to": {}, "duration": 0.5,
                })
            cam = beat.get("camera") or {}
            timeline.append({
                "time": round(offset, 2), "target": "camera", "action": "cameraPan",
                "to": {"position": _safe_vec3(cam.get("position"), (0, 3, 9)), "target": _safe_vec3(cam.get("lookAt"), (0, 1, 0))},
                "duration": 1.2,
            })

        # A code-guaranteed "chapter card" — regardless of what the model
        # produced, every beat opens with its own title fading in and out,
        # like a documentary chapter marker, and the camera pushes in toward
        # whatever that beat is actually about partway through.
        title_id = f"b{i}_titlecard"
        objects.append({
            "id": title_id, "type": "text", "text": beat_titles[i] if i < len(beat_titles) else f"Part {i+1}",
            "position": [0, 4.6, 0], "rotation": [0, 0, 0], "scale": [1.4, 1.4, 1.4], "color": "#F3EEE1",
        })
        timeline.append({"time": round(offset, 2), "target": title_id, "action": "appear", "to": {}, "duration": 0.5})
        timeline.append({"time": round(offset + 2.0, 2), "target": title_id, "action": "fadeOut", "to": {}, "duration": 0.6})
        timeline.append({"time": round(offset + 2.7, 2), "target": title_id, "action": "disappear", "to": {}, "duration": 0.2})

        focus = _beat_focus_point(beat)
        push_in_pos = [focus[0] * 0.5, 2.6, focus[2] * 0.5 + 6.5]
        timeline.append({
            "time": round(offset + 1.0, 2), "target": "camera", "action": "cameraZoom",
            "to": {"position": push_in_pos}, "duration": 2.2,
        })

        for entry in beat.get("timeline", []):
            new_entry = dict(entry)
            new_entry["target"] = "camera" if entry["target"] == "camera" else id_map.get(entry["target"], entry["target"])
            new_entry["time"] = round(_safe_float(entry.get("time"), 0.0) + offset, 2)
            to = dict(new_entry.get("to") or {})
            # "revealCrossSection" references another top-level object id from
            # the same beat — remap it through the same beat-scoped id_map,
            # otherwise the reveal points at a pre-merge id that no longer exists.
            for key in ("section", "reveal"):
                if to.get(key) in id_map:
                    to[key] = id_map[to[key]]
            new_entry["to"] = to
            timeline.append(new_entry)

        for line in beat.get("voice", []):
            voice.append({"time": round(_safe_float(line.get("time"), 0.0) + offset, 2), "text": line.get("text", "")})

        # Cinematic shots (new, additive camera-direction layer) — carried
        # through the same beat-scoped id_map + time offset as the timeline.
        for shot in beat.get("shots", []):
            new_shot = dict(shot)
            new_shot["id"] = f"b{i}_{shot.get('id', 'shot')}"
            new_shot["start"] = round(_safe_float(shot.get("start"), 0.0) + offset, 2)
            cam_cfg = dict(shot.get("camera") or {})
            if cam_cfg.get("focus") in id_map:
                cam_cfg["focus"] = id_map[cam_cfg["focus"]]
            new_shot["camera"] = cam_cfg
            shots.append(new_shot)

        offset += _scene_local_duration(beat)

    scene = {
        "title": lesson_title,
        "summary": "",
        "camera": first_beat.get("camera", {"position": [0, 3, 9], "lookAt": [0, 1, 0], "fov": 50}),
        "lighting": first_beat.get("lighting", {}),
        "environment": first_beat.get("environment", {}),
        "objects": objects,
        "timeline": timeline,
        "shots": shots,
        "voice": voice,
        "subtitles": voice,
        "scene_version": SCENE_GENERATOR_VERSION,
    }
    return _validate_scene(scene, fallback_text=fallback_text)


def _validate_scene_beat(beat: dict) -> dict:
    """Light per-beat validation: sanitize types/ids before merging, but skip
    the whole-scene narration/liveliness passes (those run once, after merge)."""
    beat = beat if isinstance(beat, dict) else {}
    beat.setdefault("camera", {"position": [0, 3, 9], "lookAt": [0, 1, 0], "fov": 50})
    beat.setdefault("lighting", {
        "ambient": {"color": "#ffffff", "intensity": 0.5},
        "directional": [{"color": "#ffffff", "intensity": 0.8, "position": [5, 8, 5]}],
    })
    beat.setdefault("environment", {"background": "#0e1a2b", "fog": False})
    env = beat["environment"] if isinstance(beat.get("environment"), dict) else {}
    if env.get("theme") not in _VALID_ENVIRONMENT_THEMES:
        env.pop("theme", None)  # let the renderer auto-detect rather than force a wrong theme
    beat["environment"] = env

    objects = beat.get("objects") or []
    clean_objects = []
    seen_ids = set()
    for i, obj in enumerate(objects):
        if not isinstance(obj, dict):
            continue
        obj_id = str(obj.get("id") or f"obj{i}")
        if obj_id in seen_ids:
            obj_id = f"{obj_id}_{i}"
        seen_ids.add(obj_id)
        obj["id"] = obj_id
        clean_objects.append(_normalize_object(obj, i))
    beat["objects"] = clean_objects

    valid_ids = {o["id"] for o in clean_objects} | {"camera"}
    clean_timeline = []
    for entry in (beat.get("timeline") or []):
        if not isinstance(entry, dict) or entry.get("target") not in valid_ids or entry.get("action") not in _VALID_ACTIONS:
            continue
        entry["time"] = _safe_float(entry.get("time"), 0.0)
        entry["duration"] = _safe_float(entry.get("duration"), 1.0)
        entry.setdefault("to", {})
        clean_timeline.append(entry)
    beat["timeline"] = sorted(clean_timeline, key=lambda e: e["time"])

    clean_shots = []
    for shot in (beat.get("shots") or []):
        if not isinstance(shot, dict):
            continue
        cam_cfg = shot.get("camera") if isinstance(shot.get("camera"), dict) else {}
        if cam_cfg.get("focus") is not None and cam_cfg.get("focus") not in valid_ids:
            cam_cfg.pop("focus", None)  # dangling reference — let it fall back to explicit position/target
        if cam_cfg.get("action") not in _VALID_CAMERA_SHOT_ACTIONS:
            cam_cfg["action"] = "focus"
        clean_shots.append({
            "id": str(shot.get("id") or f"shot{len(clean_shots)}"),
            "start": _safe_float(shot.get("start"), 0.0),
            "duration": max(0.3, _safe_float(shot.get("duration"), 2.0)),
            "camera": cam_cfg,
        })
    beat["shots"] = sorted(clean_shots, key=lambda s: s["start"])

    clean_voice = []
    for v in (beat.get("voice") or []):
        if isinstance(v, dict) and v.get("text"):
            v["time"] = _safe_float(v.get("time"), 0.0)
            clean_voice.append(v)
    beat["voice"] = sorted(clean_voice, key=lambda v: v["time"])
    return beat


# ----------------------------------------------------------------------------
# Written lesson notes — a separate, lightweight call so it never competes
# with the scene JSON's token budget (which is what actually narrates and
# animates the lesson, and must never get truncated).
# ----------------------------------------------------------------------------

NOTES_SYSTEM = """You write detailed, well-explained study notes for a lesson \
— the kind a strong student could learn the entire topic from without \
watching anything else. Respond ONLY with a JSON object matching exactly \
this shape:

{
  "sections": [
    {"heading": "...", "body": "..."}
  ]
}

Rules:
- Produce 6-9 sections that together thoroughly explain the lesson, covering
  (in this order, adapted to the actual content):
  1. Overview — what this concept is and why it matters
  2. Key terms — the important vocabulary, each term clearly defined
  3. How it works — the mechanism or process, step by step, in the order it
     actually happens
  4. One or two worked examples applying the concept concretely
  5. Common misconceptions or mistakes learners make with this topic
  6. How this connects to related ideas or what it's used for in practice
  7. Summary — the core takeaway in a few sentences
- Each "body" is a substantial paragraph, 4-7 sentences — write it the way a
  strong textbook chapter would, with real explanatory depth, not a
  bullet-point summary and not filler restating the heading.
- Be concrete: use the actual facts, numbers, and terminology from the
  lesson material rather than vague generalities.
- Base everything strictly on the lesson content provided — do not invent
  facts that aren't supported by it."""


def generate_lesson_notes(client: Groq, lesson_title: str, lesson_summary: str, key_points, source_excerpt: str) -> dict:
    user = (
        f"LESSON TITLE: {lesson_title}\n"
        f"LESSON SUMMARY: {lesson_summary}\n"
        f"KEY POINTS: {json.dumps(key_points, ensure_ascii=False)}\n\n"
        f"SOURCE MATERIAL:\n{_truncate(source_excerpt, MAX_NOTES_SOURCE_CHARS)}"
    )
    notes = _chat_json(client, NOTES_SYSTEM, user, model=TEXT_MODEL, max_tokens=2600)
    return _validate_notes(notes, lesson_title, lesson_summary, key_points)


def _validate_notes(notes: dict, title: str, summary: str, key_points) -> dict:
    sections = notes.get("sections") if isinstance(notes, dict) else None
    clean = []
    if isinstance(sections, list):
        for s in sections:
            if isinstance(s, dict) and s.get("heading") and s.get("body"):
                clean.append({"heading": str(s["heading"]), "body": str(s["body"])})
    if not clean:
        # Fallback so the Notes tab is never empty even if this call fails oddly
        clean = [{"heading": title or "Overview", "body": summary or "No notes available for this lesson."}]
        if key_points:
            clean.append({"heading": "Key points", "body": " ".join(f"{p}." for p in key_points)})
    return {"sections": clean}


_VALID_OBJECT_TYPES = {
    "box", "sphere", "cylinder", "cone", "torus", "plane", "arrow", "line",
    "text", "graph_bar", "graph_line", "pie_chart", "character", "building",
    "tree", "terrain", "robot", "car", "book", "table", "chair", "icon",
    "process_flow", "molecule", "beam", "force_vector", "cross_section", "formula",
}
_VALID_ACTIONS = {
    "appear", "move", "rotate", "scale", "orbit", "bounce", "fadeIn", "fadeOut",
    "disappear", "highlight", "colorChange", "cameraZoom", "cameraRotate",
    "cameraPan", "graphGrowth", "arrowFlow", "flow", "bondForm", "bondBreak",
    "revealCrossSection", "highlightTerm", "deform",
}
_VALID_ENVIRONMENT_THEMES = {
    "chemistry", "biology", "physics", "astronomy", "engineering",
    "mathematics", "business", "generic",
}
_VALID_CAMERA_SHOT_ACTIONS = {
    "wideShot", "pushIn", "pullBack", "orbit", "arc", "closeUp", "macro",
    "overhead", "highAngle", "lowAngle", "focus", "rackFocus", "establish",
    "dollyIn", "dollyOut", "pan", "tilt", "track", "follow", "flyThrough",
}

# process_flow and molecule are structural objects (their own internal
# layout — stages/paths, atoms/bonds — is what matters) rather than simple
# geometry. cross_section objects are also excluded from the generic
# "add filler motion" pass below since they're deliberately hidden until
# revealed by "revealCrossSection", not "appear".
_STRUCTURAL_OBJECT_TYPES = {"process_flow", "molecule", "cross_section"}


_FALLBACK_SHAPES = ["sphere", "cylinder", "torus", "cone", "box"]
PALETTE_HEX = ["#C9A24C", "#5FA08C", "#C1633B", "#8A7137", "#B9C0CC", "#DAB463"]

# Common elements mapped to a rendering color/size hint the engine understands —
# the AI only needs to give a symbol; visuals are consistent across lessons.
ELEMENT_HINTS = {
    "H": "#F3EEE1", "O": "#C1633B", "C": "#4A4A4A", "N": "#5FA08C",
    "NA": "#DAB463", "CL": "#8FBF7A", "FE": "#B15E3B", "CA": "#B9C0CC",
}


def _safe_float(value, default: float = 0.0) -> float:
    """Groq occasionally returns numbers as strings (or omits/garbles them)
    despite the schema — this is what actually caused the 'unsupported
    operand type(s) for +: int and str' crash. Every numeric value that
    came from the model's own JSON gets coerced through this before it's
    ever used in arithmetic."""
    try:
        return float(value)
    except (TypeError, ValueError):
        return default


def _safe_vec3(value, default=(0.0, 0.0, 0.0)) -> list:
    if not isinstance(value, (list, tuple)) or len(value) != 3:
        return [float(d) for d in default]
    return [_safe_float(value[i], default[i]) for i in range(3)]


def _normalize_object(obj: dict, index: int) -> dict:
    if obj.get("type") not in _VALID_OBJECT_TYPES:
        obj["type"] = _FALLBACK_SHAPES[index % len(_FALLBACK_SHAPES)]

    obj["position"] = _safe_vec3(obj.get("position"), (0, 0, 0))
    obj["rotation"] = _safe_vec3(obj.get("rotation"), (0, 0, 0))
    obj["scale"] = _safe_vec3(obj.get("scale"), (1, 1, 1))
    obj.setdefault("color", "#C9A24C")

    if obj["type"] == "process_flow":
        stages = obj.get("stages") or []
        clean_stages = []
        seen_stage_ids = set()
        for j, s in enumerate(stages):
            if not isinstance(s, dict) or not s.get("label"):
                continue
            sid = str(s.get("id") or f"stage{j}")
            if sid in seen_stage_ids:
                sid = f"{sid}_{j}"
            seen_stage_ids.add(sid)
            default_pos = (j * 2.4 - (len(stages) - 1) * 1.2, 0, 0)
            clean_stages.append({
                "id": sid,
                "label": str(s["label"]),
                "position": _safe_vec3(s.get("position"), default_pos),
                "color": s.get("color") or PALETTE_HEX[j % len(PALETTE_HEX)],
            })
        obj["stages"] = clean_stages

        stage_ids = {s["id"] for s in clean_stages}
        clean_paths = []
        for p in (obj.get("paths") or []):
            if isinstance(p, dict) and p.get("from") in stage_ids and p.get("to") in stage_ids and p["from"] != p["to"]:
                clean_paths.append({"from": p["from"], "to": p["to"]})
        obj["paths"] = clean_paths
        obj["cycle"] = bool(obj.get("cycle", False))

        # Not enough structure to render as a flow — fall back to a plain shape
        if len(clean_stages) < 2 or not clean_paths:
            obj["type"] = "sphere"

    elif obj["type"] == "molecule":
        atoms = obj.get("atoms") or []
        clean_atoms = []
        seen_atom_ids = set()
        for j, a in enumerate(atoms):
            if not isinstance(a, dict):
                continue
            aid = str(a.get("id") or f"atom{j}")
            if aid in seen_atom_ids:
                aid = f"{aid}_{j}"
            seen_atom_ids.add(aid)
            default_pos = (j * 0.9 - (len(atoms) - 1) * 0.45, 0, 0)
            clean_atoms.append({
                "id": aid,
                "element": str(a.get("element", "C")).upper()[:2],
                "position": _safe_vec3(a.get("position"), default_pos),
            })
        obj["atoms"] = clean_atoms

        atom_ids = {a["id"] for a in clean_atoms}
        clean_bonds = []
        for b in (obj.get("bonds") or []):
            if isinstance(b, dict) and b.get("from") in atom_ids and b.get("to") in atom_ids and b["from"] != b["to"]:
                clean_bonds.append({"from": b["from"], "to": b["to"]})
        obj["bonds"] = clean_bonds

        if not clean_atoms:
            obj["type"] = "sphere"

    elif obj["type"] == "beam":
        dims = obj.get("dimensions") if isinstance(obj.get("dimensions"), dict) else {}
        obj["shape"] = obj.get("shape") if obj.get("shape") in ("round", "rect") else "round"
        obj["dimensions"] = {
            "length": _safe_float(dims.get("length"), 3.2),
            "radius": _safe_float(dims.get("radius"), 0.32),
            "width": _safe_float(dims.get("width"), 0.6),
            "height": _safe_float(dims.get("height"), 0.6),
        }
        obj["supports"] = bool(obj.get("supports", False))
        obj.setdefault("material", "metal")

    elif obj["type"] == "force_vector":
        obj["direction"] = _safe_vec3(obj.get("direction"), (1, 0, 0))
        obj["magnitude"] = max(0.3, min(3.0, _safe_float(obj.get("magnitude"), 1.0)))

    elif obj["type"] == "cross_section":
        obj["shape"] = obj.get("shape") if obj.get("shape") in ("circle", "rect") else "circle"
        obj["size"] = max(0.3, _safe_float(obj.get("size"), 1.1))
        pattern = obj.get("stressPattern")
        obj["stressPattern"] = pattern if pattern in ("uniform", "bending", "shear", "torsion") else "uniform"
        obj["intensity"] = max(0.2, min(3.0, _safe_float(obj.get("intensity"), 1.0)))

    elif obj["type"] == "formula":
        expression = str(obj.get("expression") or "").strip()
        terms = obj.get("terms")
        if not expression and not (isinstance(terms, list) and terms):
            # Nothing renderable — fall back rather than showing an empty panel
            obj["type"] = "text"
            obj["text"] = obj.get("label") or "Formula"
        else:
            obj["expression"] = expression or " ".join(
                (t if isinstance(t, str) else str(t.get("symbol", ""))) for t in (terms or [])
            )

    return obj


def _estimate_speech_seconds(text: str) -> float:
    words = len((text or "").split())
    return max(1.4, words / 2.6)


def _synthesize_narration(text: str, min_lines: int = 8) -> list:
    """Builds a gapless narration track from lesson text when Groq's own
    voice track is too sparse or missing — guarantees every lesson talks
    from start to finish."""
    sentences = [s.strip() for s in re.split(r"(?<=[.!?])\s+", (text or "").strip()) if len(s.strip()) > 8]
    if not sentences:
        sentences = ["Let's walk through this lesson."]
    # Repeat/cycle through available sentences if the source is too short to
    # reach the minimum line count, so short lessons still narrate fully.
    lines = []
    i = 0
    t = 0.0
    while len(lines) < max(min_lines, len(sentences)):
        sentence = sentences[i % len(sentences)]
        lines.append({"time": round(t, 2), "text": sentence})
        t += _estimate_speech_seconds(sentence) + 0.2
        i += 1
        if i >= len(sentences) and len(lines) >= min_lines:
            break
    return lines


def _validate_scene(scene: dict, fallback_text: str = "") -> dict:
    """Defensive normalization so a malformed Groq response can't crash the renderer."""
    scene.setdefault("title", "Untitled lesson")
    scene.setdefault("summary", "")
    scene.setdefault("camera", {"position": [0, 3, 9], "lookAt": [0, 1, 0], "fov": 50})
    scene.setdefault("lighting", {
        "ambient": {"color": "#ffffff", "intensity": 0.5},
        "directional": [{"color": "#ffffff", "intensity": 0.8, "position": [5, 8, 5]}],
    })
    scene.setdefault("environment", {"background": "#0e1a2b", "fog": False})
    env = scene["environment"] if isinstance(scene.get("environment"), dict) else {}
    if env.get("theme") not in _VALID_ENVIRONMENT_THEMES:
        env.pop("theme", None)
    scene["environment"] = env
    scene.setdefault("scene_version", SCENE_GENERATOR_VERSION)

    objects = scene.get("objects") or []
    clean_objects = []
    seen_ids = set()
    for i, obj in enumerate(objects):
        if not isinstance(obj, dict):
            continue
        obj_id = str(obj.get("id") or f"obj{i}")
        if obj_id in seen_ids:
            obj_id = f"{obj_id}_{i}"
        seen_ids.add(obj_id)
        obj["id"] = obj_id
        clean_objects.append(_normalize_object(obj, i))
    scene["objects"] = clean_objects

    valid_ids = {o["id"] for o in clean_objects} | {"camera"}
    timeline = scene.get("timeline") or []
    clean_timeline = []
    for entry in timeline:
        if not isinstance(entry, dict):
            continue
        if entry.get("target") not in valid_ids:
            continue
        if entry.get("action") not in _VALID_ACTIONS:
            continue
        entry["time"] = _safe_float(entry.get("time"), 0.0)
        entry["duration"] = _safe_float(entry.get("duration"), 1.0)
        entry.setdefault("to", {})
        clean_timeline.append(entry)
    clean_timeline.sort(key=lambda e: e["time"])
    scene["timeline"] = clean_timeline

    clean_shots = []
    for shot in (scene.get("shots") or []):
        if not isinstance(shot, dict):
            continue
        cam_cfg = shot.get("camera") if isinstance(shot.get("camera"), dict) else {}
        if cam_cfg.get("focus") is not None and cam_cfg.get("focus") not in valid_ids:
            cam_cfg.pop("focus", None)
        if cam_cfg.get("action") not in _VALID_CAMERA_SHOT_ACTIONS:
            cam_cfg["action"] = "focus"
        clean_shots.append({
            "id": str(shot.get("id") or f"shot{len(clean_shots)}"),
            "start": _safe_float(shot.get("start"), 0.0),
            "duration": max(0.3, _safe_float(shot.get("duration"), 2.0)),
            "camera": cam_cfg,
        })
    clean_shots.sort(key=lambda s: s["start"])
    scene["shots"] = clean_shots

    voice = []
    for v in (scene.get("voice") or []):
        if isinstance(v, dict) and v.get("text"):
            v["time"] = _safe_float(v.get("time"), 0.0)
            voice.append(v)
    voice.sort(key=lambda v: v["time"])

    # Guarantee the lesson always talks: if Groq returned too few lines, or
    # left a long silent gap anywhere, replace with a synthesized gapless
    # narration built from the lesson's own text.
    needs_fallback = len(voice) < 6
    if not needs_fallback:
        prev_end = 0.0
        for line in voice:
            if line.get("time", 0) - prev_end > 6.0:
                needs_fallback = True
                break
            prev_end = line.get("time", 0) + _estimate_speech_seconds(line.get("text", ""))

    if needs_fallback:
        voice = _synthesize_narration(fallback_text or scene.get("summary", ""))

    scene["voice"] = voice
    scene["subtitles"] = voice
    scene["labels"] = scene.get("labels") or []
    scene["animations"] = []  # animation instructions live in `timeline`; kept for schema compatibility

    scene["timeline"] = _ensure_liveliness(scene["objects"], scene["timeline"], voice)

    return scene


_FILLER_ACTIONS = ["highlight", "bounce", "colorChange"]


def _ensure_liveliness(objects: list, timeline: list, voice: list) -> list:
    """Code-level guarantee (on top of the prompt's own instruction) that no
    object just sits there after appearing — anything with a single timeline
    entry gets a couple of extra beats spread through the rest of the scene."""
    total_duration = max(
        max([e.get("time", 0) + e.get("duration", 1) for e in timeline], default=0),
        max([v.get("time", 0) + _estimate_speech_seconds(v.get("text", "")) for v in voice], default=0),
        6.0,
    )
    beat_counts = {}
    for e in timeline:
        beat_counts[e.get("target")] = beat_counts.get(e.get("target"), 0) + 1

    extra = []
    for i, obj in enumerate(objects):
        oid = obj["id"]
        if obj.get("type") in _STRUCTURAL_OBJECT_TYPES:
            continue  # process_flow/molecule bring their own internal motion
        if beat_counts.get(oid, 0) > 1:
            continue  # already does something beyond appearing
        for j, frac in enumerate([0.4, 0.75]):
            action = _FILLER_ACTIONS[(i + j) % len(_FILLER_ACTIONS)]
            entry = {
                "time": round(total_duration * frac + i * 0.25, 2),
                "target": oid, "action": action, "duration": 1.2, "to": {},
            }
            if action == "colorChange":
                accent = ["#5FA08C", "#DAB463", "#C1633B"][i % 3]
                entry["to"] = {"color": accent}
            extra.append(entry)

    combined = timeline + extra
    combined.sort(key=lambda e: e.get("time", 0))
    return combined


# ----------------------------------------------------------------------------
# Phase 7 — quizzes and final exams
# ----------------------------------------------------------------------------

QUIZ_SYSTEM = """You are an assessment writer. Write quiz questions strictly \
from the given lesson content. Respond ONLY with a JSON object matching \
exactly this shape:

{
  "questions": [
    {
      "type": "multiple_choice" | "true_false" | "fill_blank" | "short_answer",
      "prompt": "...",
      "options": ["...", "..."],
      "correct_answer": "...",
      "explanation": "one sentence on why this is correct",
      "topic_tag": "short topic label this question belongs to",
      "difficulty": "easy" | "medium" | "hard"
    }
  ]
}

Rules:
- "options" is required (2-5 items) only for "multiple_choice"; use exactly ["True","False"] for "true_false"; omit or use an empty list for "fill_blank" and "short_answer".
- "correct_answer" for multiple_choice must exactly match one of "options".
- Mix difficulties across the set.
- Every question must be answerable strictly from the given content."""


def generate_quiz(client: Groq, title: str, content: str, num_questions: int = 5) -> dict:
    user = f"TITLE: {title}\nNUMBER OF QUESTIONS: {num_questions}\n\nCONTENT:\n{_truncate(content, MAX_QUIZ_SOURCE_CHARS)}"
    quiz = _chat_json(client, QUIZ_SYSTEM, user, max_tokens=2000)
    return _validate_quiz(quiz)


def generate_final_exam(client: Groq, course_title: str, lesson_summaries: list, num_questions: int = 10) -> dict:
    content = "\n".join(f"- {s}" for s in lesson_summaries)
    user = (
        f"TITLE: Final Exam — {course_title}\n"
        f"NUMBER OF QUESTIONS: {num_questions}\n\n"
        f"This exam must cover ALL of the following lesson summaries, roughly evenly:\n{_truncate(content, MAX_QUIZ_SOURCE_CHARS)}"
    )
    quiz = _chat_json(client, QUIZ_SYSTEM, user, max_tokens=3000)
    return _validate_quiz(quiz)


_VALID_QUESTION_TYPES = {"multiple_choice", "true_false", "fill_blank", "short_answer"}


def _validate_quiz(quiz: dict) -> dict:
    questions = quiz.get("questions") or []
    clean = []
    for q in questions:
        if not isinstance(q, dict) or not q.get("prompt") or not q.get("correct_answer"):
            continue
        if q.get("type") not in _VALID_QUESTION_TYPES:
            q["type"] = "short_answer"
        if q["type"] == "true_false":
            q["options"] = ["True", "False"]
        elif q["type"] == "multiple_choice":
            options = q.get("options") or []
            if q["correct_answer"] not in options:
                options.append(q["correct_answer"])
            q["options"] = options
        else:
            q["options"] = []
        q.setdefault("explanation", "")
        q.setdefault("topic_tag", "General")
        q.setdefault("difficulty", "medium")
        clean.append(q)
    quiz["questions"] = clean
    return quiz


def grade_open_answer(client: Groq, prompt: str, correct_answer: str, student_answer: str) -> dict:
    """Used for fill_blank / short_answer grading, where exact string match is too strict."""
    system = (
        "You grade a single quiz answer. Respond ONLY with JSON: "
        '{"correct": true|false, "score": 0.0-1.0, "feedback": "one short sentence"}. '
        "Give partial credit (score between 0 and 1) for answers that are substantially "
        "correct but incomplete or imprecisely worded."
    )
    user = f"QUESTION: {prompt}\nEXPECTED ANSWER: {correct_answer}\nSTUDENT ANSWER: {student_answer}"
    try:
        result = _chat_json(client, system, user, model=FAST_MODEL, max_tokens=200)
        result.setdefault("correct", False)
        result.setdefault("score", 1.0 if result.get("correct") else 0.0)
        result.setdefault("feedback", "")
        return result
    except Exception:
        # Fall back to a simple normalized string match if grading fails
        match = student_answer.strip().lower() == correct_answer.strip().lower()
        return {"correct": match, "score": 1.0 if match else 0.0, "feedback": ""}


# ----------------------------------------------------------------------------
# AI Tutor
# ----------------------------------------------------------------------------

TUTOR_MODES = {
    "explain_again": "Explain the concept again, a different way than before.",
    "simplify": "Explain it as simply as possible, for a total beginner.",
    "more_examples": "Give two additional concrete examples of this concept.",
    "real_world": "Give one detailed real-world application of this concept.",
    "analogy": "Explain this concept using a single clear analogy.",
    "translate": "Translate your explanation into the requested language.",
    "practice": "Write three new practice questions (with answers) on this concept.",
}


def tutor_reply(client: Groq, mode: str, course_material: str, question: str, language: str = "en") -> str:
    instruction = TUTOR_MODES.get(mode, "Answer the student's question directly and clearly.")
    system = (
        "You are Orbit's AI tutor. You must answer ONLY using the course material "
        "provided below — never introduce facts that aren't in it or in the student's "
        "own question. Keep answers focused and conversational, 2-6 sentences unless "
        f"asked for examples or practice questions. Respond in language code: {language}.\n\n"
        f"COURSE MATERIAL:\n{_truncate(course_material, MAX_QUIZ_SOURCE_CHARS)}"
    )
    user = f"{instruction}\n\nStudent's question: {question}" if question else instruction

    last_exc = None
    for attempt in range(3):
        try:
            response = client.chat.completions.create(
                model=TEXT_MODEL,
                messages=[{"role": "system", "content": system}, {"role": "user", "content": user}],
                temperature=0.5,
                max_tokens=600,
            )
            return response.choices[0].message.content.strip()
        except Exception as exc:  # noqa: BLE001
            last_exc = exc
            if _is_rate_limit_error(exc) and attempt < 2:
                time.sleep(20 * (attempt + 1))
                continue
            raise
    raise last_exc