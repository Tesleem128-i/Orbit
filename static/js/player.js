// Orbit — lesson player controller

document.addEventListener("DOMContentLoaded", () => {
  const stage = document.getElementById("stage");
  const loading = document.getElementById("loading");
  const loadingText = document.getElementById("loadingText");
  const subtitleEl = document.getElementById("subtitle");
  const btnPlay = document.getElementById("btnPlay");
  const btnRestart = document.getElementById("btnRestart");
  const btnPrev = document.getElementById("btnPrev");
  const btnNext = document.getElementById("btnNext");
  const btnFullscreen = document.getElementById("btnFullscreen");
  const seekBar = document.getElementById("seekBar");
  const speedSelect = document.getElementById("speedSelect");
  const btnQuiz = document.getElementById("btnQuiz");
  const completeNote = document.getElementById("completeNote");

  let engine = null;
  let seeking = false;
  let hasCompleted = false;

  // ---------------------------------------------------------------
  // Ambient music toggle — injected into the transport bar next to the
  // speed selector so no HTML template changes are required. Preference
  // persists across lessons via localStorage (read inside engine.js).
  // ---------------------------------------------------------------
  let musicEnabled = window.localStorage ? window.localStorage.getItem("orbit_music_enabled") !== "off" : true;
  const btnMusic = document.createElement("button");
  btnMusic.type = "button";
  btnMusic.className = "player-btn player-btn--music";
  btnMusic.title = "Toggle background music";
  btnMusic.setAttribute("aria-label", "Toggle background music");
  btnMusic.textContent = musicEnabled ? "♪" : "♪̶";
  btnMusic.classList.toggle("is-muted", !musicEnabled);
  if (speedSelect && speedSelect.parentNode) {
    speedSelect.parentNode.insertBefore(btnMusic, speedSelect);
  }
  btnMusic.addEventListener("click", () => {
    musicEnabled = !musicEnabled;
    btnMusic.textContent = musicEnabled ? "♪" : "♪̶";
    btnMusic.classList.toggle("is-muted", !musicEnabled);
    if (engine) engine.setMusicEnabled(musicEnabled);
  });

  // ---------------------------------------------------------------
  // Watch / Read notes tabs
  // ---------------------------------------------------------------
  const viewTabs = document.querySelectorAll(".player-view-tab");
  const viewPanels = document.querySelectorAll(".player-view");
  let notesLoaded = false;

  viewTabs.forEach((tab) => {
    tab.addEventListener("click", () => {
      viewTabs.forEach((t) => t.classList.toggle("is-active", t === tab));
      viewPanels.forEach((p) => { p.style.display = p.dataset.viewPanel === tab.dataset.view ? "" : "none"; });
      if (tab.dataset.view === "watch" && engine && !engine.isPlaying) {
        // leave paused as the user left it — no auto-resume
      }
      if (tab.dataset.view === "notes") {
        if (engine && engine.isPlaying) { engine.pause(); btnPlay.textContent = "▶"; }
        if (!notesLoaded) loadNotes();
      }
    });
  });

  function loadNotes() {
    notesLoaded = true;
    const notesLoading = document.getElementById("notesLoading");
    const notesContent = document.getElementById("notesContent");
    fetch(`/api/lessons/${LESSON_ID}/notes`)
      .then((r) => r.json())
      .then((data) => {
        notesLoading.style.display = "none";
        notesContent.style.display = "block";
        if (!data.ok) {
          notesContent.innerHTML = `<p class="dim-text">${escapeHtml(data.error || "Could not load notes for this lesson.")}</p>`;
          return;
        }
        notesContent.innerHTML = data.notes.sections.map((s) => `
          <div class="notes-section">
            <h3>${escapeHtml(s.heading)}</h3>
            <p>${escapeHtml(s.body)}</p>
          </div>
        `).join("");
      })
      .catch(() => {
        notesLoading.style.display = "none";
        notesContent.style.display = "block";
        notesContent.innerHTML = `<p class="dim-text">Something went wrong loading the notes. Try refreshing.</p>`;
      });
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : str;
    return div.innerHTML;
  }

  const hudStatus = document.getElementById("hudStatus");
  function setHudStatus(text) { if (hudStatus) hudStatus.textContent = text; }

  fetch(`/api/lessons/${LESSON_ID}/scene`)
    .then((r) => r.json())
    .then((data) => {
      if (!data.ok) {
        loadingText.textContent = data.error || "Could not build this lesson's scene.";
        setHudStatus("ERROR");
        return;
      }
      engine = new OrbitSceneEngine(stage, data.scene, {
        onProgress: (frac) => { if (!seeking) seekBar.value = Math.round(frac * 1000); },
        onSubtitle: (text) => { subtitleEl.textContent = text || ""; subtitleEl.style.opacity = text ? "1" : "0"; },
        onEnd: () => {
          btnPlay.textContent = "▶";
          setHudStatus("COMPLETE");
          markComplete();
        },
      });
      // WebGPURenderer.init() is asynchronous — wait for setup before playing.
      return engine.ready.then(() => {
        loading.style.display = "none";
        engine.play();
        btnPlay.textContent = "⏸";
        setHudStatus(engine.rendererKind === "webgpu" ? "LIVE RENDER · WEBGPU" : "LIVE RENDER");
        wireExportButton();
      });
    })
    .catch((err) => {
      console.error("[Orbit] Lesson player failed to start:", err);
      loadingText.textContent = "Something went wrong loading this lesson. Check the browser console for details, or try refreshing.";
      setHudStatus("ERROR");
    });

  btnPlay.addEventListener("click", () => {
    if (!engine) return;
    if (engine.isPlaying) { engine.pause(); btnPlay.textContent = "▶"; setHudStatus("PAUSED"); }
    else { engine.play(); btnPlay.textContent = "⏸"; setHudStatus("LIVE RENDER"); }
  });

  btnRestart.addEventListener("click", () => {
    if (!engine) return;
    engine.restart();
    btnPlay.textContent = "⏸";
  });

  speedSelect.addEventListener("change", () => {
    if (!engine) return;
    const speed = parseFloat(speedSelect.value);
    engine.setSpeed(speed);
    engine.setVoiceSpeed(speed);
  });

  seekBar.addEventListener("mousedown", () => { seeking = true; });
  seekBar.addEventListener("touchstart", () => { seeking = true; });
  seekBar.addEventListener("change", () => {
    if (!engine) return;
    engine.seekFraction(seekBar.value / 1000);
    seeking = false;
  });

  btnFullscreen.addEventListener("click", () => {
    if (!document.fullscreenElement) stage.requestFullscreen?.();
    else document.exitFullscreen?.();
  });

  if (btnPrev && PREV_LESSON_ID) {
    btnPrev.addEventListener("click", () => { window.location.href = `/lesson/${PREV_LESSON_ID}`; });
  }
  if (btnNext && NEXT_LESSON_ID) {
    btnNext.addEventListener("click", () => { window.location.href = `/lesson/${NEXT_LESSON_ID}`; });
  }

  btnQuiz.addEventListener("click", () => {
    fetch(`/api/lessons/${LESSON_ID}/quiz`)
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) window.location.href = `/quiz/${data.quiz.id}`;
        else alert(data.error || "Could not load the quiz.");
      });
  });

  function markComplete() {
    if (hasCompleted) return;
    hasCompleted = true;
    fetch(`/api/lessons/${LESSON_ID}/complete`, { method: "POST" })
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) completeNote.textContent = `Lesson complete — +25 XP · streak ${data.streak_days} days`;
      });
  }

  // ---------------------------------------------------------------
  // Video export (Phase 4 of the architecture doc) — captures the
  // canvas via MediaRecorder and downloads a .webm file. Note: this is
  // VISUAL ONLY. The Web Speech API does not expose synthesized speech
  // as a capturable audio track in any current browser, so narration
  // audio cannot be baked into the exported file — only real recorded
  // narration audio (a future TTS-API upgrade) could fix that.
  // ---------------------------------------------------------------
  let mediaRecorder = null;
  let recordedChunks = [];

  function wireExportButton() {
    const btnExport = document.getElementById("btnExport");
    if (!btnExport || !engine || !engine.renderer || !engine.renderer.domElement.captureStream) {
      return; // captureStream unsupported in this browser — quietly skip, don't advertise a broken feature
    }
    btnExport.style.display = "inline-flex";
    btnExport.addEventListener("click", () => {
      if (mediaRecorder && mediaRecorder.state === "recording") {
        mediaRecorder.stop();
        return;
      }
      startExport(btnExport);
    });
  }

  function startExport(btnExport) {
    const canvas = engine.renderer.domElement;
    const stream = canvas.captureStream(30);
    recordedChunks = [];
    const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9") ? "video/webm;codecs=vp9" : "video/webm";

    try {
      mediaRecorder = new MediaRecorder(stream, { mimeType });
    } catch (err) {
      alert("Video export isn't supported in this browser.");
      return;
    }

    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = () => {
      const blob = new Blob(recordedChunks, { type: "video/webm" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `orbit-lesson-${LESSON_ID}.webm`;
      a.click();
      URL.revokeObjectURL(url);
      btnExport.textContent = "⬇ VIDEO";
      btnExport.disabled = false;
    };

    engine.restart();
    mediaRecorder.start();
    btnExport.textContent = "■ STOP";
    engine.play();

    const stopWhenSceneEnds = () => {
      if (!mediaRecorder || mediaRecorder.state !== "recording") return;
      if (!engine.isPlaying) { mediaRecorder.stop(); return; }
      requestAnimationFrame(stopWhenSceneEnds);
    };
    requestAnimationFrame(stopWhenSceneEnds);
  }

  window.addEventListener("beforeunload", () => { if (engine) engine.dispose(); });
});
