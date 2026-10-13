# Call Copilot

A real-time answer assistant for calls and interviews. It listens, transcribes live, and streams an answer to whatever you were just asked — on one screen, with no navigation and no accounts.

Ships as a **macOS desktop app** (Electron) and runs in a browser as a fallback.

---

## Quick start

```bash
npm install
npm start
```

The app opens, then press **Keys** in the top bar. You need **one transcription key and one answers key** — and an OpenAI key counts as both, so a single key is enough to get running.

| Key | Transcription | Answers | Notes |
| --- | --- | --- | --- |
| [Deepgram](https://console.deepgram.com) | yes | — | $200 free credit, no card — roughly 400+ hours of streaming |
| [Anthropic](https://console.anthropic.com/settings/keys) | — | yes | Claude Opus 5 / Sonnet 5 / Haiku 4.5 |
| [OpenAI](https://platform.openai.com/api-keys) | yes | yes | Covers both halves with one key |
| [Amazon Nova](https://console.aws.amazon.com/bedrock) | — | yes | Access key ID + secret + region |
| **Local (Ollama)** | — | yes | **No key, no cost.** See below |

Hit **Save & test** — every key you submit is verified against the live provider before the dialog closes. Keys are written to `~/Library/Application Support/call-copilot/keys.json` with `0600` permissions and are **never sent to the page**; the UI only ever sees a masked `••••1234` preview. If you would rather not use the dialog, copy `.env.example` to `.env` instead.

Providers you have no key for are greyed out in the controls, and the app picks a working one for you.

Then press **Start** and talk.

### Browser mode

```bash
npm run web      # http://localhost:5178
```

Same app, minus system-audio loopback, the always-on-top pin, and hide-from-screen-share.

### Packaging a .app

```bash
npm run dist     # -> dist/Call Copilot-1.0.0.dmg
```

Unsigned. Gatekeeper will need a right-click → Open the first time.

---

## Using it

**Top bar** — Start/Stop, status, mode, and the answer controls.
**Left** — the live transcript. **Right** — the current answer plus every previous one.

### When an answer gets generated

- **Auto** (default) — it waits until the other party has actually stopped talking for the configured pause (default 2.0s), then answers **everything** they said since the last answer. Any further speech, even a single word, pushes the timer out, so a long multi-sentence question is never cut off mid-thought. Detecting a question does not shorten the wait — the pause setting is the whole contract. Question detection takes a trailing `?`, interrogative openers (`how would you…`, `can you walk me through…`), and common interview phrasings, because speech recognition drops question marks constantly.
- **Manual** — nothing happens until you press **Answer**, or select part of the transcript and press **Answer this**.

Every request carries two tiers of context, not the whole session:

1. **Verbatim recent speech** — the last 4 minutes or 20 speaker turns, whichever is smaller.
2. **A compact record of the call so far** — every earlier question with a shortened version of the answer you were given (last 6 exchanges, questions clipped to 180 chars and answers to 420).

The second tier is what makes back-references work. "How would you scale *that approach*?", "you mentioned Redis earlier — why not Memcached?", "give me a better version of that" all resolve, because the model can see what was asked *and what it already told you* — verbatim transcript alone contains neither once the original question scrolls out.

Both tiers are capped, so a long call does not keep getting slower or more expensive.

**Clear context** in that dialog makes the model forget this call so far without deleting anything: earlier questions and answers stay on screen, they just stop being sent. Useful when the interview moves to a new topic and you do not want every later answer dragging the previous one in. An attached previous round is a deliberate choice and is left alone — it has its own Detach control.

**Context** in the Answers pane header shows exactly what will be sent with the next answer — your About me, the trimmed record of earlier exchanges, and the verbatim transcript window — with the limits spelled out. The memory is bounded, and this makes it obvious what the model can and cannot resolve.

### Providers

Both halves are swappable from the controls panel, per answer, with no restart:

| | Options | Default |
| --- | --- | --- |
| **Transcription** | Deepgram (`nova-3`) or OpenAI (`gpt-live-transcribe`) | Deepgram |
| **Answers** | Anthropic (Opus 5 / Sonnet 5 / Haiku 4.5), OpenAI (GPT-5.6 Terra / Luna / Sol, GPT-6 Astra), **Nova** (Lite / Micro / Pro), or **Local** via Ollama | Claude Opus 5 |

#### Amazon Nova (AWS Bedrock)

Uses the Bedrock `ConverseStream` API, so answers stream like every other provider. Needs four values in the Keys dialog — access key ID, secret access key, region, and model ID. Only the two credentials are masked; region and model stay visible and editable.

Two things that commonly block a first call, both reported with the exact fix:

- **Model access** must be enabled for the model, per region, in the Bedrock console. Otherwise `AccessDeniedException`.
- **Inference profiles.** Some Nova models are only served through a cross-region profile — the same id with a geography prefix (`us.amazon.nova-lite-v1:0`). The app detects that error and retries once with the prefix for your region automatically, so plain `amazon.nova-lite-v1:0` works either way.

The IAM user needs `bedrock:InvokeModelWithResponseStream`.

#### Local models (free, and the fastest option here)

Pick **Local** under Answers. No key, no per-call cost, works offline — and because there is no network round trip and no reasoning tokens, it has the *lowest* time-to-first-token of the three.

```bash
brew install ollama
ollama pull llama3.2:3b
```

Measured on an M2 / 8 GB with `llama3.2:3b`, brief answers:

| | Time to first token | Throughput |
| --- | --- | --- |
| First answer after Start | ~630 ms | ~30 tok/s |
| Steady state | ~240 ms | ~34 tok/s |
| `llama3.2:1b` | ~65 ms | ~60 tok/s |

Three things make that work, and all of them matter:

1. **Server tuning.** Ollama must run with `OLLAMA_FLASH_ATTENTION=1` and `OLLAMA_KV_CACHE_TYPE=q8_0`. Without them, time to first token is ~2.6 s instead of ~240 ms — a 10× difference. The installer LaunchAgent at `~/Library/LaunchAgents/com.callcopilot.ollama.plist` sets these and starts Ollama at login. Remove it with `launchctl unload` to undo.
2. **Warm on Start.** Pressing Start runs one throwaway token through the real system prompt, so the model is resident *and* the prompt prefix is already in the KV cache. Cold model load is ~16 s; you pay it when you press Start, never mid-question.
3. **Identical options between warm-up and real requests.** If the `options` object differs at all, Ollama rebuilds the runner and discards the cached prefix — the first answer jumps from 634 ms back to 4.8 s. `RUNTIME_OPTIONS` in `server/providers/ollama.js` is shared by both paths for exactly this reason. Don't add a per-request option without adding it to the warm-up too.

Quality is well below Claude or GPT — expect competent, generic answers rather than sharp ones. If a cloud provider runs out of credit mid-call, the error banner offers a one-click switch to Local.

Switching the answer provider or model takes effect on the next answer. Switching transcription takes effect on the next **Start**, because the two services want different audio sample rates (Deepgram 16 kHz, OpenAI 24 kHz) and the capture graph is built around that.

### Audio source

**Controls → Audio source** picks what the app listens to:

| | Captures | Use when |
| --- | --- | --- |
| **Them only** (default) | System audio only — your mic is never opened | Interviews. Only their questions are transcribed, nothing you say |
| **Mic only** | Your microphone | Testing alone, or dictating |
| **Both** | Both, as separate speakers | You want your own answers logged for context |

"Them only" is the simplest and most reliable mode: there is no microphone stream at all, so speaker bleed is impossible and nothing you say can trigger an answer. macOS needs Screen Recording permission for the loopback tap.

### Who said what

In **Both** mode with Deepgram as the transcription provider, the two voices are kept apart end to end:

- Your mic goes to channel 0, the call audio to channel 1, interleaved into one stereo stream.
- Deepgram transcribes each channel independently (`multichannel=true`) and reports which one spoke.
- The transcript labels every line **You** or **Them**, with separate level meters in the top bar.

That separation drives the behaviour that matters in an interview:

| | Effect |
| --- | --- |
| **Them** speaks | Starts the auto-answer clock; their question is what gets answered |
| **You** speak | Recorded as context, **never** triggers an answer |

Without it, reading an answer aloud would be transcribed as new speech and trigger another answer off your own voice.

The model sees the labels too, so it knows what you have already said and won't hand you the same point twice. Own-voice lines are context only — it never answers them.

Two limits worth knowing. Speaker separation needs **Deepgram**; OpenAI transcription gets one mixed stream and a warning banner saying so. And use **headphones** — with speakers, the call audio bleeds into your mic and lands on both channels.

### Replying

Both the main window and the overlay have a reply box. Type a follow-up and it is asked like any spoken question — carrying your About me, the record of earlier exchanges and the transcript window — so "make that half as long", "go deeper on the Redis part" or "what about Memcached?" all resolve against what was already said.

The overlay has no provider access and holds no state: replies *and* control changes typed there are relayed to the main window, which owns the session and acts on them. Results stream back to both. That one-way ownership is why the two can never drift apart.

### Usage and cost

**Usage** in the Answers pane header shows what the session has consumed: calls, input and output tokens per model, transcription minutes, and an estimated cost.

Token counts are whatever each provider reports (`usage.input_tokens`, `metadata.usage`, Ollama's `prompt_eval_count`) — not guessed locally. Costs are computed from a published-list-price table in `server/config.js`, indicative only:

| | USD / 1M tokens (in → out) |
| --- | --- |
| Claude Opus 5 · Sonnet 5 · Haiku 4.5 | 5→25 · 2→10 · 1→5 |
| GPT-6 Astra · 5.6 Sol · Terra · Luna | 10→50 · 4→20 · 2→12 · 0.20→1.20 |
| Nova Pro · Lite · Micro | 0.80→3.20 · 0.06→0.24 · 0.035→0.14 |
| Deepgram nova-3 streaming | $0.0077 per minute |

Local models show **free** rather than a number. Rows with no published rate in the table are shown but excluded from the total, and calls that returned no token counts are flagged rather than silently counted as zero — a cost display that quietly under-reports is worse than none.

Prices move; edit `PRICING` in `server/config.js` when they do.

### Saved interviews

Name a call in the top bar and it is kept when you press Stop. Saved interviews are listed **in the transcript panel** whenever no call is running — visible without opening anything, with **Use as base** on each row — and the **Interviews** dialog holds the same list plus delete controls. **Use as base** attaches one to the current call, and from then on every request carries that round's questions and answers as a dated `<previous_round>` block.

That is what makes a second round work: the model is told what was covered last time, told to stay consistent with it, and told never to imply it was said today. Contradicting your own earlier answer is the fastest way to lose an interview.

- Records live in `~/Library/Application Support/call-copilot/sessions/` at `0600`, one JSON file each — not in the page's localStorage, which is capped and origin-scoped.
- A call with no transcript and no answers is not saved.
- **Save as…** writes the interview to a file you pick — Markdown by default, or JSON for the raw record. Markdown because it opens anywhere, pastes into a doc intact, and stays readable as plain text: a title block with the date and counts, the background used, numbered questions with the answer given, then the transcript with speaker labels. Sections with no content are omitted rather than left empty.
- Delete individually (two clicks, to avoid losing a record by accident) or **Delete all**.
- If the base record is deleted elsewhere, the next launch detaches it and says so rather than silently sending nothing.
- The **Context** viewer shows the attached round, so you can see exactly what is carried over.

### Languages

Two independent settings, in Controls and in the overlay:

- **Spoken language** — what the transcription service listens for: English, **Urdu**, Hindi, Arabic, Spanish, French, German, or Mixed.
- **Answer in** — *Match the question* (default), English, **Urdu (اردو script)**, **Roman Urdu (Latin script)**, or any of the others.

Roman Urdu exists because Nastaliq is slow to scan on screen mid-call, and Latin script is how Pakistani engineers actually write Urdu. The prompt carries a worked example so the model produces the real register rather than a literal translation — technical terms stay in English:

> Main rate limiter ke liye Redis use karunga, token bucket algorithm ke saath. Har request pe ek token consume hota hai.

Two limits worth knowing:

- **Deepgram's Mixed mode does not include Urdu** (it covers 10 languages; Urdu is a separate monolingual model). For Urdu you must pick Urdu explicitly, which means English inside that session transcribes poorly. There is no clean Urdu+English code-switching option today, and the app warns you when Mixed is selected.
- Changing the spoken language needs a **Start** cycle; the answer language applies immediately.

### Two rules that matter more than they look

The prompt carries two instructions that exist because of real failures seen in use:

- **Never invent experience.** Left to itself the model will happily answer "have you done this in Rails?" with fabricated Sidekiq work, because it was told to speak in the user's voice. It is now required to ground any claim of personal experience in About me, and otherwise to relate it to what the user *has* done or say plainly that they have not used it. A fabricated claim gets caught by the very next follow-up.
- **A short follow-up is about the topic just discussed.** "What about X?", "have you done this in Y?", "and at scale?" carry the previous subject over. Without this the model answers them as fresh general questions and the reply reads as a non sequitur.

Both are worth keeping if you edit `server/prompt.js`.

### Answer controls

All of these apply to the *next* answer with no reload, and persist in local storage:

Answers are written to be **spoken, not read**: continuous prose with no headings, bold, bullets or labels, because none of that can be said out loud. Lists are spoken ("First… Second… And third…"). The single exception is code, which goes in a fenced block with speakable words around it.

- **Detail** — brief / balanced / detailed
- **Style** — precise and direct / conversational / technical
- **Technical depth** — high-level / intermediate / deep (deep gets code, real API names, numbers)
- **About me** — your role, background, and product context. It goes into the system prompt of **every** request: spoken answers, screen reads and regenerates alike. This is the single highest-leverage field; fill it in.
- **Regenerate** — re-answers the last question with whatever the settings say now.

### Keyboard

| Shortcut | Action |
| --- | --- |
| `⌘K` | Start / stop |
| `⌘↵` | Answer now |
| `⌘R` | Regenerate |
| `⌘⌥L` | Reload the window |
| `⌘⇧R` | Read the chosen screen |
| `⌘⇧O` | Overlay on / off |
| `⌘,` | Keys |
| `Esc` | Collapse controls |

### Reading the screen

Not every question is spoken. **Read screen** (or `⌘⇧R`) captures a display or window and answers whatever question is on it — a coding task, a shared doc, a multiple-choice prompt, a stack trace.

**Read** in the top bar opens a menu with both options, and names the screen it will read from:

| | What it does |
| --- | --- |
| **Snip a region** (`⌘⇧A`) | Freezes the chosen source, you drag a box around just the question, and only that crop is sent |
| **Whole screen** (`⌘⇧R`) | Sends everything on the chosen screen or window |
| **Change screen…** | Pick a different display or window |

The shortcuts work without opening the menu.

Snipping is usually what you want: it removes the surrounding noise, so the model answers the question rather than whatever else is on screen. The frame is **frozen** the moment the selector opens, so what you crop is what you saw — not what arrived half a second later. The selector also has an optional note box ("solve it", "explain the error", "write the SQL") which becomes the instruction.

Small crops are upscaled before sending, since on-screen text is often tiny.

Choose the source once — **Read → Change screen…**, or the **Screen to read** row in Controls. Thumbnails make it obvious which is which; Call Copilot's own windows are excluded, so it never reads its own answers. The capture goes to the current answer provider as an image and the answer streams into the panel like any other.

Notes:

- **A small model will guess.** The prompt tells the model to say it cannot read the image rather than invent a question — but on a weak model (Nova Lite, a local 3B) treat a screen answer as a draft and check any specific it names. This is the same ceiling as spoken answers, and it bites harder here because a bad crop looks like a valid question.
- **Needs a vision-capable provider.** Anthropic, OpenAI and Nova (Lite/Pro) all read images. Local text models do not — you get a message telling you to pull a vision model (`ollama pull llama3.2-vision`) or switch provider, rather than a silent failure.
- Captures are resized to 1920px wide and encoded as JPEG (quality 90). A full-screen PNG runs past 1MB; JPEG holds text legibility at roughly a quarter the size.
- **Window ids are not stable across restarts** (display ids are), so the remembered window is re-resolved by name before giving up.

### Overlay

**Overlay** in the top bar (or `⌘⇧O`) opens a small floating window that sits above everything else — the meeting, the browser, a fullscreen app — showing the answers while the main window keeps the settings and controls.

- Shows **only the current answer** — it is a glance surface, not a log. Past answers stay in the main window.
- **Always on top**, including over fullscreen apps, and visible on every Space.
- **Hidden from screen sharing by default.** The shield button in its title bar reads **Hidden** (green) or **Visible** (red) so the state is never in doubt, and it re-asserts protection after the window loads rather than trusting a single call at creation.
- **Controls** opens a scrollable panel inside the overlay with the full set: Start/Stop, Answer now, Regenerate, Mode, Length, Depth, Style, answer provider and model, **Snip / Whole screen / Change screen**, the chosen screen's name, audio source, transcription provider and the auto-answer pause. Nothing needs the main window mid-call. Changes sync both ways and persist.
  Choosing a screen opens a dialog that lives in the main window, so that one action deliberately brings the main window forward — otherwise the click would look like it did nothing.
- **Lock** makes clicks pass through to whatever is underneath, so it can sit over the meeting controls without stealing them.
- **Fade** cycles opacity; **Transcript** shows or hides a compact transcript strip; drag it by the title bar.

The overlay is a pure view — it holds no state of its own. The main window pushes a snapshot on every change, so audio capture and answering stay in one place.

Two things make that reliable, and both are easy to get wrong:

- **`backgroundThrottling: false` on both windows.** While the overlay is in use the main window is by definition hidden behind the meeting, and Chromium throttles hidden windows to roughly 1Hz — measured here, `requestAnimationFrame` fired **once in three seconds** and a 100ms interval fired three times. The overlay was starved of updates exactly when it was needed.
- **Pushes are throttled with a timer, not `requestAnimationFrame`**, for the same reason, with a 1s heartbeat as a safety net and re-adoption of an already-open overlay after the main window reloads.

Verified with a controlled test: with protection on, a full-screen `screencapture` does not contain the overlay; with it off, it does.

### Desktop-only

- **System audio** — tick "Also capture system audio" to transcribe the *other* participants, not just your mic. Uses ScreenCaptureKit loopback, so no BlackHole or Loopback virtual device is needed. Requires macOS 13+ and Screen Recording permission.
- **Hide from Dock & app switcher** — in Controls. Makes it an accessory app: no Dock icon, and it stops appearing in ⌘Tab. Because that leaves no way to click back to it, the window is summoned with a global **⌃⌥C** (toggles show/hide). The toggle *refuses to turn on* if that shortcut is already taken by another app, rather than leaving the window unreachable. The preference lives in the main process so the icon never flashes into the Dock at launch.
- **Pin** — float the window above Zoom/Meet.
- **Hidden from share** — on by default. Sets `setContentProtection`, so the window does not appear in screen shares or recordings.

---

## How it works

```
mic ──┐
      ├─► AudioWorklet ─► PCM16 ─► ws://…/stt ─► Deepgram  ─┐
loopback ┘                                    │  or OpenAI ─┘
                                              ▼
                                      transcript (partial + final)
                                              │
                                    recent window + settings
                                              ▼
                              POST /api/answer ─► Anthropic ─┐
                                                 or OpenAI  ─┴─► SSE ─► right panel
```

The renderer talks only to the local backend. Every provider key lives in the Electron main process and never reaches the page; the browser sends the *name* of the provider it wants, never a credential.

Both sides are adapters behind one interface. `server/stt/` normalises Deepgram's `Results` frames and OpenAI's incremental `…transcription.delta` events into the same `{text, isFinal}` shape — OpenAI sends increments where Deepgram resends the whole partial, so the adapter accumulates per item. `server/providers/` does the same for answers, mapping Claude's `.stream()` and OpenAI's `response.output_text.delta` onto one SSE format.

**Latency choices.** Audio ships in 64 ms frames. Transcription renders partials in place and commits finals. Answers stream token by token — nothing waits for a complete response. Reasoning is held at the lowest useful level (`low`, raised a notch for *detailed*) on both providers, which is the main time-to-first-token lever; override with `ANTHROPIC_EFFORT` / `OPENAI_REASONING_EFFORT`, or `ANSWER_FAST_MODE=1` for Opus 5 fast mode (~2.5× output tokens/sec at premium pricing).

**Failure handling**, all surfaced inline rather than in the console:

- Mic permission denied → banner with the exact System Settings path.
- STT socket drop → automatic reconnect with exponential backoff on both hops, with up to ~4 s of audio buffered across the gap so you lose a beat instead of the session.
- LLM failure → the error lands in the answer card, typed by cause (bad key, rate limit, unknown model, network, refusal).
- Missing keys → the Keys dialog opens on launch, and unusable providers are greyed out rather than failing at Start.

### When the transcript lags or misses speech

There is a live **input level meter** next to the status pill. It is the fastest way to tell the two failure modes apart:

| Meter | Meaning | Fix |
| --- | --- | --- |
| Dead while you talk | Audio never reaches the app | Wrong input device, or another app grabbed the mic. A banner says so after ~6s |
| Moving, transcript behind | Audio is reaching the service late | A banner appears once the socket backlog passes 64 KB — usually the network |
| Moving, words missing | The browser is gating quiet speech | Tick **Raw mic** in Controls to turn off noise suppression, echo cancellation and auto gain |

Capture sources can die mid-session — macOS reclaims the screen-recording tap, the display sleeps, another app takes the mic. When that happens the app never reports "still listening" without checking that something is actually live:

- One of two sources ends → warning, carry on with the other.
- The only source ends → one automatic attempt to re-acquire it, and a confirmation if it works.
- Re-acquire fails → the session stops, status goes to **Error**, and the banner says which source died and what to do.

A watchdog also fires if capture stalls for more than a second, or if audio is flowing but silent.

Worth knowing on an 8 GB machine: a local model holds ~2 GB resident, and with several other apps open macOS starts swapping — that will make capture stutter. `llama3.2:1b` halves the footprint if that happens.

Measured for reference: the capture path holds a 64 ms frame cadence (median 64.0 ms, worst 66.2 ms) even while a local model is generating, and end-to-end transcription lag stays flat at 0.02-0.08s over a 24s session with no socket backlog.

---

## Configuration

Everything is optional except the two keys.

| Variable | Default | Notes |
| --- | --- | --- |
| `DEEPGRAM_API_KEY` | — | Or set it in the Keys dialog |
| `ANTHROPIC_API_KEY` | — | Or set it in the Keys dialog |
| `OPENAI_API_KEY` | — | Covers transcription *and* answers |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | Local model server |
| `OLLAMA_MODEL` | `llama3.2:3b` | Default local model |
| `DEEPGRAM_MODEL` | `nova-3` | |
| `OPENAI_STT_MODEL` | `gpt-live-transcribe` | |
| `STT_LANGUAGE` | `en` | |
| `ANTHROPIC_MODEL` | `claude-opus-5` | Default selection; changeable in the UI |
| `OPENAI_MODEL` | `gpt-5.6-terra` | Default selection; changeable in the UI |
| `ANTHROPIC_EFFORT` | per detail level | `low` → `max`; trades latency for depth |
| `OPENAI_REASONING_EFFORT` | per detail level | `none` → `xhigh` |
| `ANSWER_FAST_MODE` | `0` | Opus 5 fast mode, premium pricing |
| `PORT` | `5178` | Browser mode only; the desktop app picks an ephemeral port |

## Layout

```
electron/     main process — window, media permissions, loopback audio, key storage path
server/       express + ws backend (runs inside Electron, or standalone for browser mode)
  app.js        routes, /stt websocket upgrade, key verification
  config.js     keys, model defaults, provider registry
  prompt.js     system + user message construction
  answer.js     answer route; dispatches to a provider
  providers/    anthropic.js, openai.js, ollama.js — streaming answers
  stt/          index.js (reconnect + buffering), deepgram.js, openai.js
  keys.js       server-side key store (0600)
public/       the single-page UI
  app.js        capture, transcript state, triggers, answer streaming
  pcm-worklet.js  float32 → mono PCM16 framing
```

## Notes

Recording a call may require the other party's consent where you are. That is on you.
