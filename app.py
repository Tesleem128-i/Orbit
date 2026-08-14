"""
Orbit — AI-powered learning platform
Phase 1: Authentication, database, landing page, dashboard shell.

All routes live in this single file per project spec (no Blueprints).
"""

import os
import re
import json
from datetime import datetime, timezone

from flask import Flask, render_template, redirect, url_for, request, flash, jsonify
from flask_sqlalchemy import SQLAlchemy
from flask_login import (
    LoginManager, UserMixin, login_user, login_required,
    logout_user, current_user
)
from flask_bcrypt import Bcrypt
from werkzeug.middleware.proxy_fix import ProxyFix
from werkzeug.utils import secure_filename
from dotenv import load_dotenv

import extraction
import ai_pipeline

load_dotenv()

# ----------------------------------------------------------------------------
# App configuration
# ----------------------------------------------------------------------------

BASE_DIR = os.path.abspath(os.path.dirname(__file__))

app = Flask(__name__)
app.wsgi_app = ProxyFix(app.wsgi_app, x_proto=1, x_host=1)

app.config["SECRET_KEY"] = os.environ.get("ORBIT_SECRET_KEY", "dev-secret-key-change-in-production")

# Database: SQLite by default for local development. Swap DATABASE_URL to a
# postgresql:// URI (e.g. postgresql+psycopg2://user:pass@host:5432/orbit) to
# move to PostgreSQL — SQLAlchemy models below require no changes.
db_url = os.environ.get("DATABASE_URL", f"sqlite:///{os.path.join(BASE_DIR, 'instance', 'orbit.db')}")
if db_url.startswith("postgres://"):  # Heroku-style URIs
    db_url = db_url.replace("postgres://", "postgresql://", 1)

app.config["SQLALCHEMY_DATABASE_URI"] = db_url
app.config["SQLALCHEMY_TRACK_MODIFICATIONS"] = False
# Managed Postgres (Render included) can silently drop idle connections;
# without pre_ping the next request on a stale connection raises instead of
# reconnecting. No effect on SQLite.
app.config["SQLALCHEMY_ENGINE_OPTIONS"] = {"pool_pre_ping": True}

app.config["MAX_CONTENT_LENGTH"] = 200 * 1024 * 1024  # 200 MB upload ceiling (used from Phase 2 on)
app.config["UPLOAD_FOLDER"] = os.path.join(BASE_DIR, "static", "uploads")
app.config["GENERATED_FOLDER"] = os.path.join(BASE_DIR, "static", "generated")
app.config["REMEMBER_COOKIE_DURATION"] = 60 * 60 * 24 * 30  # 30 days

# DEBUG is opt-in via env only — never trust a hardcoded True in a deployed
# process. Render sets nothing by default, so this is False in production
# unless ORBIT_DEBUG=1 is explicitly set.
app.config["DEBUG"] = os.environ.get("ORBIT_DEBUG", "0") == "1"

# Cookies over HTTPS only once we're actually deployed (Render terminates TLS
# at the edge and forwards plain HTTP internally, which is why ProxyFix above
# is required for Flask to know the original request was secure).
app.config["SESSION_COOKIE_SECURE"] = not app.config["DEBUG"]
app.config["SESSION_COOKIE_HTTPONLY"] = True
app.config["SESSION_COOKIE_SAMESITE"] = "Lax"
app.config["REMEMBER_COOKIE_SECURE"] = not app.config["DEBUG"]
app.config["REMEMBER_COOKIE_HTTPONLY"] = True

db = SQLAlchemy(app)
bcrypt = Bcrypt(app)

login_manager = LoginManager(app)
login_manager.login_view = "login"
login_manager.login_message = "Please log in to continue."
login_manager.login_message_category = "info"


# ----------------------------------------------------------------------------
# Models
# ----------------------------------------------------------------------------

class User(UserMixin, db.Model):
    __tablename__ = "users"

    id = db.Column(db.Integer, primary_key=True)
    username = db.Column(db.String(64), unique=True, nullable=False, index=True)
    email = db.Column(db.String(255), unique=True, nullable=False, index=True)
    password_hash = db.Column(db.String(255), nullable=False)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    last_active_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

    # Progress (Phase 8 will expand on these; columns exist now so the
    # dashboard shell has real, persisted values to render from day one)
    xp = db.Column(db.Integer, default=0)
    coins = db.Column(db.Integer, default=0)
    streak_days = db.Column(db.Integer, default=0)
    courses_completed = db.Column(db.Integer, default=0)

    # Settings
    theme = db.Column(db.String(16), default="dark")            # dark | light
    playback_speed = db.Column(db.Float, default=1.0)
    voice_speed = db.Column(db.Float, default=1.0)
    language = db.Column(db.String(8), default="en")

    def set_password(self, raw_password: str) -> None:
        self.password_hash = bcrypt.generate_password_hash(raw_password).decode("utf-8")

    def check_password(self, raw_password: str) -> bool:
        return bcrypt.check_password_hash(self.password_hash, raw_password)

    def to_settings_dict(self) -> dict:
        return {
            "theme": self.theme,
            "playback_speed": self.playback_speed,
            "voice_speed": self.voice_speed,
            "language": self.language,
        }


class Upload(db.Model):
    __tablename__ = "uploads"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    original_filename = db.Column(db.String(255), nullable=False)
    stored_filename = db.Column(db.String(255), nullable=False)
    file_type = db.Column(db.String(16), nullable=False)   # pdf, docx, txt, pptx, mp3, wav, m4a, pasted, youtube
    size_bytes = db.Column(db.Integer, default=0)
    status = db.Column(db.String(24), default="uploaded")  # uploaded -> analyzing -> ready (Phase 2+)
    extracted_text = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

    user = db.relationship("User", backref=db.backref("uploads", lazy="dynamic", order_by="Upload.created_at.desc()"))

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "name": self.original_filename,
            "type": self.file_type,
            "size_bytes": self.size_bytes,
            "status": self.status,
            "created_at": self.created_at.isoformat(),
        }


