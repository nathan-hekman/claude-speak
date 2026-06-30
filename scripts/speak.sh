#!/usr/bin/env bash
#
# claude-speak - speak Claude Code activity aloud via the system TTS voice.
#
# Invoked by the plugin's hooks (reads the hook JSON from stdin):
#   speak.sh notify   speak the Notification message (Claude needs input)
#   speak.sh stop     speak a summary of Claude's last reply
#   speak.sh print    print what WOULD be spoken (testing); no audio
#
# Settings come from a config file written by `/claude-speak` (control.sh):
#   ~/.config/claude-speak/config.json   (override path: CLAUDE_SPEAK_CONFIG)
# Any CLAUDE_SPEAK_* environment variable overrides the matching config key,
# so power users can still pin values in ~/.claude/settings.json "env".
#
# Config keys (env var -> json key):
#   CLAUDE_SPEAK_ENABLED       enabled              1 (default) | 0 to mute
#   CLAUDE_SPEAK_VOICE         voice                voice name; see `say -v '?'`
#   CLAUDE_SPEAK_RATE          rate                 words-per-minute
#   CLAUDE_SPEAK_CAP           cap                  max chars spoken (default 500)
#   CLAUDE_SPEAK_MARKER        marker               regex; speak from match onward
#   CLAUDE_SPEAK_NOTIFY        speak_notifications  speak idle/permission alerts?
#                                                   default 0 (off) so "Claude is
#                                                   waiting for your input" stays quiet
#   CLAUDE_SPEAK_RECAP         recap                1 = model-generated recap fallback
#   CLAUDE_SPEAK_RECAP_MODEL   recap_model          model for recaps (default haiku)
#
# Reply summary is chosen in this order (never the verbose full reply):
#   1. a TL;DR / TLDR block (the `marker`)  ->  speak from there onward
#   2. otherwise the reply's last paragraph (its conclusion)
#   3. optional: if recap=1, a 1-2 sentence model recap is tried before (2)
#
# TTS backends, tried in order:
#   say (macOS) -> spd-say -> espeak-ng/espeak (Linux) -> powershell.exe (Win/WSL)
#
# Bash 3.2 compatible (macOS default). No `set -e`/`set -u` on purpose: a
# missing voice or a no-match grep must never abort speech.

mode="${1:-stop}"
# Dry-run: print what would be spoken instead of speaking it.
dry="${CLAUDE_SPEAK_PRINT:-0}"
[ "${2:-}" = "--print" ] && dry=1
[ "$mode" = "print" ] && { mode="stop"; dry=1; }

# Never recurse: a model recap spawns `claude`, whose own Stop hook would call
# this script again. The child carries this sentinel and exits immediately.
[ -n "${CLAUDE_SPEAK_CHILD:-}" ] && exit 0

# ---- config -----------------------------------------------------------------
CONFIG="${CLAUDE_SPEAK_CONFIG:-$HOME/.config/claude-speak/config.json}"

# cfg <json-key> <default> <ENV_NAME> : env var (if set) wins, else config file,
# else default.
cfg() {
  key="$1"; def="$2"; envname="$3"
  if [ -n "$envname" ]; then
    eval "ev=\${$envname:-__UNSET__}"
    [ "$ev" != "__UNSET__" ] && { printf '%s' "$ev"; return; }
  fi
  if [ -f "$CONFIG" ] && command -v jq >/dev/null 2>&1; then
    fv="$(jq -r --arg k "$key" 'if has($k) and .[$k] != null then .[$k] else empty end' "$CONFIG" 2>/dev/null)"
    [ -n "$fv" ] && { printf '%s' "$fv"; return; }
  fi
  printf '%s' "$def"
}

# truthy: 1/true/yes/on -> 0 (true), everything else -> 1 (false)
truthy() {
  case "$(printf '%s' "$1" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) return 0 ;; *) return 1 ;;
  esac
}

