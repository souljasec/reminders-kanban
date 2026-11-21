#!/bin/bash
# Reminders Kanban — installer / updater / uninstaller
#
#   curl -fsSL https://raw.githubusercontent.com/souljasec/reminders-kanban/main/install.sh | bash
#   ./install.sh [options]
#
# Options (all optional; without a terminal, e.g. when an AI runs this, safe defaults are used):
#   -y, --yes                 accept all defaults without asking
#   --claude-desktop / --no-claude-desktop   connect Claude Desktop (default: yes if installed)
#   --claude-code    / --no-claude-code      connect Claude Code    (default: yes if installed)
#   --codex          / --no-codex            connect Codex / ChatGPT desktop (default: yes if `codex` is installed)
#   --login-item     / --no-login-item       start Übersicht at login (default: yes)
#   --uninstall               remove the widget, helper and AI connections (keeps your tasks; add --purge to
#                             also delete projects/order data)
set -euo pipefail

REPO="https://github.com/souljasec/reminders-kanban"
APPDIR="$HOME/Library/Application Support/Reminders Kanban"
BIN="$APPDIR/reminders-kanban"
WIDGET="$HOME/Library/Application Support/Übersicht/widgets/kanban.widget"
CLAUDE_CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"

say()  { printf '\033[1;34m==>\033[0m %s\n' "$1"; }
ok()   { printf '\033[1;32m ✓\033[0m %s\n' "$1"; }
warn() { printf '\033[1;33m !\033[0m %s\n' "$1"; }
die()  { printf '\033[1;31mError:\033[0m %s\n' "$1" >&2; exit 1; }

YES=0; UNINSTALL=0; PURGE=0
CD=""; CC=""; CX=""; LOGIN=""
for a in "$@"; do
  case "$a" in
    -y|--yes) YES=1 ;;
    --claude-desktop) CD=1 ;;  --no-claude-desktop) CD=0 ;;
    --claude-code) CC=1 ;;     --no-claude-code) CC=0 ;;
    --codex) CX=1 ;;           --no-codex) CX=0 ;;
    --login-item) LOGIN=1 ;;   --no-login-item) LOGIN=0 ;;
    --uninstall) UNINSTALL=1 ;; --purge) PURGE=1 ;;
    -h|--help) sed -n '2,16p' "$0" 2>/dev/null || true; exit 0 ;;
    *) die "Unknown option: $a (see --help)" ;;
  esac
done

INTERACTIVE=0
if [[ $YES -eq 0 ]] && { : </dev/tty; } 2>/dev/null; then INTERACTIVE=1; fi

# ask "question" default(1/0) → returns 0 for yes
ask() {
  local q="$1" def="$2" ans
  if [[ $INTERACTIVE -eq 0 ]]; then [[ $def -eq 1 ]]; return; fi
  local hint="[Y/n]"; [[ $def -eq 0 ]] && hint="[y/N]"
  read -r -p "    $q $hint " ans </dev/tty || ans=""
  ans=$(echo "$ans" | tr '[:upper:]' '[:lower:]')
  if [[ -z "$ans" ]]; then [[ $def -eq 1 ]]; else [[ "$ans" == y* ]]; fi
}
decide() { # decide <flag-value> "question" default → 0 for yes
  local flag="$1" q="$2" def="$3"
  if [[ "$flag" == "1" ]]; then return 0; elif [[ "$flag" == "0" ]]; then return 1; fi
  ask "$q" "$def"
}

have_claude_desktop() { [[ -d "/Applications/Claude.app" || -d "$(dirname "$CLAUDE_CFG")" ]]; }
have_claude_code()    { command -v claude >/dev/null 2>&1; }
have_codex()          { command -v codex >/dev/null 2>&1; }