class Course(db.Model):
    __tablename__ = "courses"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    upload_id = db.Column(db.Integer, db.ForeignKey("uploads.id"), nullable=True)
    title = db.Column(db.String(255), nullable=False)
    description = db.Column(db.Text, default="")
    difficulty = db.Column(db.String(16), default="beginner")
    status = db.Column(db.String(24), default="generating")  # generating -> ready -> failed
    error_message = db.Column(db.Text, default="")
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

    user = db.relationship("User", backref=db.backref("courses", lazy="dynamic", order_by="Course.created_at.desc()"))
    modules = db.relationship("Module", backref="course", cascade="all, delete-orphan", order_by="Module.order_index")

    def total_lessons(self) -> int:
        return sum(len(m.lessons) for m in self.modules)

    def to_summary_dict(self, user_id: int) -> dict:
        progress = CourseProgress.query.filter_by(user_id=user_id, course_id=self.id).first()
        total = self.total_lessons()
        completed = progress.completed_lesson_count() if progress else 0
        return {
            "id": self.id,
            "title": self.title,
            "description": self.description,
            "difficulty": self.difficulty,
            "status": self.status,
            "error_message": self.error_message,
            "module_count": len(self.modules),
            "lesson_count": total,
            "percent_complete": round((completed / total) * 100) if total else 0,
            "created_at": self.created_at.isoformat(),
        }


class Module(db.Model):
    __tablename__ = "modules"

    id = db.Column(db.Integer, primary_key=True)
    course_id = db.Column(db.Integer, db.ForeignKey("courses.id"), nullable=False, index=True)
    order_index = db.Column(db.Integer, default=0)
    title = db.Column(db.String(255), nullable=False)
    description = db.Column(db.Text, default="")

    lessons = db.relationship("Lesson", backref="module", cascade="all, delete-orphan", order_by="Lesson.order_index")


class Lesson(db.Model):
    __tablename__ = "lessons"

    id = db.Column(db.Integer, primary_key=True)
    module_id = db.Column(db.Integer, db.ForeignKey("modules.id"), nullable=False, index=True)
    order_index = db.Column(db.Integer, default=0)
    title = db.Column(db.String(255), nullable=False)
    summary = db.Column(db.Text, default="")
    key_points = db.Column(db.Text, default="[]")  # JSON list
    scene_json = db.Column(db.Text, nullable=True)  # generated + cached lazily (Phase 4)
    notes_json = db.Column(db.Text, nullable=True)  # generated + cached lazily — written lesson notes
    quiz_generated = db.Column(db.Boolean, default=False)

    def get_key_points(self) -> list:
        try:
            return json.loads(self.key_points or "[]")
        except (json.JSONDecodeError, TypeError):
            return []

    def to_dict(self) -> dict:
        return {
            "id": self.id,
            "title": self.title,
            "summary": self.summary,
            "key_points": self.get_key_points(),
            "has_scene": bool(self.scene_json),
            "order_index": self.order_index,
        }


class Quiz(db.Model):
    __tablename__ = "quizzes"

    id = db.Column(db.Integer, primary_key=True)
    lesson_id = db.Column(db.Integer, db.ForeignKey("lessons.id"), nullable=True, index=True)
    course_id = db.Column(db.Integer, db.ForeignKey("courses.id"), nullable=True, index=True)
    is_final_exam = db.Column(db.Boolean, default=False)
    title = db.Column(db.String(255), default="Quiz")

    questions = db.relationship("Question", backref="quiz", cascade="all, delete-orphan", order_by="Question.order_index")
    lesson = db.relationship("Lesson", backref=db.backref("quiz", uselist=False))

    def to_public_dict(self) -> dict:
        """Question payload WITHOUT correct answers — safe to send before submission."""
        return {
            "id": self.id,
            "title": self.title,
            "is_final_exam": self.is_final_exam,
            "questions": [q.to_public_dict() for q in self.questions],
        }


class Question(db.Model):
    __tablename__ = "questions"

    id = db.Column(db.Integer, primary_key=True)
    quiz_id = db.Column(db.Integer, db.ForeignKey("quizzes.id"), nullable=False, index=True)
    order_index = db.Column(db.Integer, default=0)
    type = db.Column(db.String(24), nullable=False)  # multiple_choice | true_false | fill_blank | short_answer
    prompt = db.Column(db.Text, nullable=False)
    options_json = db.Column(db.Text, default="[]")
    correct_answer = db.Column(db.Text, nullable=False)
    explanation = db.Column(db.Text, default="")
    topic_tag = db.Column(db.String(120), default="General")
    difficulty = db.Column(db.String(16), default="medium")

    def get_options(self) -> list:
        try:
            return json.loads(self.options_json or "[]")
        except (json.JSONDecodeError, TypeError):
            return []

    def to_public_dict(self) -> dict:
        return {
            "id": self.id,
            "type": self.type,
            "prompt": self.prompt,
            "options": self.get_options(),
            "difficulty": self.difficulty,
        }


class QuizAttempt(db.Model):
    __tablename__ = "quiz_attempts"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    quiz_id = db.Column(db.Integer, db.ForeignKey("quizzes.id"), nullable=False, index=True)
    score_percent = db.Column(db.Float, default=0.0)
    passed = db.Column(db.Boolean, default=False)
    answers_json = db.Column(db.Text, default="{}")
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

    quiz = db.relationship("Quiz")


class CourseProgress(db.Model):
    __tablename__ = "course_progress"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    course_id = db.Column(db.Integer, db.ForeignKey("courses.id"), nullable=False, index=True)
    completed_lesson_ids = db.Column(db.Text, default="[]")
    last_studied_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))
    certificate_issued = db.Column(db.Boolean, default=False)
    exam_score = db.Column(db.Float, nullable=True)

    __table_args__ = (db.UniqueConstraint("user_id", "course_id", name="uq_user_course"),)

    def get_completed_ids(self) -> set:
        try:
            return set(json.loads(self.completed_lesson_ids or "[]"))
        except (json.JSONDecodeError, TypeError):
            return set()

    def completed_lesson_count(self) -> int:
        return len(self.get_completed_ids())

    def mark_lesson_complete(self, lesson_id: int) -> None:
        ids = self.get_completed_ids()
        ids.add(lesson_id)
        self.completed_lesson_ids = json.dumps(list(ids))
        self.last_studied_at = datetime.now(timezone.utc)


