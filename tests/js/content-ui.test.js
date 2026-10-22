const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const geometry = require("../../extension/selection-geometry.js");
const suggestionLogic = require("../../extension/suggestion-logic.js");
const contentScript = fs.readFileSync(path.join(__dirname, "..", "..", "extension", "content.js"), "utf8");
const fixture = fs.readFileSync(path.join(__dirname, "..", "manual", "typing-fixture.html"), "utf8");
const chromeManifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "extension", "manifest.json"), "utf8"));
const firefoxManifest = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "extension", "manifest_firefox.json"), "utf8"));
const packageInfo = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "..", "package.json"), "utf8"));

const rect = (left, top, width, height) => ({
  left,
  top,
  right: left + width,
  bottom: top + height,
  width,
  height,
});

test("selection anchors to the last visible text fragment instead of a whole selection box", () => {
  const firstLine = rect(80, 180, 420, 22);
  const lastLine = rect(350, 440, 180, 22);
  const selectionBounds = rect(80, 180, 900, 520);
  const editor = rect(40, 400, 700, 90);
  const range = {
    getClientRects: () => [firstLine, lastLine],
    getBoundingClientRect: () => selectionBounds,
  };

  assert.equal(geometry.getSelectionAnchorRect(range, editor, 1200, 800), lastLine);
});

test("empty or viewport-sized selections fall back to the visible editor", () => {
  const editor = rect(100, 600, 500, 90);
  const empty = { getClientRects: () => [], getBoundingClientRect: () => rect(0, 0, 0, 0) };
  const fullViewport = { getClientRects: () => [], getBoundingClientRect: () => rect(0, 0, 1200, 800) };

  assert.equal(geometry.getSelectionAnchorRect(empty, editor, 1200, 800), editor);
  assert.equal(geometry.getSelectionAnchorRect(fullViewport, editor, 1200, 800), editor);
});

test("large rich-editor blocks use a visible selection endpoint", () => {
  const editor = rect(40, 0, 800, 700);
  let collapsed = false;
  const range = {
    getClientRects: () => [rect(40, 0, 800, 700)],
    cloneRange: () => ({
      collapse(value) { collapsed = value === false; },
      getBoundingClientRect: () => rect(430, 118, 0, 24),
    }),
    getBoundingClientRect: () => rect(40, 0, 800, 700),
  };
  assert.deepEqual(geometry.getSelectionAnchorRect(range, editor, 1200, 800), rect(430, 118, 1, 24));
  assert.equal(collapsed, true);
  assert.match(contentScript, /anchor === editorRect && editorRect\.height > document\.documentElement\.clientHeight \* 0\.6/);
});

test("floating controls flip and clamp using viewport coordinates", () => {
  const nearTop = geometry.getNearPosition(rect(1180, 6, 24, 18), 180, 44, 1200, 800, {
    preferBelow: false,
    gap: 10,
  });
  assert.equal(nearTop.side, "below");
  assert.equal(nearTop.top, 34);
  assert.equal(nearTop.left, 1012);

  const nearBottom = geometry.getNearPosition(rect(160, 770, 200, 20), 220, 70, 800, 800, {
    preferBelow: false,
    gap: 8,
  });
  assert.equal(nearBottom.side, "above");
  assert.equal(nearBottom.top, 692);
  assert.equal(nearBottom.left, 160);
});

test("full-height textarea selections anchor by their text, not the editor bottom", () => {
  const editor = rect(405, 94, 700, 1300);
  const mirror = rect(-100000, 0, 700, 2000);
  const metrics = {
    offsetWidth: 700, offsetHeight: 1300, clientLeft: 1, clientTop: 1,
    clientWidth: 698, clientHeight: 1298, scrollLeft: 0, scrollTop: 0,
  };
  const selectedLines = [rect(-99979, 16, 230, 26), rect(-99979, 42, 385, 26)];
  const anchor = geometry.projectTextFieldRects(selectedLines, editor, mirror, metrics, 1143, 1396);
  assert.deepEqual(anchor, rect(426, 136, 385, 26));
  const toolbar = geometry.getNearPosition(anchor, 400, 42, 1143, 1396, { preferBelow: false, gap: 10 });
  assert.equal(toolbar.top, 84);
  assert.ok(toolbar.top < 200);
});