# Claude Desktop: merge our server into its JSON config (backup first)
claude_desktop_config() { # add|remove
  mkdir -p "$(dirname "$CLAUDE_CFG")"
  if [[ -f "$CLAUDE_CFG" ]]; then cp "$CLAUDE_CFG" "$CLAUDE_CFG.bak-reminders-kanban"; fi
  /usr/bin/python3 -I - "$CLAUDE_CFG" "$BIN" "$1" <<'PY'
import json, os, sys
path, binary, mode = sys.argv[1], sys.argv[2], sys.argv[3]
cfg = {}
if os.path.exists(path):
    with open(path) as f:
        txt = f.read().strip()
    cfg = json.loads(txt) if txt else {}
servers = cfg.setdefault("mcpServers", {})
if mode == "add":
    servers["reminders-kanban"] = {"command": binary, "args": ["mcp"]}
else:
    servers.pop("reminders-kanban", None)
with open(path, "w") as f:
    json.dump(cfg, f, indent=2)
PY
}

# ───────────────────────── uninstall ─────────────────────────
if [[ $UNINSTALL -eq 1 ]]; then
  say "Uninstalling Reminders Kanban (your tasks stay in Apple Reminders)"
  rm -rf "$WIDGET" && ok "Widget removed"
  rm -f "$BIN" && ok "Helper removed"
  if [[ -f "$CLAUDE_CFG" ]] && grep -q reminders-kanban "$CLAUDE_CFG"; then claude_desktop_config remove && ok "Disconnected Claude Desktop"; fi
  if have_claude_code; then claude mcp remove -s user reminders-kanban >/dev/null 2>&1 && ok "Disconnected Claude Code" || true; fi
  if have_codex; then codex mcp remove reminders-kanban >/dev/null 2>&1 && ok "Disconnected Codex" || true; fi
  if [[ $PURGE -eq 1 ]]; then rm -rf "$APPDIR" && ok "Projects and order data deleted"; fi
  echo "Done. Übersicht itself is still installed (brew uninstall --cask ubersicht to remove it)."
  exit 0
fi

# ───────────────────────── checks ─────────────────────────
[[ "$(uname)" == "Darwin" ]] || die "macOS only (Apple Reminders isn't available on other systems)."
major=$(sw_vers -productVersion | cut -d. -f1)
(( major >= 14 )) || die "macOS 14 Sonoma or newer is required."

UPDATING=0; [[ -f "$WIDGET/index.jsx" ]] && UPDATING=1
OLD_VERSION=""; [[ -x "$BIN" ]] && OLD_VERSION=$("$BIN" version 2>/dev/null || true)
say "$([[ $UPDATING -eq 1 ]] && echo Updating || echo Installing) Reminders Kanban"

# 1. Übersicht
if [[ ! -d "/Applications/Übersicht.app" ]]; then
  if command -v brew >/dev/null; then
    say "Installing Übersicht (the free app that shows desktop widgets)…"
    brew install --cask ubersicht
  else
    die "Install Übersicht first: https://tracesof.net/uebersicht/ (or install Homebrew from https://brew.sh)."
  fi
fi
ok "Übersicht"

# 2. Swift compiler (Xcode Command Line Tools)
if ! xcrun --find swiftc >/dev/null 2>&1; then
  xcode-select --install >/dev/null 2>&1 || true
  die "Xcode Command Line Tools are needed once to build the helper. A macOS window has opened to install them; run this installer again when it finishes."
fi

# 3. Source: this folder if run from a clone, otherwise download the latest release
SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd)/kanban.widget"
if [[ ! -f "$SRC/src/bridge.swift" ]]; then
  # github.com/<repo>/releases/latest redirects to …/releases/tag/<tag> (no API rate limit)
  TAG=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$REPO/releases/latest" 2>/dev/null | sed -n 's#.*/releases/tag/##p')
  [[ -n "$TAG" ]] || die "Couldn't find the latest release at $REPO/releases. Check your internet connection and try again."
  [[ -n "$OLD_VERSION" && "v$OLD_VERSION" == "$TAG" ]] && ok "Already on the latest version ($TAG), reinstalling it"
  TMP=$(mktemp -d)
  curl -fsSL "$REPO/archive/refs/tags/$TAG.tar.gz" | tar -xz -C "$TMP" --strip-components=1
  SRC="$TMP/kanban.widget"