class WeakTopic(db.Model):
    __tablename__ = "weak_topics"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    topic = db.Column(db.String(120), nullable=False)
    wrong_count = db.Column(db.Integer, default=0)
    total_count = db.Column(db.Integer, default=0)

    __table_args__ = (db.UniqueConstraint("user_id", "topic", name="uq_user_topic"),)

    def accuracy(self) -> float:
        return round(((self.total_count - self.wrong_count) / self.total_count) * 100) if self.total_count else 100


ACHIEVEMENT_DEFS = [
    {"key": "first_orbit", "name": "First Orbit", "description": "Upload your first document"},
    {"key": "first_lesson", "name": "First Lesson", "description": "Complete your first 3D lesson"},
    {"key": "quiz_streak", "name": "Quiz Streak", "description": "Pass 5 quizzes in a row"},
    {"key": "seven_day_streak", "name": "7-Day Streak", "description": "Study seven days in a row"},
    {"key": "course_complete", "name": "Course Complete", "description": "Finish an entire course and exam"},
    {"key": "deep_diver", "name": "Deep Diver", "description": "Ask the AI tutor 25 questions"},
]


class UserAchievement(db.Model):
    __tablename__ = "user_achievements"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    achievement_key = db.Column(db.String(64), nullable=False)
    unlocked_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))

    __table_args__ = (db.UniqueConstraint("user_id", "achievement_key", name="uq_user_achievement"),)


class TutorMessage(db.Model):
    __tablename__ = "tutor_messages"

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey("users.id"), nullable=False, index=True)
    course_id = db.Column(db.Integer, db.ForeignKey("courses.id"), nullable=True, index=True)
    role = db.Column(db.String(16), nullable=False)  # user | assistant
    content = db.Column(db.Text, nullable=False)
    created_at = db.Column(db.DateTime, default=lambda: datetime.now(timezone.utc))


@login_manager.user_loader
def load_user(user_id):
    return db.session.get(User, int(user_id))


# ----------------------------------------------------------------------------
# Validation helpers
# ----------------------------------------------------------------------------

USERNAME_RE = re.compile(r"^[a-zA-Z0-9_]{3,32}$")
EMAIL_RE = re.compile(r"^[^@\s]+@[^@\s]+\.[^@\s]+$")

ALLOWED_UPLOAD_EXTENSIONS = {"pdf", "docx", "txt", "pptx", "mp3", "wav", "m4a"}
MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024  # 100 MB per file


def validate_signup(username: str, email: str, password: str, confirm: str) -> list:
    errors = []
    if not USERNAME_RE.match(username or ""):
        errors.append("Username must be 3–32 characters: letters, numbers, and underscores only.")
    if not EMAIL_RE.match(email or ""):
        errors.append("Enter a valid email address.")
    if not password or len(password) < 8:
        errors.append("Password must be at least 8 characters.")
    if password != confirm:
        errors.append("Passwords do not match.")
    if username and User.query.filter_by(username=username).first():
        errors.append("That username is already taken.")
    if email and User.query.filter_by(email=email.lower()).first():
        errors.append("An account with that email already exists.")
    return errors


# ----------------------------------------------------------------------------
# Landing page
# ----------------------------------------------------------------------------

@app.route("/")
def index():
    if current_user.is_authenticated:
        return redirect(url_for("dashboard"))
    return render_template("index.html")


# ----------------------------------------------------------------------------
# Auth routes
# ----------------------------------------------------------------------------

@app.route("/signup", methods=["GET", "POST"])
def signup():
    if current_user.is_authenticated:
        return redirect(url_for("dashboard"))

    if request.method == "POST":
        username = request.form.get("username", "").strip()
        email = request.form.get("email", "").strip().lower()
        password = request.form.get("password", "")
        confirm = request.form.get("confirm_password", "")

        errors = validate_signup(username, email, password, confirm)
        if errors:
            for e in errors:
                flash(e, "error")
            return render_template("signup.html", username=username, email=email), 400

        user = User(username=username, email=email)
        user.set_password(password)
        db.session.add(user)
        db.session.commit()

        login_user(user, remember=True)
        flash("Welcome to Orbit — your account is ready.", "success")
        return redirect(url_for("dashboard"))

    return render_template("signup.html")


@app.route("/login", methods=["GET", "POST"])
def login():
    if current_user.is_authenticated:
        return redirect(url_for("dashboard"))

    if request.method == "POST":
        identifier = request.form.get("identifier", "").strip().lower()
        password = request.form.get("password", "")
        remember = bool(request.form.get("remember"))

        user = User.query.filter(
            (db.func.lower(User.username) == identifier) | (User.email == identifier)
        ).first()

        if user and user.check_password(password):
            user.last_active_at = datetime.now(timezone.utc)
            db.session.commit()
            login_user(user, remember=remember)
            flash("Logged in successfully.", "success")
            next_url = request.args.get("next")
            return redirect(next_url or url_for("dashboard"))

        flash("Incorrect username/email or password.", "error")
        return render_template("login.html", identifier=identifier), 401

    return render_template("login.html")


@app.route("/logout")
@login_required
def logout():
    logout_user()
    flash("You've been logged out.", "info")
    return redirect(url_for("index"))


# ----------------------------------------------------------------------------
# Dashboard (single-page shell — sections are swapped client-side via JS)
# ----------------------------------------------------------------------------

@app.route("/dashboard")
@login_required
def dashboard():
    return render_template("dashboard.html", user=current_user)


def _save_upload_record(user_id: int, original_name: str, stored_name: str, file_type: str, size_bytes: int) -> Upload:
    record = Upload(
        user_id=user_id,
        original_filename=original_name,
        stored_filename=stored_name,
        file_type=file_type,
        size_bytes=size_bytes,
        status="uploaded",
    )
    db.session.add(record)
    db.session.commit()
    return record


@app.route("/api/uploads", methods=["GET"])
@login_required
def list_uploads():
    uploads = current_user.uploads.limit(50).all()
    return jsonify({"uploads": [u.to_dict() for u in uploads]})


