#!/usr/bin/env bash
#
# claude-speak control - read/write the config that speak.sh obeys.
# Backs the `/claude-speak` slash command. Usage:
#
#   control.sh on                 enable speaking
#   control.sh off                mute (plugin stays installed)
#   control.sh status             print current settings + environment
#   control.sh voice [<name>]     set the voice; no name -> list good voices
#   control.sh rate <wpm>         set words-per-minute (blank to clear)
#   control.sh notify on|off      speak idle/permission alerts (default off)
#   control.sh recap on|off       model-generated recap fallback (default off)
#   control.sh cap <n>            max characters spoken
#   control.sh voices             list installed natural (Premium/Enhanced) voices
#   control.sh allvoices          list every English voice say can use
#   control.sh personal-voice [<name>]  macOS: authorize + speak in YOUR Personal Voice
#   control.sh test [<text>]      speak a sample line with current settings
#   control.sh get <key>          print one config value
#   control.sh set <key> <value>  raw set (advanced)
#   control.sh path               print the config file path
#
# Config lives at ~/.config/claude-speak/config.json (override: CLAUDE_SPEAK_CONFIG).

CONFIG="${CLAUDE_SPEAK_CONFIG:-$HOME/.config/claude-speak/config.json}"
PY="$(command -v python3 || command -v python)"
VOICES_DIR="${CLAUDE_SPEAK_VOICES_DIR:-$HOME/.local/share/claude-speak/voices}"

resolve_piper() {
  if [ -n "$CLAUDE_SPEAK_PIPER_BIN" ] && [ -x "$CLAUDE_SPEAK_PIPER_BIN" ]; then echo "$CLAUDE_SPEAK_PIPER_BIN"; return; fi
  p="$(command -v piper 2>/dev/null)"; [ -n "$p" ] && { echo "$p"; return; }
  [ -x "$HOME/.local/bin/piper" ] && echo "$HOME/.local/bin/piper"
}

ensure_config() {
  d="$(dirname "$CONFIG")"
  [ -d "$d" ] || mkdir -p "$d"
  [ -f "$CONFIG" ] || cat > "$CONFIG" <<'JSON'
{
  "enabled": true,
  "voice": "",
  "rate": "",
  "cap": 500,
  "marker": "TL;?DR",
  "speak_notifications": false,
  "recap": false,
  "recap_model": "haiku"
}
JSON
}

# set_key <key> <raw-json-value>   e.g. set_key voice '"Zoe (Enhanced)"'
set_key() {
  ensure_config
  "$PY" - "$CONFIG" "$1" "$2" <<'PY'
import json, sys
path, key, raw = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    cfg = json.load(open(path))
except Exception:
    cfg = {}
try:
    val = json.loads(raw)
except Exception:
    val = raw
cfg[key] = val
json.dump(cfg, open(path, "w"), indent=2)
open(path, "a").write("\n")
PY
}

get_key() {
  [ -f "$CONFIG" ] || { printf '%s' "$2"; return; }
  "$PY" - "$CONFIG" "$1" "$2" <<'PY'
import json, sys
path, key, default = sys.argv[1], sys.argv[2], sys.argv[3]
try:
    cfg = json.load(open(path))
except Exception:
    cfg = {}
v = cfg.get(key, default)
if isinstance(v, bool):
    v = "true" if v else "false"
print("" if v is None else v)
PY
}

list_natural() { say -v '?' 2>/dev/null | grep -iE '\((Premium|Enhanced)\)' ; }
list_english() { say -v '?' 2>/dev/null | grep -iE 'en[_-]' ; }

cmd="${1:-status}"; shift 2>/dev/null

