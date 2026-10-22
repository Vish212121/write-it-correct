const test = require("node:test");
const assert = require("node:assert/strict");

const errors = require("../../extension/request-errors.js");

test("provider response errors have useful rewrite-specific messages", () => {
  assert.match(errors.message("EMPTY_RESPONSE", "rewrite"), /returned no text for this rewrite/i);
  assert.match(errors.message("BLOCKED_BY_SAFETY", "rewrite"), /declined this text/i);
  assert.match(errors.message("GROQ_HTTP_400", "rewrite"), /HTTP 400/);
  assert.match(errors.message("GROQ_RATE_LIMIT", "rewrite"), /rate-limiting/i);
});

test("unknown error objects are sanitized and retain a diagnostic code", () => {
  const rawProviderText = "token=do-not-show-private-response";
  assert.equal(errors.getErrorCode({ message: rawProviderText }), "UNKNOWN_ERROR");
  const message = errors.message({ message: rawProviderText }, "check");
  assert.match(message, /error UNKNOWN_ERROR/);
  assert.doesNotMatch(message, /do-not-show-private-response/);
});

test("background connection errors direct users to refresh the stale page", () => {
  assert.match(errors.message("BACKGROUND_UNAVAILABLE", "rewrite"), /Reload the extension, then refresh this page/);
  assert.match(errors.message("EXTENSION_CONTEXT_INVALIDATED", "rewrite"), /write it correct was reloaded or updated.*Refresh this page/);
});

test("oversized and unverified text actions explain that no unsafe edit was applied", () => {
  assert.match(errors.message("TEXT_TOO_LONG", "rewrite"), /too long to rewrite safely/);
  assert.match(errors.message("TEXT_TOO_LONG", "check"), /too long to check safely/);
  assert.match(errors.message("UNVERIFIED_SUGGESTION", "rewrite"), /No changes were applied/);
  assert.match(errors.message("SUGGESTION_TOO_BROAD", "rewrite"), /change too much text/);
});
