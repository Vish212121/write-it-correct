const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const suggestionLogic = require("../../extension/suggestion-logic.js");

const source = fs.readFileSync(path.join(__dirname, "..", "..", "extension", "background.js"), "utf8");

function createBackground({ fetchImpl, sendMessageImpl, onPacingWait } = {}) {
  let messageListener;
  let installListener;
  let menuClickListener;
  const pacingDelays = [];
  let fakeNow = 100_000;
  const localValues = {
    groqApiKey: "unit-test-key",
    model: "qwen/qwen3.8-27b",
    language: "auto",
    disabledSites: [],
    liveCheckEnabled: true,
  };
  const chrome = {
    storage: {
      local: {
        remove: async () => {},
        get: async (defaults) => ({ ...defaults, ...localValues }),
      },
      onChanged: { addListener: () => {} },
    },
    runtime: {
      onMessage: { addListener: (listener) => { messageListener = listener; } },
      onInstalled: { addListener: (listener) => { installListener = listener; } },
      lastError: undefined,
    },
    contextMenus: {
      removeAll: (callback) => callback?.(),
      create: () => {},
      onClicked: { addListener: (listener) => { menuClickListener = listener; } },
    },
    tabs: {
      sendMessage: (...args) => sendMessageImpl?.(...args),
    },
  };
  const nativeSetTimeout = setTimeout;
  const context = {
    chrome,
    URL,
    AbortController,
    fetch: fetchImpl || (async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ choices: [{ finish_reason: "stop", message: { content: '{"issues":[]}' } }] }),
    })),
    Date: class extends Date { static now() { return fakeNow; } },
    setTimeout: (callback, delay, ...args) => {
      if (delay === 2200) {
        pacingDelays.push(delay);
        fakeNow += delay;
        onPacingWait?.();
        return nativeSetTimeout(callback, 0, ...args);
      }
      return nativeSetTimeout(callback, delay, ...args);
    },
    clearTimeout,
    console,
    GembarSuggestionLogic: suggestionLogic,
  };
  vm.runInNewContext(source, context, { filename: "background.js" });
  return {
    chrome,
    pacingDelays,
    get installListener() { return installListener; },
    get menuClickListener() { return menuClickListener; },
    message(message) {
      return new Promise((resolve) => {
        const keepChannelOpen = messageListener(message, {}, resolve);
        assert.equal(keepChannelOpen, true);
      });
    },
  };
}

function providerResponse(content, finishReason = "stop") {
  return {
    ok: true,
    status: 200,
    headers: { get: () => null },
    json: async () => ({ choices: [{ finish_reason: finishReason, message: { content } }] }),
  };
}

function issueFor(text, original, suggestion, type = "grammar") {
  const start = text.indexOf(original);
  assert.notEqual(start, -1, `fixture must contain ${original}`);
  return { original, suggestion, type, message: "Make the minimal correction.", start, end: start + original.length };
}

test("Groq 429 responses preserve Retry-After for the content script", async () => {
  let requestCount = 0;
  const background = createBackground({
    fetchImpl: async () => ({
      get ok() { return false; },
      get status() { return 429; },
      get headers() { return { get: (name) => name.toLowerCase() === "retry-after" ? "7" : null }; },
      json: async () => {
        requestCount += 1;
        return { error: { type: "rate_limit_exceeded", message: "Too many requests" } };
      },
    }),
  });

  const response = await background.message({ type: "GEMBAR_CHECK_TEXT", text: "synthetic test text" });
  assert.equal(response.ok, false);
  assert.equal(response.error, "GROQ_RATE_LIMIT");
  assert.equal(response.retryAfterMs, 7000);
  const duringCooldown = await background.message({ type: "GEMBAR_CHECK_TEXT", text: "another sample" });
  assert.equal(duringCooldown.error, "GROQ_RATE_LIMIT");
  assert.equal(duringCooldown.retryAfterMs, 7000);
  assert.equal(requestCount, 1);
});

test("a queued request rechecks cooldown after waiting for its pace slot", async () => {
  let releaseFirstFetch;
  let fetchCount = 0;
  const background = createBackground({
    fetchImpl: async () => {
      fetchCount += 1;
      if (fetchCount === 1) {
        return new Promise((resolve) => { releaseFirstFetch = resolve; });
      }
      throw new Error("cooldown should have prevented this request");
    },
    onPacingWait: () => releaseFirstFetch?.({
      ok: false,
      status: 429,
      headers: { get: (name) => name.toLowerCase() === "retry-after" ? "10" : null },
      json: async () => ({ error: { type: "rate_limit_exceeded", message: "Too many requests" } }),
    }),
  });

  const first = background.message({ type: "GEMBAR_CHECK_TEXT", text: "first sample" });
  const second = background.message({ type: "GEMBAR_CHECK_TEXT", text: "second sample" });
  const [firstResponse, secondResponse] = await Promise.all([first, second]);

  assert.equal(firstResponse.error, "GROQ_RATE_LIMIT");
  assert.equal(secondResponse.error, "GROQ_RATE_LIMIT");
  assert.equal(secondResponse.retryAfterMs, 10_000);
  assert.equal(fetchCount, 1);
});