@app.route("/api/uploads", methods=["POST"])
@login_required
def create_upload():
    # Case 1: a real file (pdf/docx/txt/pptx/mp3/wav/m4a)
    if "file" in request.files:
        file = request.files["file"]
        if not file or file.filename == "":
            return jsonify({"ok": False, "error": "No file selected."}), 400

        filename = secure_filename(file.filename)
        ext = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
        if ext not in ALLOWED_UPLOAD_EXTENSIONS:
            return jsonify({"ok": False, "error": f"Unsupported file type: .{ext}"}), 400

        file.seek(0, os.SEEK_END)
        size_bytes = file.tell()
        file.seek(0)
        if size_bytes > MAX_UPLOAD_SIZE_BYTES:
            return jsonify({"ok": False, "error": "File exceeds the 100 MB limit."}), 413

        user_dir = os.path.join(app.config["UPLOAD_FOLDER"], str(current_user.id))
        os.makedirs(user_dir, exist_ok=True)
        stored_name = f"{int(datetime.now(timezone.utc).timestamp())}_{filename}"
        file.save(os.path.join(user_dir, stored_name))

        record = _save_upload_record(current_user.id, filename, stored_name, ext, size_bytes)
        return jsonify({"ok": True, "upload": record.to_dict()})

    # Case 2: pasted text or a YouTube link, submitted as JSON
    data = request.get_json(silent=True) or {}
    kind = data.get("kind")

    if kind == "pasted":
        text = (data.get("text") or "").strip()
        if len(text) < 20:
            return jsonify({"ok": False, "error": "Paste at least a few sentences of text."}), 400

        user_dir = os.path.join(app.config["UPLOAD_FOLDER"], str(current_user.id))
        os.makedirs(user_dir, exist_ok=True)
        stored_name = f"{int(datetime.now(timezone.utc).timestamp())}_pasted.txt"
        with open(os.path.join(user_dir, stored_name), "w", encoding="utf-8") as f:
            f.write(text)

        record = _save_upload_record(
            current_user.id, "Pasted text", stored_name, "pasted", len(text.encode("utf-8"))
        )
        return jsonify({"ok": True, "upload": record.to_dict()})

    if kind == "youtube":
        url = (data.get("url") or "").strip()
        if not re.match(r"^https?://(www\.)?(youtube\.com|youtu\.be)/", url):
            return jsonify({"ok": False, "error": "Enter a valid YouTube URL."}), 400

        user_dir = os.path.join(app.config["UPLOAD_FOLDER"], str(current_user.id))
        os.makedirs(user_dir, exist_ok=True)
        stored_name = f"{int(datetime.now(timezone.utc).timestamp())}_youtube.txt"
        with open(os.path.join(user_dir, stored_name), "w", encoding="utf-8") as f:
            f.write(url)

        record = _save_upload_record(current_user.id, url, stored_name, "youtube", len(url))
        return jsonify({"ok": True, "upload": record.to_dict()})

    return jsonify({"ok": False, "error": "Unrecognized upload request."}), 400


# ----------------------------------------------------------------------------
# Shared helpers — XP, streaks, achievements
# ----------------------------------------------------------------------------

def _bump_streak(user: "User") -> None:
    now = datetime.now(timezone.utc)
    last = user.last_active_at
    if not user.streak_days:
        user.streak_days = 1
    elif last is not None:
        gap_days = (now.date() - last.date()).days
        if gap_days == 1:
            user.streak_days += 1
        elif gap_days > 1:
            user.streak_days = 1
        # gap_days == 0 -> already studied today, streak unchanged
    user.last_active_at = now


def _check_streak_achievement(user_id: int, streak_days: int) -> list:
    unlocked = []
    if streak_days >= 7 and _unlock_achievement(user_id, "seven_day_streak"):
        unlocked.append("seven_day_streak")
    return unlocked


def _award_xp(user: "User", xp: int, coins: int = 0) -> None:
    user.xp = (user.xp or 0) + xp
    user.coins = (user.coins or 0) + coins


def _unlock_achievement(user_id: int, key: str) -> bool:
    if UserAchievement.query.filter_by(user_id=user_id, achievement_key=key).first():
        return False
    db.session.add(UserAchievement(user_id=user_id, achievement_key=key))
    return True


def _get_ai_client():
    return ai_pipeline.get_client()


def _friendly_ai_error(exc: Exception) -> str:
    if ai_pipeline._is_rate_limit_error(exc):
        return (
            "Groq's free-tier rate limit was hit (it allows a limited number of "
            "tokens per minute). Wait about a minute and try again — this usually "
            "resolves itself, since Groq's limit resets every 60 seconds."
        )
    return str(exc)


def _course_source_text(course: "Course") -> str:
    if course.upload_id:
        upload = db.session.get(Upload, course.upload_id)
        if upload and upload.extracted_text:
            return upload.extracted_text
    # Fall back to concatenated lesson summaries if the source text is unavailable
    parts = []
    for module in course.modules:
        for lesson in module.lessons:
            parts.append(f"{lesson.title}: {lesson.summary}")
    return "\n".join(parts)


# ----------------------------------------------------------------------------
# Phase 2 + 3 — extraction, analysis, course generation
# ----------------------------------------------------------------------------

@app.route("/api/uploads/<int:upload_id>/generate-course", methods=["POST"])
@login_required
def generate_course(upload_id):
    upload = db.session.get(Upload, upload_id)
    if not upload or upload.user_id != current_user.id:
        return jsonify({"ok": False, "error": "Upload not found."}), 404

    course = Course(user_id=current_user.id, upload_id=upload.id, title="Generating…", status="generating")
    db.session.add(course)
    db.session.commit()

    try:
        client = _get_ai_client()

        if not upload.extracted_text:
            upload.status = "analyzing"
            db.session.commit()
            text = extraction.extract_text(upload, app.config["UPLOAD_FOLDER"], groq_client=client)
            upload.extracted_text = text
            db.session.commit()
        else:
            text = upload.extracted_text

        analysis = ai_pipeline.analyze_content(client, text)
        outline = ai_pipeline.generate_course_outline(client, text, analysis)

        course.title = outline.get("title") or "Untitled Course"
        course.description = outline.get("description", "")
        course.difficulty = outline.get("difficulty", "beginner")

        for m_idx, m in enumerate(outline.get("modules", [])):
            module = Module(course_id=course.id, order_index=m_idx, title=m.get("title", f"Module {m_idx+1}"),
                             description=m.get("description", ""))
            db.session.add(module)
            db.session.flush()
            for l_idx, l in enumerate(m.get("lessons", [])):
                lesson = Lesson(
                    module_id=module.id,
                    order_index=l_idx,
                    title=l.get("title", f"Lesson {l_idx+1}"),
                    summary=l.get("summary", ""),
                    key_points=json.dumps(l.get("key_points", [])),
                )
                db.session.add(lesson)

        course.status = "ready"
        upload.status = "ready"
        db.session.commit()

        _unlock_achievement(current_user.id, "first_orbit")
        db.session.commit()

        return jsonify({"ok": True, "course": course.to_summary_dict(current_user.id)})

    except Exception as exc:  # noqa: BLE001 — surface any pipeline failure to the client
        db.session.rollback()
        course = db.session.get(Course, course.id)
        if course:
            course.status = "failed"
            course.error_message = str(exc)
            db.session.commit()
        return jsonify({"ok": False, "error": f"Course generation failed: {_friendly_ai_error(exc)}"}), 500