case "$cmd" in
  on)   set_key enabled true;  echo "claude-speak: ON" ;;
  off)  set_key enabled false; echo "claude-speak: OFF (muted; still installed)" ;;

  notify)
    case "${1:-}" in
      on)  set_key speak_notifications true;  echo "Idle/permission alerts: SPOKEN" ;;
      off) set_key speak_notifications false; echo "Idle/permission alerts: SILENT" ;;
      *)   echo "usage: notify on|off" ;;
    esac ;;

  recap)
    case "${1:-}" in
      on)  set_key recap true;  echo "Model recap fallback: ON" ;;
      off) set_key recap false; echo "Model recap fallback: OFF" ;;
      *)   echo "usage: recap on|off" ;;
    esac ;;

  voice)
    if [ -n "${1:-}" ]; then
      name="$*"
      if command -v say >/dev/null 2>&1 && ! say -v '?' 2>/dev/null | grep -qiF "$name"; then
        echo "warning: '$name' not found in 'say -v ?'. Saving anyway."
      fi
      set_key voice "$("$PY" -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$name")"
      echo "Voice set to: $name"
    else
      echo "Current voice: $(get_key voice '(system default)')"
      echo "Natural (Premium/Enhanced) voices installed:"
      list_natural || echo "  none — download some in System Settings > Accessibility > Spoken Content > System Voice > Manage Voices"
    fi ;;

  rate)  set_key rate "$("$PY" -c 'import json,sys;print(json.dumps(sys.argv[1]))' "${1:-}")"; echo "Rate: ${1:-cleared}" ;;
  cap)   set_key cap "${1:-500}"; echo "Cap: ${1:-500} chars" ;;

  voices)    list_natural || echo "none installed" ;;
  allvoices) list_english ;;

  engine)
    case "${1:-}" in
      auto|piper|system) set_key engine "\"$1\""; echo "Engine: $1" ;;
      *) echo "usage: engine auto|piper|system" ;;
    esac ;;

  piper-install)
    if resolve_piper >/dev/null; then echo "piper already installed: $(resolve_piper)"; exit 0; fi
    echo "Installing piper-tts (local neural TTS)..."
    if command -v uv >/dev/null 2>&1; then uv tool install piper-tts
    elif command -v pipx >/dev/null 2>&1; then pipx install piper-tts
    else "$PY" -m pip install --user piper-tts; fi
    if resolve_piper >/dev/null; then echo "installed: $(resolve_piper)"; else echo "install failed — is uv/pipx/pip available?"; exit 1; fi ;;

  piper-voice)
    # Download a Piper voice by HuggingFace id (e.g. en_GB-cori-high) and select it.
    id="${1:-}"; [ -n "$id" ] || { echo "usage: piper-voice <id>  e.g. en_GB-cori-high"; exit 1; }
    mkdir -p "$VOICES_DIR"
    "$PY" - "$id" "$VOICES_DIR" <<'PY' || exit 1
import sys, os, urllib.request
vid, vdir = sys.argv[1], sys.argv[2]
lang = vid.split('-')[0]          # en_GB
name = vid.split('-')[1]          # cori
qual = vid.split('-')[2]          # high
top  = lang.split('_')[0]         # en
base = f"https://huggingface.co/rhasspy/piper-voices/resolve/main/{top}/{lang}/{name}/{qual}/{vid}"
for ext in (".onnx", ".onnx.json"):
    dst = os.path.join(vdir, vid + ext)
    if os.path.exists(dst) and os.path.getsize(dst) > 0:
        print("have", os.path.basename(dst)); continue
    print("downloading", vid + ext)
    urllib.request.urlretrieve(base + ext, dst)
