// Orbit — course library view

document.addEventListener("DOMContentLoaded", () => {
  const modulesContainer = document.getElementById("modulesContainer");
  const difficultyEl = document.getElementById("courseDifficulty");
  const progressFill = document.getElementById("courseProgressFill");
  const progressLabel = document.getElementById("courseProgressLabel");
  const btnExam = document.getElementById("btnExam");
  const btnCertificate = document.getElementById("btnCertificate");

  fetch(`/api/courses/${COURSE_ID}`)
    .then((r) => r.json())
    .then((data) => {
      if (!data.ok) {
        modulesContainer.innerHTML = `<p class="dim-text">${escapeHtml(data.error || "Could not load this course.")}</p>`;
        return;
      }
      difficultyEl.textContent = `${data.course.difficulty} · ${data.course.lesson_count} lessons`;
      progressFill.style.width = `${data.course.percent_complete}%`;
      progressLabel.textContent = `${data.course.percent_complete}% complete`;

      if (data.certificate_issued) {
        btnCertificate.style.display = "inline-flex";
        btnExam.textContent = "Retake the final exam";
      }

      modulesContainer.innerHTML = data.modules.map((mod) => `
        <div class="module-block">
          <h3>${escapeHtml(mod.title)}</h3>
          <p>${escapeHtml(mod.description)}</p>
          ${mod.lessons.map((lesson) => `
            <div class="lesson-row ${lesson.completed ? 'is-complete' : ''}" data-lesson-id="${lesson.id}">
              <div class="lesson-row__left">
                <div class="lesson-row__check">${lesson.completed ? '✓' : ''}</div>
                <div>
                  <div class="lesson-row__title">${escapeHtml(lesson.title)}</div>
                  <div class="lesson-row__summary">${escapeHtml(lesson.summary)}</div>
                </div>
              </div>
              <span class="lesson-row__go">Watch &rarr;</span>
            </div>
          `).join("")}
        </div>
      `).join("");

      modulesContainer.querySelectorAll(".lesson-row").forEach((row) => {
        row.addEventListener("click", () => { window.location.href = `/lesson/${row.dataset.lessonId}`; });
      });
    })
    .catch(() => { modulesContainer.innerHTML = `<p class="dim-text">Something went wrong loading this course.</p>`; });

  btnExam.addEventListener("click", () => {
    btnExam.disabled = true;
    btnExam.textContent = "Preparing exam…";
    fetch(`/api/courses/${COURSE_ID}/exam`)
      .then((r) => r.json())
      .then((data) => {
        if (data.ok) window.location.href = `/quiz/${data.quiz.id}`;
        else { alert(data.error || "Could not build the exam."); btnExam.disabled = false; btnExam.textContent = "Take the final exam"; }
      });
  });

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : str;
    return div.innerHTML;
  }
});