@app.route("/api/courses", methods=["GET"])
@login_required
def list_courses():
    courses = current_user.courses.all()
    return jsonify({"courses": [c.to_summary_dict(current_user.id) for c in courses]})


@app.route("/api/courses/<int:course_id>", methods=["GET"])
@login_required
def get_course(course_id):
    course = db.session.get(Course, course_id)
    if not course or course.user_id != current_user.id:
        return jsonify({"ok": False, "error": "Course not found."}), 404

    progress = CourseProgress.query.filter_by(user_id=current_user.id, course_id=course.id).first()
    completed_ids = progress.get_completed_ids() if progress else set()

    modules = []
    for module in course.modules:
        modules.append({
            "id": module.id,
            "title": module.title,
            "description": module.description,
            "lessons": [dict(l.to_dict(), completed=l.id in completed_ids) for l in module.lessons],
            "quiz_id": module.lessons[0].quiz.id if module.lessons and module.lessons[0].quiz else None,
        })

    return jsonify({
        "ok": True,
        "course": course.to_summary_dict(current_user.id),
        "modules": modules,
        "certificate_issued": bool(progress and progress.certificate_issued),
    })


# ----------------------------------------------------------------------------
# Phase 4 — 3D scene JSON, generated lazily per lesson and cached
# ----------------------------------------------------------------------------

@app.route("/api/lessons/<int:lesson_id>/scene", methods=["GET"])
@login_required
def get_lesson_scene(lesson_id):
    lesson = db.session.get(Lesson, lesson_id)
    if not lesson or lesson.module.course.user_id != current_user.id:
        return jsonify({"ok": False, "error": "Lesson not found."}), 404

    # Ownership is already enforced above, so ?regenerate=1 can only ever
    # force-rebuild a scene the current user owns.
    force_regenerate = request.args.get("regenerate") == "1"

    cached_scene = None
    if lesson.scene_json:
        cached_scene = json.loads(lesson.scene_json)
        # A scene generated by an older schema version (missing object types,
        # no shots/environment.theme, etc.) is stale — regenerate instead of
        # silently serving output from a superseded pipeline. Scenes that
        # already match the current version are served straight from cache.
        is_current = cached_scene.get("scene_version") == ai_pipeline.SCENE_GENERATOR_VERSION
        if is_current and not force_regenerate:
            return jsonify({"ok": True, "scene": cached_scene, "lesson": lesson.to_dict()})

    try:
        client = _get_ai_client()
        course = lesson.module.course
        source_text = _course_source_text(course)
        scene = ai_pipeline.generate_scene_json(client, lesson.title, lesson.summary, lesson.get_key_points(), source_text)
        lesson.scene_json = json.dumps(scene)
        db.session.commit()
        return jsonify({"ok": True, "scene": scene, "lesson": lesson.to_dict()})
    except Exception as exc:  # noqa: BLE001
        # Regeneration failed (rate limit, transient Groq error, etc.) — if we
        # have ANY cached scene, even a stale-schema one, serve it rather than
        # hard-failing the lesson player.
        if cached_scene is not None:
            return jsonify({"ok": True, "scene": cached_scene, "lesson": lesson.to_dict(), "stale": True})
        return jsonify({"ok": False, "error": f"Scene generation failed: {_friendly_ai_error(exc)}"}), 500


# ----------------------------------------------------------------------------
# Renderer benchmark — dev-only. Serves the hand-authored demo scenes from
# ai_pipeline.generate_demo_scene() so the Three.js renderer can be checked
# visually without spending a Groq call or depending on real lesson content.
# Gated behind app.debug so it can never accidentally end up reachable in a
# production deployment (app.run(debug=True) is local-only, see bottom of
# this file); nothing here touches the database.
# ----------------------------------------------------------------------------

@app.route("/dev/demo-scene/<topic>")
@login_required
def demo_scene_view(topic):
    if not app.debug:
        return "Not available.", 404
    available = ai_pipeline.list_demo_scenes()
    try:
        scene = ai_pipeline.generate_demo_scene(topic)
    except KeyError:
        return jsonify({"ok": False, "error": f"Unknown demo topic '{topic}'.", "available": available}), 404
    return render_template(
        "demo_scene.html", topic=topic, scene_json=json.dumps(scene), available_topics=available,
    )


@app.route("/api/lessons/<int:lesson_id>/notes", methods=["GET"])
@login_required
def get_lesson_notes(lesson_id):
    lesson = db.session.get(Lesson, lesson_id)
    if not lesson or lesson.module.course.user_id != current_user.id:
        return jsonify({"ok": False, "error": "Lesson not found."}), 404

    if lesson.notes_json:
        return jsonify({"ok": True, "notes": json.loads(lesson.notes_json)})

    try:
        client = _get_ai_client()
        course = lesson.module.course
        source_text = _course_source_text(course)
        notes = ai_pipeline.generate_lesson_notes(client, lesson.title, lesson.summary, lesson.get_key_points(), source_text)
        lesson.notes_json = json.dumps(notes)
        db.session.commit()
        return jsonify({"ok": True, "notes": notes})
    except Exception as exc:  # noqa: BLE001
        return jsonify({"ok": False, "error": f"Notes generation failed: {_friendly_ai_error(exc)}"}), 500