ENABLED="$(cfg enabled 1 CLAUDE_SPEAK_ENABLED)"
truthy "$ENABLED" || exit 0
command -v jq >/dev/null 2>&1 || exit 0

VOICE="$(cfg voice '' CLAUDE_SPEAK_VOICE)"
RATE="$(cfg rate '' CLAUDE_SPEAK_RATE)"
CAP="$(cfg cap 500 CLAUDE_SPEAK_CAP)"
MARKER="$(cfg marker 'TL;?DR' CLAUDE_SPEAK_MARKER)"
NOTIFY="$(cfg speak_notifications 0 CLAUDE_SPEAK_NOTIFY)"
RECAP="$(cfg recap 0 CLAUDE_SPEAK_RECAP)"
RECAP_MODEL="$(cfg recap_model haiku CLAUDE_SPEAK_RECAP_MODEL)"

# Optional Piper neural-TTS backend (free, fully local, more natural than the OS
# voices). engine: auto | piper | system. In auto, Piper is used when a binary
# and a model are both resolvable; otherwise it falls back to the OS voice.
ENGINE="$(cfg engine auto CLAUDE_SPEAK_ENGINE)"
PIPER_BIN="$(cfg piper_bin '' CLAUDE_SPEAK_PIPER_BIN)"
PIPER_MODEL="$(cfg piper_model '' CLAUDE_SPEAK_PIPER_MODEL)"

# Optional floating avatar (the Claudette desktop app, in ./avatar-app). When it's
# running we render the reply to a WAV and hand it the audio + text; the avatar plays
# it and lip-syncs, so speak.sh stays silent. When it's NOT running the handoff fails
# fast and we fall through to normal local playback below. Off via avatar=false / env.
AVATAR="$(cfg avatar 1 CLAUDE_SPEAK_AVATAR)"
AVATAR_PORT="$(cfg avatar_port 8456 CLAUDE_SPEAK_AVATAR_PORT)"

# Resolve a usable piper binary (config -> PATH -> ~/.local/bin).
resolve_piper() {
  if [ -n "$PIPER_BIN" ] && [ -x "$PIPER_BIN" ]; then printf '%s' "$PIPER_BIN"; return; fi
  p="$(command -v piper 2>/dev/null)"; [ -n "$p" ] && { printf '%s' "$p"; return; }
  [ -x "$HOME/.local/bin/piper" ] && printf '%s' "$HOME/.local/bin/piper"
}

# Speak via Piper: synth to a temp wav, then play it with the OS audio player.
# Returns 0 on success, 1 if Piper isn't usable so the caller can fall back.
piper_speak() {
  pb="$(resolve_piper)"
  [ -n "$pb" ] || return 1
  [ -n "$PIPER_MODEL" ] && [ -f "$PIPER_MODEL" ] || return 1
  wav="$(mktemp -t claude-speak).wav"
  printf '%s' "$1" | "$pb" -m "$PIPER_MODEL" -f "$wav" >/dev/null 2>&1 || { rm -f "$wav"; return 1; }
  [ -s "$wav" ] || { rm -f "$wav"; return 1; }
  if command -v afplay >/dev/null 2>&1; then afplay "$wav"
  elif command -v paplay >/dev/null 2>&1; then paplay "$wav"
  elif command -v aplay >/dev/null 2>&1; then aplay -q "$wav"
  else rm -f "$wav"; return 1; fi
  rm -f "$wav"; return 0
}

