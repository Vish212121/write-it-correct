const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const fixturePath = (name) => path.join(__dirname, "..", "fixtures", name);
const readFixture = (name) => JSON.parse(fs.readFileSync(fixturePath(name), "utf8"));

const ALLOWED_TYPES = new Set(["spelling", "grammar", "punctuation", "style", "clarity"]);

function validateIssue(issue, sourceText = null) {
  const errors = [];
  if (!issue || typeof issue !== "object" || Array.isArray(issue)) {
    return ["issue must be an object"];
  }
  if (typeof issue.original !== "string" || issue.original.length === 0) {
    errors.push("original must be a non-empty string");
  }
  if (typeof issue.suggestion !== "string") {
    errors.push("suggestion must be a string");
  }
  if (!ALLOWED_TYPES.has(issue.type)) {
    errors.push("type is unsupported");
  }
  if (typeof issue.message !== "string") {
    errors.push("message must be a string");
  }
  if (!Number.isInteger(issue.start) || issue.start < 0 || !Number.isInteger(issue.end) || issue.end <= issue.start) {
    errors.push("start and end offsets must be valid integers");
  }
  if (typeof issue.suggestion === "string" && issue.suggestion === issue.original) {
    errors.push("suggestion must change the original text");
  }
  if (sourceText !== null && typeof issue.original === "string" && !sourceText.includes(issue.original)) {
    errors.push("original must occur in source text");
  }
  if (sourceText !== null && Number.isInteger(issue.start) && Number.isInteger(issue.end) &&
      sourceText.slice(issue.start, issue.end) !== issue.original) {
    errors.push("offsets must point to the original text");
  }
  return errors;
}

function locateNonOverlapping(text, issues) {
  const accepted = [];
  for (const issue of issues) {
    const start = text.indexOf(issue.original);
    if (start < 0) continue;
    const end = start + issue.original.length;
    if (accepted.some((item) => start < item.end && end > item.start)) continue;
    accepted.push({ issue, start, end });
  }
  return accepted;
}

function normalizeIssues(raw, sourceText) {
  if (!Array.isArray(raw)) throw new Error("MALFORMED_RESPONSE");
  if (raw.some((issue) => validateIssue(issue, sourceText).length > 0)) {
    throw new Error("MALFORMED_RESPONSE");
  }
  return raw.slice(0, 40);
}

test("valid issue fixture follows the contract", () => {
  const issues = readFixture("issue-valid.json");
  assert.equal(issues.every((issue) => validateIssue(issue).length === 0), true);
});

test("invalid issue fixture is rejected", () => {
  const issues = readFixture("issue-invalid.json");
  assert.equal(issues.every((issue) => validateIssue(issue).length > 0), true);
  assert.throws(() => normalizeIssues(issues, "teh is bad"), /MALFORMED_RESPONSE/);
});

test("valid issue response is normalized", () => {
  const issues = readFixture("issue-valid.json");
  assert.deepEqual(normalizeIssues(issues, "teh is here,,"), issues);
});

test("original values must occur verbatim in source text", () => {
  const issue = readFixture("issue-valid.json")[0];
  const positioned = { ...issue, start: 9, end: 12 };
  assert.deepEqual(validateIssue(positioned, "The word teh is here."), []);
  assert.equal(validateIssue(issue, "The word teh is here.").includes("offsets must point to the original text"), true);
  assert.equal(validateIssue(issue, "The sentence is correct.").length > 0, true);
});

test("overlapping issue ranges are not accepted together", () => {
  const fixture = readFixture("issue-repeated.json");
  const located = locateNonOverlapping(fixture.text, fixture.issues);
  assert.equal(located.length, 1);
  assert.equal(located[0].issue.original, "teh");
});

test("settings fixture has the expected baseline shape", () => {
  const settings = readFixture("settings.json");
  assert.equal(typeof settings.groqApiKey, "string");
  assert.equal(typeof settings.model, "string");
  assert.equal(typeof settings.language, "string");
});
