(() => {
  "use strict";

  // ---------------------------------------------------------
  // CONFIG: edit these values only
  // ---------------------------------------------------------
  // For deployment, set window.API_BASE before this script loads, e.g.
  // <script>window.API_BASE = "https://your-api.example.com";</script>
  const API_BASE = window.API_BASE || "http://127.0.0.1:8000";
  const REQUEST_TIMEOUT_MS = 20000;

  // Shown when the predicted score is in the "strained" band.
  // Replace with a helpline for your users' region if needed.
  const SUPPORT_TEXT =
    "Consider talking to someone you trust or a counsellor. In India, Tele-MANAS offers free, 24×7 support on 14416 or 1-800-891-4416. Elsewhere, search for your local mental health helpline.";

  const form = document.getElementById("predict-form");
  const submitBtn = document.getElementById("submit-btn");
  const resetBtn = document.getElementById("reset-btn");
  const errorRetryBtn = document.getElementById("error-retry-btn");

  const stateIdle = document.getElementById("state-idle");
  const stateLoading = document.getElementById("state-loading");
  const stateResult = document.getElementById("state-result");
  const stateError = document.getElementById("state-error");

  const scoreNumberEl = document.getElementById("score-number");
  const scoreBandEl = document.getElementById("score-band");
  const scoreContextEl = document.getElementById("score-context");
  const gaugeFill = document.getElementById("gauge-fill");
  const errorLabelEl = document.getElementById("error-label");
  const errorCopyEl = document.getElementById("error-copy");

  const GAUGE_ARC_LENGTH = 314; // approx pi * r(100)
  let isSubmitting = false;

  // ---------------------------------------------------------
  // Mobile navigation
  // ---------------------------------------------------------
  const navToggle = document.getElementById("nav-toggle");
  const navLinks = document.getElementById("nav-links");

  function setNav(open) {
    navToggle.setAttribute("aria-expanded", String(open));
    navToggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    navLinks.classList.toggle("open", open);
  }
  navToggle.addEventListener("click", () => setNav(navToggle.getAttribute("aria-expanded") !== "true"));
  navLinks.querySelectorAll("a").forEach((a) => a.addEventListener("click", () => setNav(false)));
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && navLinks.classList.contains("open")) {
      setNav(false);
      navToggle.focus();
    }
  });

  // ---------------------------------------------------------
  // Gauge tick marks (0..10, every 2 units)
  // ---------------------------------------------------------
  function drawTicks() {
    document.querySelectorAll(".gauge-ticks").forEach((g) => {
      g.replaceChildren();
      const cx = 120, cy = 140, rOuter = 100, rInner = 90;
      for (let i = 0; i <= 10; i += 2) {
        const angle = Math.PI - (i / 10) * Math.PI;
        const line = document.createElementNS("http://www.w3.org/2000/svg", "line");
        line.setAttribute("x1", (cx + rOuter * Math.cos(angle)).toFixed(1));
        line.setAttribute("y1", (cy - rOuter * Math.sin(angle)).toFixed(1));
        line.setAttribute("x2", (cx + rInner * Math.cos(angle)).toFixed(1));
        line.setAttribute("y2", (cy - rInner * Math.sin(angle)).toFixed(1));
        g.appendChild(line);
      }
    });
  }
  drawTicks();

  // ---------------------------------------------------------
  // Segmented control (stress_level), now an accessible radiogroup
  // ---------------------------------------------------------
  const segGroup = document.getElementById("stress_level_group");
  const stressHiddenInput = document.getElementById("stress_level");
  const segButtons = Array.from(segGroup.querySelectorAll(".seg-btn"));

  function selectStress(btn) {
    segButtons.forEach((b) => {
      const on = b === btn;
      b.setAttribute("aria-checked", String(on));
      b.tabIndex = on ? 0 : -1;
    });
    stressHiddenInput.value = btn.dataset.value;
    clearFieldError(stressHiddenInput);
  }

  segButtons.forEach((btn, i) => {
    btn.tabIndex = i === 0 ? 0 : -1;
    btn.addEventListener("click", () => selectStress(btn));
    btn.addEventListener("keydown", (e) => {
      const keys = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 };
      if (!(e.key in keys)) return;
      e.preventDefault();
      const next = segButtons[(i + keys[e.key] + segButtons.length) % segButtons.length];
      next.focus();
      selectStress(next);
    });
  });

  // ---------------------------------------------------------
  // Field-level error helpers
  // ---------------------------------------------------------
  const fieldWrapper = (input) => input.closest(".field");

  function setFieldError(input, message) {
    const wrap = fieldWrapper(input);
    if (!wrap) return;
    wrap.classList.add("field-error");
    input.setAttribute("aria-invalid", "true");
    const msgEl = wrap.querySelector(".error-msg");
    if (msgEl) msgEl.textContent = message;
  }

  function clearFieldError(input) {
    const wrap = fieldWrapper(input);
    if (!wrap) return;
    wrap.classList.remove("field-error");
    input.removeAttribute("aria-invalid");
    const msgEl = wrap.querySelector(".error-msg");
    if (msgEl) msgEl.textContent = "";
  }

  function clearAllErrors() {
    form.querySelectorAll(".field").forEach((f) => f.classList.remove("field-error"));
    form.querySelectorAll("[aria-invalid]").forEach((el) => el.removeAttribute("aria-invalid"));
    form.querySelectorAll(".error-msg").forEach((m) => (m.textContent = ""));
  }

  // ---------------------------------------------------------
  // Client-side validation mirroring the StudentData model
  // ---------------------------------------------------------
  function validate(payload) {
    const errors = [];

    const numericChecks = [
      ["age", 10, 100],
      ["avg_daily_usage_hours", 0, 24],
      ["daily_unlocks", 0, Infinity],
      ["study_hours", 0, 24],
      ["physical_activity_hours", 0, 24],
      ["sleep_hours_per_night", 0, 24],
    ];

    numericChecks.forEach(([key, min, max]) => {
      const input = document.getElementById(key);
      const val = payload[key];
      if (val === "" || val === null || Number.isNaN(val)) {
        errors.push([input, "This field is required."]);
      } else if (val < min || val > max) {
        errors.push([input, `Must be between ${min} and ${max === Infinity ? "0 or more" : max}.`]);
      }
    });

    ["gender", "country", "academic_level", "most_used_platform", "purpose_of_use"].forEach((key) => {
      const input = document.getElementById(key);
      if (!payload[key] || String(payload[key]).trim() === "") {
        errors.push([input, "This field is required."]);
      }
    });

    if (!payload.stress_level) {
      errors.push([stressHiddenInput, "Pick a stress level."]);
    }

    return errors;
  }

  // ---------------------------------------------------------
  // Gather form data into the exact StudentData shape (unchanged)
  // ---------------------------------------------------------
  function collectPayload() {
    const fd = new FormData(form);
    const num = (k, parse) => (fd.get(k) === "" ? NaN : parse(fd.get(k)));
    return {
      age: num("age", (v) => parseInt(v, 10)),
      gender: fd.get("gender") || "",
      country: (fd.get("country") || "").trim(),
      academic_level: fd.get("academic_level") || "",
      most_used_platform: fd.get("most_used_platform") || "",
      purpose_of_use: fd.get("purpose_of_use") || "",
      avg_daily_usage_hours: num("avg_daily_usage_hours", parseFloat),
      daily_unlocks: num("daily_unlocks", (v) => parseInt(v, 10)),
      study_hours: num("study_hours", parseFloat),
      physical_activity_hours: num("physical_activity_hours", parseFloat),
      sleep_hours_per_night: num("sleep_hours_per_night", parseFloat),
      stress_level: fd.get("stress_level") || "",
    };
  }

  // ---------------------------------------------------------
  // UI state switching
  // ---------------------------------------------------------
  function showState(name) {
    [stateIdle, stateLoading, stateResult, stateError].forEach((el) => (el.hidden = true));
    ({ idle: stateIdle, loading: stateLoading, result: stateResult, error: stateError }[name]).hidden = false;
  }

  // On narrow screens the result sits below the form, so bring it into view.
  function revealResultPanel() {
    const panel = document.querySelector(".result-panel");
    if (panel && window.matchMedia("(max-width: 960px)").matches) {
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      panel.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
    }
  }

  function setSubmitting(value) {
    isSubmitting = value;
    submitBtn.disabled = value;
    submitBtn.classList.toggle("loading", value);
    submitBtn.setAttribute("aria-busy", String(value));
  }

  function bandFor(score) {
    if (score < 4) {
      return {
        label: "Signal: strained",
        context: "Your responses suggest elevated strain right now. Small shifts in sleep or screen time can go a long way.",
      };
    }
    if (score < 7) {
      return {
        label: "Signal: balanced",
        context: "Your rhythm looks fairly steady, with some room to recover and reset.",
      };
    }
    return {
      label: "Signal: strong",
      context: "Your habits point to a well-supported, resilient baseline. Keep it up.",
    };
  }

  function renderResult(score) {
    const clamped = Math.max(0, Math.min(10, score));
    const { label, context } = bandFor(clamped);

    scoreNumberEl.textContent = score.toFixed(1);
    scoreBandEl.textContent = label;
    scoreContextEl.textContent = context;

    const supportNote = document.getElementById("support-note");
    document.getElementById("support-text").textContent = SUPPORT_TEXT;
    supportNote.hidden = clamped >= 4;

    gaugeFill.style.transition = "none";
    gaugeFill.style.strokeDashoffset = String(GAUGE_ARC_LENGTH);
    showState("result");
    // Force a reflow so the arc animates from empty.
    void gaugeFill.getBoundingClientRect();
    requestAnimationFrame(() => {
      gaugeFill.style.transition = "";
      gaugeFill.style.strokeDashoffset = String(GAUGE_ARC_LENGTH * (1 - clamped / 10));
    });

    revealResultPanel(); // the panel's aria-live region announces the result
  }

  function renderError(label, copy) {
    errorLabelEl.textContent = label;
    errorCopyEl.textContent = copy;
    showState("error");
    revealResultPanel();
  }

  // ---------------------------------------------------------
  // Map FastAPI / Pydantic 422 errors onto fields where possible
  // ---------------------------------------------------------
  function applyServerValidationErrors(detail) {
    if (!Array.isArray(detail)) return false;
    let matched = false;
    detail.forEach((err) => {
      const field = Array.isArray(err.loc) ? err.loc[err.loc.length - 1] : null;
      const input = field ? document.getElementById(field) : null;
      const target = field === "stress_level" ? stressHiddenInput : input;
      if (target) {
        setFieldError(target, err.msg || "Invalid value.");
        matched = true;
      }
    });
    return matched;
  }

  // ---------------------------------------------------------
  // Submit handler
  // ---------------------------------------------------------
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    if (isSubmitting) return; // block double submits
    clearAllErrors();

    const payload = collectPayload();
    const clientErrors = validate(payload);

    if (clientErrors.length > 0) {
      clientErrors.forEach(([input, msg]) => input && setFieldError(input, msg));
      const first = clientErrors[0][0];
      // The hidden stress input can't take focus, so focus its first button instead.
      (first === stressHiddenInput ? segButtons[0] : first)?.focus?.();
      return;
    }

    setSubmitting(true);
    showState("loading");

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    try {
      const res = await fetch(`${API_BASE}/predict`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (res.status === 422) {
        const body = await res.json().catch(() => null);
        const matched = body && applyServerValidationErrors(body.detail);
        renderError(
          "Check your inputs",
          matched
            ? "The API rejected a few fields. They are marked on the form."
            : "The API rejected this submission. Please review your inputs and try again."
        );
        return;
      }

      if (!res.ok) {
        let detailMsg = `The API responded with status ${res.status}.`;
        const body = await res.json().catch(() => null);
        if (body && typeof body.detail === "string") detailMsg = body.detail;
        renderError("Prediction failed", detailMsg);
        return;
      }

      const data = await res.json();
      if (typeof data.predicted_mental_health_score !== "number") {
        renderError("Unexpected response", "The API responded, but the score was missing or malformed.");
        return;
      }

      renderResult(data.predicted_mental_health_score);
    } catch (err) {
      if (err && err.name === "AbortError") {
        renderError(
          "The request timed out",
          `The server didn't respond within ${REQUEST_TIMEOUT_MS / 1000} seconds. Check that the backend is running, then try again.`
        );
      } else {
        renderError(
          "Can't reach the server",
          `Couldn't connect to ${API_BASE}. Make sure the backend is running and that this page's origin is allowed by its CORS settings.`
        );
      }
    } finally {
      clearTimeout(timer);
      setSubmitting(false);
    }
  });

  // Clear errors as the user edits
  form.querySelectorAll("input, select").forEach((el) => {
    el.addEventListener("input", () => clearFieldError(el));
    el.addEventListener("change", () => clearFieldError(el));
  });

  resetBtn.addEventListener("click", () => {
    showState("idle");
    document.getElementById("age").focus();
  });

  errorRetryBtn.addEventListener("click", () => {
    showState("idle");
  });
})();