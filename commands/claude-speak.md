---
description: Control claude-speak — speak Claude's replies aloud (on/off/setup/voice/status/test)
argument-hint: "[on | off | setup | status | voice <name> | test | notify on|off | recap on|off]"
allowed-tools: Bash, AskUserQuestion
---

You are running the `/claude-speak` control command. The argument is: `$ARGUMENTS`

The plugin's control script is at `${CLAUDE_PLUGIN_ROOT}/scripts/control.sh`. Run it with the Bash tool. Always quote the path. Keep your reply short.

## Routing

- **empty** or `status` → run `bash "${CLAUDE_PLUGIN_ROOT}/scripts/control.sh" status` and show the output.
- `on` / `off` → run `bash "${CLAUDE_PLUGIN_ROOT}/scripts/control.sh" on` (or `off`). Confirm in one line.
- `test` → run `bash "${CLAUDE_PLUGIN_ROOT}/scripts/control.sh" test`. Tell the user to listen.
- `voice <name>` → run `bash "${CLAUDE_PLUGIN_ROOT}/scripts/control.sh" voice "<name>"`, then `... test` so they hear it.
- `notify on|off`, `recap on|off`, `rate <n>`, `cap <n>` → pass straight through to control.sh.
- `setup` (or empty arg on first ever run) → run the **Setup flow** below.

If `$ARGUMENTS` is anything else, run `bash "${CLAUDE_PLUGIN_ROOT}/scripts/control.sh" $ARGUMENTS` and report the result.

## Setup flow

Goal: pick the most natural-sounding voice available and confirm speaking is on.

1. Run `bash "${CLAUDE_PLUGIN_ROOT}/scripts/control.sh" init` to create the config.
2. Run `bash "${CLAUDE_PLUGIN_ROOT}/scripts/control.sh" voices` to list installed **Premium/Enhanced** voices (the natural ones — macOS blocks Siri voices from the `say` command, so Premium/Enhanced is the best local quality).
3. Sample the top candidates so the user can compare. For each of up to 4 natural voices, speak a short sample, e.g.:
   `say -v "Zoe (Enhanced)" "Hi, I'm Zoe. I can read Claude's replies to you."`
   Pace them one at a time. Prefer US English voices first, then others.
4. If **no** Premium/Enhanced voices are installed, tell the user how to add them: System Settings → Accessibility → Spoken Content → System Voice → **Manage Voices**, download a Premium voice (e.g. "Ava (Premium)", "Zoe (Premium)"), then re-run `/claude-speak setup`. Offer to set a decent default (Samantha) meanwhile.
5. Use **AskUserQuestion** to let the user pick a voice from the ones you sampled.
6. Save it: `bash "${CLAUDE_PLUGIN_ROOT}/scripts/control.sh" voice "<chosen>"`.
7. Make sure speaking is on: `bash "${CLAUDE_PLUGIN_ROOT}/scripts/control.sh" on`.
8. Speak a final confirmation with the chosen voice via `... test`.
9. Show `... status` and remind: idle "waiting for your input" alerts are **off** by default — enable with `/claude-speak notify on`.

Notes:
- Never edit `~/.claude/settings.json` here — all state lives in the control script's config file. The hooks are already registered by the plugin.
- Speaking only happens on macOS/Linux/Windows where a TTS engine and `jq` exist; if `control.sh test` says no `say`, report that plainly.
