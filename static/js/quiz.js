// Orbit — quiz / exam taking

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("quizForm");
  const btnSubmit = document.getElementById("btnSubmit");
  const btnBack = document.getElementById("btnBack");
  const resultBox = document.getElementById("quizResult");
  let questions = [];

  fetch(`/api/quizzes/${QUIZ_ID}`)
    .then((r) => r.json())
    .then((data) => {
      if (!data.ok) { form.innerHTML = `<p class="dim-text">${escapeHtml(data.error || "Could not load this quiz.")}</p>`; btnSubmit.style.display = "none"; return; }
      questions = data.quiz.questions;
      form.innerHTML = questions.map((q, i) => renderQuestion(q, i)).join("");
    });

  function renderQuestion(q, index) {
    let body = "";
    if (q.type === "multiple_choice" || q.type === "true_false") {
      body = `<div class="quiz-options">${q.options.map((opt, i) => `
        <label class="quiz-option" data-qid="${q.id}">
          <input type="radio" name="q_${q.id}" value="${escapeAttr(opt)}">
          <span>${escapeHtml(opt)}</span>
        </label>
      `).join("")}</div>`;
    } else {
      body = `<input type="text" class="quiz-text-input" name="q_${q.id}" placeholder="Type your answer…">`;
    }
    return `
      <div class="quiz-question" data-question-id="${q.id}">
        <div class="quiz-question__meta">Question ${index + 1} · ${q.difficulty}</div>
        <div class="quiz-question__prompt">${escapeHtml(q.prompt)}</div>
        ${body}
        <div class="quiz-feedback-slot"></div>
      </div>
    `;
  }

  btnSubmit.addEventListener("click", () => {
    const answers = {};
    questions.forEach((q) => {
      if (q.type === "multiple_choice" || q.type === "true_false") {
        const checked = form.querySelector(`input[name="q_${q.id}"]:checked`);
        answers[q.id] = checked ? checked.value : "";
      } else {
        const input = form.querySelector(`input[name="q_${q.id}"]`);
        answers[q.id] = input ? input.value : "";
      }
    });

    btnSubmit.disabled = true;
    btnSubmit.textContent = "Grading…";

    fetch(`/api/quizzes/${QUIZ_ID}/submit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ answers }),
    })
      .then((r) => r.json())
      .then((data) => {
        if (!data.ok) { alert(data.error || "Could not grade this quiz."); btnSubmit.disabled = false; btnSubmit.textContent = "Submit answers"; return; }
        showResult(data);
      });
  });

  function showResult(data) {
    resultBox.style.display = "block";
    resultBox.innerHTML = `
      <div class="quiz-result__score">${data.score_percent}%</div>
      <div class="quiz-result__status ${data.passed ? 'passed' : 'failed'}">${data.passed ? 'Passed' : 'Not passed yet'}</div>
    `;
    resultBox.scrollIntoView({ behavior: "smooth" });

    data.feedback.forEach((f) => {
      const qBlock = form.querySelector(`[data-question-id="${f.question_id}"]`);
      if (!qBlock) return;
      qBlock.querySelectorAll(".quiz-option").forEach((opt) => {
        const input = opt.querySelector("input");
        if (input.value === f.correct_answer) opt.classList.add("is-correct");
        else if (input.checked) opt.classList.add("is-incorrect");
        input.disabled = true;
      });
      const textInput = qBlock.querySelector(".quiz-text-input");
      if (textInput) textInput.disabled = true;

      const slot = qBlock.querySelector(".quiz-feedback-slot");
      slot.innerHTML = `<div class="quiz-feedback ${f.correct ? 'is-correct' : 'is-incorrect'}">
        ${f.correct ? 'Correct.' : `Correct answer: ${escapeHtml(f.correct_answer)}.`} ${escapeHtml(f.explanation || f.feedback || '')}
      </div>`;
    });

    btnSubmit.style.display = "none";
    btnBack.style.display = "inline-flex";
  }

  function escapeHtml(str) {
    const div = document.createElement("div");
    div.textContent = str == null ? "" : str;
    return div.innerHTML;
  }
  function escapeAttr(str) { return escapeHtml(str).replace(/"/g, "&quot;"); }
});
