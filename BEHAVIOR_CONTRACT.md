# Gembar browser extension behavior contract

This document describes the behavior expected from the extension. It does not
change runtime behavior by itself.

## Rewrite modes

The extension supports these modes:

- `fix`: correct only clear spelling, grammar, and punctuation errors by
  changing the shortest possible source spans. Preserve all unaffected text,
  wording, tone, capitalization, spacing, and paragraph breaks exactly. Apply
  only suggestions whose source ranges can be verified; leave the selection
  unchanged when no corrections are returned.
- `improve`: improve clarity, flow, and word choice while preserving meaning
  and tone.
- `shorten`: make the text more concise while preserving key meaning.
- `formal`: rewrite in a formal, professional tone.
- `casual`: rewrite in a relaxed, conversational tone.

Unknown modes use `improve` as the safe fallback.

## Issue response

An issue response is a JSON array. Each item must contain:

```json
{
  "original": "exact non-empty substring from the submitted text",
  "suggestion": "replacement text, which may be empty when deleting text",
  "type": "spelling | grammar | punctuation | style | clarity",
  "message": "short explanation",
  "start": 0,
  "end": 3
}
```

The `original`, `suggestion`, and `message` values must be strings. `original`
must be non-empty and occur verbatim in the submitted text. `type` must be one
of the five allowed values. `start` and `end` are zero-based JavaScript string
offsets with an exclusive end; the source slice at that range must match
`original`. If the offsets are inaccurate, the extension may recover only when
`original` occurs at one unambiguous location; repeated matches are reported as
unverified. Unknown fields may be ignored.

The extension must treat malformed items as invalid rather than applying them.
A malformed response must not be presented as a successful correction. An
empty valid array means no suggestions were returned. The UI must not tell the
user that text is error-free based only on an empty model response.

## Matching and replacement

- Matching is case-sensitive unless documented otherwise.
- A replacement must target the intended occurrence, not an arbitrary
  occurrence of the same substring.
- Overlapping issues must not be applied simultaneously.
- The `fix` action must reject overly broad proposed ranges instead of applying
  a sentence- or paragraph-level rewrite as a correction.
- If the source text changed after checking, discard or revalidate the result
  before applying it.
- Applying an issue must preserve the rest of the source text.
- Applying all issues must first confirm the complete checked text is still
  current, then apply only the validated, non-overlapping ranges. If the text
  changed, discard the batch and recheck it.

## Suggestion panel

- The panel offers **Apply** for an individual issue and **Apply all** for the
  current set of validated issues.
- Keep the panel translucent and place it where it does not cover the active
  editor or visible page text. When no clear position is available, show a
  compact translucent chip in the least occupied available spot; let the user
  expand it when they want the full list.
- Selecting text in an editable field opens the selection toolbar and checks
  that selected text for issues. Keyboard selection must work as well as mouse
  selection.
- Fields in regular page DOM, open shadow roots, and supported frames should be
  discovered and checked. Closed shadow roots and canvas editors remain
  inaccessible to page content scripts.

## Limits

The current extension limits are:

- Live checks and **Fix**: at most 6,000 input characters and 40 issues.
- Other rewrites: at most 8,000 input characters and 1,536 output tokens.
- Oversized input must be rejected instead of silently truncating the selection.

These limits are interim and may change as the extension evolves.

## Settings

The conceptual settings are:

```json
{
  "groqApiKey": "",
  "model": "qwen/qwen3.8-27b",
  "language": "auto"
}
```

The extension additionally supports disabled sites and live-check state. A
missing API key must produce a clear configuration error and must not trigger
a network request.

## Error behavior

The extension should distinguish at least these conditions:

- missing API key;
- request timeout or network failure;
- Groq HTTP/API failure, including account rate limits and `Retry-After` timing;
- refused or empty Groq response;
- malformed issue response;
- stale source text during application.

Errors must not silently become a successful "no issues found" result.
The service worker paces requests across tabs and holds new requests during a
provider-supplied rate-limit cooldown. Short retry windows may be retried once;
longer account limits are reported without sending repeated requests.
