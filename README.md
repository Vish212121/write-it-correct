# write it correct

**write it correct** is a browser extension for proofreading and rewriting
text directly in supported web editors. It checks text while you type, shows
correction suggestions near the editor, and provides selection-based writing
actions. The extension sends requests directly to Groq from its background
worker; this project does not include a server that handles your text.

## Features

- **Check while typing:** proofreads after a short pause and marks validated
  spelling, grammar, punctuation, clarity, and style suggestions.
- **Apply suggestions:** apply a single correction or **Apply all** validated,
  non-overlapping corrections for the current text.
- **Fix:** correct clear spelling, grammar, and punctuation errors while
  preserving unaffected words, tone, spacing, and paragraph breaks. Broad
  rewrites are rejected rather than applied as a correction.
- **Improve, Shorten, Formal, and Casual:** rewrite selected text for the
  chosen goal while preserving its meaning.
- **Selection toolbar:** select text with the mouse or keyboard to open the
  action toolbar and check the selection.
- **Context menu:** run writing actions from the browser's right-click menu.
- **Site controls:** pause the extension on the current site or maintain a
  disabled-site list in Settings.
- **Language and model settings:** choose a writing language or automatic
  detection, and set a Groq model ID.

## Browser and editor support

The project provides Manifest V3 builds for Chromium browsers and Firefox.
The content script supports standard text inputs and textareas, regular
`contenteditable` editors, open shadow roots, and supported frames.

Some editors cannot be accessed by ordinary content scripts. This includes
canvas-based editors, closed shadow roots, and browser-protected pages such as
extension stores. Complex editors may rerender text in ways that limit live
underlines or suggestion placement. The manual fixtures cover common editor
shapes, but they do not replace testing on each target website.

## Install in Chrome, Edge, or Brave