test("live checks share a request pace across fields", async () => {
  const background = createBackground();
  const first = await background.message({ type: "GEMBAR_CHECK_TEXT", text: "first sample" });
  const second = await background.message({ type: "GEMBAR_CHECK_TEXT", text: "second sample" });
  assert.equal(first.ok, true);
  assert.equal(second.ok, true);
  assert.deepEqual(background.pacingDelays, [2200]);
});

test("live check preserves exact suggestion offsets and requests a careful two-pass review", async () => {
  let submittedBody;
  const issue = { original: "deos", suggestion: "does", type: "spelling", message: "Correct spelling.", start: 15, end: 19 };
  const background = createBackground({
    fetchImpl: async (_url, options) => {
      submittedBody = JSON.parse(options.body);
      return {
        ok: true,
        status: 200,
        headers: { get: () => null },
        json: async () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ issues: [issue] }) } }] }),
      };
    },
  });
  const response = await background.message({ type: "GEMBAR_CHECK_TEXT", text: "Does this work deos" });
  assert.equal(response.ok, true);
  assert.equal(response.issues[0].start, 15);
  assert.equal(response.issues[0].end, 19);
  assert.match(submittedBody.messages[0].content, /two passes/);
  assert.match(submittedBody.messages[0].content, /UTF-16 string indexing/);
});

test("live check rejects unchanged or structurally invalid model suggestions", async () => {
  const background = createBackground({
    fetchImpl: async () => ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => ({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ issues: [{
        original: "teh", suggestion: "teh", type: "spelling", message: "No change.", start: 0, end: 3,
      }] }) } }] }),
    }),
  });
  const response = await background.message({ type: "GEMBAR_CHECK_TEXT", text: "teh" });
  assert.equal(response.ok, false);
  assert.equal(response.error, "MALFORMED_RESPONSE");
});

test("Fix applies local grammar and spelling edits from corrected text and preserves paragraph layout", async () => {
  const paragraph = "Yesterday I recieve the package. It were damaged, but the seller respond quickly.\nThey send a replacment after I reported it. The package also included a warranty card and two instruction booklets.";
  const corrected = "Yesterday I received the package. It was damaged, but the seller responded quickly.\nThey sent a replacement after I reported it. The package also included a warranty card and two instruction booklets.";
  let body;
  const background = createBackground({
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return providerResponse(corrected);
    },
  });

  const response = await background.message({ type: "GEMBAR_REWRITE_TEXT", mode: "fix", text: paragraph });
  assert.equal(response.ok, true);
  assert.equal(response.result, corrected);
  assert.equal(body.messages[1].content, paragraph);
  assert.equal(body.response_format, undefined);
  assert.equal(body.max_completion_tokens, 4096);
  assert.match(body.messages[0].content, /Return only the complete corrected text/);
  assert.match(body.messages[0].content, /entire text in two passes/);
  assert.match(body.messages[0].content, /Do not paraphrase/);
  assert.doesNotMatch(body.messages[0].content, /improve your writing|word choice/i);
  assert.match(response.result, /quickly\.\nThey sent a replacement/);
});

test("Fix preserves clean text and user whitespace exactly", async () => {
  for (const text of ["The package arrived yesterday.", "  Keep this spacing.\n  And this line.  "]) {
    const background = createBackground({ fetchImpl: async () => providerResponse(text) });
    const response = await background.message({ type: "GEMBAR_REWRITE_TEXT", mode: "fix", text });
    assert.equal(response.ok, true);
    assert.equal(response.result, text);
  }
});

test("Fix makes a minimal punctuation correction to a short sentence", async () => {
  const text = "Where are you going";
  const background = createBackground({ fetchImpl: async () => providerResponse("Where are you going?") });
  const response = await background.message({ type: "GEMBAR_REWRITE_TEXT", mode: "fix", text });
  assert.equal(response.ok, true);
  assert.equal(response.result, "Where are you going?");
});

test("Fix uses the corrected output to target the intended repeated word", async () => {
  const text = "bad then bad";
  const background = createBackground({ fetchImpl: async () => providerResponse("good then bad") });
  const response = await background.message({ type: "GEMBAR_REWRITE_TEXT", mode: "fix", text });
  assert.equal(response.ok, true);
  assert.equal(response.result, "good then bad");
});

test("Fix rejects a validly located paragraph-wide rewrite as too broad to apply safely", async () => {
  const text = "The first part of this report describes the launch plan. The second part explains the risks and the staffing changes. The final part lists decisions and follow-up tasks for next week.";
  const background = createBackground({ fetchImpl: async () => providerResponse("This report outlines the launch, risks, staffing changes, decisions, and next steps for the coming week.") });
  const response = await background.message({ type: "GEMBAR_REWRITE_TEXT", mode: "fix", text });
  assert.equal(response.ok, false);
  assert.equal(response.error, "SUGGESTION_TOO_BROAD");
  assert.equal(response.result, undefined);
});

