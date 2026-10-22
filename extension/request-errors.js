// Consistent, user-safe error messages shared by in-page actions and tests.
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  if (root) root.GembarRequestErrors = api;
})(typeof globalThis === "object" ? globalThis : this, function () {
  "use strict";

  function getErrorCode(error) {
    const value = typeof error === "string"
      ? error
      : error && typeof error === "object"
        ? error.code || error.error || error.message || ""
        : "";
    const normalized = String(value).trim().toUpperCase();
    if (/^GROQ_HTTP_\d{3}$/.test(normalized)) return normalized;
    return /^[A-Z][A-Z0-9_]{1,63}$/.test(normalized) ? normalized : "UNKNOWN_ERROR";
  }

  function message(error, operation = "check") {
    const code = getErrorCode(error);
    const action = operation === "rewrite" ? "rewrite" : "check";
    switch (code) {
      case "BACKGROUND_UNAVAILABLE":
        return "write it correct could not reach its background worker. Reload the extension, then refresh this page.";
      case "EXTENSION_CONTEXT_INVALIDATED":
        return "write it correct was reloaded or updated. Refresh this page to reconnect the extension.";
      case "NO_API_KEY":
        return "Add your Groq API key in write it correct settings to use writing suggestions.";
      case "NO_MODEL":
        return "Choose a Groq model in write it correct settings.";
      case "REQUEST_TIMEOUT":
        return `The writing ${action} timed out. Try again.`;
      case "NETWORK_ERROR":
        return "Could not reach Groq. Check your connection and try again.";
      case "GROQ_AUTH_ERROR":
        return "Groq could not authenticate this key. Check it in write it correct settings.";
      case "GROQ_RATE_LIMIT":
        return "Groq is rate-limiting requests. Wait a little, then try again.";
      case "GROQ_UNAVAILABLE":
        return "Groq is temporarily unavailable. Try again shortly.";
      case "INCOMPLETE_RESPONSE":
        return `Groq returned an incomplete ${action}. Try a shorter selection or try again.`;
      case "TEXT_TOO_LONG":
        return action === "rewrite"
          ? "This selection is too long to rewrite safely. Select a shorter passage and try again."
          : "This text is too long to check safely. Select a shorter passage and try again.";
      case "UNVERIFIED_SUGGESTION":
        return "write it correct could not safely verify these corrections. No changes were applied; select a shorter passage or try again.";
      case "SUGGESTION_TOO_BROAD":
        return "write it correct detected a correction that would change too much text, so it left your selection unchanged. Select a sentence or smaller passage and try again.";
      case "EMPTY_RESPONSE":
        return `Groq returned no text for this ${action}. Try again or choose another model in write it correct settings.`;
      case "BLOCKED_BY_SAFETY":
        return "Groq declined this text. Try selecting a shorter or different passage.";
      case "INVALID_RESPONSE":
        return "Groq returned an unreadable response. Try again shortly.";
      case "MALFORMED_RESPONSE":
        return "write it correct could not read Groq’s response. Try again or choose another model.";
      case "UNKNOWN_MESSAGE":
        return "write it correct could not start this action. Reload the extension and refresh this page.";
      case "REQUEST_FAILED":
        return `The writing ${action} failed unexpectedly. Try again.`;
      default:
        if (code.startsWith("GROQ_HTTP_")) {
          const status = code.slice("GROQ_HTTP_".length);
          return `Groq rejected this request (HTTP ${status}). Check the model and API access in write it correct settings.`;
        }
        return `write it correct could not ${action} this text (error ${code}). Try again or check write it correct settings.`;
    }
  }

  return { getErrorCode, message };
});