test("scrolled and wrapped textareas use the last visible selected line", () => {
  const editor = rect(100, -200, 600, 700);
  const mirror = rect(-100000, 0, 600, 1200);
  const metrics = {
    offsetWidth: 600, offsetHeight: 700, clientLeft: 1, clientTop: 1,
    clientWidth: 598, clientHeight: 698, scrollLeft: 0, scrollTop: 500,
  };
  const fragments = [
    rect(-99900, 700, 280, 24), // y = 0 after field and internal scroll
    rect(-99900, 728, 340, 24), // y = 28
    rect(-99900, 1300, 250, 24), // outside the field
  ];
  const anchor = geometry.projectTextFieldRects(fragments, editor, mirror, metrics, 800, 500);
  assert.deepEqual(anchor, rect(200, 28, 340, 24));
});

test("single-line input accounts for horizontal scrolling and clips hidden text", () => {
  const field = rect(20, 300, 280, 40);
  const mirror = rect(-100000, 0, 280, 40);
  const metrics = {
    offsetWidth: 280, offsetHeight: 40, clientLeft: 1, clientTop: 1,
    clientWidth: 278, clientHeight: 38, scrollLeft: 120, scrollTop: 0,
  };
  const visible = geometry.projectTextFieldRects([rect(-99840, 9, 90, 22)], field, mirror, metrics, 800, 600);
  assert.deepEqual(visible, rect(60, 309, 90, 22));
  const hidden = geometry.projectTextFieldRects([rect(-99990, 9, 30, 22)], field, mirror, metrics, 800, 600);
  assert.equal(hidden, null);
});

test("textarea mirror keeps a single text node, copies typography, and cleans up", () => {
  const fragments = [rect(-99970, 15, 120, 26), rect(-99970, 41, 200, 26)];
  let mirror;
  let removed = false;
  let rangeStart;
  let rangeEnd;
  const document = {
    defaultView: { getComputedStyle: () => ({
      borderTopWidth: "1px", borderRightWidth: "1px",
      borderBottomWidth: "1px", borderLeftWidth: "1px",
      paddingTop: "15px", paddingRight: "24px", paddingBottom: "80px", paddingLeft: "24px",
      fontFamily: "Arial", fontSize: "18px", lineHeight: "26px",
    }) },
    createElement(tag) {
      assert.equal(tag, "div");
      mirror = {
        style: {}, children: [], appendChild(node) { this.children.push(node); },
        getBoundingClientRect: () => rect(-100000, 0, 500, 1000),
        remove() { removed = true; },
      };
      return mirror;
    },
    createTextNode(text) { return { text }; },
    createRange() { return {
      setStart(node, offset) { rangeStart = { node, offset }; },
      setEnd(node, offset) { rangeEnd = { node, offset }; },
      getClientRects: () => fragments,
    }; },
    body: { appendChild() {} },
  };
  const value = "First line.\nSecond line has a typo.";
  const field = {
    value, tagName: "TEXTAREA", wrap: "soft", ownerDocument: document,
    clientWidth: 498, clientHeight: 698, clientLeft: 1, clientTop: 1,
    offsetWidth: 500, offsetHeight: 700, scrollLeft: 0, scrollTop: 0,
    getBoundingClientRect: () => rect(100, 50, 500, 700),
  };
  const anchor = geometry.getTextFieldSelectionRect(field, 0, value.length, 800, 800);
  assert.deepEqual(anchor, rect(130, 91, 200, 26));
  assert.equal(mirror.style.width, "500px");
  assert.equal(mirror.style.whiteSpace, "pre-wrap");
  assert.equal(mirror.style.paddingTop, "15px");
  assert.equal(mirror.children.length, 1);
  assert.equal(mirror.children[0].text, value);
  assert.equal(rangeStart.node, mirror.children[0]);
  assert.equal(rangeStart.offset, 0);
  assert.equal(rangeEnd.offset, value.length);
  assert.equal(removed, true);
});

