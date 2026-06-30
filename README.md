# claude-speak

Hear Claude Code. A small [Claude Code](https://docs.claude.com/en/docs/claude-code)
plugin that speaks a short summary of each reply aloud, so you can look away and
still follow along.

- **Natural voice, fully local, no API keys.** Use your system voice (macOS
  `say`, Linux `spd-say`/`espeak`, Windows PowerShell) **or** the bundled support
  for [Piper](https://github.com/rhasspy/piper) — a free, offline neural TTS that
  sounds noticeably more human.
- **Speaks the summary, not the wall of text.** It reads the reply's `TL;DR`
  block if there is one, otherwise just the conclusion (last paragraph) — never
  the whole verbose reply.
- **Quiet by default.** The naggy "Claude is waiting for your input" alert is
  **off** unless you turn it on.
- **Optional floating avatar (macOS).** A frameless, always-on-top desktop head
  (Claudette) that **lip-syncs** to whatever claude-speak speaks — see
  [Floating desktop avatar](#floating-desktop-avatar-macos).
- **One command to drive it:** `/claude-speak on | off | setup | voice | avatar | status`.

## Install

```text
/plugin marketplace add nathan-hekman/claude-speak
/plugin install claude-speak@claude-speak
```

Then run the guided setup:

```text
/claude-speak setup
```

Setup samples the natural voices available on your machine, lets you pick one
(and can install Piper + a high-quality voice for you), and turns speaking on.

## Requirements

- [`jq`](https://jqlang.github.io/jq/) on your `PATH` (parses the hook payload).
- A TTS engine — at least one of:
  - **Piper** (recommended, most natural): installed for you by `/claude-speak
    setup`, or manually with `uv tool install piper-tts` / `pipx install piper-tts`.
  - **macOS** — `say` (built in).
  - **Linux** — `spd-say` (speech-dispatcher) or `espeak-ng` / `espeak`.
  - **Windows / WSL** — `powershell.exe` (built in).

If no TTS engine or `jq` is found, the plugin stays silent — it never errors.

## Command reference

| Command | What it does |
|---------|--------------|
| `/claude-speak` or `/claude-speak status` | Show current settings. |
| `/claude-speak on` / `off` | Enable / mute (stays installed). |
| `/claude-speak setup` | Guided voice picker; can install Piper. |
| `/claude-speak voice <name>` | Set the **system** TTS voice (macOS: any `say -v '?'` name). |
| `/claude-speak personal-voice [<name>]` | **macOS:** authorize + speak replies in your own **Personal Voice**. |
| `/claude-speak avatar [on\|off\|status]` | **macOS:** launch / quit the floating desktop avatar that lip-syncs. |
| `/claude-speak test [text]` | Speak a sample line with the current settings. |
| `/claude-speak notify on` / `off` | Speak idle/permission alerts. Default **off**. |
| `/claude-speak recap on` / `off` | Model-generated 1-2 sentence recap when a reply has no `TL;DR`. Default **off**. |
| `/claude-speak engine auto\|piper\|system` | Choose the TTS backend. `auto` uses Piper when available. |
| `/claude-speak piper-install` | Install the Piper engine. |
| `/claude-speak piper-voice <id>` | Download + select a Piper voice (e.g. `en_GB-cori-high`). |

## Voices

### Piper (recommended)

Piper voices are free, offline, and more natural than the built-in OS voices.
Browse them at the [Piper voice samples](https://rhasspy.github.io/piper-samples/)
page, then:

```text
/claude-speak piper-voice en_US-amy-medium
```

The model downloads to `~/.local/share/claude-speak/voices/` and is selected
automatically. `engine` is set to `piper`.

### System voices (macOS)

```bash
say -v '?'        # list installed voices
```

For higher quality, download a **Premium** or **Enhanced** voice in System
Settings → Accessibility → Spoken Content → System Voice → **Manage Voices**,
then `/claude-speak voice "Zoe (Enhanced)"`.

> Note: macOS blocks **Siri** voices from the `say` command, so they can't be
> used here. Premium/Enhanced are the best built-in option; Piper is better still.

### Personal Voice (macOS — your own cloned voice)

macOS can read Claude's replies in **your own voice**. First create one in
**System Settings → Accessibility → Personal Voice** (and turn on *Allow Apps to
Request to Use*). Then:

```text
/claude-speak personal-voice
```

This authorizes the app running claude-speak to use Personal Voice (approve the
one-time system dialog), selects your voice, and sets `engine=system`. With more
than one Personal Voice, name it: `/claude-speak personal-voice "My Voice"`.

How it works: Apple only exposes Personal Voice to apps holding a per-app
authorization, so plain `say -v` can't reach it by default. The bundled
[`personal-voice-authorize.swift`](scripts/personal-voice-authorize.swift) calls
Apple's public `requestPersonalVoiceAuthorization` API — no private API,
entitlement, or code injection. The grant attaches to the app that runs `say`
(the Claude app, your terminal, ...), so run the command from the same place
claude-speak runs. macOS only; a headless/SSH host has no dialog to approve.

## Floating desktop avatar (macOS)

An optional, frameless, always-on-top desktop head — **Claudette** — that
lip-syncs to whatever claude-speak speaks. It reuses the avatar (3D head, real
viseme lip-sync, and the look/feel settings) from the
[claudette](https://github.com/nathan-hekman) project, wrapped in a small Electron
app under [`avatar-app/`](avatar-app/).

**How the hand-off works.** When the avatar is running, `speak.sh` renders each
reply to a WAV (keeping your Personal Voice), POSTs it to the app's local bridge
(`127.0.0.1:8456`), and the avatar plays it + drives the mouth — so `speak.sh`
itself stays silent. When the avatar **isn't** running the POST fails instantly
and claude-speak plays the audio itself, exactly as before. Nothing to toggle:
the routing follows whether the app is up.

**Build it once** (unsigned local app, no code-signing needed):

```bash
cd avatar-app
./sync-avatar.sh        # pull the avatar + GLB models from your claudette checkout
npm install
npm run dist            # builds dist/mac-arm64/Claudette Avatar.app
```

**Run it:**

```text
/claude-speak avatar        # launch (or: open the built .app)
/claude-speak avatar off    # quit
/claude-speak avatar status # is it running?
```

- **Controls** live in its menu-bar icon: show/hide, settings, recenter, a voice
  on/off toggle, and quit. Hover the top of the window for a drag strip + a gear
  that opens the full look/feel panel (look, model, background, expressions, idle
  tuners). Drag her by that strip; the rest of the window orbits/zooms the head.
- **Opening the app offers to turn claude-speak on** if it's off; **quitting it
  asks whether to mute claude-speak too** or just close the avatar.
- The avatar's code + GLB models are **vendored** into `avatar-app/`. After you
  improve the avatar in claudette, re-run `./sync-avatar.sh` and `npm run dist`.

## Configuration

State lives in `~/.config/claude-speak/config.json` (written by `/claude-speak`).
You normally never edit it by hand. Any `CLAUDE_SPEAK_*` environment variable
overrides the matching key, for power users who prefer to pin values in the
`env` block of `~/.claude/settings.json`.

| Env var | Config key | Default | Meaning |
|---------|-----------|---------|---------|
| `CLAUDE_SPEAK_ENABLED` | `enabled` | `true` | Master on/off. |
| `CLAUDE_SPEAK_ENGINE` | `engine` | `auto` | `auto` \| `piper` \| `system`. |
| `CLAUDE_SPEAK_PIPER_MODEL` | `piper_model` | — | Path to a Piper `.onnx` model. |
| `CLAUDE_SPEAK_VOICE` | `voice` | system default | System TTS voice name. |
| `CLAUDE_SPEAK_RATE` | `rate` | voice default | Words per minute. |
| `CLAUDE_SPEAK_CAP` | `cap` | `500` | Max characters spoken. |
| `CLAUDE_SPEAK_MARKER` | `marker` | `TL;?DR` | Regex; speak from this line onward. Matches `TL;DR`, `TLDR`, `TLDR [ds-mode]`. |
| `CLAUDE_SPEAK_NOTIFY` | `speak_notifications` | `false` | Speak idle/permission alerts. |
| `CLAUDE_SPEAK_RECAP` | `recap` | `false` | Model recap fallback. |
| `CLAUDE_SPEAK_AVATAR` | `avatar` | `true` | Hand audio to the floating avatar when it's running. |
| `CLAUDE_SPEAK_AVATAR_PORT` | `avatar_port` | `8456` | Local bridge port the avatar listens on. |

## How it works

The plugin registers two [hooks](https://docs.claude.com/en/docs/claude-code/hooks):

- **Stop** → `speak.sh stop` reads the last assistant message from the transcript,
  picks what to speak (TL;DR block → optional model recap → conclusion), strips
  markdown/decoration, caps the length, and speaks it.
- **Notification** → `speak.sh notify` speaks the alert message — but only if you
  enabled `notify on`.

Both run with `async: true`, so speech never blocks your next prompt.

### Test what it would say (no audio)

```bash
echo '{"transcript_path":"/path/to/session.jsonl"}' | scripts/speak.sh stop --print
```

## Disable / uninstall

- Mute: `/claude-speak off`.
- Remove: `/plugin uninstall claude-speak@claude-speak`.

## License

MIT — see [LICENSE](LICENSE).