1. Create an API key in the [Groq Console](https://console.groq.com/keys).
2. Open `chrome://extensions` (or `edge://extensions`) and enable **Developer
   mode**.
3. Select **Load unpacked** and choose this repository's `extension/` folder.
4. Open **write it correct Settings**, enter your Groq API key, and save.
5. Open a supported page and type to check text, or select text to open the
   writing toolbar.

Brave uses Chromium extension management and loads the same `extension/`
folder. Labels may vary slightly between browser versions.

## Install temporarily in Firefox

Firefox uses a different Manifest V3 background configuration. Make a copy of
`extension/`, replace the copied `manifest.json` with `manifest_firefox.json`
(rename the Firefox manifest to `manifest.json`), then open
`about:debugging#/runtime/this-firefox`. Choose **Load Temporary Add-on** and
select the copied `manifest.json`. Temporary add-ons are removed when Firefox
closes; permanent distribution requires Mozilla signing.

## Configure the extension

Open **Settings** from the extension popup to configure:

- **Groq API key:** stored in local browser extension storage. A key is needed
  to check or rewrite text.
- **Groq model ID:** defaults to `qwen/qwen3.8-27b`. Model availability and
  account access can change; use a model ID enabled for your Groq account.
- **Writing language:** choose a language or use **Auto-detect**.
- **Check while typing:** disable this to stop automatic checks. Selection
  actions remain available.
- **Disabled sites:** add hostnames where the extension should not read or
  check text. The popup also toggles the current site.

The extension rejects oversized input instead of silently truncating it. The
current limits are 6,000 characters for live checks and Fix, 40 issues per
check, and 8,000 characters for other rewrite actions. Provider rate limits
and model availability are controlled by Groq and can change. The background
worker paces requests and respects a provider-supplied retry cooldown.

## How it works

1. The content script discovers supported editors and observes typing and
   selection changes.
2. It sends a message to the extension background worker when a live check or
   writing action is requested.
3. The worker reads settings, validates the request, and calls Groq's Chat
   Completions API.
4. Check responses are validated against the source text and character
   offsets. Ambiguous, malformed, stale, overlapping, or overly broad edits
   are rejected.
5. Before applying a correction, the extension checks that the source text is
   still current. Applying all revalidates the complete checked text first.

The API key is not exposed to page scripts. Changes are applied only after the
source has been verified, which helps prevent a delayed response from
overwriting newer text.

## Data and privacy

- The Groq API key is stored in local browser extension storage.
- Text is sent to Groq when a live check or user-requested writing action runs.
- Requests go directly from the extension background worker to Groq. There is
  no project application server or account system in the request path.
- No text is sent merely by installing the extension. Live checks can be
  disabled in Settings.
- Review the provider's current terms and data controls before sending
  sensitive material: [Groq data controls](https://console.groq.com/docs/your-data).

Groq controls model availability, account quotas, and data handling. These
policies can change independently of the extension.

## Repository layout

```text
extension/                 Browser extension source and browser manifests
tests/js/                  Node.js logic and regression tests
tests/python/              Python contract tests
tests/fixtures/             Sample settings and issue-response data
tests/manual/              Local browser fixtures for editors and placement
BEHAVIOR_CONTRACT.md        Expected correction, rewrite, and safety behavior
DESIGN_NOTES.md             Visual identity and extension interface direction
```

### Source map

| File | Responsibility |
| --- | --- |
| `extension/background.js` | Settings migration, request validation, Groq calls, request pacing, context-menu actions |
| `extension/content.js` | Editor discovery, live checks, suggestions, selection toolbar, safe application |
| `extension/suggestion-logic.js` | Issue-range validation and minimal replacement construction |
| `extension/selection-geometry.js` | Selection measurement and viewport-aware control placement |
| `extension/request-errors.js` | Error classification and user-facing messages |
| `extension/popup.html` / `popup.js` | Current-site enable/disable control |
| `extension/options.html` / `options.js` | API key, model, language, live-check, and disabled-site settings |
| `extension/manifest.json` | Chromium extension manifest |
| `extension/manifest_firefox.json` | Firefox manifest variant |

## Development

### Requirements

- Node.js 18 or later for the JavaScript checks.
- Python 3 for the optional Python contract tests.
- No build step is required for the extension.

### Run automated checks

Run these commands from the repository root:

```bash
npm ci
npm run check
python -m unittest discover -s tests/python -v
```

`npm run check` runs the JavaScript regression tests and syntax checks. The
Python command runs the contract tests using Python's standard library.

### Manual browser fixtures

Load the unpacked extension, then open these local pages in a browser:

- `tests/manual/typing-fixture.html` exercises an input, a textarea, and local
  contenteditable examples shaped like messaging and mail composers.
- `tests/manual/selection-placement-browser.html` exercises selection
  placement for tall, wrapped, scrolled, and single-line editors.

These are local fixtures, not live copies of third-party websites. A useful
manual pass is to type a sentence with a clear typo, wait for live suggestions,
select text with mouse and keyboard, use Fix and Improve separately, apply one
suggestion and **Apply all**, and verify that unrelated text remains unchanged.

### Reload after editing

After changing extension files, reload the extension from `chrome://extensions`
or `edge://extensions`, then refresh pages where it was already running. In
Firefox, reload the temporary add-on from `about:debugging` and refresh the
test page. Existing content scripts can become stale when the extension is
reloaded.

## Troubleshooting

- **No suggestions:** confirm a Groq API key is saved, the extension is enabled
  for the site, live checks are enabled, and the selected model is available
  to your account.
- **Rate-limit message:** wait for the provider cooldown and check the account
  and model limits. Repeated retries may not help until the cooldown expires.
- **Stale extension connection:** reload the extension and fully refresh the
  affected page so it receives the updated content script.
- **No toolbar in an editor:** check whether the editor is canvas-based,
  inside a closed shadow root, or on a browser-protected page.
- **Controls cover page content:** the panel chooses a clear position when
  possible and can collapse to a compact chip when the page is crowded. The
  manual placement fixture helps reproduce viewport and scrolling cases.

## Project guidance

- [Behavior contract](BEHAVIOR_CONTRACT.md) describes rewrite modes, issue
  validation, replacement safety, limits, and error handling.
- [Design notes](DESIGN_NOTES.md) records the color, typography, and interface
  direction.
