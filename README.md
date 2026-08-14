# Orbit — Local Setup

Orbit turns learning material into interactive cinematic 3D lessons.

This is for running the project **locally** after cloning it from GitHub.
For deploying it to Render, see `DEPLOY.md` instead.

## 1. Prerequisites

- Python 3.11+
- A [Groq API key](https://console.groq.com/keys) (lesson/scene generation
  calls the Groq API — the app will start without one, but generating a
  lesson will fail until it's set)
- Git

## 2. Clone the repo

```bash
git clone <your-repo-url>
cd orbit
```

## 3. Create a virtual environment

```bash
python3 -m venv venv

# macOS / Linux
source venv/bin/activate

# Windows (PowerShell)
venv\Scripts\Activate.ps1
```

## 4. Install dependencies

```bash
pip install -r requirements.txt
```

## 5. Set up your environment variables

Copy the example file and fill in your own values:

```bash
cp .env.example .env
```

Open `.env` and set at minimum:

```
GROQ_API_KEY=your-real-groq-key
ORBIT_SECRET_KEY=any-long-random-string
```

Leave `DATABASE_URL` blank — without it the app uses a local SQLite database
at `instance/orbit.db`, created automatically the first time you run it.
Leave `ORBIT_DEBUG=0` unless you want Flask's debug mode (auto-reload,
in-browser tracebacks) while developing — then set it to `1`.

## 6. Run the app

```bash
python app.py
```

The first run automatically creates the SQLite database and the
`static/uploads/` and `static/generated/` folders. You should see:

```
* Running on http://0.0.0.0:5000
```

Open **http://localhost:5000** in your browser.

## 7. Everyday use

- Stop the server: `Ctrl+C`
- Re-activate the virtualenv in a new terminal: `source venv/bin/activate`
  (or the Windows equivalent above)
- Your data persists between runs in `instance/orbit.db` and
  `static/uploads/` / `static/generated/` — delete those if you want a
  clean slate

## Troubleshooting

| Problem | Likely fix |
|---|---|
| `RuntimeError: GROQ_API_KEY is not set.` | You didn't set it in `.env`, or forgot to `cp .env.example .env` |
| `ModuleNotFoundError: ...` | Virtualenv isn't activated, or `pip install -r requirements.txt` wasn't run in it |
| Port 5000 already in use | Another process is using it — stop it, or run `PORT=5001 python app.py` |
| Changes to `.py` files don't show up | Set `ORBIT_DEBUG=1` in `.env` for auto-reload, or restart `python app.py` manually |
| Uploaded files/lessons disappeared | They live in `static/uploads/` and `static/generated/`, which are git-ignored and local-only — they're not lost on GitHub, they just never existed there |

## Project layout

```
app.py            Flask app — all routes (no blueprints, per project spec)
ai_pipeline.py     AI scene/storyboard generation (calls Groq)
extraction.py      PDF/document text extraction
engine.js          Three.js cinematic lesson renderer (static/js)
player.js          Lesson player controller (static/js)
player.css         Lesson player styles (static/css)
templates/         Flask/Jinja HTML templates
static/uploads/    User-uploaded source material (git-ignored)
static/generated/  Generated lesson assets (git-ignored)
instance/orbit.db  Local SQLite database (git-ignored)
```
