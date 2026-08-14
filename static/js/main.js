// Orbit — landing page interactions

document.addEventListener("DOMContentLoaded", () => {
  // FAQ accordion
  document.querySelectorAll(".faq-item__q").forEach((btn) => {
    btn.addEventListener("click", () => {
      const item = btn.closest(".faq-item");
      const answer = item.querySelector(".faq-item__a");
      const isOpen = item.classList.contains("is-open");

      document.querySelectorAll(".faq-item.is-open").forEach((open) => {
        if (open !== item) {
          open.classList.remove("is-open");
          open.querySelector(".faq-item__a").style.maxHeight = null;
        }
      });

      if (isOpen) {
        item.classList.remove("is-open");
        answer.style.maxHeight = null;
      } else {
        item.classList.add("is-open");
        answer.style.maxHeight = answer.scrollHeight + "px";
      }
    });
  });

  // Auto-dismiss flash messages
  setTimeout(() => {
    document.querySelectorAll(".flash").forEach((f) => {
      f.style.transition = "opacity 0.3s ease";
      f.style.opacity = "0";
      setTimeout(() => f.remove(), 300);
    });
  }, 5000);
});