test("nested scroll panes clip selected text before toolbar placement", () => {
  const editor = rect(100, 50, 500, 700);
  const mirror = rect(-100000, 0, 500, 1000);
  const metrics = {
    offsetWidth: 500, offsetHeight: 700, clientLeft: 1, clientTop: 1,
    clientWidth: 498, clientHeight: 698, scrollLeft: 0, scrollTop: 0,
  };
  const pane = rect(80, 100, 550, 200);
  assert.equal(geometry.projectTextFieldRects([rect(-99900, 390, 100, 22)],
    editor, mirror, metrics, 800, 800, pane), null);
  assert.deepEqual(geometry.projectTextFieldRects([rect(-99900, 140, 100, 22)],
    editor, mirror, metrics, 800, 800, pane), rect(200, 190, 100, 22));
});

test("shadow-root selections and same-text retries keep controls reachable", () => {
  assert.match(contentScript, /el === el\.getRootNode\?\.\(\)\.activeElement/);
  assert.match(contentScript, /signature === currentSelectionSignature && toolbar\?\.isConnected/);
  assert.match(contentScript, /removeToolbar\(\);\s*currentSelectionSignature = null;\s*if \(!resp\?\.ok\)/);
});

test("selection fragments outside the viewport do not create an edge-clamped toolbar", () => {
  const field = rect(60, 50, 500, 650);
  const mirror = rect(-100000, 0, 500, 1200);
  const metrics = {
    offsetWidth: 500, offsetHeight: 650, clientLeft: 1, clientTop: 1,
    clientWidth: 498, clientHeight: 648, scrollLeft: 0, scrollTop: 0,
  };
  assert.equal(geometry.projectTextFieldRects([rect(-99900, 900, 150, 22)], field, mirror, metrics, 800, 700), null);
  assert.match(contentScript, /if \(!isUsableRect\(rect, document\.documentElement\.clientWidth/);
  assert.match(contentScript, /getTextFieldSelectionRect\(\s*info\.el, info\.start, info\.end/);
});

test("toolbar wraps inside narrow viewports", () => {
  const css = fs.readFileSync(path.join(__dirname, "..", "..", "extension", "content.css"), "utf8");
  assert.match(css, /\.gembar-toolbar\s*\{[^}]*flex-wrap: wrap/s);
  assert.match(css, /\.gembar-toolbar\s*\{[^}]*max-width: calc\(100vw - 16px\)/s);
});

test("whole-editor and unique selections recover when nested editor offsets are unavailable", () => {
  assert.equal(geometry.resolveSelectionStart("We recieved your mesage.", "We recieved your mesage.", -1), 0);
  assert.equal(geometry.resolveSelectionStart("A typo is here.", "typo", -1), 2);
  assert.equal(geometry.resolveSelectionStart("same text, same text", "same text", -1), -1);
});

test("WhatsApp style mouse and keyboard events are observed in capture phase", () => {
  assert.match(contentScript, /addEventListener\("pointerup", updateSelectionToolbar, true\)/);
  assert.match(contentScript, /addEventListener\("mouseup", updateSelectionToolbar, true\)/);
  assert.match(contentScript, /addEventListener\("keyup", updateSelectionToolbar, true\)/);
});

test("both extension manifests load shared helpers before the content script", () => {
  for (const manifest of [chromeManifest, firefoxManifest]) {
    assert.deepEqual(manifest.content_scripts[0].js, ["selection-geometry.js", "request-errors.js", "suggestion-logic.js", "content.js"]);
    assert.equal(manifest.version, packageInfo.version);
  }
});

test("message failures stay in-page without global rejection false positives", () => {
  assert.doesNotMatch(contentScript, /alert\s*\(/);
  assert.match(contentScript, /showActionFailure\(info\.el, resp\?\.error/);
  assert.match(contentScript, /error: "EXTENSION_CONTEXT_INVALIDATED"/);
  assert.match(contentScript, /error: "BACKGROUND_UNAVAILABLE"/);
  assert.doesNotMatch(contentScript, /resolve\(null\)/);
  assert.match(contentScript, /root\.addEventListener\("selectionchange"/);
  assert.doesNotMatch(contentScript, /addEventListener\("unhandledrejection"/);
  assert.match(contentScript, /pendingMessage\.catch\(handleMessageError\)/);
});

test("local site-shaped fixtures cover common message and mail editors", () => {
  assert.match(contentScript, /gembar-suggestions-apply-all/);
  assert.match(fixture, /<textarea id="test-area"/);
  assert.match(fixture, /<input id="test-input" type="text"/);
  for (const id of ["whatsapp-composer", "slack-composer", "gmail-composer"]) {
    assert.match(fixture, new RegExp(`id="${id}"[^>]*contenteditable="true"`));
  }
});

test("suggestion ranges use verified offsets and reject ambiguous fallback matches", () => {
  const repeated = "bad, then bad";
  const secondBad = { original: "bad", suggestion: "good", type: "spelling", message: "Correct spelling.", start: 10, end: 13 };
  const result = suggestionLogic.locateIssues(repeated, [secondBad]);
  assert.equal(result.located.length, 1);
  assert.equal(result.located[0].start, 10);
  assert.equal(result.unmatched, 0);

  const ambiguous = suggestionLogic.locateIssues(repeated, [{ ...secondBad, start: 1, end: 4 }]);
  assert.equal(ambiguous.located.length, 0);
  assert.equal(ambiguous.unmatched, 1);
});

test("unique bad offsets recover safely, while overlaps and unchanged replacements are rejected", () => {
  const source = "We recieved this.";
  const mismatch = suggestionLogic.locateIssues(source, [{
    original: "recieved", suggestion: "received", type: "spelling", message: "Correct spelling.", start: 0, end: 8,
  }]);
  assert.equal(mismatch.located[0].start, 3);
  assert.equal(mismatch.unmatched, 0);

  const overlaps = suggestionLogic.locateIssues("teh", [
    { original: "teh", suggestion: "the", type: "spelling", message: "Correct spelling.", start: 0, end: 3 },
    { original: "teh", suggestion: "the!", type: "punctuation", message: "Add punctuation.", start: 0, end: 3 },
  ]);
  assert.equal(overlaps.located.length, 1);
  assert.equal(overlaps.unmatched, 1);

  const unchanged = suggestionLogic.locateIssues(source, [{
    original: "this", suggestion: "this", type: "style", message: "No actual change.", start: 12, end: 16,
  }]);
  assert.equal(unchanged.located.length, 0);
  assert.equal(unchanged.unmatched, 1);
});

test("Apply all builds a safe ordered replacement and rejects stale or overlapping ranges", () => {
  const source = "We recieved teh note.";
  const issues = [
    { original: "teh", suggestion: "the", type: "spelling", message: "Correct spelling.", start: 12, end: 15 },
    { original: "recieved", suggestion: "received", type: "spelling", message: "Correct spelling.", start: 3, end: 11 },
  ];
  const replacement = suggestionLogic.buildReplacement(source, issues);
  assert.equal(replacement.ok, true);
  assert.equal(replacement.text, "We received the note.");

  const stale = suggestionLogic.buildReplacement(source, [{ ...issues[0], start: 0, end: 3 }]);
  assert.equal(stale.ok, false);
  const overlapping = suggestionLogic.buildReplacement("teh", [
    { ...issues[0], original: "te", start: 0, end: 2 },
    { ...issues[0], original: "eh", start: 1, end: 3 },
  ]);
  assert.equal(overlapping.ok, false);
});

test("Show keeps the expanded panel available when all placements cover page content", () => {
  const candidates = [
    { bounded: true, side: "above", textScore: 3, editorOverlapArea: 0 },
    { bounded: true, side: "corner", textScore: 1, editorOverlapArea: 150 },
  ];
  assert.equal(suggestionLogic.chooseSuggestionPlacement(candidates), null);
  assert.equal(suggestionLogic.chooseSuggestionPlacement(candidates, { allowOverlap: true }).side, "corner");
  assert.match(contentScript, /panel\.dataset\.manualExpanded === "true"/);
});

test("empty model results do not show an error-free success message", () => {
  assert.doesNotMatch(contentScript, /Looks good\. No suggestions found\./);
  assert.match(contentScript, /issueResult\.unmatched/);
  assert.match(fs.readFileSync(path.join(__dirname, "..", "..", "extension", "background.js"), "utf8"), /Proofread the text carefully in two passes/);
});

test("UTF-16 offsets place suggestions correctly after emoji text", () => {
  const source = "Hi 😀 deos";
  const start = source.indexOf("deos");
  const result = suggestionLogic.locateIssues(source, [{
    original: "deos", suggestion: "does", type: "spelling", message: "Correct spelling.", start, end: start + 4,
  }]);
  assert.equal(result.located[0].start, start);
  assert.equal(source.slice(result.located[0].start, result.located[0].end), "deos");
});

test("delayed rewrites can apply only while the source and selected text remain unchanged", () => {
  const source = "Keep this paragraph intact except for the typo.";
  const selection = "the typo";
  assert.equal(suggestionLogic.isReplacementCurrent(source, source, selection, selection), true);
  assert.equal(suggestionLogic.isReplacementCurrent(`${source} edited`, source, selection, selection), false);
  assert.equal(suggestionLogic.isReplacementCurrent(source, source, "a different range", selection), false);
  assert.match(contentScript, /Gembar found no verified correction for this selection/);
  assert.match(contentScript, /Select it again before applying a rewrite/);
});

test("Fix reuses current, verified live issues without another provider request", () => {
  assert.match(contentScript, /function cachedFixReplacement\(info\)/);
  assert.match(contentScript, /state\.lastText !== info\.sourceText/);
  assert.match(contentScript, /getFieldText\(info\.el\) !== info\.sourceText/);
  assert.match(contentScript, /await pendingCheck\.catch\(\(\) => \{\}\)/);
  assert.match(contentScript, /cachedFix === null\s*\? await rewriteText/);

  const selected = "fro small senntemnce oit wokrs";
  const issues = [
    { original: "fro", suggestion: "for", type: "spelling", message: "Spelling", start: 0, end: 3 },
    { original: "senntemnce", suggestion: "sentence", type: "spelling", message: "Spelling", start: 10, end: 20 },
    { original: "oit", suggestion: "it", type: "spelling", message: "Spelling", start: 21, end: 24 },
    { original: "wokrs", suggestion: "works", type: "spelling", message: "Spelling", start: 25, end: 30 },
  ];
  const result = suggestionLogic.buildMinimalFixReplacement(selected, issues);
  assert.equal(result.ok, true);
  assert.equal(result.text, "for small sentence it works");
});

test("cached Fix applies only verified issues inside the selected line of a larger note", () => {
  const selected = "fro small senntemnce oit wokrs";
  const source = `The first, longer sentence has an eror.\n${selected}`;
  const start = source.indexOf(selected);
  const issues = [
    { original: "eror", suggestion: "error", type: "spelling", message: "Spelling", start: source.indexOf("eror"), end: source.indexOf("eror") + 4 },
    { original: "fro", suggestion: "for", type: "spelling", message: "Spelling", start, end: start + 3 },
    { original: "wokrs", suggestion: "works", type: "spelling", message: "Spelling", start: source.indexOf("wokrs"), end: source.indexOf("wokrs") + 5 },
  ];
  assert.equal(suggestionLogic.buildCachedSelectionFixReplacement(source, selected, start, issues),
    "for small senntemnce oit works");
  assert.equal(suggestionLogic.buildCachedSelectionFixReplacement(source, selected, start - 1, issues), null);
  assert.equal(suggestionLogic.buildCachedSelectionFixReplacement(source, selected, start, [issues[0]]), null);
});

test("minimal Fix ignores style and rejects overlapping, stale, and broad changes", () => {
  const source = "Please chek this sentence.";
  const spelling = { original: "chek", suggestion: "check", type: "spelling", message: "Spelling", start: 7, end: 11 };
  const style = { original: "Please", suggestion: "Kindly", type: "style", message: "Style", start: 0, end: 6 };
  const result = suggestionLogic.buildMinimalFixReplacement(source, [style, spelling]);
  assert.equal(result.ok, true);
  assert.equal(result.text, "Please check this sentence.");
  assert.equal(suggestionLogic.buildMinimalFixReplacement(source, [style]).text, source);
  assert.equal(suggestionLogic.buildMinimalFixReplacement("bad then bad", [
    { original: "bad", suggestion: "good", type: "spelling", message: "Spelling", start: 1, end: 4 },
  ]).reason, "UNVERIFIED_SUGGESTION");
  assert.equal(suggestionLogic.buildMinimalFixReplacement(source, [spelling, {
    ...spelling, suggestion: "checks",
  }]).reason, "UNVERIFIED_SUGGESTION");
  assert.equal(suggestionLogic.buildMinimalFixReplacement(source, [{
    original: source, suggestion: "Check it.", type: "grammar", message: "Rewrite", start: 0, end: source.length,
  }]).reason, "SUGGESTION_TOO_BROAD");
});

test("Fix derives minimal verified edits from natural text output", () => {
  const cases = [
    ["fro small senntemnce oit wokrs", "for small sentence it works"],
    ["Where are you going", "Where are you going?"],
    ["I has a replacment", "I have a replacement"],
  ];
  for (const [source, corrected] of cases) {
    const result = suggestionLogic.buildMinimalFixFromText(source, corrected);
    assert.equal(result.ok, true);
    assert.equal(result.text, corrected);
    assert.ok(result.issues.length > 0);
    assert.ok(result.issues.every((issue) => source.slice(issue.start, issue.end) === issue.original));
  }
  const clean = "The package arrived yesterday.";
  assert.deepEqual(suggestionLogic.buildMinimalFixFromText(clean, clean), { ok: true, text: clean, issues: [] });
  assert.equal(suggestionLogic.buildMinimalFixFromText("Keep  this spacing", "Keep this spacing").reason, "UNVERIFIED_SUGGESTION");
});

test("status near a full-height editor uses visible text instead of the editor bottom", () => {
  assert.match(contentScript, /function fieldStatusAnchor\(el, selectionInfo = null\)/);
  assert.match(contentScript, /getTextFieldSelectionRect\(el, el\.selectionStart, el\.selectionEnd/);
  assert.match(contentScript, /getSelectionAnchorRect\(range, null, viewportWidth, viewportHeight\)/);
  assert.match(contentScript, /placeNear\(state\.status, fieldStatusAnchor\(el, selectionInfo\)/);
});

test("Fix trims unchanged sentence context and preserves Unicode boundaries", () => {
  const sentence = "This sentence has a speling eror.";
  const sentenceIssue = {
    original: sentence,
    suggestion: "This sentence has a spelling error.",
    type: "spelling",
    message: "Correct spelling.",
    start: 0,
    end: sentence.length,
  };
  const narrowed = suggestionLogic.minimizeIssue(sentenceIssue);
  assert.ok(narrowed);
  assert.ok(narrowed.original.length < sentence.length);
  assert.equal(sentence.slice(narrowed.start, narrowed.end), narrowed.original);
  assert.equal(suggestionLogic.buildReplacement(sentence, [narrowed]).text, "This sentence has a spelling error.");

  const insertion = "Where are you going";
  const punctuation = suggestionLogic.minimizeIssue({
    original: insertion,
    suggestion: `${insertion}?`,
    type: "punctuation",
    message: "Add a question mark.",
    start: 0,
    end: insertion.length,
  });
  assert.equal(punctuation.original, "g");
  assert.equal(punctuation.suggestion, "g?");

  const emojiText = "Hi 😀 teh";
  const emojiIssue = suggestionLogic.minimizeIssue({
    original: emojiText,
    suggestion: "Hi 😀 the",
    type: "spelling",
    message: "Correct spelling.",
    start: 0,
    end: emojiText.length,
  });
  assert.ok(emojiIssue);
  assert.equal(emojiText.slice(emojiIssue.start, emojiIssue.end), emojiIssue.original);
  assert.doesNotMatch(emojiIssue.original, /[\uD800-\uDBFF]$/);
});