print("ok")
PY
    set_key piper_model "\"$VOICES_DIR/$id.onnx\""
    set_key engine '"piper"'
    echo "Piper voice set to: $id"
    echo "Engine: piper" ;;

  piper-voices)
    if [ -d "$VOICES_DIR" ]; then ls "$VOICES_DIR"/*.onnx 2>/dev/null | sed -E 's#.*/##; s/\.onnx$//' || echo "(none downloaded)"; else echo "(none downloaded)"; fi ;;

  test)
    ensure_config
    txt="${*:-claude speak is working. This is the voice you will hear.}"
    engine="$(get_key engine auto)"
    pmodel="$(get_key piper_model '')"
    pb="$(resolve_piper)"
    use_piper=0
    case "$engine" in
      piper) use_piper=1 ;;
      auto) [ -n "$pb" ] && [ -n "$pmodel" ] && [ -f "$pmodel" ] && use_piper=1 ;;
    esac
    if [ "$use_piper" = "1" ] && [ -n "$pb" ] && [ -f "$pmodel" ]; then
      wav="$(mktemp -t claude-speak).wav"
      printf '%s' "$txt" | "$pb" -m "$pmodel" -f "$wav" >/dev/null 2>&1
      if [ -s "$wav" ] && command -v afplay >/dev/null 2>&1; then afplay "$wav"
      elif [ -s "$wav" ] && command -v paplay >/dev/null 2>&1; then paplay "$wav"
      elif [ -s "$wav" ] && command -v aplay >/dev/null 2>&1; then aplay -q "$wav"; fi
      rm -f "$wav"
      echo "Spoke a test line with Piper ($(basename "$pmodel" .onnx))."
    elif command -v say >/dev/null 2>&1; then
      v="$(get_key voice '')"; r="$(get_key rate '')"
      a=(); [ -n "$v" ] && a=(-v "$v"); [ -n "$r" ] && a=("${a[@]}" -r "$r")
      printf '%s' "$txt" | say "${a[@]}"
      echo "Spoke a test line with voice='${v:-system default}'."
    else
      echo "no TTS engine available on this platform"
    fi ;;

  personal-voice|pv)
    # macOS: use your Personal Voice (a clone of YOUR voice, created in System
    # Settings > Accessibility > Personal Voice) as the spoken voice. Apple gates
    # it behind a one-time per-app authorization; the bundled Swift helper grants
    # it to whichever app runs this command (the Claude app, your terminal, ...),
    # after which `say -v "<Your Voice>"` can use it. See README > Personal Voice.
    case "$(uname)" in Darwin) ;; *) echo "Personal Voice is macOS-only."; exit 1 ;; esac
    command -v swiftc >/dev/null 2>&1 || { echo "Personal Voice needs Xcode Command Line Tools (swiftc). Run: xcode-select --install"; exit 1; }
    want="$*"
    src="$(dirname "$0")/personal-voice-authorize.swift"
    [ -f "$src" ] || { echo "missing authorizer: $src"; exit 1; }
    bin="${TMPDIR:-/tmp}/claude-speak-pv-authorize"
    if [ ! -x "$bin" ] || [ "$src" -nt "$bin" ]; then
      swiftc -O "$src" -o "$bin" 2>/dev/null || { echo "could not build the Personal Voice authorizer"; exit 1; }
    fi
    echo "Requesting Personal Voice access — if a system dialog appears, click Allow..."
    out="$("$bin" 2>/dev/null)"
    pvstatus="$(printf '%s\n' "$out" | sed -n 's/^AUTH_STATUS=\([0-9]*\).*/\1/p')"
    voices="$(printf '%s\n' "$out" | sed -n 's/^PERSONAL_VOICE name=\(.*\) id=.*/\1/p')"
    if [ "$pvstatus" != "3" ]; then
      echo "Not authorized (status ${pvstatus:-unknown})."
      echo "Turn on System Settings > Accessibility > Personal Voice > 'Allow Apps to Request to Use', create a voice, then retry."
      exit 1
    fi
    if [ -z "$voices" ]; then
      echo "Authorized, but no Personal Voice exists yet. Create one in System Settings > Accessibility > Personal Voice, then retry."
      exit 1
    fi
    if [ -n "$want" ]; then
      chosen="$(printf '%s\n' "$voices" | grep -iF -- "$want" | head -1)"
      [ -n "$chosen" ] || { echo "No Personal Voice matches '$want'. Available:"; printf '  %s\n' "$voices"; exit 1; }
    elif [ "$(printf '%s\n' "$voices" | grep -c .)" = "1" ]; then
      chosen="$voices"
    else
      echo "You have multiple Personal Voices — choose one with:"
      echo "  /claude-speak personal-voice \"<name>\""
      printf '  %s\n' "$voices"
      exit 0
    fi
    set_key engine '"system"'
    set_key voice "$("$PY" -c 'import json,sys;print(json.dumps(sys.argv[1]))' "$chosen")"
    set_key enabled true
    echo "Personal Voice set: $chosen   (engine=system, speaking ON)"
    printf '%s' "This is your Personal Voice, now reading Claude's replies." | say -v "$chosen" 2>/dev/null
    ;;

  status)
    ensure_config
    echo "config: $CONFIG"
    echo "enabled:             $(get_key enabled true)"
    echo "engine:              $(get_key engine auto)   (auto|piper|system)"
    echo "piper:               $(resolve_piper || echo 'not installed')"
    echo "piper_model:         $(get_key piper_model '(none)')"
    echo "voice (system TTS):  $(get_key voice '(system default)')"
    echo "rate:                $(get_key rate '(voice default)')"
    echo "cap:                 $(get_key cap 500) chars"
    echo "speak_notifications: $(get_key speak_notifications false)   (the 'waiting for input' voice)"
    echo "recap:               $(get_key recap false)"
    echo "marker:              $(get_key marker 'TL;?DR')" ;;

  get)  get_key "${1:-}" '' ;;
  set)  set_key "${1:-}" "$("$PY" -c 'import json,sys;print(json.dumps(sys.argv[1]))' "${2:-}")"; echo "set ${1:-}=${2:-}" ;;
  path) echo "$CONFIG" ;;

  init) ensure_config; echo "wrote $CONFIG" ;;

  *) echo "unknown command: $cmd"; echo "try: on | off | setup | status | voice | personal-voice | test | notify on|off"; exit 1 ;;
esac