test("Fix rejects a tiny source range replaced with a long generated passage", async () => {
  const text = "This is bad.";
  const background = createBackground({ fetchImpl: async () => providerResponse("This is a detailed alternative paragraph that changes the meaning and expands the original text.") });
  const response = await background.message({ type: "GEMBAR_REWRITE_TEXT", mode: "fix", text });
  assert.equal(response.ok, false);
  assert.equal(response.error, "SUGGESTION_TOO_BROAD");
});

test("Fix and other actions reject over-limit text without truncating or sending it", async () => {
  let fetchCount = 0;
  const background = createBackground({
    fetchImpl: async () => { fetchCount += 1; return providerResponse("unchanged"); },
  });
  const tooLongForCheck = "x".repeat(6001);
  const tooLongForRewrite = "x".repeat(8001);

  const fix = await background.message({ type: "GEMBAR_REWRITE_TEXT", mode: "fix", text: tooLongForCheck });
  const check = await background.message({ type: "GEMBAR_CHECK_TEXT", text: tooLongForCheck });
  const rewrite = await background.message({ type: "GEMBAR_REWRITE_TEXT", mode: "improve", text: tooLongForRewrite });
  assert.equal(fix.error, "TEXT_TOO_LONG");
  assert.equal(check.error, "TEXT_TOO_LONG");
  assert.equal(rewrite.error, "TEXT_TOO_LONG");
  assert.equal(fetchCount, 0);
});

test("improve, shorten, formal, and casual remain distinct generative actions", async () => {
  const modes = {
    improve: /Improve clarity, flow, and word choice/,
    shorten: /Make the text noticeably more concise/,
    formal: /Rewrite the text in a formal, professional tone/,
    casual: /Rewrite the text in a relaxed, conversational tone/,
  };
  let body;
  const background = createBackground({
    fetchImpl: async (_url, options) => {
      body = JSON.parse(options.body);
      return providerResponse("Rewritten sample.");
    },
  });
  for (const [mode, instruction] of Object.entries(modes)) {
    const response = await background.message({ type: "GEMBAR_REWRITE_TEXT", mode, text: "Original sample." });
    assert.equal(response.ok, true, mode);
    assert.equal(response.result, "Rewritten sample.", mode);
    assert.match(body.messages[0].content, instruction, mode);
    assert.equal(body.response_format, undefined, `${mode} should remain a free rewrite`);
  }
});

test("a rewrite response cleaned down to empty text cannot erase the selection", async () => {
  const background = createBackground({ fetchImpl: async () => providerResponse("```text\n```\n") });
  const response = await background.message({ type: "GEMBAR_REWRITE_TEXT", mode: "improve", text: "Keep this." });
  assert.equal(response.ok, false);
  assert.equal(response.error, "EMPTY_RESPONSE");
});

test("context-menu actions ignore protected pages before messaging", () => {
  let sendCount = 0;
  const background = createBackground({ sendMessageImpl: () => { sendCount += 1; } });
  background.menuClickListener({ menuItemId: "gembar-fix", frameId: 0 }, { id: 1, url: "chrome://extensions" });
  assert.equal(sendCount, 0);
});

test("non-JSON error bodies keep their HTTP status classification", async () => {
  const background = createBackground({
    fetchImpl: async () => ({
      ok: false,
      status: 429,
      headers: { get: (name) => name.toLowerCase() === "retry-after" ? "3" : null },
      json: async () => { throw new SyntaxError("not JSON"); },
    }),
  });
  const response = await background.message({ type: "GEMBAR_CHECK_TEXT", text: "synthetic test text" });
  assert.equal(response.error, "GROQ_RATE_LIMIT");
  assert.equal(response.retryAfterMs, 3000);
});

test("context-menu receiver errors are consumed through lastError", () => {
  let callbackCalled = false;
  const background = createBackground({
    sendMessageImpl: (_tabId, _message, _options, callback) => {
      background.chrome.runtime.lastError = { message: "Could not establish connection. Receiving end does not exist." };
      callback();
      background.chrome.runtime.lastError = undefined;
      callbackCalled = true;
    },
  });
  assert.doesNotThrow(() => background.menuClickListener(
    { menuItemId: "gembar-fix", frameId: 9 },
    { id: 1, url: "https://example.test/" }
  ));
  assert.equal(callbackCalled, true);
});

test("context-menu Promise rejections are consumed when a frame has no receiver", async () => {
  let rejectionHandlerAttached = false;
  const background = createBackground({
    sendMessageImpl: (_tabId, _message, _options, callback) => {
      callback?.();
      const rejected = Promise.reject(new Error("Could not establish connection. Receiving end does not exist."));
      const nativeCatch = rejected.catch.bind(rejected);
      rejected.catch = (handler) => {
        rejectionHandlerAttached = true;
        return nativeCatch(handler);
      };
      return rejected;
    },
  });

  assert.doesNotThrow(() => background.menuClickListener(
    { menuItemId: "gembar-fix", frameId: 9 },
    { id: 1, url: "https://example.test/" }
  ));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(rejectionHandlerAttached, true);
});