@app.route("/api/lessons/<int:lesson_id>/quiz", methods=["GET"])
@login_required
def get_lesson_quiz(lesson_id):
    lesson = db.session.get(Lesson, lesson_id)
    if not lesson or lesson.module.course.user_id != current_user.id:
        return jsonify({"ok": False, "error": "Lesson not found."}), 404

    quiz = lesson.quiz
    if quiz:
        return jsonify({"ok": True, "quiz": quiz.to_public_dict()})

    try:
        client = _get_ai_client()
        content = f"{lesson.summary}\n" + "\n".join(lesson.get_key_points())
        quiz_data = ai_pipeline.generate_quiz(client, lesson.title, content, num_questions=5)

        quiz = Quiz(lesson_id=lesson.id, title=f"{lesson.title} — Quiz")
        db.session.add(quiz)
        db.session.flush()
        for q_idx, q in enumerate(quiz_data.get("questions", [])):
            db.session.add(Question(
                quiz_id=quiz.id, order_index=q_idx, type=q["type"], prompt=q["prompt"],
                options_json=json.dumps(q.get("options", [])), correct_answer=q["correct_answer"],
                explanation=q.get("explanation", ""), topic_tag=q.get("topic_tag", "General"),
                difficulty=q.get("difficulty", "medium"),
            ))
        db.session.commit()
        return jsonify({"ok": True, "quiz": quiz.to_public_dict()})
    except Exception as exc:  # noqa: BLE001
        db.session.rollback()
        return jsonify({"ok": False, "error": f"Quiz generation failed: {_friendly_ai_error(exc)}"}), 500


@app.route("/api/lessons/<int:lesson_id>/complete", methods=["POST"])
@login_required
def complete_lesson(lesson_id):
    lesson = db.session.get(Lesson, lesson_id)
    if not lesson or lesson.module.course.user_id != current_user.id:
        return jsonify({"ok": False, "error": "Lesson not found."}), 404

    course = lesson.module.course
    progress = CourseProgress.query.filter_by(user_id=current_user.id, course_id=course.id).first()
    if not progress:
        progress = CourseProgress(user_id=current_user.id, course_id=course.id)
        db.session.add(progress)

    is_new = lesson.id not in progress.get_completed_ids()
    progress.mark_lesson_complete(lesson.id)
    _bump_streak(current_user)

    unlocked = []
    if is_new:
        _award_xp(current_user, xp=25, coins=5)
        if _unlock_achievement(current_user.id, "first_lesson"):
            unlocked.append("first_lesson")
    unlocked += _check_streak_achievement(current_user.id, current_user.streak_days)

    total = course.total_lessons()
    if total and len(progress.get_completed_ids()) >= total:
        if not current_user.courses_completed:
            current_user.courses_completed = 0
        # only bump the completed-course counter once, tracked via certificate flag downstream

    db.session.commit()
    return jsonify({
        "ok": True,
        "xp": current_user.xp,
        "coins": current_user.coins,
        "streak_days": current_user.streak_days,
        "unlocked_achievements": unlocked,
        "percent_complete": round((len(progress.get_completed_ids()) / total) * 100) if total else 0,
    })


# ----------------------------------------------------------------------------
# Phase 7 — quiz + exam grading
# ----------------------------------------------------------------------------

def _grade_quiz(quiz: "Quiz", answers: dict, client) -> dict:
    total = len(quiz.questions)
    correct_count = 0
    feedback = []
    topic_updates = {}

    for q in quiz.questions:
        student_answer = str(answers.get(str(q.id), "")).strip()
        is_correct = False
        partial_feedback = ""

        if q.type in ("multiple_choice", "true_false"):
            is_correct = student_answer.strip().lower() == q.correct_answer.strip().lower()
        else:
            try:
                graded = ai_pipeline.grade_open_answer(client, q.prompt, q.correct_answer, student_answer)
                is_correct = bool(graded.get("correct"))
                partial_feedback = graded.get("feedback", "")
            except Exception:  # noqa: BLE001
                is_correct = student_answer.strip().lower() == q.correct_answer.strip().lower()

        if is_correct:
            correct_count += 1

        topic_updates.setdefault(q.topic_tag, {"wrong": 0, "total": 0})
        topic_updates[q.topic_tag]["total"] += 1
        if not is_correct:
            topic_updates[q.topic_tag]["wrong"] += 1

        feedback.append({
            "question_id": q.id,
            "correct": is_correct,
            "correct_answer": q.correct_answer,
            "explanation": q.explanation,
            "feedback": partial_feedback,
        })

    score_percent = round((correct_count / total) * 100) if total else 0
    return {"score_percent": score_percent, "feedback": feedback, "topic_updates": topic_updates}


def _apply_weak_topics(user_id: int, topic_updates: dict) -> None:
    for topic, counts in topic_updates.items():
        row = WeakTopic.query.filter_by(user_id=user_id, topic=topic).first()
        if not row:
            row = WeakTopic(user_id=user_id, topic=topic, wrong_count=0, total_count=0)
            db.session.add(row)
        row.wrong_count += counts["wrong"]
        row.total_count += counts["total"]


@app.route("/api/quizzes/<int:quiz_id>", methods=["GET"])
@login_required
def get_quiz(quiz_id):
    quiz = db.session.get(Quiz, quiz_id)
    if not quiz:
        return jsonify({"ok": False, "error": "Quiz not found."}), 404
    owner_id = quiz.lesson.module.course.user_id if quiz.lesson else db.session.get(Course, quiz.course_id).user_id
    if owner_id != current_user.id:
        return jsonify({"ok": False, "error": "Quiz not found."}), 404
    return jsonify({"ok": True, "quiz": quiz.to_public_dict()})