# Render speech to a WAV file (no playback) for the avatar to analyse. Mirrors the engine
# used for live playback: Piper when selected/available, else macOS `say -o` (which keeps
# your Personal Voice and writes 16-bit PCM the avatar's <audio> element decodes cleanly).
render_wav() {
  _txt="$1"; _out="$2"; _pb=""
  case "$ENGINE" in piper|auto) _pb="$(resolve_piper)" ;; esac
  if [ -n "$_pb" ] && [ -n "$PIPER_MODEL" ] && [ -f "$PIPER_MODEL" ]; then
    printf '%s' "$_txt" | "$_pb" -m "$PIPER_MODEL" -f "$_out" >/dev/null 2>&1 || return 1
    [ -s "$_out" ]; return
  fi
  if command -v say >/dev/null 2>&1; then
    a=(); [ -n "$VOICE" ] && a=(-v "$VOICE"); [ -n "$RATE" ] && a=("${a[@]}" -r "$RATE")
    printf '%s' "$_txt" | say "${a[@]}" --data-format=LEI16@22050 -o "$_out" >/dev/null 2>&1 || return 1
    [ -s "$_out" ]; return
  fi
  return 1
}

# If the floating Claudette avatar is running, render the speech and POST it (base64 JSON)
# to the app's bridge. Returns 0 ONLY when the avatar accepted it, so the caller skips local
# playback (the avatar owns the audio). Any miss -> 1 -> normal local TTS plays. A closed
# port fails the probe near-instantly, so this costs ~nothing when the avatar isn't up.
avatar_handoff() {
  truthy "$AVATAR" || return 1
  command -v curl >/dev/null 2>&1 || return 1
  [ "$(curl -s -m 0.6 -o /dev/null -w '%{http_code}' "http://127.0.0.1:$AVATAR_PORT/health" 2>/dev/null)" = "200" ] || return 1
  wav="$(mktemp -t claude-speak-avatar).wav"
  render_wav "$1" "$wav" || { rm -f "$wav"; return 1; }
  b64="$(base64 < "$wav" | tr -d '\n')"; rm -f "$wav"
  [ -n "$b64" ] || return 1
  payload="$(jq -n --arg t "$1" --arg b "$b64" '{text:$t,b64:$b,format:"wav"}')" || return 1
  [ "$(printf '%s' "$payload" | curl -s -m 12 -o /dev/null -w '%{http_code}' \
      -X POST -H 'Content-Type: application/json' --data-binary @- \
      "http://127.0.0.1:$AVATAR_PORT/speak" 2>/dev/null)" = "200" ]
}

# Generate a 1-2 sentence spoken recap of a reply via a fast headless model.
generate_recap() {
  reply_in="$(printf '%s' "$1" | head -c 4000)"
  to=""
  if command -v gtimeout >/dev/null 2>&1; then to="gtimeout 30"
  elif command -v timeout >/dev/null 2>&1; then to="timeout 30"; fi
  out="$(CLAUDE_SPEAK_CHILD=1 $to claude -p \
"Summarize the assistant reply between the markers into a 1-2 sentence recap of what was accomplished, for reading aloud.

<<<REPLY
$reply_in
REPLY>>>" \
    --append-system-prompt "You are a text summarizer. The user message contains an assistant reply between <<<REPLY and REPLY>>> markers. Output ONLY a 1 to 2 sentence recap of what that reply accomplished, in plain spoken English. No markdown, lists, code, file paths, preamble, or questions. Never mention conversation context or missing information; just summarize the text given. Begin with the action verb (e.g. 'Refactored the parser...'), not with 'The assistant'." \
    --model "$RECAP_MODEL" --max-turns 4 --strict-mcp-config \
    --settings '{"disableAllHooks":true,"alwaysThinkingEnabled":false,"effortLevel":"low"}' 2>/dev/null)"
  case "$out" in
    Error:*|*"Reached max turns"*|"") return 0 ;;
  esac
  printf '%s' "$out"
}

input="$(cat)"

if [ "$mode" = "notify" ]; then
  # Idle / permission alerts are off by default — this is the "Claude is waiting
  # for your input" voice that most people find naggy. Opt in with notify on.
  truthy "$NOTIFY" || exit 0
  raw="$(printf '%s' "$input" | jq -r '.message // empty')"
else
  f="$(printf '%s' "$input" | jq -r '.transcript_path // empty')"
  if [ -z "$f" ] || [ ! -f "$f" ]; then exit 0; fi
  raw="$(jq -rs 'map(select(.type=="assistant")) | last | .message.content[]? | select(.type=="text") | .text' "$f" 2>/dev/null)"
  [ -n "$raw" ] || exit 0

  ln="$(printf '%s\n' "$raw" | grep -niE "$MARKER" 2>/dev/null | head -1 | cut -d: -f1)"
  if [ -n "$ln" ]; then
    # 1) A summary marker (TL;DR / TLDR) is present: speak from there onward.
    raw="$(printf '%s\n' "$raw" | tail -n +"$ln")"
  else
    # 2) No marker. Optional model recap, else the conclusion (last paragraph).
    recap=""
    if truthy "$RECAP" && command -v claude >/dev/null 2>&1; then
      recap="$(generate_recap "$raw")"
    fi
    if [ -n "$(printf '%s' "$recap" | tr -d '[:space:]')" ]; then
      raw="$recap"
    else
      raw="$(printf '%s\n' "$raw" | awk 'BEGIN{RS=""} {p=$0} END{print p}')"
    fi
  fi
fi

[ -n "$raw" ] || exit 0

# Make it pleasant to hear: unwrap markdown links to their text, strip the
# TL;DR header line itself, drop decorative non-ASCII (bullets, box rules),
# bracket labels like "[ds-mode]", and markdown markers. Then cap the length.
spoken="$(printf '%s' "$raw" \
  | sed -E 's/\[([^]]+)\]\([^)]+\)/\1/g' \
  | sed -E '/^[[:space:]]*[^A-Za-z0-9]*TL;?DR/Id' \
  | LC_ALL=C tr -cd '\11\12\15\40-\176' \
  | sed -E -e 's/\[[A-Za-z0-9 ._-]+\]//g' -e 's/[*#`_>]//g' \
  | head -c "$CAP")"

case "$(printf '%s' "$spoken" | tr -d '[:space:]')" in "") exit 0 ;; esac

