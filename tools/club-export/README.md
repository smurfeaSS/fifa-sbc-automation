# Club export

Reads your club out of the FC Web App and saves it as a JSON file for the
assistant to import. Nothing is uploaded; the file lands in your Downloads
folder and stays on your machine.

## Usage

**Use a devtools Snippet, not the console.** Pasting 300 lines into a console
is unreliable — some browsers flatten it to a single line, and then a
`SyntaxError` about a regular expression flag is the result. Snippets keep the
file intact and let you re-run it with one click next time.

### Chrome / Edge

1. Log in to the FC Web App as normal, let it finish loading.
2. **F12 → Sources → Snippets → New snippet**.
3. Paste the whole of `export-club.js`, then **Ctrl+Enter** to run.

### Firefox

1. **F12 → Console**.
2. Press **Ctrl+B** to open the multi-line editor (paste into the console's
   single-line prompt is what mangles it).
3. Paste, then **Ctrl+Enter**.

Firefox may also require you to type `allow pasting` once before it accepts a
paste into devtools at all — a protection against people being talked into
pasting things they do not understand, which is worth taking seriously in
general.

### Either way

4. Wait — it deliberately paces itself, so a large club takes a few minutes.
5. Import the downloaded file:

```
npm run cli -- import ~/Downloads/club-export-2026-09-22.json
```

## What it does and does not do

**Does:** issues GET requests to the same club and squad endpoints the Web App
itself reads while you browse, pages through the results, and downloads the
JSON.

**Does not:** write anything to your account. There is no code path in this file
that buys, sells, lists, discards, submits an SBC or edits a squad. A URL
allowlist (`ALLOWED_PATH_PATTERNS`) rejects any request outside a small set of
read endpoints, and a method check rejects anything that is not a GET.

It never reads your password. It reads the session token the page already holds,
uses it to talk to EA exactly as the app does, and neither logs nor stores nor
transmits it.

## About the throttle

There is a randomised 800–1500 ms pause between page reads. This is the point of
the design, not an oversight: it turns a burst of ~20 rapid requests into a few
minutes of traffic that looks like someone scrolling their club. **Do not lower
these values.** Run the export when your club has changed meaningfully — weekly
is plenty — rather than every session.

## Honest note on risk

Using any third-party tool with the Web App is against EA's terms, regardless of
how careful the tool is. This snippet is built to sit at the mildest end of that
category: read-only, throttled, one-shot, no market activity, no background
process. Enforcement in practice has centred on transfer-market automation —
autobuyers and snipers — which is a different thing entirely from reading your
own club once a week.

That is an informed judgement about risk, not a guarantee. EA does not publish
detection criteria. Decide with that in mind.

## If it fails

Run it with `CONFIG.probeOnly = true` (top of the file). It reports what it
could and could not find in the page without reading anything, which is what to
share when asking for a fix.

Common cases:

| Symptom | Cause | Fix |
|---|---|---|
| "game version could not be detected" | Page layout changed | Set `CONFIG.gameVersion = 'fc27'` manually |
| HTTP 401 / 403 | Session expired | Reload the Web App, rerun |
| HTTP 429 | Rate limited | Wait several minutes. Do not immediately retry |
| "service layer NOT found" | App internals changed | Harmless — it falls back to direct GETs |
| `SyntaxError: invalid regular expression flag` | The paste was flattened to one line | Use a Snippet, or Firefox's Ctrl+B editor |

The script is written to survive being flattened — every comment is a `/* */`
block rather than a `//` line comment, precisely so a mangled paste still
parses. But a Snippet avoids the question entirely.

The snippet aborts on the first failed request rather than retrying, so a
failure leaves nothing half-done.