@app.route("/api/quizzes/<int:quiz_id>/submit", methods=["POST"])
@login_required
def submit_quiz(quiz_id):
    quiz = db.session.get(Quiz, quiz_id)
    if not quiz:
        return jsonify({"ok": False, "error": "Quiz not found."}), 404

    answers = (request.get_json(silent=True) or {}).get("answers", {})
    client = _get_ai_client()
    result = _grade_quiz(quiz, answers, client)
    _apply_weak_topics(current_user.id, result["topic_updates"])
    _bump_streak(current_user)

    passing_score = 70
    passed = result["score_percent"] >= passing_score

    attempt = QuizAttempt(
        user_id=current_user.id, quiz_id=quiz.id, score_percent=result["score_percent"],
        passed=passed, answers_json=json.dumps(answers),
    )
    db.session.add(attempt)

    unlocked = []
    if passed:
        _award_xp(current_user, xp=40 if quiz.is_final_exam else 15, coins=10 if quiz.is_final_exam else 3)
        recent = QuizAttempt.query.filter_by(user_id=current_user.id).order_by(QuizAttempt.created_at.desc()).limit(5).all()
        if len(recent) >= 4 and all(a.passed for a in recent[:4]):
            if _unlock_achievement(current_user.id, "quiz_streak"):
                unlocked.append("quiz_streak")
    unlocked += _check_streak_achievement(current_user.id, current_user.streak_days)

    if quiz.is_final_exam and passed:
        progress = CourseProgress.query.filter_by(user_id=current_user.id, course_id=quiz.course_id).first()
        if not progress:
            progress = CourseProgress(user_id=current_user.id, course_id=quiz.course_id)
            db.session.add(progress)
        progress.exam_score = result["score_percent"]
        if not progress.certificate_issued:
            progress.certificate_issued = True
            current_user.courses_completed = (current_user.courses_completed or 0) + 1
            if _unlock_achievement(current_user.id, "course_complete"):
                unlocked.append("course_complete")

    db.session.commit()
    return jsonify({
        "ok": True,
        "score_percent": result["score_percent"],
        "passed": passed,
        "feedback": result["feedback"],
        "unlocked_achievements": unlocked,
    })


@app.route("/api/courses/<int:course_id>/exam", methods=["GET"])
@login_required
def get_final_exam(course_id):
    course = db.session.get(Course, course_id)
    if not course or course.user_id != current_user.id:
        return jsonify({"ok": False, "error": "Course not found."}), 404

    existing = Quiz.query.filter_by(course_id=course.id, is_final_exam=True).first()
    if existing:
        return jsonify({"ok": True, "quiz": existing.to_public_dict()})

    try:
        client = _get_ai_client()
        summaries = [l.summary for m in course.modules for l in m.lessons]
        exam_data = ai_pipeline.generate_final_exam(client, course.title, summaries)

        quiz = Quiz(course_id=course.id, is_final_exam=True, title=f"Final Exam — {course.title}")
        db.session.add(quiz)
        db.session.flush()
        for q_idx, q in enumerate(exam_data.get("questions", [])):
            db.session.add(Question(
                quiz_id=quiz.id, order_index=q_idx, type=q["type"], prompt=q["prompt"],
                options_json=json.dumps(q.get("options", [])), correct_answer=q["correct_answer"],
                explanation=q.get("explanation", ""), topic_tag=q.get("topic_tag", "General"),
                difficulty=q.get("difficulty", "medium"),
            ))
        db.session.commit()
        return jsonify({"ok": True, "quiz": quiz.to_public_dict()})
    except Exception as exc:  # noqa: BLE001
        db.session.rollback()
        return jsonify({"ok": False, "error": f"Exam generation failed: {_friendly_ai_error(exc)}"}), 500


# ----------------------------------------------------------------------------
# Certificates
# ----------------------------------------------------------------------------

@app.route("/certificate/<int:course_id>")
@login_required
def certificate(course_id):
    course = db.session.get(Course, course_id)
    if not course or course.user_id != current_user.id:
        return redirect(url_for("dashboard"))
    progress = CourseProgress.query.filter_by(user_id=current_user.id, course_id=course.id).first()
    if not progress or not progress.certificate_issued:
        return redirect(url_for("dashboard"))
    return render_template("certificate.html", course=course, user=current_user, progress=progress)


# ----------------------------------------------------------------------------
# Progress + achievements
# ----------------------------------------------------------------------------

@app.route("/api/progress", methods=["GET"])
@login_required
def get_progress():
    attempts = QuizAttempt.query.filter_by(user_id=current_user.id).order_by(QuizAttempt.created_at.desc()).limit(20).all()
    weak_topics = (WeakTopic.query.filter_by(user_id=current_user.id)
                   .filter(WeakTopic.total_count > 0).all())
    weak_sorted = sorted(weak_topics, key=lambda w: w.accuracy())[:6]

    total_lessons = sum(c.total_lessons() for c in current_user.courses)
    completed_lessons = sum(p.completed_lesson_count() for p in
                             CourseProgress.query.filter_by(user_id=current_user.id).all())

    return jsonify({
        "xp": current_user.xp,
        "coins": current_user.coins,
        "streak_days": current_user.streak_days,
        "courses_completed": current_user.courses_completed,
        "percent_complete": round((completed_lessons / total_lessons) * 100) if total_lessons else 0,
        "quiz_scores": [{"quiz_title": a.quiz.title, "score_percent": a.score_percent,
                          "passed": a.passed, "date": a.created_at.isoformat()} for a in attempts],
        "weak_areas": [{"topic": w.topic, "accuracy": w.accuracy()} for w in weak_sorted],
    })


@app.route("/api/achievements", methods=["GET"])
@login_required
def get_achievements():
    unlocked_keys = {a.achievement_key for a in UserAchievement.query.filter_by(user_id=current_user.id).all()}
    result = []
    for a in ACHIEVEMENT_DEFS:
        result.append({**a, "unlocked": a["key"] in unlocked_keys})
    return jsonify({"achievements": result})


# ----------------------------------------------------------------------------
# AI Tutor
# ----------------------------------------------------------------------------

@app.route("/api/tutor/ask", methods=["POST"])
@login_required
def tutor_ask():
    data = request.get_json(silent=True) or {}
    course_id = data.get("course_id")
    mode = data.get("mode", "")
    question = (data.get("question") or "").strip()

    course = db.session.get(Course, course_id) if course_id else None
    if course and course.user_id != current_user.id:
        return jsonify({"ok": False, "error": "Course not found."}), 404
    if not course:
        latest = current_user.courses.filter_by(status="ready").first()
        course = latest

    if not course:
        return jsonify({"ok": False, "error": "Upload material first so the tutor has something to teach from."}), 400

    material = _course_source_text(course)
    db.session.add(TutorMessage(user_id=current_user.id, course_id=course.id, role="user",
                                 content=question or f"[{mode}]"))

    try:
        client = _get_ai_client()
        reply = ai_pipeline.tutor_reply(client, mode, material, question, language=current_user.language)
    except Exception as exc:  # noqa: BLE001
        db.session.rollback()
        return jsonify({"ok": False, "error": f"Tutor request failed: {_friendly_ai_error(exc)}"}), 500

    db.session.add(TutorMessage(user_id=current_user.id, course_id=course.id, role="assistant", content=reply))
    db.session.commit()

    asked_count = TutorMessage.query.filter_by(user_id=current_user.id, role="user").count()
    unlocked = []
    if asked_count >= 25 and _unlock_achievement(current_user.id, "deep_diver"):
        unlocked.append("deep_diver")
        db.session.commit()

    return jsonify({"ok": True, "reply": reply, "course_id": course.id, "unlocked_achievements": unlocked})


