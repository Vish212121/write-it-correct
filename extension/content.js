// Gembar content script
// Runs on every page/frame. Does NOT talk to Groq directly (background does) so
// no page ever sees your API key or the request.

(function () {
  if (window.__gembarInjected) return;
  window.__gembarInjected = true;
  const { getSelectionAnchorRect, getTextFieldSelectionRect, isUsableRect, resolveSelectionStart, getNearPosition } = globalThis.GembarSelectionGeometry;
  const { getErrorCode, message: requestErrorMessage } = globalThis.GembarRequestErrors;
  const {
    locateIssues: locateSuggestionIssues,
    buildReplacement,
    buildCachedSelectionFixReplacement,
    isReplacementCurrent,
    chooseSuggestionPlacement,
  } = globalThis.GembarSuggestionLogic;

  const TEXT_INPUT_TYPES = new Set([
    "text", "search", "email", "url", "tel", undefined, "",
  ]);

  let settings = null;
  let enabledOnThisSite = true;
  let providerRetryAfterUntil = 0;
  const MAX_AUTOMATIC_RETRY_MS = 90_000;
  let lastContextTarget = null; // {el, isCE, selStart, selEnd, range}
  let contextInvalidated = false;
  const observers = new Set();
  const observedRoots = new WeakSet();
  const observerByRoot = new WeakMap();
  const trackedFields = new Set();
  const attachedFields = new WeakSet();
  const ISSUE_TYPES = new Set(["spelling", "grammar", "punctuation", "style", "clarity"]);

  const fieldState = new WeakMap(); // el -> {issues, lastText, timer, overlay, markerLayer}

  // An extension reload can leave a long-lived tab with an obsolete content
  // script. Stop that script only when its own runtime is invalid; a missing
  // background receiver is handled as a recoverable messaging failure. Both
  // callback and Promise errors from our sendMessage calls are handled below.
  // Avoid a global unhandled-rejection listener: page scripts and other
  // extensions can reject with the same error text.
  function isContextValid() {
    try {
      return !!chrome?.runtime?.id;
    } catch (e) {
      return false;
    }
  }

  function safeSendMessage(msg) {
    return new Promise((resolve) => {
      if (contextInvalidated || !isContextValid()) {
        handleContextInvalidated();
        resolve({ ok: false, error: "EXTENSION_CONTEXT_INVALIDATED" });
        return;
      }
      try {
        const handleMessageError = (error) => {
          const errorText = String(error?.message || error || "");
          if (!isContextValid() || errorText.includes("Extension context invalidated")) {
            handleContextInvalidated();
            resolve({ ok: false, error: "EXTENSION_CONTEXT_INVALIDATED" });
          } else {
            resolve({ ok: false, error: "BACKGROUND_UNAVAILABLE" });
          }
        };
        const pendingMessage = chrome.runtime.sendMessage(msg, (resp) => {
          try {
            const message = String(chrome.runtime?.lastError?.message || "");
            if (message) {
              handleMessageError(message);
              return;
            }
            resolve(resp || { ok: false, error: "BACKGROUND_UNAVAILABLE" });
          } catch (error) {
            handleContextInvalidated();
            resolve({ ok: false, error: "EXTENSION_CONTEXT_INVALIDATED" });
          }
        });
        // Promise-based extension APIs may reject as well as invoking the
        // compatibility callback. Consume that rejection to avoid the
        // browser's unhandled-rejection warning on missing receivers.
        if (pendingMessage && typeof pendingMessage.catch === "function") {
          pendingMessage.catch(handleMessageError);
        }
      } catch (error) {
        const errorText = String(error?.message || error || "");
        if (!isContextValid() || errorText.includes("Extension context invalidated")) {
          handleContextInvalidated();
          resolve({ ok: false, error: "EXTENSION_CONTEXT_INVALIDATED" });
        } else {
          resolve({ ok: false, error: "BACKGROUND_UNAVAILABLE" });
        }
      }
    });
  }

  function handleContextInvalidated() {
    if (contextInvalidated) return;
    contextInvalidated = true;
    for (const rootObserver of observers) {
      try { rootObserver.disconnect(); } catch (e) {}
    }
    observers.clear();
    try { clearAllOverlays(); } catch (e) {}
    console.warn("write it correct: the extension was reloaded/updated. Refresh this page to re-enable it here.");
  }

  function getContentEditableRoot(el) {
    if (!el?.isContentEditable) return null;
    let root = el;
    while (root.parentElement?.isContentEditable) root = root.parentElement;
    return root;
  }

  function selectionFor(el) {
    const root = el?.getRootNode?.();
    const selection = typeof root?.getSelection === "function" ? root.getSelection() : null;
    return selection || window.getSelection();
  }

  function getSiteHostname() {
    if (location.hostname) return location.hostname;
    try { return new URL(document.referrer).hostname; } catch (e) { return ""; }
  }

  function isTextField(el) {
    if (!el) return false;
    if (el.tagName === "TEXTAREA") return !el.disabled && !el.readOnly;
    if (el.tagName === "INPUT") return TEXT_INPUT_TYPES.has(el.type) && !el.disabled && !el.readOnly;
    if (el.isContentEditable) {
      const root = getContentEditableRoot(el);
      return root === el && root.getAttribute("aria-disabled") !== "true" && root.getAttribute("aria-readonly") !== "true";
    }
    return false;
  }

  function getFieldText(el) {
    // textContent (not innerText) so offsets line up exactly with the TreeWalker
    // used later to locate and replace text inside rich, framework-managed editors
    // (WhatsApp, Slack, Notion, etc. all use React/Lexical-style contenteditable).
    if (el.isContentEditable) return el.textContent;
    return el.value;
  }

  // React/Vue-safe value setter so frameworks notice programmatic edits.
  function setNativeValue(el, value) {
    const proto = el.tagName === "TEXTAREA" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) {
      desc.set.call(el, value);
    } else {
      el.value = value;
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }

  function replaceRangeInField(el, start, end, replacement) {
    if (el.isContentEditable) return; // handled separately
    const before = el.value.slice(0, start);
    const after = el.value.slice(end);
    const newValue = before + replacement + after;
    const caret = start + replacement.length;
    setNativeValue(el, newValue);
    try {
      el.setSelectionRange(caret, caret);
    } catch (e) {}
  }

  function applyAllFieldIssues(el, issues) {
    const source = getFieldText(el);
    if (fieldState.get(el)?.lastText !== source) return { ok: false, stale: true };
    const replacement = buildReplacement(source, issues);
    if (!replacement.ok) return { ok: false, stale: true };
    const ordered = replacement.issues;
    const result = replacement.text;

    const selectionStart = el.selectionStart;
    const selectionEnd = el.selectionEnd;
    setNativeValue(el, result);
    if (selectionStart != null && selectionEnd != null) {
      const mapPosition = (position) => {
        let delta = 0;
        for (const issue of ordered) {
          if (position <= issue.start) break;
          if (position < issue.end) return issue.start + delta + issue.suggestion.length;
          delta += issue.suggestion.length - (issue.end - issue.start);
        }
        return position + delta;
      };
      try { el.setSelectionRange(mapPosition(selectionStart), mapPosition(selectionEnd)); } catch (e) {}
    }
    return { ok: true };
  }

  // ---------- Settings / per-site toggle ----------
  function loadSettings() {
    return safeSendMessage({ type: "GEMBAR_GET_SETTINGS" }).then((resp) => {
      settings = resp?.ok && resp.settings
        ? resp.settings
        : { disabledSites: [], liveCheckEnabled: true, hasApiKey: false, startupError: resp?.error || "BACKGROUND_UNAVAILABLE" };
      enabledOnThisSite = !settings.disabledSites?.includes(getSiteHostname());
      if (!settings.startupError && (!settings.hasApiKey || settings.liveCheckEnabled === false || !enabledOnThisSite)) {
        clearAllOverlays();
        return;
      }
      for (const el of trackedFields) {
        const state = fieldState.get(el);
        if (state) state.lastText = null;
        scheduleCheck(el, { immediate: true });
      }
    });
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (contextInvalidated || area !== "local") return;
    if (changes.disabledSites) {
      const list = changes.disabledSites.newValue || [];
      enabledOnThisSite = !list.includes(getSiteHostname());
      if (!enabledOnThisSite) clearAllOverlays();
      else if (settings?.hasApiKey && settings.liveCheckEnabled !== false) {
        for (const el of trackedFields) scheduleCheck(el, { immediate: true });
      }
    }
    if (changes.groqApiKey || changes.model || changes.language || changes.liveCheckEnabled) {
      loadSettings();
    }
  });

  function clearAllOverlays() {
    closePopup();
    closeSuggestionsPanel();
    for (const el of trackedFields) {
      const state = fieldState.get(el);
      if (!state) continue;
      clearTimeout(state.timer);
      clearTimeout(state.retryTimer);
      state.timer = null;
      state.retryTimer = null;
      state.generation = (state.generation || 0) + 1;
      state.needsRecheck = false;
      state.lastText = null;
      state.fullCheckText = null;
      state.issues = [];
      state.resizeObserver?.disconnect();
      state.resizeObserver = null;
      if (state.overlayScrollHandler) {
        el.removeEventListener("scroll", state.overlayScrollHandler);
        state.overlayScrollHandler = null;
      }
      state.markerResizeObserver?.disconnect();
      state.markerResizeObserver = null;
      if (state.markerScrollHandler) {
        el.removeEventListener("scroll", state.markerScrollHandler);
        state.markerScrollHandler = null;
      }
      state.markerScrollAttached = false;
      state.overlay = null;
      state.markerLayer = null;
      state.thinking = null;
      clearTimeout(state.statusTimer);
      state.status = null;
      if (!document.documentElement.contains(el)) trackedFields.delete(el);
    }
    document.querySelectorAll(".gembar-overlay, .gembar-mark-layer, .gembar-status, .gembar-badge, .gembar-panel, .gembar-popup, .gembar-toolbar, .gembar-thinking").forEach((n) => n.remove());
  }

  // ---------- Provider messaging helpers ----------
  function checkText(text) {
    return safeSendMessage({ type: "GEMBAR_CHECK_TEXT", text });
  }
  function rewriteText(text, mode) {
    return safeSendMessage({ type: "GEMBAR_REWRITE_TEXT", text, mode });
  }

  // ---------- Mirror overlay for input/textarea ----------
  const MIRROR_PROPS = [
    "boxSizing", "width", "height", "paddingTop", "paddingRight", "paddingBottom", "paddingLeft",
    "borderTopWidth", "borderRightWidth", "borderBottomWidth", "borderLeftWidth",
    "fontFamily", "fontSize", "fontWeight", "fontStyle", "letterSpacing", "lineHeight",
    "textAlign", "textTransform", "whiteSpace", "wordWrap", "wordBreak", "tabSize",
  ];

  function ensureOverlay(el) {
    let state = fieldState.get(el);
    if (!state) {
      state = { issues: [], lastText: null, timer: null, overlay: null };
      fieldState.set(el, state);
    }
    if (state.overlay && document.body.contains(state.overlay)) return state.overlay;

    const overlay = document.createElement("div");
    overlay.className = "gembar-overlay";
    document.body.appendChild(overlay);
    state.overlay = overlay;

    positionOverlay(el, overlay);
    const ro = new ResizeObserver(() => positionOverlay(el, overlay));
    ro.observe(el);
    state.resizeObserver = ro;

    state.overlayScrollHandler = () => {
      overlay.scrollTop = el.scrollTop;
      overlay.scrollLeft = el.scrollLeft;
    };
    el.addEventListener("scroll", state.overlayScrollHandler);

    return overlay;
  }

  function clearFieldOverlay(el) {
    const state = fieldState.get(el);
    if (!state) return;
    state.overlay?.remove();
    state.overlay = null;
    state.resizeObserver?.disconnect();
    state.resizeObserver = null;
    if (state.overlayScrollHandler) {
      el.removeEventListener("scroll", state.overlayScrollHandler);
      state.overlayScrollHandler = null;
    }
  }

  function positionOverlay(el, overlay) {
    const rect = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    overlay.style.position = "absolute";
    overlay.style.top = `${window.scrollY + rect.top}px`;
    overlay.style.left = `${window.scrollX + rect.left}px`;
    overlay.style.width = `${rect.width}px`;
    overlay.style.height = `${rect.height}px`;
    for (const prop of MIRROR_PROPS) overlay.style[prop] = cs[prop];
    overlay.style.overflow = "hidden";
    overlay.style.color = "transparent";
    overlay.style.pointerEvents = "none";
    overlay.style.zIndex = "2147483000";
  }

  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  // Places a floating element (popup/panel/toolbar) next to an anchor rect,
  // flipping above/below and clamping left/right so it never renders off the
  // visible viewport — e.g. a chat compose box sitting at the very bottom of
  // the screen, where "always open downward" would push the panel out of view.
  // Returns "above" or "below" so callers can flip a pointer/tail to match.
  function placeNear(node, anchorRect, { preferBelow = true, gap = 6, align = "left" } = {}) {
    const vw = document.documentElement.clientWidth;
    const vh = document.documentElement.clientHeight;
    node.style.visibility = "hidden";
    node.style.position = "fixed";
    node.style.top = "0px";
    node.style.left = "0px";
    if (!document.body.contains(node)) document.body.appendChild(node);
    const h = node.offsetHeight;
    const w = node.offsetWidth;

    const position = getNearPosition(anchorRect, w, h, vw, vh, { preferBelow, gap, align });
    node.style.top = `${position.top}px`;
    node.style.left = `${position.left}px`;
    node.style.visibility = "visible";
    return position.side;
  }

  function fieldStatusAnchor(el, selectionInfo = null) {
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    if (selectionInfo?.el === el) {
      const selected = toolbarAnchorRect(selectionInfo);
      if (isUsableRect(selected, viewportWidth, viewportHeight)) return selected;
    }
    if (el.tagName === "TEXTAREA" || el.tagName === "INPUT") {
      if (el.selectionEnd > el.selectionStart) {
        const selected = getTextFieldSelectionRect(el, el.selectionStart, el.selectionEnd, viewportWidth, viewportHeight);
        if (isUsableRect(selected, viewportWidth, viewportHeight)) return selected;
      }
    } else {
      const selection = selectionFor(el);
      if (selection?.rangeCount && !selection.isCollapsed) {
        const range = selection.getRangeAt(0);
        if (el.contains(range.commonAncestorContainer)) {
          const selected = getSelectionAnchorRect(range, null, viewportWidth, viewportHeight);
          if (isUsableRect(selected, viewportWidth, viewportHeight)) return selected;
        }
      }
    }
    const rect = el.getBoundingClientRect();
    const top = Math.max(8, rect.top);
    const left = Math.max(8, rect.left);
    return { left, right: left + 1, top, bottom: top + 1, width: 1, height: 1 };
  }

  function showFieldStatus(el, message, duration = 5000, errorCode = "", selectionInfo = null) {
    const state = fieldState.get(el) || {};
    fieldState.set(el, state);
    if (!state.status || !document.body.contains(state.status)) {
      state.status = document.createElement("div");
      state.status.className = "gembar-status";
      state.status.setAttribute("role", "status");
      state.status.setAttribute("aria-live", "polite");
      document.body.appendChild(state.status);
    }
    state.status.textContent = message;
    if (errorCode) state.status.dataset.errorCode = errorCode;
    else delete state.status.dataset.errorCode;
    placeNear(state.status, fieldStatusAnchor(el, selectionInfo), { preferBelow: false, gap: 8 });
    clearTimeout(state.statusTimer);
    state.statusTimer = setTimeout(() => {
      state.status?.remove();
      state.status = null;
      state.statusTimer = null;
    }, duration);
  }

  function hideFieldStatus(el) {
    const state = fieldState.get(el);
    if (!state) return;
    clearTimeout(state.statusTimer);
    state.status?.remove();
    state.status = null;
    state.statusTimer = null;
  }

  function showActionFailure(el, error, operation = "rewrite", selectionInfo = null) {
    const code = getErrorCode(error);
    const message = requestErrorMessage(error, operation);
    // Keep the diagnostic useful without logging user text, API keys, or the
    // provider's response body.
    console.warn(`write it correct ${operation} failed (${code}).`);
    if (el?.isConnected && isTextField(el)) {
      showFieldStatus(el, message, 8000, code, selectionInfo);
      return;
    }
    const status = document.createElement("div");
    status.className = "gembar-status";
    status.setAttribute("role", "status");
    status.setAttribute("aria-live", "polite");
    status.dataset.errorCode = code;
    status.textContent = message;
    status.style.position = "fixed";
    status.style.right = "16px";
    status.style.bottom = "16px";
    document.body.appendChild(status);
    setTimeout(() => status.remove(), 8000);
  }

  function checkFailureMessage(error) {
    return requestErrorMessage(error, "check");
  }

  function scheduleAutomaticRetry(el, state, delay) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
    if (!Number.isFinite(delay) || delay <= 0 || delay > MAX_AUTOMATIC_RETRY_MS) return;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      if (el.isConnected) scheduleCheck(el, { immediate: true });
    }, delay);
  }

  function scheduleRateLimitRetry(el, state, delay) {
    if ((Number.isFinite(state.rateLimitRetryCount) ? state.rateLimitRetryCount : 0) >= 1 ||
        !Number.isFinite(delay) || delay <= 0 || delay > MAX_AUTOMATIC_RETRY_MS) {
      state.rateRetryPending = false;
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
      return;
    }
    clearTimeout(state.retryTimer);
    state.rateRetryPending = true;
    state.retryTimer = setTimeout(() => {
      state.retryTimer = null;
      const remaining = providerRetryAfterUntil - Date.now();
      if (remaining > 0) {
        scheduleRateLimitRetry(el, state, remaining + 250);
        return;
      }
      state.rateRetryPending = false;
      state.rateLimitRetryCount = (Number.isFinite(state.rateLimitRetryCount) ? state.rateLimitRetryCount : 0) + 1;
      if (el.isConnected) scheduleCheck(el, { immediate: true });
    }, delay + 250);
  }

  function handleRateLimit(el, state, resp) {
    const retryAfterMs = Number.isFinite(resp?.retryAfterMs) ? Math.max(1000, resp.retryAfterMs) : null;
    if (retryAfterMs == null) {
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
      showFieldStatus(el, checkFailureMessage("GROQ_RATE_LIMIT"));
      return;
    }
    providerRetryAfterUntil = Math.max(providerRetryAfterUntil, Date.now() + retryAfterMs);
    const seconds = Math.ceil(retryAfterMs / 1000);
    const canRetry = retryAfterMs <= MAX_AUTOMATIC_RETRY_MS &&
      (Number.isFinite(state.rateLimitRetryCount) ? state.rateLimitRetryCount : 0) < 1;
    const message = `Groq rate-limited this request. ${canRetry ? "Retrying" : "Try again"} in ${seconds} second${seconds === 1 ? "" : "s"}.`;
    showFieldStatus(el, message, Math.min(15000, Math.max(5000, retryAfterMs + 1000)));
    scheduleRateLimitRetry(el, state, retryAfterMs);
  }

  function handleTransientFailure(el, state, error) {
    const retryCount = Number.isFinite(state.retryCount) ? state.retryCount : 0;
    if (!["NETWORK_ERROR", "REQUEST_TIMEOUT", "GROQ_UNAVAILABLE"].includes(error) || retryCount >= 1) {
      showFieldStatus(el, checkFailureMessage(error || ""));
      return;
    }
    state.retryCount = retryCount + 1;
    showFieldStatus(el, "A temporary connection issue occurred. Retrying once in a moment.", 7000);
    scheduleAutomaticRetry(el, state, 2500);
  }

  function renderOverlayContent(el, overlay, text, located) {
    let html = "";
    let cursor = 0;
    located.forEach((iss, i) => {
      html += escapeHtml(text.slice(cursor, iss.start));
      const safeType = ISSUE_TYPES.has(iss.type) ? iss.type : "grammar";
      html += `<span class="gembar-issue gembar-${safeType}" data-idx="${i}">${escapeHtml(text.slice(iss.start, iss.end))}</span>`;
      cursor = iss.end;
    });
    html += escapeHtml(text.slice(cursor));
    overlay.innerHTML = html.replace(/\n/g, "<br/>") + "\u200b";

    overlay.querySelectorAll(".gembar-issue").forEach((span) => {
      span.style.pointerEvents = "auto";
      span.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const idx = Number(span.dataset.idx);
        const issue = located[idx];
        showFixPopup(el, span, issue);
      });
    });
  }

  function showThinking(el) {
    const state = fieldState.get(el);
    if (!state) return;
    if (!state.thinking) {
      const dot = document.createElement("div");
      dot.className = "gembar-thinking";
      dot.setAttribute("role", "status");
      dot.setAttribute("aria-live", "polite");
      dot.textContent = "Checking...";
      document.body.appendChild(dot);
      state.thinking = dot;
    }
    positionThinking(el, state.thinking);
    state.thinking.style.display = "block";
  }
  function hideThinking(el) {
    const state = fieldState.get(el);
    if (state?.thinking) state.thinking.style.display = "none";
  }
  function positionThinking(el, dot) {
    const rect = el.getBoundingClientRect();
    dot.style.position = "absolute";
    dot.style.top = `${window.scrollY + rect.top + 6}px`;
    dot.style.left = `${window.scrollX + rect.right - 14}px`;
  }

  function scheduleCheck(el, { immediate = false } = {}) {
    const state = fieldState.get(el) || {};
    fieldState.set(el, state);
    trackedFields.add(el);
    clearTimeout(state.timer);
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
    const currentText = getFieldText(el);
    if (state.lastText != null && state.lastText !== currentText) {
      state.lastText = null;
      state.fullCheckText = null;
      state.issues = [];
      state.panelDismissedText = null;
      state.suggestionAnchorRange = null;
      state.retryText = currentText;
      state.retryCount = 0;
      state.rateLimitRetryCount = 0;
      state.rateRetryPending = false;
      closeSuggestionsPanel();
      hideFieldStatus(el);
      clearFieldOverlay(el);
      if (el.isContentEditable) renderContentEditableMarks(el, []);
    }
    if (state.retryText !== currentText) {
      state.retryText = currentText;
      state.retryCount = 0;
      state.rateLimitRetryCount = 0;
      state.rateRetryPending = false;
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
    }
    if (!enabledOnThisSite || settings?.liveCheckEnabled === false || !settings) return;
    if (settings.startupError) {
      showFieldStatus(el, checkFailureMessage(settings.startupError));
      return;
    }
    if (!settings.hasApiKey) {
      showFieldStatus(el, checkFailureMessage("NO_API_KEY"));
      return;
    }
    const cooldownMs = providerRetryAfterUntil - Date.now();
    if (cooldownMs > 0) {
      const seconds = Math.ceil(cooldownMs / 1000);
      const canRetry = state.rateRetryPending || (cooldownMs <= MAX_AUTOMATIC_RETRY_MS &&
        (Number.isFinite(state.rateLimitRetryCount) ? state.rateLimitRetryCount : 0) < 1);
      showFieldStatus(el, `Groq rate-limited this request. ${canRetry ? "Retrying" : "Try again"} in ${seconds} second${seconds === 1 ? "" : "s"}.`,
        cooldownMs <= MAX_AUTOMATIC_RETRY_MS ? Math.max(5000, cooldownMs + 1000) : 12000);
      if (canRetry) scheduleRateLimitRetry(el, state, cooldownMs);
      return;
    }
    hideFieldStatus(el);
    state.generation = (state.generation || 0) + 1;
    const generation = state.generation;
    // Debounce typing so the user sees suggestions shortly after a pause,
    // without sending one request for every keystroke.
    const delay = immediate ? 150 : 500;
    state.timer = setTimeout(async () => {
      state.timer = null;
      const text = getFieldText(el);
      if (!text || text.trim().length < 4) {
        clearFieldOverlay(el);
        if (el.isContentEditable) renderContentEditableMarks(el, []);
        return;
      }
      if (state.inFlight) {
        state.needsRecheck = true;
        return;
      }
      if (text === state.lastText && state.fullCheckText === text) {
        if (state.issues?.length && state.panelDismissedText !== text && activeSuggestionsField !== el) {
          renderSuggestionsPanel(el, state.issues);
        }
        return;
      }
      if (state.retryText !== text) {
        state.retryText = text;
        state.retryCount = 0;
        state.rateLimitRetryCount = 0;
        state.rateRetryPending = false;
      }
      state.lastText = text;
      state.inFlight = true;
      const requestGeneration = generation;
      showThinking(el);
      let resp;
      let pendingCheck = null;
      try {
        pendingCheck = checkText(text);
        state.checkPromise = pendingCheck;
        resp = await pendingCheck;
      } catch (error) {
        resp = { ok: false, error: String(error?.message || error || "REQUEST_FAILED") };
      } finally {
        if (state.checkPromise === pendingCheck) state.checkPromise = null;
        state.inFlight = false;
        hideThinking(el);
      }
      // The field may have changed again while we were waiting on the network —
      // if so, a newer check is already queued, so drop this stale response.
      const changedSinceRequest = getFieldText(el) !== text || state.generation !== requestGeneration;
      if (changedSinceRequest || state.needsRecheck) {
        state.needsRecheck = false;
        scheduleCheck(el);
        return;
      }
      if (!resp?.ok) {
        if (resp) {
          state.lastText = null;
          if (resp.error === "GROQ_RATE_LIMIT") handleRateLimit(el, state, resp);
          else handleTransientFailure(el, state, resp.error);
        }
        return;
      }
      state.retryCount = 0;
      state.rateLimitRetryCount = 0;
      state.rateRetryPending = false;
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
      if (Date.now() >= providerRetryAfterUntil) providerRetryAfterUntil = 0;
      const issueResult = locateSuggestionIssues(text, resp.issues);
      const located = issueResult.located;
      state.issues = located;
      state.fullCheckText = text;
      if (!el.isContentEditable) {
        if (located.length) {
          const overlay = ensureOverlay(el);
          positionOverlay(el, overlay);
          renderOverlayContent(el, overlay, text, located);
        } else {
          clearFieldOverlay(el);
        }
      } else {
        renderContentEditableMarks(el, located);
      }
      renderSuggestionsPanel(el, located);
      if (issueResult.unmatched) {
        showFieldStatus(el, "write it correct found suggestions it could not safely match to this text. Please edit or recheck it before applying changes.", 8000, "UNVERIFIED_SUGGESTION");
      }
    }, delay);
  }

  // Call this right after a fix/rewrite is applied to a field: clears now-stale
  // underlines immediately (instead of leaving old ones up until the next check
  // finishes) and queues a fast recheck.
  function invalidateAndRecheck(el) {
    const state = fieldState.get(el);
    if (state) {
      state.lastText = null;
      clearFieldOverlay(el);
      state.issues = [];
      if (el.isContentEditable) renderContentEditableMarks(el, []);
    }
    scheduleCheck(el, { immediate: true });
  }

  // Rich editors often use React, Lexical or ProseMirror to own their DOM.
  // Draw marks in a separate, pointer-transparent layer so we never insert
  // spans into that DOM or disrupt the editor's caret and event handling.
  function ensureContentEditableLayer(el) {
    const state = fieldState.get(el);
    if (state.markerLayer && document.body.contains(state.markerLayer)) return state.markerLayer;

    const layer = document.createElement("div");
    layer.className = "gembar-mark-layer";
    layer.setAttribute("aria-hidden", "true");
    document.body.appendChild(layer);
    state.markerLayer = layer;
    if (!state.markerResizeObserver) {
      state.markerResizeObserver = new ResizeObserver(() => renderContentEditableMarks(el, state.issues || []));
      state.markerResizeObserver.observe(el);
    }
    if (!state.markerScrollAttached) {
      state.markerScrollAttached = true;
      state.markerScrollHandler = () => renderContentEditableMarks(el, state.issues || []);
      el.addEventListener("scroll", state.markerScrollHandler);
    }
    return layer;
  }

  function rangeForOffsets(el, start, end) {
    if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end <= start) return null;
    const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    const nodes = [];
    let node;
    while ((node = walker.nextNode())) nodes.push(node);

    let offset = 0, startNode = null, startOffset = 0, endNode = null, endOffset = 0;
    for (const textNode of nodes) {
      const length = textNode.nodeValue.length;
      const nextOffset = offset + length;
      if (length && startNode === null && start >= offset && start < nextOffset) {
        startNode = textNode;
        startOffset = start - offset;
      }
      if (length && endNode === null && end > offset && end <= nextOffset) {
        endNode = textNode;
        endOffset = end - offset;
      }
      offset = nextOffset;
    }
    if (!startNode || !endNode) return null;
    const range = document.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    return range;
  }

  function renderContentEditableMarks(el, located) {
    const state = fieldState.get(el);
    if (!state) return;
    if (!located.length) {
      state.markerLayer?.remove();
      state.markerLayer = null;
      return;
    }

    const layer = ensureContentEditableLayer(el);
    layer.replaceChildren();
    located.forEach((issue, issueIndex) => {
      const range = rangeForOffsets(el, issue.start, issue.end);
      if (!range || range.toString() !== issue.original) return;
      const type = ISSUE_TYPES.has(issue.type) ? issue.type : "grammar";
      for (const rect of range.getClientRects()) {
        if (!rect.width || !rect.height) continue;
        const mark = document.createElement("span");
        mark.className = `gembar-mark gembar-${type}`;
        mark.dataset.issueIndex = String(issueIndex);
        mark.title = issue.message || "Writing suggestion";
        mark.style.left = `${rect.left}px`;
        mark.style.top = `${rect.top}px`;
        mark.style.width = `${rect.width}px`;
        mark.style.height = `${rect.height}px`;
        layer.appendChild(mark);
      }
    });
  }

  function replaceRangeInContentEditable(el, issue, suggestion) {
    const range = rangeForOffsets(el, issue.start, issue.end);
    if (!range || range.toString() !== issue.original) return false;
    const selection = selectionFor(el);
    if (!selection) return false;
    selection.removeAllRanges();
    selection.addRange(range);
    const inserted = document.execCommand("insertText", false, suggestion);
    if (!inserted) {
      range.deleteContents();
      range.insertNode(document.createTextNode(suggestion));
    }
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  function applyAllIssues(el, issues) {
    if (!el.isContentEditable) return applyAllFieldIssues(el, issues);

    const source = getFieldText(el);
    if (fieldState.get(el)?.lastText !== source) return { ok: false, stale: true, applied: 0 };
    const replacement = buildReplacement(source, issues);
    if (!replacement.ok) return { ok: false, stale: true, applied: 0 };
    const ordered = replacement.issues;

    let applied = 0;
    for (const issue of [...ordered].reverse()) {
      const before = getFieldText(el);
      if (before.slice(issue.start, issue.end) !== issue.original) {
        return { ok: false, stale: true, applied };
      }
      if (!replaceRangeInContentEditable(el, issue, issue.suggestion)) {
        return { ok: false, stale: true, applied };
      }
      const expected = before.slice(0, issue.start) + issue.suggestion + before.slice(issue.end);
      if (getFieldText(el) !== expected) return { ok: false, stale: true, applied: applied + 1 };
      applied += 1;
    }
    if (getFieldText(el) !== replacement.text) return { ok: false, stale: true, applied };
    return { ok: true, applied };
  }

  // ---------- Fix popup ----------
  let activePopup = null;
  let activePopupAnchor = null;
  let activeSuggestionsPanel = null;
  let activeSuggestionsField = null;
  let activeSuggestionsAnchorRange = null;
  let activeSuggestionsObserver = null;
  let activeSuggestionsScrollHandler = null;
  let suggestionsPositionFrame = null;
  function closePopup() {
    if (activePopup) {
      activePopup.remove();
      activePopup = null;
    }
    activePopupAnchor = null;
  }
  document.addEventListener("click", closePopup, true);

  // The same suggestion popup is anchored to mirror underlines in text fields
  // or to a transparent geometry mark in rich editors.
  function showFixPopup(el, anchorEl, issue) {
    closePopup();
    const rect = anchorEl.getBoundingClientRect();
    const popup = document.createElement("div");
    popup.className = "gembar-popup";
    popup.innerHTML = `
      <div class="gembar-popup-msg">${escapeHtml(issue.message || "Suggestion")}</div>
      <div class="gembar-popup-sugg">"${escapeHtml(issue.suggestion || "")}"</div>
      <div class="gembar-popup-actions">
        <button class="gembar-btn gembar-accept">Accept</button>
        <button class="gembar-btn gembar-ignore">Ignore</button>
      </div>`;
    document.body.appendChild(popup);
    placeNear(popup, rect, { preferBelow: true, align: "left", gap: 4 });
    popup.addEventListener("click", (e) => e.stopPropagation());
    activePopup = popup;
    activePopupAnchor = anchorEl;

    popup.querySelector(".gembar-accept").addEventListener("click", () => {
      const currentText = getFieldText(el);
      if (currentText !== fieldState.get(el)?.lastText || currentText.slice(issue.start, issue.end) !== issue.original) {
        closePopup();
        showFieldStatus(el, "That text has changed. write it correct is checking it again.");
        invalidateAndRecheck(el);
        return;
      }
      const applied = el.isContentEditable
        ? replaceRangeInContentEditable(el, issue, issue.suggestion)
        : (replaceRangeInField(el, issue.start, issue.end, issue.suggestion), true);
      if (!applied) {
        closePopup();
        showFieldStatus(el, "Could not apply that change. Please try again.");
        invalidateAndRecheck(el);
        return;
      }
      invalidateAndRecheck(el);
      closePopup();
    });
    popup.querySelector(".gembar-ignore").addEventListener("click", () => {
      const state = fieldState.get(el);
      if (state) {
        state.issues = (state.issues || []).filter((candidate) => candidate.start !== issue.start || candidate.end !== issue.end);
        if (el.isContentEditable) renderContentEditableMarks(el, state.issues);
        else if (state.overlay) renderOverlayContent(el, state.overlay, getFieldText(el), state.issues);
      }
      closePopup();
    });
  }

  function closeSuggestionsPanel() {
    if (suggestionsPositionFrame !== null) {
      cancelAnimationFrame(suggestionsPositionFrame);
      suggestionsPositionFrame = null;
    }
    activeSuggestionsObserver?.disconnect();
    activeSuggestionsObserver = null;
    if (activeSuggestionsField && activeSuggestionsScrollHandler) {
      activeSuggestionsField.removeEventListener("scroll", activeSuggestionsScrollHandler);
    }
    activeSuggestionsScrollHandler = null;
    activeSuggestionsPanel?.remove();
    activeSuggestionsPanel = null;
    activeSuggestionsField = null;
    activeSuggestionsAnchorRange = null;
  }

  function renderSuggestionsPanel(el, issues, anchorRange = null) {
    closeSuggestionsPanel();
    if (!issues?.length) return;

    const state = fieldState.get(el);
    if (!state) return;
    let visibleIssues = [...issues];

    const panel = document.createElement("section");
    panel.className = "gembar-suggestions";
    panel.setAttribute("role", "region");
    panel.setAttribute("aria-label", "Writing suggestions");

    const header = document.createElement("div");
    header.className = "gembar-suggestions-header";
    const title = document.createElement("strong");
    title.textContent = `write it correct suggestions (${visibleIssues.length})`;
    const headerActions = document.createElement("div");
    headerActions.className = "gembar-suggestions-header-actions";
    const applyAll = document.createElement("button");
    applyAll.className = "gembar-suggestions-apply-all";
    applyAll.type = "button";
    applyAll.textContent = "Apply all";
    const toggle = document.createElement("button");
    toggle.className = "gembar-suggestions-toggle";
    toggle.type = "button";
    toggle.hidden = true;
    const close = document.createElement("button");
    close.className = "gembar-suggestions-close";
    close.type = "button";
    close.textContent = "Close";
    close.setAttribute("aria-label", "Close suggestions");
    close.addEventListener("click", (event) => {
      event.stopPropagation();
      state.panelDismissedText = state.lastText;
      closeSuggestionsPanel();
    });
    toggle.addEventListener("click", (event) => {
      event.stopPropagation();
      if (panel.classList.contains("gembar-suggestions-compact")) {
        panel.classList.remove("gembar-suggestions-compact");
        panel.dataset.manualExpanded = "true";
        toggle.textContent = "Minimize";
      } else {
        panel.classList.add("gembar-suggestions-compact");
        delete panel.dataset.manualExpanded;
        toggle.textContent = "Show";
      }
      positionSuggestionsPanel(el, panel, anchorRange);
    });
    headerActions.append(applyAll, toggle, close);
    header.append(title, headerActions);
    panel.appendChild(header);

    const list = document.createElement("div");
    list.className = "gembar-suggestion-list";
    visibleIssues.slice(0, 6).forEach((issue) => {
      const item = document.createElement("article");
      item.className = "gembar-suggestion-item";

      const message = document.createElement("div");
      message.className = "gembar-suggestion-message";
      message.textContent = issue.message || "Writing suggestion";

      const change = document.createElement("div");
      change.className = "gembar-suggestion-change";
      const original = document.createElement("span");
      original.className = "gembar-suggestion-original";
      original.textContent = issue.original;
      const arrow = document.createElement("span");
      arrow.className = "gembar-suggestion-arrow";
      arrow.textContent = "→";
      const suggestion = document.createElement("span");
      suggestion.className = "gembar-suggestion-replacement";
      suggestion.textContent = issue.suggestion || "Delete";
      change.append(original, arrow, suggestion);

      const actions = document.createElement("div");
      actions.className = "gembar-suggestion-actions";
      const accept = document.createElement("button");
      accept.className = "gembar-suggestion-accept";
      accept.type = "button";
      accept.textContent = "Apply";
      const ignore = document.createElement("button");
      ignore.className = "gembar-suggestion-ignore";
      ignore.type = "button";
      ignore.textContent = "Dismiss";
      actions.append(accept, ignore);
      item.append(message, change, actions);
      list.appendChild(item);

      accept.addEventListener("click", () => {
        const currentText = getFieldText(el);
        if (currentText !== state.lastText || currentText.slice(issue.start, issue.end) !== issue.original) {
          closeSuggestionsPanel();
          showFieldStatus(el, "That text changed. Checking it again.");
          invalidateAndRecheck(el);
          return;
        }
        const applied = el.isContentEditable
          ? replaceRangeInContentEditable(el, issue, issue.suggestion)
          : (replaceRangeInField(el, issue.start, issue.end, issue.suggestion), true);
        if (!applied) {
          closeSuggestionsPanel();
          showFieldStatus(el, "Could not apply that change. Please try again.");
          invalidateAndRecheck(el);
          return;
        }
        closeSuggestionsPanel();
        invalidateAndRecheck(el);
      });

      ignore.addEventListener("click", () => {
        state.issues = (state.issues || []).filter((candidate) => candidate !== issue);
        if (el.isContentEditable) renderContentEditableMarks(el, state.issues);
        else if (state.overlay) renderOverlayContent(el, state.overlay, getFieldText(el), state.issues);
        visibleIssues = visibleIssues.filter((candidate) => candidate !== issue);
        renderSuggestionsPanel(el, visibleIssues, anchorRange);
      });
    });
    panel.appendChild(list);
    applyAll.addEventListener("click", () => {
      const result = applyAllIssues(el, visibleIssues);
      closeSuggestionsPanel();
      if (!result.ok) {
        showFieldStatus(el, result.applied
          ? "Some changes were applied, but the editor changed. write it correct is checking it again."
          : "That text changed. write it correct is checking it again.");
      }
      invalidateAndRecheck(el);
    });

    if (visibleIssues.length > 6) {
      const more = document.createElement("div");
      more.className = "gembar-suggestions-more";
      more.textContent = `${visibleIssues.length - 6} more issue${visibleIssues.length - 6 === 1 ? "" : "s"} marked in the text.`;
      panel.appendChild(more);
    }

    document.body.appendChild(panel);
    panel.__gembarIssues = visibleIssues;
    activeSuggestionsPanel = panel;
    activeSuggestionsField = el;
    activeSuggestionsAnchorRange = anchorRange;
    panel.addEventListener("click", (event) => event.stopPropagation());
    if (!positionSuggestionsPanel(el, panel, anchorRange)) {
      closeSuggestionsPanel();
      return;
    }
    activeSuggestionsObserver = new ResizeObserver(() => {
      queueSuggestionsPosition(el, panel, anchorRange);
    });
    activeSuggestionsObserver.observe(el);
    activeSuggestionsScrollHandler = () => {
      queueSuggestionsPosition(el, panel, anchorRange);
    };
    el.addEventListener("scroll", activeSuggestionsScrollHandler, { passive: true });
  }

  function positionSuggestionsPanel(el, panel, anchorRange = activeSuggestionsAnchorRange) {
    if (!panel || !document.body.contains(panel) || !el.isConnected) return false;
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const editor = el.getBoundingClientRect();
    let anchor = anchorRange
      ? getSelectionAnchorRect(anchorRange, editor, viewportWidth, viewportHeight)
      : null;
    if (!anchor && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) {
      // Anchor suggestions to the selected text, or to their first visible
      // issue during a full-field check. Tall editors must not pull the panel
      // down to their bottom edge when the writing is near the top.
      const activeInRoot = el === document.activeElement || el === el.getRootNode?.().activeElement;
      if (activeInRoot && el.selectionStart !== el.selectionEnd) {
        anchor = getTextFieldSelectionRect(el, el.selectionStart, el.selectionEnd, viewportWidth, viewportHeight);
      }
      for (const issue of panel.__gembarIssues || []) {
        if (anchor) break;
        anchor = getTextFieldSelectionRect(el, issue.start, issue.end, viewportWidth, viewportHeight);
      }
    }
    if (!anchor) anchor = editor;
    if (!isUsableRect(anchor, viewportWidth, viewportHeight)) anchor = editor;
    if (!isUsableRect(anchor, viewportWidth, viewportHeight)) return false;
    const gap = 10;
    const inset = 10;
    panel.style.position = "fixed";
    panel.style.visibility = "hidden";

    const clamp = (value, min, max) => Math.max(min, Math.min(value, max));
    const makePositions = (width, height) => [
      { side: "below", left: clamp(anchor.right - width, inset, viewportWidth - width - inset), top: anchor.bottom + gap },
      { side: "above", left: clamp(anchor.right - width, inset, viewportWidth - width - inset), top: anchor.top - height - gap },
      { side: "right", left: anchor.right + gap, top: clamp(anchor.top, inset, viewportHeight - height - inset) },
      { side: "left", left: anchor.left - width - gap, top: clamp(anchor.top, inset, viewportHeight - height - inset) },
      { side: "corner", left: viewportWidth - width - inset, top: viewportHeight - height - inset },
      { side: "corner", left: inset, top: viewportHeight - height - inset },
      { side: "corner", left: viewportWidth - width - inset, top: inset },
      { side: "corner", left: inset, top: inset },
    ];
    const editorOverlapArea = (position, width, height) => {
      const overlapWidth = Math.max(0, Math.min(position.left + width, editor.right) - Math.max(position.left, editor.left));
      const overlapHeight = Math.max(0, Math.min(position.top + height, editor.bottom) - Math.max(position.top, editor.top));
      return overlapWidth * overlapHeight;
    };
    const visibleTextScore = (position, width, height) => {
      let score = 0;
      const controlSelector = "a, button, input, textarea, select, [role='button'], [contenteditable='true']";
      for (let y = position.top + 12; y < position.top + height - 6; y += 32) {
        for (let x = position.left + 12; x < position.left + width - 6; x += 32) {
          const hit = document.elementFromPoint(x, y);
          if (!hit || hit === document.body || hit === document.documentElement || panel.contains(hit)) continue;
          if (hit.tagName === "IFRAME" || hit.closest?.(controlSelector)) {
            score += 1;
            continue;
          }
          const caret = document.caretPositionFromPoint?.(x, y);
          const range = caret ? null : document.caretRangeFromPoint?.(x, y);
          const textNode = caret?.offsetNode || range?.startContainer;
          if (textNode?.nodeType === Node.TEXT_NODE && /\S/.test(textNode.nodeValue || "")) score += 1;
        }
      }
      return score;
    };
    const boundedPositions = (width, height) => makePositions(width, height)
      .filter((position) => position.left >= inset && position.top >= inset &&
        position.left + width <= viewportWidth - inset &&
        position.top + height <= viewportHeight - inset)
      .map((position) => ({
        ...position,
        bounded: true,
        textScore: visibleTextScore(position, width, height),
        editorOverlapArea: editorOverlapArea(position, width, height),
      }));
    let compact = panel.classList.contains("gembar-suggestions-compact");
    const manualExpanded = panel.dataset.manualExpanded === "true";
    let width = panel.offsetWidth;
    let height = panel.offsetHeight;
    let candidates = boundedPositions(width, height);
    let valid = chooseSuggestionPlacement(candidates);
    const toggle = panel.querySelector(".gembar-suggestions-toggle");
    if (!valid && !compact && !manualExpanded) {
      panel.classList.add("gembar-suggestions-compact");
      delete panel.dataset.manualExpanded;
      compact = true;
      if (toggle) {
        toggle.hidden = false;
        toggle.textContent = "Show";
      }
      width = panel.offsetWidth;
      height = panel.offsetHeight;
      candidates = boundedPositions(width, height);
      valid = chooseSuggestionPlacement(candidates);
    }
    if (!compact && toggle) {
      toggle.hidden = false;
      toggle.textContent = "Minimize";
    }
    // Some editors fill the viewport, leaving no position outside the editor.
    // Keep an explicitly expanded panel open in the least occupied spot, and
    // use a compact chip for automatic placement when no clear area exists.
    if (!valid) {
      if (!manualExpanded && !compact) {
        panel.classList.add("gembar-suggestions-compact");
        delete panel.dataset.manualExpanded;
        compact = true;
        if (toggle) {
          toggle.hidden = false;
          toggle.textContent = "Show";
        }
        width = panel.offsetWidth;
        height = panel.offsetHeight;
        candidates = boundedPositions(width, height);
      }
      valid = chooseSuggestionPlacement(candidates, { allowOverlap: true });
    }
    if (!valid) return false;
    panel.style.left = `${valid.left}px`;
    panel.style.top = `${valid.top}px`;
    panel.dataset.placement = valid.side;
    panel.style.visibility = "visible";
    return true;
  }

  function queueSuggestionsPosition(el, panel, anchorRange = activeSuggestionsAnchorRange) {
    if (suggestionsPositionFrame !== null) return;
    suggestionsPositionFrame = requestAnimationFrame(() => {
      suggestionsPositionFrame = null;
      if (activeSuggestionsField === el && activeSuggestionsPanel === panel && !positionSuggestionsPanel(el, panel, anchorRange)) {
        closeSuggestionsPanel();
      }
    });
  }

  document.addEventListener("click", (event) => {
    if (activeSuggestionsPanel && !activeSuggestionsPanel.contains(event.target)) {
      closeSuggestionsPanel();
    }
  });
  document.addEventListener("scroll", () => {
    if (activeSuggestionsField && activeSuggestionsPanel) {
      queueSuggestionsPosition(activeSuggestionsField, activeSuggestionsPanel, activeSuggestionsAnchorRange);
    }
  }, true);

  // Marks have pointer-events:none, so the host editor still receives the
  // original click and caret behavior. Use its coordinates to open the card.
  document.addEventListener("click", (event) => {
    if (event.target?.closest?.(".gembar-popup, .gembar-toolbar, .gembar-status, .gembar-panel")) return;
    const editable = (event.composedPath?.() || [event.target])
      .map((target) => getContentEditableRoot(target))
      .find(Boolean);
    if (!editable) return;
    const state = fieldState.get(editable);
    if (!state?.markerLayer) return;
    for (const mark of state.markerLayer.querySelectorAll(".gembar-mark")) {
      const rect = mark.getBoundingClientRect();
      if (event.clientX >= rect.left && event.clientX <= rect.right && event.clientY >= rect.top && event.clientY <= rect.bottom) {
        const issue = state.issues?.[Number(mark.dataset.issueIndex)];
        if (issue) showFixPopup(editable, mark, issue);
        return;
      }
    }
  }, true);

  // ---------- Floating rewrite toolbar on selection ----------
  const ICONS = {
    fix: '<path d="M20 6 9 17l-5-5"/>',
    improve: '<path d="M12 3v4M12 17v4M3 12h4M17 12h4M5.6 5.6l2.8 2.8M15.6 15.6l2.8 2.8M18.4 5.6l-2.8 2.8M8.4 15.6l-2.8 2.8"/>',
    shorten: '<path d="M4 12h16M4 12l4-4M4 12l4 4M20 12l-4-4M20 12l-4 4"/>',
    formal: '<path d="M4 7h16v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7Z"/><path d="M8 7V5a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    casual: '<circle cx="12" cy="12" r="9"/><path d="M8.5 14.5s1.2 1.5 3.5 1.5 3.5-1.5 3.5-1.5"/><path d="M9 9h.01M15 9h.01"/>',
  };
  const REWRITE_MODES = [
    { mode: "fix", label: "Fix" },
    { mode: "improve", label: "Improve" },
    { mode: "shorten", label: "Shorten" },
    { mode: "formal", label: "Formal" },
    { mode: "casual", label: "Casual" },
  ];

  let toolbar = null;
  let toolbarInfo = null;
  let selectionUpdateTimer = null;
  let selectionCheckTimer = null;
  let selectionCheckGeneration = 0;
  let currentSelectionSignature = null;
  let nextEditableId = 1;
  const editableIds = new WeakMap();
  function removeToolbar() {
    if (toolbar) {
      toolbar.remove();
      toolbar = null;
    }
    toolbarInfo = null;
  }

  function currentEditableSelectionInfo(event) {
    const path = event?.composedPath?.() || [];
    const pathActive = path.find((target) =>
      isTextField(target) || getContentEditableRoot(target)
    );
    if (event && path.length && !pathActive) return null;
    let active = pathActive || document.activeElement;
    while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement;
    if (active && isTextField(active) && (active.tagName === "TEXTAREA" || active.tagName === "INPUT")) {
      const s = active.selectionStart, e = active.selectionEnd;
      if (s !== e && s != null) {
        return {
          kind: "field", el: active, start: s, end: e,
          text: active.value.slice(s, e), sourceText: active.value,
        };
      }
      return null;
    }
    const ce = getContentEditableRoot(active);
    const sel = selectionFor(ce || active);
    if (sel && sel.rangeCount && !sel.isCollapsed) {
      const range = sel.getRangeAt(0);
      const container = range.commonAncestorContainer;
      const host = container.nodeType === 1 ? container : container.parentElement;
      const rangeRoot = getContentEditableRoot(host);
      if (rangeRoot) {
        return {
          kind: "ce", el: rangeRoot, range: range.cloneRange(),
          text: sel.toString(), sourceText: getFieldText(rangeRoot),
        };
      }
    }
    return null;
  }

  function getEditableId(el) {
    if (!editableIds.has(el)) editableIds.set(el, nextEditableId++);
    return editableIds.get(el);
  }

  function selectionStartOffset(info) {
    if (info.kind === "field") return info.start;
    try {
      const prefix = document.createRange();
      prefix.selectNodeContents(info.el);
      prefix.setEnd(info.range.startContainer, info.range.startOffset);
      return prefix.toString().length;
    } catch (error) {
      return -1;
    }
  }

  function makeSelectionSignature(info) {
    if (!info) return null;
    let start = resolveSelectionStart(getFieldText(info.el), info.text, selectionStartOffset(info));
    if (start < 0) {
      const rect = getSelectionAnchorRect(
        info.range,
        info.el.getBoundingClientRect(),
        document.documentElement.clientWidth,
        document.documentElement.clientHeight
      );
      start = `rect:${Math.round(rect.left)}:${Math.round(rect.top)}`;
    }
    return `${getEditableId(info.el)}:${start}:${info.text}`;
  }

  function checkSelectedText(info, signature, start) {
    if (!enabledOnThisSite || settings?.liveCheckEnabled === false || !settings?.hasApiKey) return;
    const el = info.el;
    const source = getFieldText(el);
    start = resolveSelectionStart(source, info.text, start);
    if (start < 0) return;

    attach(el);
    const state = fieldState.get(el) || { issues: [], lastText: null, timer: null, overlay: null };
    fieldState.set(el, state);
    // Let a pending full-field check handle the current value instead of
    // issuing a second provider request for a selection in the same field.
    if (state.timer || state.inFlight) return;
    if (state.fullCheckText === source) {
      const selectedIssues = (state.issues || []).filter((issue) => issue.start >= start && issue.end <= start + info.text.length);
      if (selectedIssues.length) {
        state.panelDismissedText = null;
        renderSuggestionsPanel(el, selectedIssues, info.kind === "ce" ? info.range.cloneRange() : null);
      }
      return;
    }
    if (state.retryText !== source) {
      state.retryText = source;
      state.retryCount = 0;
      state.rateLimitRetryCount = 0;
      state.rateRetryPending = false;
    }
    state.lastText = source;
    state.panelDismissedText = null;
    const requestGeneration = ++selectionCheckGeneration;
    checkText(info.text).then((resp) => {
      if (requestGeneration !== selectionCheckGeneration || !el.isConnected || getFieldText(el) !== source) return;
      if (!resp?.ok) {
        if (resp?.error === "GROQ_RATE_LIMIT") handleRateLimit(el, state, resp);
        else if (resp?.error) handleTransientFailure(el, state, resp.error);
        return;
      }
      state.retryCount = 0;
      state.rateLimitRetryCount = 0;
      state.rateRetryPending = false;
      clearTimeout(state.retryTimer);
      state.retryTimer = null;
      const currentInfo = currentEditableSelectionInfo();
      if (makeSelectionSignature(currentInfo) !== signature) return;
      const issueResult = locateSuggestionIssues(info.text, resp.issues);
      const located = issueResult.located.map((issue) => ({
        ...issue,
        start: issue.start + start,
        end: issue.end + start,
      }));
      const selectionEnd = start + info.text.length;
      const outsideSelection = (state.issues || []).filter((issue) =>
        issue.end <= start || issue.start >= selectionEnd
      );
      const mergedIssues = [...outsideSelection, ...located].sort((a, b) => a.start - b.start);
      state.issues = mergedIssues;
      state.lastText = source;
      state.suggestionAnchorRange = info.kind === "ce" ? info.range.cloneRange() : null;
      if (!el.isContentEditable) {
        if (mergedIssues.length) {
          const overlay = ensureOverlay(el);
          positionOverlay(el, overlay);
          renderOverlayContent(el, overlay, source, mergedIssues);
        } else clearFieldOverlay(el);
      } else {
        renderContentEditableMarks(el, mergedIssues);
      }
      if (located.length) renderSuggestionsPanel(el, located, info.kind === "ce" ? info.range.cloneRange() : null);
      else if (activeSuggestionsField === el) closeSuggestionsPanel();
      if (issueResult.unmatched) {
        showFieldStatus(el, "write it correct found suggestions it could not safely match to this text. Please edit or recheck it before applying changes.", 8000, "UNVERIFIED_SUGGESTION");
      }
    }).catch((error) => {
      if (requestGeneration === selectionCheckGeneration && el.isConnected) {
        handleTransientFailure(el, fieldState.get(el) || state, String(error?.message || error));
      }
    });
  }

  function updateSelectionToolbar(event = null) {
    clearTimeout(selectionUpdateTimer);
    selectionUpdateTimer = setTimeout(() => {
      if ((event?.composedPath?.() || []).some((target) =>
        target?.classList?.contains("gembar-suggestions") ||
        target?.classList?.contains("gembar-popup") ||
        target?.classList?.contains("gembar-toolbar")
      )) return;
      const info = currentEditableSelectionInfo(event);
      const signature = makeSelectionSignature(info);
      if (!info || info.text.trim().length < 2 || !signature) {
        currentSelectionSignature = null;
        clearTimeout(selectionCheckTimer);
        selectionCheckTimer = null;
        selectionCheckGeneration += 1;
        removeToolbar();
        return;
      }
      if (signature === currentSelectionSignature && toolbar?.isConnected) return;
      const rect = toolbarAnchorRect(info);
      if (!isUsableRect(rect, document.documentElement.clientWidth, document.documentElement.clientHeight)) {
        currentSelectionSignature = null;
        clearTimeout(selectionCheckTimer);
        selectionCheckTimer = null;
        selectionCheckGeneration += 1;
        removeToolbar();
        return;
      }
      currentSelectionSignature = signature;
      showToolbarForSelection(info, rect);
      clearTimeout(selectionCheckTimer);
      selectionCheckTimer = setTimeout(() => {
        selectionCheckTimer = null;
        const currentInfo = currentEditableSelectionInfo();
        if (makeSelectionSignature(currentInfo) !== signature) return;
        checkSelectedText(info, signature, selectionStartOffset(info));
      }, 450);
    }, 40);
  }

  function iconSvg(mode) {
    return `<svg class="gembar-tb-icon" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[mode]}</svg>`;
  }

  function toolbarAnchorRect(info) {
    const editorRect = info.el.getBoundingClientRect();
    if (info.kind === "field") {
      return getTextFieldSelectionRect(
        info.el, info.start, info.end,
        document.documentElement.clientWidth,
        document.documentElement.clientHeight
      );
    }
    const anchor = getSelectionAnchorRect(
        info.range,
        editorRect,
        document.documentElement.clientWidth,
        document.documentElement.clientHeight
      );
    // A viewport-sized rich editor is a poor substitute for missing range
    // geometry: it would put the toolbar at the window edge.
    return anchor === editorRect && editorRect.height > document.documentElement.clientHeight * 0.6
      ? null : anchor;
  }

  function repositionFloatingControls() {
    if (activePopup && activePopupAnchor?.isConnected) {
      placeNear(activePopup, activePopupAnchor.getBoundingClientRect(), { preferBelow: true, align: "left", gap: 4 });
    } else if (activePopup) {
      closePopup();
    }
    if (toolbar && toolbarInfo?.el.isConnected) {
      const anchor = toolbarAnchorRect(toolbarInfo);
      if (!isUsableRect(anchor, document.documentElement.clientWidth, document.documentElement.clientHeight)) {
        removeToolbar();
        currentSelectionSignature = null;
        clearTimeout(selectionCheckTimer);
        selectionCheckTimer = null;
        selectionCheckGeneration += 1;
        return;
      }
      const side = placeNear(toolbar, anchor, { preferBelow: false, gap: 10, align: "left" });
      toolbar.classList.toggle("gembar-below", side === "below");
    } else if (toolbar) {
      removeToolbar();
    }
  }

  function cachedFixReplacement(info) {
    const state = fieldState.get(info.el);
    if (!state?.issues?.length || state.lastText !== info.sourceText ||
        getFieldText(info.el) !== info.sourceText) return null;
    const start = resolveSelectionStart(info.sourceText, info.text, selectionStartOffset(info));
    if (start < 0) return null;
    return buildCachedSelectionFixReplacement(info.sourceText, info.text, start, state.issues);
  }

  async function rewriteSelection(info, mode) {
    let cachedFix = mode === "fix" ? cachedFixReplacement(info) : null;
    const pendingCheck = fieldState.get(info.el)?.checkPromise;
    if (mode === "fix" && cachedFix === null && pendingCheck) {
      // The live review may already be answering this exact text. Let it
      // finish before asking Groq the same question a second time.
      await pendingCheck.catch(() => {});
      cachedFix = cachedFixReplacement(info);
    }
    return cachedFix === null
      ? await rewriteText(info.text, mode)
      : { ok: true, result: cachedFix };
  }

  function showToolbarForSelection(info, rect) {
    removeToolbar();
    if (!enabledOnThisSite) return;
    toolbar = document.createElement("div");
    toolbar.className = "gembar-toolbar";
    toolbar.innerHTML =
      REWRITE_MODES.map(
        (m) => `<button class="gembar-tb-btn" data-mode="${m.mode}">${iconSvg(m.mode)}<span>${m.label}</span></button>`
      ).join("") + '<div class="gembar-toolbar-tail"></div>';
    document.body.appendChild(toolbar);
    toolbarInfo = info;
    const side = placeNear(toolbar, rect, { preferBelow: false, gap: 10, align: "left" });
    if (side === "below") toolbar.classList.add("gembar-below");
    toolbar.addEventListener("mousedown", (e) => e.preventDefault()); // keep selection alive
    toolbar.addEventListener("click", async (e) => {
      const btn = e.target.closest(".gembar-tb-btn");
      if (!btn || toolbar.classList.contains("gembar-busy")) return;
      toolbar.classList.add("gembar-busy");
      btn.classList.add("gembar-tb-loading");
      let resp;
      try {
        resp = await rewriteSelection(info, btn.dataset.mode);
      } catch (error) {
        resp = { ok: false, error: error?.message || "REQUEST_FAILED" };
      }
      removeToolbar();
      currentSelectionSignature = null;
      if (!resp?.ok) {
        showActionFailure(info.el, resp?.error || "REQUEST_FAILED", "rewrite", info);
        return;
      }
      applyReplacement(info, resp.result, btn.dataset.mode);
    });
  }

  function applyReplacement(info, newText, mode = "rewrite") {
    if (!info?.el?.isConnected || typeof newText !== "string") return false;
    const currentSource = getFieldText(info.el);
    const currentSelection = info.kind === "field"
      ? info.el.value.slice(info.start, info.end)
      : info.range?.toString();
    if (!isReplacementCurrent(currentSource, info.sourceText, currentSelection, info.text)) {
      showFieldStatus(info.el, "That text changed while write it correct was working. Select it again before applying a rewrite.", 5000, "", info);
      scheduleCheck(info.el, { immediate: true });
      return false;
    }
    if (newText === info.text) {
      showFieldStatus(info.el, mode === "fix"
        ? "write it correct found no verified correction for this selection. Your text was left unchanged."
        : "No text changes were returned; your selection was left unchanged.", 5000, "", info);
      return true;
    }
    if (info.kind === "field") {
      replaceRangeInField(info.el, info.start, info.end, newText);
      invalidateAndRecheck(info.el);
    } else if (info.kind === "ce") {
      // Select the exact range, then use execCommand like a real paste/typing
      // action would, so React/Lexical/ProseMirror-based editors (WhatsApp,
      // Slack, Notion...) pick up the change through their normal input path
      // instead of having a foreign DOM node appear.
      if (!info.range || !info.el.contains(info.range.startContainer) ||
          !info.el.contains(info.range.endContainer) || info.range.toString() !== info.text) {
        showFieldStatus(info.el, "That text changed while write it correct was working. Select it again before applying a rewrite.", 5000, "", info);
        scheduleCheck(info.el, { immediate: true });
        return false;
      }
      const sel = selectionFor(info.el);
      if (!sel) return false;
      sel.removeAllRanges();
      sel.addRange(info.range);
      const ok = document.execCommand("insertText", false, newText);
      if (!ok) {
        info.range.deleteContents();
        info.range.insertNode(document.createTextNode(newText));
      }
      info.el.dispatchEvent(new Event("input", { bubbles: true }));
      invalidateAndRecheck(info.el);
    }
    return true;
  }

  document.addEventListener("pointerup", updateSelectionToolbar, true);
  document.addEventListener("mouseup", updateSelectionToolbar, true);
  document.addEventListener("keyup", updateSelectionToolbar, true);
  document.addEventListener("select", updateSelectionToolbar, true);
  document.addEventListener("selectionchange", () => updateSelectionToolbar());

  // ---------- Right-click context menu handling ----------
  document.addEventListener("contextmenu", (e) => {
    const path = e.composedPath?.() || [e.target];
    const el = path.find((target) => isTextField(target) && (target.tagName === "TEXTAREA" || target.tagName === "INPUT")) || e.target;
    if (isTextField(el) && (el.tagName === "TEXTAREA" || el.tagName === "INPUT")) {
      lastContextTarget = {
        kind: "field", el, start: el.selectionStart, end: el.selectionEnd,
        text: el.value.slice(el.selectionStart, el.selectionEnd), sourceText: el.value,
      };
    } else {
      const ce = path.map((target) => getContentEditableRoot(target)).find(Boolean);
      const sel = selectionFor(ce);
      if (ce && sel && sel.rangeCount) {
        const range = sel.getRangeAt(0).cloneRange();
        lastContextTarget = { kind: "ce", el: ce, range, text: range.toString(), sourceText: getFieldText(ce) };
      }
    }
  });

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg?.type === "GEMBAR_CONTEXT_ACTION" && lastContextTarget) {
      const target = lastContextTarget;
      const text = target.text;
      if (!text || !text.trim()) return;
      rewriteSelection(target, msg.mode).then((resp) => {
        if (!resp?.ok) {
          showActionFailure(target.el, resp?.error || "REQUEST_FAILED", "rewrite", target);
          return;
        }
        applyReplacement(target, resp.result, msg.mode);
      }).catch((error) => {
        showActionFailure(target.el, error?.message || "REQUEST_FAILED", "rewrite", target);
      });
    }
  });

  // ---------- Wire up live checking ----------
  function attach(el) {
    if (el?.isContentEditable) el = getContentEditableRoot(el);
    if (!isTextField(el)) return;
    if (attachedFields.has(el)) {
      trackedFields.add(el);
      return;
    }
    attachedFields.add(el);
    trackedFields.add(el);
    fieldState.set(el, fieldState.get(el) || { issues: [], lastText: null, timer: null, overlay: null });
    el.addEventListener("input", () => {
      hideFieldStatus(el);
      scheduleCheck(el);
    });
    el.addEventListener("focus", () => {
      if (activeSuggestionsField && activeSuggestionsField !== el) closeSuggestionsPanel();
      scheduleCheck(el);
    });
  }

  function scanForFields(root = document) {
    if (root?.nodeType === Node.ELEMENT_NODE && isTextField(root)) attach(root);
    root.querySelectorAll?.("textarea, input, [contenteditable]").forEach(attach);
    root.querySelectorAll?.("*").forEach((element) => {
      if (element.shadowRoot) observeRoot(element.shadowRoot);
    });
  }

  function collectFields(node, collected) {
    if (!node || (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE)) return;
    if (node.nodeType === Node.ELEMENT_NODE && isTextField(node)) collected.add(node);
    node.querySelectorAll("textarea, input, [contenteditable]").forEach((el) => {
      if (isTextField(el)) collected.add(el);
    });
    node.querySelectorAll("*").forEach((element) => {
      if (element.shadowRoot) collectFields(element.shadowRoot, collected);
    });
  }

  function disconnectDetachedShadowRoots(node) {
    if (!node || (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE)) return;
    const inspect = (root) => {
      if (root.nodeType === Node.ELEMENT_NODE && root.shadowRoot) {
        const shadowRoot = root.shadowRoot;
        if (!root.isConnected) {
          const rootObserver = observerByRoot.get(shadowRoot);
          rootObserver?.disconnect();
          if (rootObserver) observers.delete(rootObserver);
          observerByRoot.delete(shadowRoot);
          observedRoots.delete(shadowRoot);
        }
        inspect(shadowRoot);
      }
      root.querySelectorAll?.("*").forEach((element) => {
        if (element.shadowRoot) inspect(element);
      });
    };
    inspect(node);
  }

  function detachField(el) {
    closePopup();
    const state = fieldState.get(el);
    if (!state) {
      trackedFields.delete(el);
      return;
    }
    clearTimeout(state.timer);
    clearTimeout(state.retryTimer);
    clearTimeout(state.statusTimer);
    state.generation = (state.generation || 0) + 1;
    state.resizeObserver?.disconnect();
    state.markerResizeObserver?.disconnect();
    if (state.overlayScrollHandler) el.removeEventListener("scroll", state.overlayScrollHandler);
    if (state.markerScrollHandler) el.removeEventListener("scroll", state.markerScrollHandler);
    state.overlay?.remove();
    state.markerLayer?.remove();
    state.thinking?.remove();
    state.status?.remove();
    if (activeSuggestionsField === el) closeSuggestionsPanel();
    state.timer = null;
    state.retryTimer = null;
    state.overlay = null;
    state.markerLayer = null;
    state.thinking = null;
    state.status = null;
    trackedFields.delete(el);
  }

  function handleMutations(mutations) {
    const removedFields = new Set();
    const removedNodes = [];
    const addedNodes = new Set();
    for (const m of mutations) {
      m.removedNodes.forEach((node) => {
        collectFields(node, removedFields);
        removedNodes.push(node);
      });
      m.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) addedNodes.add(node);
      });
    }
    for (const node of addedNodes) {
      let ancestor = node.parentNode;
      let nestedInAddedNode = false;
      while (ancestor) {
        if (addedNodes.has(ancestor)) {
          nestedInAddedNode = true;
          break;
        }
        ancestor = ancestor.parentNode;
      }
      if (!nestedInAddedNode && node.isConnected) scanForFields(node);
    }
    queueMicrotask(() => {
      for (const el of removedFields) {
        if (!el.isConnected) detachField(el);
      }
      for (const node of removedNodes) {
        if (!node.isConnected) disconnectDetachedShadowRoots(node);
      }
    });
  }

  const shadowSelectionRoots = new WeakSet();
  function observeRoot(root) {
    if (!root || observedRoots.has(root)) return;
    observedRoots.add(root);
    scanForFields(root);
    // selectionchange does not consistently cross a shadow boundary. Register
    // at each open root so mouse and keyboard selections in web-app editors
    // still trigger the selection toolbar and selected-text check.
    if (root.host && !shadowSelectionRoots.has(root)) {
      shadowSelectionRoots.add(root);
      root.addEventListener("selectionchange", () => updateSelectionToolbar(), true);
    }
    const rootObserver = new MutationObserver(handleMutations);
    observers.add(rootObserver);
    observerByRoot.set(root, rootObserver);
    rootObserver.observe(root, { childList: true, subtree: true });
  }

  // A few component frameworks attach open shadow roots after the host has
  // already entered the page. Inspect the composed event path when a field is
  // focused or edited, so those fields are attached even if the initial scan
  // happened before their shadow tree existed.
  for (const eventName of ["focusin", "input"]) {
    document.addEventListener(eventName, (event) => {
      for (const target of event.composedPath?.() || [event.target]) {
        if (target?.nodeType === Node.ELEMENT_NODE) {
          const field = target.isContentEditable ? getContentEditableRoot(target) : target;
          const wasAttached = attachedFields.has(field);
          attach(target);
          if (!wasAttached && isTextField(field)) scheduleCheck(field);
          if (target.shadowRoot) observeRoot(target.shadowRoot);
        }
      }
    }, true);
  }

  (async function init() {
    await loadSettings();
    if (contextInvalidated) return; // extension was reloaded before this tab even finished loading
    observeRoot(document.documentElement);
    window.addEventListener("scroll", () => {
      repositionFloatingControls();
      if (!toolbar) updateSelectionToolbar();
      for (const el of trackedFields) {
        const state = fieldState.get(el);
        if (!state) continue;
        if (state.overlay) positionOverlay(el, state.overlay);
        if (el.isContentEditable && state.markerLayer) renderContentEditableMarks(el, state.issues || []);
        if (activeSuggestionsField === el) queueSuggestionsPosition(el, activeSuggestionsPanel);
        if (state.status && document.body.contains(state.status)) {
          placeNear(state.status, el.getBoundingClientRect(), { preferBelow: false, gap: 8 });
        }
      }
    }, true);
    window.addEventListener("resize", () => {
      repositionFloatingControls();
      if (!toolbar) updateSelectionToolbar();
      for (const el of trackedFields) {
        const state = fieldState.get(el);
        if (state?.overlay) positionOverlay(el, state.overlay);
        if (el.isContentEditable && state?.markerLayer) renderContentEditableMarks(el, state.issues || []);
        if (activeSuggestionsField === el) queueSuggestionsPosition(el, activeSuggestionsPanel);
      }
    });
  })();
})();