fi

# 4. Build the helper (Reminders access + AI connection)
mkdir -p "$APPDIR"
xcrun swiftc -O "$SRC/src/bridge.swift" -o "$BIN.new" \
  -Xlinker -sectcreate -Xlinker __TEXT -Xlinker __info_plist -Xlinker "$SRC/src/Info.plist" 2>&1 | grep -v "warning:" || true
[[ -x "$BIN.new" ]] || die "Building the helper failed."
mv -f "$BIN.new" "$BIN"
NEW_VERSION=$("$BIN" version)
if [[ -n "$OLD_VERSION" && "$OLD_VERSION" != "$NEW_VERSION" ]]; then
  ok "Helper built ($OLD_VERSION → $NEW_VERSION)"
else
  ok "Helper built ($NEW_VERSION)"
fi

# 5. Widget files (your position, order and projects are kept)
mkdir -p "$WIDGET"
cp "$SRC/index.jsx" "$SRC/make-room.py" "$WIDGET/"
rm -rf "$WIDGET/bridge" "$WIDGET/src"            # files from version 1.0
ok "Widget installed"

# 6. Reminders access
say "Checking Reminders access (click Allow if macOS asks)…"
if "$BIN" list >/dev/null 2>&1; then ok "Reminders access"; else
  warn "No Reminders access yet. Allow it in System Settings → Privacy & Security → Reminders."
fi

# 7. AI assistants
say "Connecting AI assistants (they can add and update tasks; they can't delete)"
CONNECTED=()
if have_claude_desktop || [[ "$CD" == "1" ]]; then
  if decide "$CD" "Connect Claude Desktop?" 1; then
    claude_desktop_config add && ok "Claude Desktop (restart Claude to load it)" && CONNECTED+=("Claude Desktop")
  fi
fi
if have_claude_code; then
  if decide "$CC" "Connect Claude Code?" 1; then
    claude mcp remove -s user reminders-kanban >/dev/null 2>&1 || true
    claude mcp add -s user reminders-kanban -- "$BIN" mcp >/dev/null && ok "Claude Code" && CONNECTED+=("Claude Code")
  fi
elif [[ "$CC" == "1" ]]; then warn "Claude Code isn't installed; skipped."; fi
if have_codex; then
  if decide "$CX" "Connect Codex / ChatGPT desktop?" 1; then
    codex mcp remove reminders-kanban >/dev/null 2>&1 || true
    codex mcp add reminders-kanban -- "$BIN" mcp >/dev/null && ok "Codex / ChatGPT desktop" && CONNECTED+=("Codex")
  fi
elif [[ "$CX" == "1" ]]; then warn "Codex CLI isn't installed; skipped."; fi
if [[ ${#CONNECTED[@]} -eq 0 ]]; then warn "No AI app connected. See README → \"Connect other AI apps\" for manual setup."; fi

# 8. Start at login
if decide "$LOGIN" "Start Übersicht automatically when you log in?" 1; then
  if osascript -e 'tell application "System Events" to get the name of every login item' 2>/dev/null | grep -q "Übersicht"; then
    ok "Übersicht already starts at login"
  elif osascript -e 'tell application "System Events" to make login item at end with properties {path:"/Applications/Übersicht.app", hidden:false}' >/dev/null 2>&1; then
    ok "Übersicht starts at login"
  else
    warn "Couldn't add the login item. Add Übersicht in System Settings → General → Login Items."
  fi
fi

# 9. Start / reload
if pgrep -x "Übersicht" >/dev/null; then osascript -e 'tell application id "tracesOf.Uebersicht" to refresh' >/dev/null 2>&1 || true
else open -a "Übersicht"; fi

echo
"$BIN" doctor || true
echo
say "Done! The widget is on your desktop. Drag its header to move it."
if [[ ${#CONNECTED[@]} -gt 0 ]]; then
  echo "    Try asking your AI: \"Add a task to my Kanban: call the dentist tomorrow at 10am\""
fi