@app.route("/api/tutor/history", methods=["GET"])
@login_required
def tutor_history():
    course_id = request.args.get("course_id", type=int)
    query = TutorMessage.query.filter_by(user_id=current_user.id)
    if course_id:
        query = query.filter_by(course_id=course_id)
    messages = query.order_by(TutorMessage.created_at.asc()).limit(100).all()
    return jsonify({"messages": [{"role": m.role, "content": m.content} for m in messages]})


# ----------------------------------------------------------------------------
# Page routes — course library, lesson player, quiz taker, exam
# ----------------------------------------------------------------------------

@app.route("/course/<int:course_id>")
@login_required
def course_view(course_id):
    course = db.session.get(Course, course_id)
    if not course or course.user_id != current_user.id:
        return redirect(url_for("dashboard"))
    return render_template("course.html", course=course, user=current_user)


@app.route("/lesson/<int:lesson_id>")
@login_required
def lesson_view(lesson_id):
    lesson = db.session.get(Lesson, lesson_id)
    if not lesson or lesson.module.course.user_id != current_user.id:
        return redirect(url_for("dashboard"))
    course = lesson.module.course
    siblings = [l for m in course.modules for l in m.lessons]
    idx = next((i for i, l in enumerate(siblings) if l.id == lesson.id), 0)
    prev_lesson = siblings[idx - 1] if idx > 0 else None
    next_lesson = siblings[idx + 1] if idx < len(siblings) - 1 else None
    return render_template("lesson.html", lesson=lesson, course=course, user=current_user,
                            prev_lesson=prev_lesson, next_lesson=next_lesson)


@app.route("/quiz/<int:quiz_id>")
@login_required
def quiz_view(quiz_id):
    quiz = db.session.get(Quiz, quiz_id)
    if not quiz:
        return redirect(url_for("dashboard"))
    owner_id = quiz.lesson.module.course.user_id if quiz.lesson else db.session.get(Course, quiz.course_id).user_id
    if owner_id != current_user.id:
        return redirect(url_for("dashboard"))
    course = quiz.lesson.module.course if quiz.lesson else db.session.get(Course, quiz.course_id)
    return render_template("quiz.html", quiz=quiz, course=course, user=current_user)


@app.route("/exam/<int:course_id>")
@login_required
def exam_view(course_id):
    course = db.session.get(Course, course_id)
    if not course or course.user_id != current_user.id:
        return redirect(url_for("dashboard"))
    existing = Quiz.query.filter_by(course_id=course.id, is_final_exam=True).first()
    if existing:
        return redirect(url_for("quiz_view", quiz_id=existing.id))
    try:
        client = _get_ai_client()
        summaries = [l.summary for m in course.modules for l in m.lessons]
        exam_data = ai_pipeline.generate_final_exam(client, course.title, summaries)
        quiz = Quiz(course_id=course.id, is_final_exam=True, title=f"Final Exam — {course.title}")
        db.session.add(quiz)
        db.session.flush()
        for q_idx, q in enumerate(exam_data.get("questions", [])):
            db.session.add(Question(
                quiz_id=quiz.id, order_index=q_idx, type=q["type"], prompt=q["prompt"],
                options_json=json.dumps(q.get("options", [])), correct_answer=q["correct_answer"],
                explanation=q.get("explanation", ""), topic_tag=q.get("topic_tag", "General"),
                difficulty=q.get("difficulty", "medium"),
            ))
        db.session.commit()
        return redirect(url_for("quiz_view", quiz_id=quiz.id))
    except Exception as exc:  # noqa: BLE001
        db.session.rollback()
        flash(f"Could not generate the final exam: {_friendly_ai_error(exc)}", "error")
        return redirect(url_for("course_view", course_id=course.id))


@app.route("/api/settings", methods=["POST"])
@login_required
def update_settings():
    data = request.get_json(silent=True) or {}

    theme = data.get("theme")
    if theme in ("dark", "light"):
        current_user.theme = theme

    playback_speed = data.get("playback_speed")
    if isinstance(playback_speed, (int, float)) and 0.5 <= playback_speed <= 2.0:
        current_user.playback_speed = float(playback_speed)

    voice_speed = data.get("voice_speed")
    if isinstance(voice_speed, (int, float)) and 0.5 <= voice_speed <= 2.0:
        current_user.voice_speed = float(voice_speed)

    language = data.get("language")
    if isinstance(language, str) and 2 <= len(language) <= 8:
        current_user.language = language

    db.session.commit()
    return jsonify({"ok": True, "settings": current_user.to_settings_dict()})


# ----------------------------------------------------------------------------
# Error handlers
# ----------------------------------------------------------------------------

@app.errorhandler(404)
def not_found(_e):
    return render_template("404.html"), 404


@app.errorhandler(413)
def too_large(_e):
    flash("That file is too large to upload.", "error")
    return redirect(request.referrer or url_for("dashboard"))


# ----------------------------------------------------------------------------
# CLI / bootstrap
# ----------------------------------------------------------------------------

def create_tables():
    os.makedirs(os.path.join(BASE_DIR, "instance"), exist_ok=True)
    os.makedirs(app.config["UPLOAD_FOLDER"], exist_ok=True)
    os.makedirs(app.config["GENERATED_FOLDER"], exist_ok=True)
    with app.app_context():
        db.create_all()


# Run once at import time — this is what actually executes in production.
# gunicorn imports this module as `app:app` and never hits the __main__
# guard below, so anything DB/folder-setup related has to live out here or
# it silently never runs and every request 500s on a missing table.
create_tables()

if __name__ == "__main__":
    # Local dev only. Render (and any gunicorn/wsgi deployment) never
    # reaches this branch — see Procfile / render.yaml.
    app.run(debug=app.config["DEBUG"], host="0.0.0.0", port=int(os.environ.get("PORT", 5000)))