// Orbit — dashboard interactions

document.addEventListener("DOMContentLoaded", () => {
  const sidebar = document.getElementById("dashSidebar");
  const scrim = document.getElementById("dashScrim");
  const drawerToggle = document.getElementById("drawerToggle");

  // ---------------------------------------------------------------
  // Sidebar navigation — swap panels client-side, no page reload
  // ---------------------------------------------------------------
  const navItems = document.querySelectorAll(".dash-nav__item");
  const panels = document.querySelectorAll(".dash-panel");

  function showSection(name) {
    navItems.forEach((btn) => btn.classList.toggle("is-active", btn.dataset.section === name));
    panels.forEach((panel) => panel.classList.toggle("is-active", panel.dataset.panel === name));
    closeDrawer();
    window.scrollTo({ top: 0, behavior: "instant" in window ? "instant" : "auto" });
    if (name === "upload") loadUploads();
    if (name === "courses") loadCourses();
    if (name === "tutor") loadTutor();
    if (name === "progress") loadProgress();
    if (name === "achievements") loadAchievements();
  }

  loadHomeDashboard();

  navItems.forEach((btn) => btn.addEventListener("click", () => showSection(btn.dataset.section)));
  document.querySelectorAll("[data-goto]").forEach((btn) => {
    btn.addEventListener("click", () => showSection(btn.dataset.goto));
  });

  // ---------------------------------------------------------------
  // Mobile drawer
  // ---------------------------------------------------------------
  function openDrawer() { sidebar.classList.add("is-open"); scrim.classList.add("is-visible"); }
  function closeDrawer() { sidebar.classList.remove("is-open"); scrim.classList.remove("is-visible"); }
  if (drawerToggle) drawerToggle.addEventListener("click", openDrawer);
  if (scrim) scrim.addEventListener("click", closeDrawer);

  // ---------------------------------------------------------------
  // Upload tabs
  // ---------------------------------------------------------------
  document.querySelectorAll(".upload-tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      document.querySelectorAll(".upload-tab").forEach((t) => t.classList.remove("is-active"));
      document.querySelectorAll(".upload-panel").forEach((p) => p.classList.remove("is-active"));
      tab.classList.add("is-active");
      document.querySelector(`.upload-panel[data-tabpanel="${tab.dataset.tab}"]`).classList.add("is-active");
    });
  });

  // ---------------------------------------------------------------
  // File dropzone
  // ---------------------------------------------------------------
  const dropzone = document.getElementById("dropzone");
  const fileInput = document.getElementById("fileInput");

  if (dropzone && fileInput) {
    dropzone.addEventListener("click", () => fileInput.click());
    dropzone.addEventListener("dragover", (e) => { e.preventDefault(); dropzone.classList.add("is-dragover"); });
    dropzone.addEventListener("dragleave", () => dropzone.classList.remove("is-dragover"));
    dropzone.addEventListener("drop", (e) => {
      e.preventDefault();
      dropzone.classList.remove("is-dragover");
      if (e.dataTransfer.files.length) uploadFile(e.dataTransfer.files[0]);
    });
    fileInput.addEventListener("change", () => {
      if (fileInput.files.length) uploadFile(fileInput.files[0]);
      fileInput.value = "";
    });
  }

  function uploadFile(file) {
    const formData = new FormData();
    formData.append("file", file);
    fetch("/api/uploads", { method: "POST", body: formData })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) { loadUploads(); }
        else { alert(data.error || "Upload failed."); }
      })
      .catch(() => alert("Upload failed — check your connection and try again."));
  }

  // Paste text
  const pasteSubmit = document.getElementById("pasteSubmit");
  if (pasteSubmit) {
    pasteSubmit.addEventListener("click", () => {
      const text = document.getElementById("pasteText").value.trim();
      if (text.length < 20) { alert("Paste at least a few sentences of text."); return; }
      fetch("/api/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "pasted", text }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.ok) { document.getElementById("pasteText").value = ""; loadUploads(); }
          else { alert(data.error || "Could not save that text."); }
        });
    });
  }

  // YouTube link
  const youtubeSubmit = document.getElementById("youtubeSubmit");
  if (youtubeSubmit) {
    youtubeSubmit.addEventListener("click", () => {
      const url = document.getElementById("youtubeUrl").value.trim();
      fetch("/api/uploads", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ kind: "youtube", url }),
      })
        .then((r) => r.json())
        .then((data) => {
          if (data.ok) { document.getElementById("youtubeUrl").value = ""; loadUploads(); }
          else { alert(data.error || "Could not save that link."); }
        });
    });
  }

  function formatBytes(bytes) {
    if (!bytes) return "0 KB";
    const units = ["B", "KB", "MB", "GB"];
    let i = 0, val = bytes;
    while (val >= 1024 && i < units.length - 1) { val /= 1024; i++; }
    return `${val.toFixed(val < 10 && i > 0 ? 1 : 0)} ${units[i]}`;
  }

  function loadUploads() {
    const list = document.getElementById("uploadsList");
    if (!list) return;
    fetch("/api/uploads")
      .then((r) => r.json())
      .then((data) => {
        const uploads = data.uploads || [];
        if (!uploads.length) {
          list.innerHTML = `<p class="uploads-empty">Nothing uploaded yet — your files will show up here.</p>`;
          return;
        }
        list.innerHTML = uploads.map((u) => `
          <div class="upload-row">
            <div>
              <div class="upload-row__name">${escapeHtml(u.name)}</div>
              <div class="upload-row__meta">${u.type.toUpperCase()} · ${formatBytes(u.size_bytes)}</div>
            </div>
            <div style="display:flex; align-items:center; gap:10px;">
              <span class="upload-row__status">${u.status}</span>
              <button class="btn btn--ghost generate-course-btn" data-upload-id="${u.id}" style="padding:8px 14px; font-size:12.5px;">Generate course</button>
            </div>
          </div>
        `).join("");
        list.querySelectorAll(".generate-course-btn").forEach((btn) => {
          btn.addEventListener("click", () => generateCourse(btn));
        });
      });
  }

  function generateCourse(btn) {
    const uploadId = btn.dataset.uploadId;
    btn.disabled = true;
    btn.textContent = "Generating…";
    fetch(`/api/uploads/${uploadId}/generate-course`, { method: "POST" })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) {
          btn.textContent = "Course ready ✓";
          showSection("courses");
        } else {
          alert(data.error || "Course generation failed.");
          btn.disabled = false;
          btn.textContent = "Generate course";
        }
      })
      .catch(() => { alert("Course generation failed — check your connection."); btn.disabled = false; btn.textContent = "Generate course"; });
  }

  // ---------------------------------------------------------------
  // Home — hero banner, course list, progress mini charts
  // ---------------------------------------------------------------
  function statusBadge(course) {
    if (course.status === "generating") return ['home-course-row__badge--generating', 'Generating'];
    if (course.status === "failed") return ['home-course-row__badge--failed', 'Failed'];
    if (course.percent_complete >= 100) return ['home-course-row__badge--done', 'Completed'];
    if (course.percent_complete > 0) return ['home-course-row__badge--progress', 'In progress'];
    return ['home-course-row__badge--progress', 'Not started'];
  }

  function renderHero(courses) {
    const hero = document.getElementById("dashHero");
    if (!hero) return;
    const inProgress = courses.find((c) => c.status === "ready" && c.percent_complete > 0 && c.percent_complete < 100);
    const anyReady = courses.find((c) => c.status === "ready");
    const featured = inProgress || anyReady;

    if (featured) {
      hero.innerHTML = `
        <div class="dash-hero__tag">${escapeHtml(featured.difficulty)}</div>
        <h1 class="dash-hero__title">${escapeHtml(featured.title)}</h1>
        <p class="dash-hero__sub">${escapeHtml((featured.description || '').slice(0, 140))}</p>
        <button class="dash-hero__cta" id="heroCta">▶ Continue course</button>
      `;
      document.getElementById("heroCta").addEventListener("click", () => { window.location.href = `/course/${featured.id}`; });
    } else {
      hero.innerHTML = `
        <div class="dash-hero__tag">Get started</div>
        <h1 class="dash-hero__title">Turn your first document into a course</h1>
        <p class="dash-hero__sub">Upload a PDF, slide deck, or recording — Orbit builds the modules, lessons, and 3D-animated explanations automatically.</p>
        <button class="dash-hero__cta" id="heroCta">▶ Upload material</button>
      `;
      document.getElementById("heroCta").addEventListener("click", () => showSection("upload"));
    }
  }

  function renderHomeCourseList(courses) {
    const container = document.getElementById("homeCoursesList");
    if (!container || !courses.length) return;
    container.innerHTML = courses.map((c) => {
      const [badgeClass, badgeText] = statusBadge(c);
      return `
        <div class="home-course-row" data-course-id="${c.id}" data-status="${c.status}">
          <div class="home-course-row__icon">◈</div>
          <div class="home-course-row__body">
            <div class="home-course-row__title">${escapeHtml(c.title)}</div>
            <div class="home-course-row__meta">${c.lesson_count} lessons · ${c.difficulty}</div>
            <div class="home-course-row__bar"><span style="width:${c.percent_complete}%"></span></div>
          </div>
          <span class="home-course-row__badge ${badgeClass}">${badgeText}</span>
        </div>
      `;
    }).join("");
    container.querySelectorAll(".home-course-row").forEach((row) => {
      row.addEventListener("click", () => {
        if (row.dataset.status === "ready") window.location.href = `/course/${row.dataset.courseId}`;
      });
    });
  }

  function renderProgressMini(progress) {
    const scores = (progress.quiz_scores || []).slice(0, 6).reverse();
    const barsEl = document.getElementById("miniBars");
    const valueEl = document.querySelector("#progressMiniGrid .mini-card__value");
    if (barsEl) {
      if (scores.length) {
        barsEl.innerHTML = scores.map((s) => `<span style="height:${Math.max(6, s.score_percent)}%"></span>`).join("");
        const avg = Math.round(scores.reduce((sum, s) => sum + s.score_percent, 0) / scores.length);
        if (valueEl) valueEl.innerHTML = `${avg}%<small>avg score</small>`;
      } else {
        barsEl.innerHTML = `<span style="height:8%"></span>`.repeat(6);
        if (valueEl) valueEl.innerHTML = `—<small>no quizzes yet</small>`;
      }
    }

    const trend = document.getElementById("miniTrend");
    if (trend) {
      if (scores.length >= 2) {
        const w = 220, h = 70, pad = 6;
        const points = scores.map((s, i) => {
          const x = pad + (i / (scores.length - 1)) * (w - pad * 2);
          const y = h - pad - (s.score_percent / 100) * (h - pad * 2);
          return `${x},${y}`;
        });
        trend.innerHTML = `<polyline points="${points.join(' ')}" fill="none" stroke="var(--brass)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />`;
      } else {
        trend.innerHTML = `<text x="110" y="38" text-anchor="middle" fill="var(--parchment-dim)" font-size="11" font-family="var(--font-mono)">Not enough data yet</text>`;
      }
    }
  }

  function loadHomeDashboard() {
    Promise.all([
      fetch("/api/courses").then((r) => r.json()),
      fetch("/api/progress").then((r) => r.json()),
    ]).then(([courseData, progress]) => {
      const courses = courseData.courses || [];
      renderHero(courses);
      renderHomeCourseList(courses);
      renderProgressMini(progress);
    });
  }

  // ---------------------------------------------------------------
  // My Courses
  // ---------------------------------------------------------------
  function loadCourses() {
    const container = document.getElementById("coursesContainer");
    if (!container) return;
    fetch("/api/courses")
      .then((r) => r.json())
      .then((data) => {
        const courses = data.courses || [];
        if (!courses.length) return; // keep the default empty state markup
        container.innerHTML = `<div class="stat-grid" style="grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));">
          ${courses.map((c) => `
            <div class="panel-card course-card" data-course-id="${c.id}" style="cursor:${c.status === 'ready' ? 'pointer' : 'default'};">
              <div class="eyebrow">${c.difficulty} · ${c.status}</div>
              <h3 style="font-size:17px; margin:10px 0 6px;">${escapeHtml(c.title)}</h3>
              <p class="dim-text" style="margin-bottom:14px;">${escapeHtml(c.description || '').slice(0, 110)}</p>
              <div class="course-progress-bar"><span style="width:${c.percent_complete}%"></span></div>
              <div class="dim-text" style="margin-top:8px; font-family: var(--font-mono); font-size:12px;">${c.lesson_count} lessons · ${c.percent_complete}% complete</div>
            </div>
          `).join("")}
        </div>`;
        container.querySelectorAll(".course-card").forEach((card) => {
          card.addEventListener("click", () => {
            const id = card.dataset.courseId;
            const course = courses.find((c) => String(c.id) === id);
            if (course && course.status === "ready") window.location.href = `/course/${id}`;
          });
        });
      });
  }

  // ---------------------------------------------------------------
  // AI Tutor
  // ---------------------------------------------------------------
  const TUTOR_MODES = [
    ["explain_again", "Explain again"], ["simplify", "Simplify"], ["more_examples", "More examples"],
    ["real_world", "Real-world example"], ["analogy", "Analogy"], ["practice", "Practice questions"],
  ];

  function loadTutor() {
    const container = document.getElementById("tutorContainer");
    if (!container) return;
    fetch("/api/courses")
      .then((r) => r.json())
      .then((data) => {
        const readyCourse = (data.courses || []).find((c) => c.status === "ready");
        if (!readyCourse) return; // keep default empty state
        renderTutorChat(container, readyCourse.id);
      });
  }

  function renderTutorChat(container, courseId) {
    container.innerHTML = `
      <div class="panel-card" style="display:flex; flex-direction:column; height:520px;">
        <div id="tutorMessages" style="flex-grow:1; overflow-y:auto; display:flex; flex-direction:column; gap:12px; padding-bottom:12px;"></div>
        <div style="display:flex; gap:8px; flex-wrap:wrap; margin-bottom:12px;">
          ${TUTOR_MODES.map(([key, label]) => `<button class="upload-tab tutor-mode-btn" data-mode="${key}">${label}</button>`).join("")}
        </div>
        <div style="display:flex; gap:10px;">
          <input type="text" id="tutorInput" class="field-input" placeholder="Ask a question about your course…" style="flex-grow:1;">
          <button class="btn btn--brass" id="tutorSend">Send</button>
        </div>
      </div>
    `;

    const messages = document.getElementById("tutorMessages");
    const input = document.getElementById("tutorInput");

    function addMessage(role, text) {
      const bubble = document.createElement("div");
      bubble.style.cssText = `max-width:80%; padding:12px 16px; border-radius:12px; font-size:14px; line-height:1.5; ${
        role === "user"
          ? "align-self:flex-end; background:var(--brass); color:var(--ink);"
          : "align-self:flex-start; background:var(--ink); border:1px solid var(--line);"
      }`;
      bubble.textContent = text;
      messages.appendChild(bubble);
      messages.scrollTop = messages.scrollHeight;
    }

    fetch(`/api/tutor/history?course_id=${courseId}`)
      .then((r) => r.json())
      .then((data) => (data.messages || []).forEach((m) => addMessage(m.role, m.content)));

    function ask(mode, question) {
      if (question) addMessage("user", question);
      const thinking = document.createElement("div");
      thinking.textContent = "…";
      thinking.style.cssText = "align-self:flex-start; color:var(--parchment-dim); font-family:var(--font-mono); font-size:13px;";
      messages.appendChild(thinking);
      messages.scrollTop = messages.scrollHeight;

      fetch("/api/tutor/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ course_id: courseId, mode, question }),
      })
        .then((r) => r.json())
        .then((data) => {
          thinking.remove();
          if (data.ok) addMessage("assistant", data.reply);
          else addMessage("assistant", data.error || "Something went wrong.");
        });
    }

    document.getElementById("tutorSend").addEventListener("click", () => {
      const q = input.value.trim();
      if (!q) return;
      ask("", q);
      input.value = "";
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") document.getElementById("tutorSend").click(); });

    container.querySelectorAll(".tutor-mode-btn").forEach((btn) => {
      btn.addEventListener("click", () => ask(btn.dataset.mode, `[${btn.textContent}]`));
    });
  }

  // ---------------------------------------------------------------
  // Progress
  // ---------------------------------------------------------------
  function loadProgress() {
    fetch("/api/progress")
      .then((r) => r.json())
      .then((data) => {
        const grid = document.getElementById("progressStatGrid");
        if (grid) {
          grid.innerHTML = `
            <div class="stat-card"><span class="stat-card__label">XP</span><span class="stat-card__value">${data.xp}</span></div>
            <div class="stat-card"><span class="stat-card__label">Coins</span><span class="stat-card__value">${data.coins}</span></div>
            <div class="stat-card"><span class="stat-card__label">Streak</span><span class="stat-card__value">${data.streak_days}<small>days</small></span></div>
            <div class="stat-card"><span class="stat-card__label">Completion</span><span class="stat-card__value">${data.percent_complete}<small>%</small></span></div>
          `;
        }

        const scores = document.getElementById("quizScoresContainer");
        if (scores) {
          if (!data.quiz_scores.length) {
            scores.innerHTML = `<p class="dim-text">No quizzes taken yet — scores will chart here once you complete your first lesson.</p>`;
          } else {
            scores.innerHTML = data.quiz_scores.map((s) => `
              <div class="upload-row">
                <div>
                  <div class="upload-row__name">${escapeHtml(s.quiz_title)}</div>
                  <div class="upload-row__meta">${new Date(s.date).toLocaleDateString()}</div>
                </div>
                <span class="upload-row__status" style="border-color: ${s.passed ? 'var(--verdigris)' : 'var(--rust)'}; color:${s.passed ? 'var(--verdigris)' : 'var(--rust)'};">${s.score_percent}%</span>
              </div>
            `).join("");
          }
        }

        const weak = document.getElementById("weakAreasContainer");
        if (weak) {
          if (!data.weak_areas.length) {
            weak.innerHTML = `<p class="dim-text">Orbit will surface topics you struggle with once you've taken a few quizzes.</p>`;
          } else {
            weak.innerHTML = data.weak_areas.map((w) => `
              <div class="upload-row">
                <div class="upload-row__name">${escapeHtml(w.topic)}</div>
                <span class="upload-row__status" style="border-color: var(--rust); color:var(--rust);">${w.accuracy}% accuracy</span>
              </div>
            `).join("");
          }
        }
      });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : str;
    return div.innerHTML;
  }

  // ---------------------------------------------------------------
  // Achievements
  // ---------------------------------------------------------------
  const ACHIEVEMENT_ICONS = {
    first_orbit: "◉", first_lesson: "◈", quiz_streak: "◆",
    seven_day_streak: "☀", course_complete: "✺", deep_diver: "✹",
  };

  function loadAchievements() {
    const grid = document.getElementById("achievementsGrid");
    if (!grid) return;
    fetch("/api/achievements")
      .then((r) => r.json())
      .then((data) => {
        grid.innerHTML = (data.achievements || []).map((a) => `
          <div class="achievement" style="opacity:${a.unlocked ? '1' : '0.55'};">
            <div class="achievement__ring" style="${a.unlocked ? 'border-color:var(--brass); color:var(--brass);' : ''}">${ACHIEVEMENT_ICONS[a.key] || '◎'}</div>
            <h4>${escapeHtml(a.name)}</h4>
            <p>${escapeHtml(a.description)}</p>
          </div>
        `).join("");
      });
  }

  // ---------------------------------------------------------------
  // Settings — theme, playback speed, voice speed, language
  // ---------------------------------------------------------------
  const savedNote = document.getElementById("settingsSavedNote");
  function flashSaved() {
    if (!savedNote) return;
    savedNote.classList.add("is-visible");
    setTimeout(() => savedNote.classList.remove("is-visible"), 1600);
  }

  function saveSettings(payload) {
    fetch("/api/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    })
      .then((r) => r.json())
      .then((data) => { if (data.ok) flashSaved(); });
  }

  const themeSegmented = document.getElementById("themeSegmented");
  if (themeSegmented) {
    themeSegmented.querySelectorAll("button").forEach((btn) => {
      btn.addEventListener("click", () => {
        themeSegmented.querySelectorAll("button").forEach((b) => b.classList.remove("is-active"));
        btn.classList.add("is-active");
        document.documentElement.setAttribute("data-theme", btn.dataset.value);
        saveSettings({ theme: btn.dataset.value });
      });
    });
  }

  const playbackSpeed = document.getElementById("playbackSpeed");
  if (playbackSpeed) playbackSpeed.addEventListener("change", () => saveSettings({ playback_speed: parseFloat(playbackSpeed.value) }));

  const voiceSpeed = document.getElementById("voiceSpeed");
  if (voiceSpeed) voiceSpeed.addEventListener("change", () => saveSettings({ voice_speed: parseFloat(voiceSpeed.value) }));

  const language = document.getElementById("language");
  if (language) language.addEventListener("change", () => saveSettings({ language: language.value }));
});
