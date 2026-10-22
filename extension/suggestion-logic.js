// Shared, deterministic helpers for validating suggestion locations and
// choosing a visible panel placement. Kept separate so edge cases are tested
// without needing a live website or provider request.
(function (root) {
  "use strict";

  const ISSUE_TYPES = new Set(["spelling", "grammar", "punctuation", "style", "clarity"]);

  function isValidIssue(issue, sourceText) {
    return !!issue &&
      typeof issue === "object" && !Array.isArray(issue) &&
      typeof issue.original === "string" && issue.original.length > 0 &&
      typeof issue.suggestion === "string" && issue.suggestion !== issue.original &&
      ISSUE_TYPES.has(issue.type) &&
      typeof issue.message === "string" && issue.message.trim().length > 0 &&
      issue.message.length <= 180 &&
      typeof sourceText === "string" && sourceText.includes(issue.original);
  }

  function findOccurrences(sourceText, needle) {
    const occurrences = [];
    let from = 0;
    while (from <= sourceText.length - needle.length) {
      const start = sourceText.indexOf(needle, from);
      if (start < 0) break;
      occurrences.push({ start, end: start + needle.length });
      from = start + Math.max(1, needle.length);
    }
    return occurrences;
  }

  function locateIssues(sourceText, issues) {
    if (!Array.isArray(issues)) return { located: [], unmatched: 1 };

    const located = [];
    let unmatched = 0;
    const seen = new Set();
    for (const issue of issues) {
      if (!isValidIssue(issue, sourceText)) {
        unmatched += 1;
        continue;
      }

      const duplicateKey = JSON.stringify([
        issue.original, issue.suggestion, issue.type, issue.message, issue.start, issue.end,
      ]);
      if (seen.has(duplicateKey)) continue;
      seen.add(duplicateKey);

      const hasOffsets = Number.isInteger(issue.start) && Number.isInteger(issue.end) &&
        issue.start >= 0 && issue.end > issue.start;
      const offsetsMatch = hasOffsets && sourceText.slice(issue.start, issue.end) === issue.original;
      let range = offsetsMatch ? { start: issue.start, end: issue.end } : null;

      if (!hasOffsets || !offsetsMatch) {
        const available = findOccurrences(sourceText, issue.original).filter((candidate) =>
          !located.some((current) => candidate.start < current.end && candidate.end > current.start)
        );
        // Fall back only when the original identifies one safe location. With
        // repeated text, never guess which occurrence the model intended.
        if (available.length === 1) range = available[0];
      }

      if (!range || located.some((current) => range.start < current.end && range.end > current.start)) {
        unmatched += 1;
        continue;
      }
      located.push({ ...issue, start: range.start, end: range.end });
    }

    located.sort((a, b) => a.start - b.start || a.end - b.end);
    return { located, unmatched };
  }

  function buildReplacement(sourceText, issues) {
    if (typeof sourceText !== "string" || !Array.isArray(issues)) {
      return { ok: false, reason: "invalid-input" };
    }
    const ordered = [...issues].sort((a, b) =>
      (Number.isInteger(a?.start) ? a.start : Number.POSITIVE_INFINITY) -
        (Number.isInteger(b?.start) ? b.start : Number.POSITIVE_INFINITY) ||
      (Number.isInteger(a?.end) ? a.end : Number.POSITIVE_INFINITY) -
        (Number.isInteger(b?.end) ? b.end : Number.POSITIVE_INFINITY)
    );
    let cursor = 0;
    let text = "";
    for (const issue of ordered) {
      if (!isValidIssue(issue, sourceText) ||
          !Number.isInteger(issue.start) || !Number.isInteger(issue.end) ||
          issue.start < cursor || issue.end <= issue.start ||
          sourceText.slice(issue.start, issue.end) !== issue.original) {
        return { ok: false, reason: "stale-or-overlapping" };
      }
      text += sourceText.slice(cursor, issue.start) + issue.suggestion;
      cursor = issue.end;
    }
    text += sourceText.slice(cursor);
    return { ok: true, text, issues: ordered };
  }

  function buildMinimalFixReplacement(sourceText, issues) {
    if (typeof sourceText !== "string" || !Array.isArray(issues)) {
      return { ok: false, reason: "UNVERIFIED_SUGGESTION" };
    }
    const fixable = issues.filter((issue) =>
      issue?.type === "spelling" || issue?.type === "grammar" || issue?.type === "punctuation"
    );
    const { located, unmatched } = locateIssues(sourceText, fixable);
    if (unmatched) return { ok: false, reason: "UNVERIFIED_SUGGESTION" };
    const minimal = located.map(minimizeIssue);
    if (minimal.some((issue) => !issue)) {
      return { ok: false, reason: "UNVERIFIED_SUGGESTION" };
    }
    const changedSpanLength = minimal.reduce((total, issue) => total + issue.end - issue.start, 0);
    const maxIssueSpan = Math.min(120, Math.max(40, Math.ceil(sourceText.length * 0.08)));
    const maxTotalSpan = Math.max(24, Math.floor(sourceText.length * 0.25));
    if (minimal.some((issue) =>
      issue.end - issue.start > maxIssueSpan ||
      issue.suggestion.length > (issue.end - issue.start) * 2 + 8
    ) || changedSpanLength > maxTotalSpan) {
      return { ok: false, reason: "SUGGESTION_TOO_BROAD" };
    }
    const replacement = buildReplacement(sourceText, minimal);
    return replacement.ok ? replacement : { ok: false, reason: "UNVERIFIED_SUGGESTION" };
  }

  function buildCachedSelectionFixReplacement(sourceText, selectedText, start, issues) {
    if (typeof sourceText !== "string" || typeof selectedText !== "string" ||
        !Number.isInteger(start) || start < 0 ||
        sourceText.slice(start, start + selectedText.length) !== selectedText ||
        !Array.isArray(issues)) return null;
    const end = start + selectedText.length;
    const selectedIssues = issues.filter((issue) =>
      issue?.start >= start && issue?.end <= end &&
      (issue.type === "spelling" || issue.type === "grammar" || issue.type === "punctuation")
    ).map((issue) => ({ ...issue, start: issue.start - start, end: issue.end - start }));
    if (!selectedIssues.length) return null;
    const replacement = buildMinimalFixReplacement(selectedText, selectedIssues);
    return replacement.ok && replacement.text !== selectedText ? replacement.text : null;
  }

  function tokenizeForMinimalDiff(text) {
    const tokens = [];
    const pattern = /\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]+/gu;
    let match;
    while ((match = pattern.exec(text))) {
      tokens.push({ value: match[0], start: match.index, end: match.index + match[0].length });
    }
    return tokens;
  }

  function buildMinimalFixFromText(sourceText, correctedText) {
    if (typeof sourceText !== "string" || typeof correctedText !== "string") {
      return { ok: false, reason: "UNVERIFIED_SUGGESTION" };
    }
    if (sourceText === correctedText) return { ok: true, text: sourceText, issues: [] };

    const sourceTokens = tokenizeForMinimalDiff(sourceText);
    const correctedTokens = tokenizeForMinimalDiff(correctedText);
    const rows = sourceTokens.length + 1;
    const columns = correctedTokens.length + 1;
    // Bound memory on unusual punctuation-heavy text; regular long paragraphs
    // stay well below this limit, while accidental full rewrites fail safely.
    if (sourceTokens.length > 1600 || correctedTokens.length > 1600) {
      return { ok: false, reason: "SUGGESTION_TOO_BROAD" };
    }

    const lcs = new Uint32Array(rows * columns);
    for (let i = sourceTokens.length - 1; i >= 0; i -= 1) {
      const row = i * columns;
      const nextRow = (i + 1) * columns;
      for (let j = correctedTokens.length - 1; j >= 0; j -= 1) {
        lcs[row + j] = sourceTokens[i].value === correctedTokens[j].value
          ? lcs[nextRow + j + 1] + 1
          : Math.max(lcs[nextRow + j], lcs[row + j + 1]);
      }
    }

    const issues = [];
    let i = 0;
    let j = 0;
    let hunk = null;
    const closeHunk = () => {
      if (!hunk) return;
      let sourceStart = hunk.sourceStart;
      let sourceEnd = hunk.sourceEnd;
      let correctedStart = hunk.correctedStart;
      let correctedEnd = hunk.correctedEnd;
      // Exact insertions need a non-empty source range for safe replacement.
      if (sourceStart === sourceEnd) {
        if (sourceEnd < sourceTokens.length) {
          sourceEnd += 1;
          correctedEnd += 1;
        } else if (sourceStart > 0) {
          sourceStart -= 1;
          correctedStart -= 1;
        } else {
          hunk = null;
          return;
        }
      }
      const start = sourceTokens[sourceStart].start;
      const end = sourceTokens[sourceEnd - 1].end;
      const targetStart = correctedTokens[correctedStart]?.start ?? correctedText.length;
      const targetEnd = correctedEnd > correctedStart
        ? correctedTokens[correctedEnd - 1].end
        : targetStart;
      const original = sourceText.slice(start, end);
      const suggestion = correctedText.slice(targetStart, targetEnd);
      if (/^\s*$/u.test(original) && /^\s*$/u.test(suggestion)) {
        issues.push({ invalidWhitespaceOnlyChange: true });
      } else if (original !== suggestion) {
        issues.push({
          original, suggestion, type: "grammar", message: "Minimal proofreading correction.", start, end,
        });
      }
      hunk = null;
    };

    while (i < sourceTokens.length || j < correctedTokens.length) {
      if (i < sourceTokens.length && j < correctedTokens.length &&
          sourceTokens[i].value === correctedTokens[j].value) {
        closeHunk();
        i += 1;
        j += 1;
        continue;
      }
      if (!hunk) hunk = { sourceStart: i, sourceEnd: i, correctedStart: j, correctedEnd: j };
      const deleteSource = i < sourceTokens.length &&
        (j >= correctedTokens.length || lcs[(i + 1) * columns + j] >= lcs[i * columns + j + 1]);
      if (deleteSource) {
        i += 1;
        hunk.sourceEnd = i;
      } else {
        j += 1;
        hunk.correctedEnd = j;
      }
    }
    closeHunk();
    if (issues.some((issue) => issue.invalidWhitespaceOnlyChange)) {
      return { ok: false, reason: "UNVERIFIED_SUGGESTION" };
    }
    const replacement = buildMinimalFixReplacement(sourceText, issues);
    if (!replacement.ok) return replacement;
    const whitespaceEquivalent = replacement.text.replace(/\s+/gu, " ") === correctedText.replace(/\s+/gu, " ");
    if (replacement.text !== correctedText && !whitespaceEquivalent) {
      return { ok: false, reason: "UNVERIFIED_SUGGESTION" };
    }
    return replacement;
  }

  function previousCodePointBoundary(text, index) {
    if (index >= 2) {
      const before = text.charCodeAt(index - 1);
      const first = text.charCodeAt(index - 2);
      if (before >= 0xdc00 && before <= 0xdfff && first >= 0xd800 && first <= 0xdbff) return index - 2;
    }
    return Math.max(0, index - 1);
  }

  function minimizeIssue(issue) {
    if (!issue || typeof issue.original !== "string" || typeof issue.suggestion !== "string" ||
        !Number.isInteger(issue.start) || !Number.isInteger(issue.end) ||
        issue.end - issue.start !== issue.original.length) return null;

    const original = issue.original;
    const suggestion = issue.suggestion;
    let prefix = 0;
    while (prefix < original.length && prefix < suggestion.length &&
           original.charCodeAt(prefix) === suggestion.charCodeAt(prefix)) prefix += 1;
    // Keep UTF-16 ranges from splitting a surrogate pair at either edge.
    if (prefix > 0 && prefix < original.length &&
        original.charCodeAt(prefix - 1) >= 0xd800 && original.charCodeAt(prefix - 1) <= 0xdbff &&
        original.charCodeAt(prefix) >= 0xdc00 && original.charCodeAt(prefix) <= 0xdfff) {
      prefix = previousCodePointBoundary(original, prefix);
    }
    if (prefix > 0 && prefix < suggestion.length &&
        suggestion.charCodeAt(prefix - 1) >= 0xd800 && suggestion.charCodeAt(prefix - 1) <= 0xdbff &&
        suggestion.charCodeAt(prefix) >= 0xdc00 && suggestion.charCodeAt(prefix) <= 0xdfff) {
      prefix = previousCodePointBoundary(suggestion, prefix);
    }

    let suffix = 0;
    while (suffix < original.length - prefix && suffix < suggestion.length - prefix &&
           original.charCodeAt(original.length - suffix - 1) ===
             suggestion.charCodeAt(suggestion.length - suffix - 1)) suffix += 1;
    const originalSuffixStart = original.length - suffix;
    const suggestionSuffixStart = suggestion.length - suffix;
    if (suffix > 0 && originalSuffixStart > 0 && originalSuffixStart < original.length &&
        original.charCodeAt(originalSuffixStart - 1) >= 0xd800 && original.charCodeAt(originalSuffixStart - 1) <= 0xdbff &&
        original.charCodeAt(originalSuffixStart) >= 0xdc00 && original.charCodeAt(originalSuffixStart) <= 0xdfff) {
      suffix = Math.max(0, suffix - 1);
    }
    if (suffix > 0 && suggestionSuffixStart > 0 && suggestionSuffixStart < suggestion.length &&
        suggestion.charCodeAt(suggestionSuffixStart - 1) >= 0xd800 && suggestion.charCodeAt(suggestionSuffixStart - 1) <= 0xdbff &&
        suggestion.charCodeAt(suggestionSuffixStart) >= 0xdc00 && suggestion.charCodeAt(suggestionSuffixStart) <= 0xdfff) {
      suffix = Math.max(0, suffix - 1);
    }

    // Insertions need a non-empty source span for safe exact-range replacement.
    if (prefix + suffix >= original.length) {
      if (prefix > 0) prefix = previousCodePointBoundary(original, prefix);
      else if (suffix > 0) suffix = Math.max(0, suffix - 1);
    }

    const minimized = {
      ...issue,
      start: issue.start + prefix,
      end: issue.end - suffix,
      original: original.slice(prefix, original.length - suffix),
      suggestion: suggestion.slice(prefix, suggestion.length - suffix),
    };
    if (!minimized.original || minimized.original === minimized.suggestion) return null;
    return minimized;
  }

  function isReplacementCurrent(currentSource, expectedSource, currentSelection, expectedSelection) {
    return typeof currentSource === "string" &&
      typeof expectedSource === "string" &&
      currentSource === expectedSource &&
      currentSelection === expectedSelection;
  }

  // Candidates are already clamped to the viewport by the caller. Normal
  // placement requires a clear page area; a user-expanded panel may overlap
  // content when necessary, choosing the least disruptive available spot.
  function chooseSuggestionPlacement(candidates, { allowOverlap = false } = {}) {
    if (!Array.isArray(candidates)) return null;
    const bounded = candidates.filter((candidate) => candidate?.bounded !== false);
    const clear = bounded.filter((candidate) => candidate.editorOverlapArea === 0);
    const noTextCovered = clear.filter((candidate) => candidate.textScore === 0);
    if (noTextCovered.length) return noTextCovered[0];
    if (!allowOverlap) return null;
    return [...bounded].sort((a, b) =>
      (a.textScore || 0) - (b.textScore || 0) ||
      (a.editorOverlapArea || 0) - (b.editorOverlapArea || 0)
    )[0] || null;
  }

  const api = Object.freeze({
    isValidIssue,
    locateIssues,
    buildReplacement,
    buildMinimalFixReplacement,
    buildCachedSelectionFixReplacement,
    buildMinimalFixFromText,
    minimizeIssue,
    isReplacementCurrent,
    chooseSuggestionPlacement,
  });
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.GembarSuggestionLogic = api;
})(globalThis);