if [ "$dry" = "1" ]; then
  printf '%s\n' "$spoken"
  exit 0
fi

# If the floating avatar is up, it plays the audio + lip-syncs; we're done. Otherwise
# (POST refused / no curl / disabled) fall through and play locally exactly as before.
avatar_handoff "$spoken" && exit 0

# Prefer Piper when selected (engine=piper) or available in auto mode.
if [ "$ENGINE" = "piper" ]; then
  piper_speak "$spoken"; exit 0
elif [ "$ENGINE" = "auto" ]; then
  piper_speak "$spoken" && exit 0
fi

if command -v say >/dev/null 2>&1; then
  a=()
  [ -n "$VOICE" ] && a=("${a[@]}" -v "$VOICE")
  [ -n "$RATE" ] && a=("${a[@]}" -r "$RATE")
  printf '%s' "$spoken" | say "${a[@]}"
elif command -v spd-say >/dev/null 2>&1; then
  a=(-w)
  [ -n "$VOICE" ] && a=("${a[@]}" -o "$VOICE")
  [ -n "$RATE" ] && a=("${a[@]}" -r "$RATE")
  spd-say "${a[@]}" -- "$spoken"
elif command -v espeak-ng >/dev/null 2>&1 || command -v espeak >/dev/null 2>&1; then
  bin="$(command -v espeak-ng 2>/dev/null || command -v espeak)"
  a=()
  [ -n "$VOICE" ] && a=("${a[@]}" -v "$VOICE")
  printf '%s' "$spoken" | "$bin" "${a[@]}"
elif command -v powershell.exe >/dev/null 2>&1; then
  printf '%s' "$spoken" | powershell.exe -NoProfile -Command 'Add-Type -AssemblyName System.Speech; $sp = New-Object System.Speech.Synthesis.SpeechSynthesizer; $sp.Speak([Console]::In.ReadToEnd())'
fi
exit 0
