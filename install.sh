#!/usr/bin/env bash
# pi-home bootstrap — one-command installer for the public pi agent home.
#
#   curl -fsSL https://raw.githubusercontent.com/marklauyq/pi-home/main/install.sh | bash
#
# Clones https://github.com/marklauyq/pi-home.git into ~/.pi/agent and runs the
# post-clone bootstrap (scripts/pi-install.mjs) there. Safe to pipe through
# bash: no cwd assumptions, `set -euo pipefail`, works on macOS and Linux.
#
# Flags:
#   --dry-run           print the full plan, change nothing
#   --dest <path>       install target instead of ~/.pi/agent (also PI_AGENT_HOME env)
#   --skip-verify       forward to pi-install.mjs (skip headless pi smoke test)
#   --non-interactive   forward to pi-install.mjs (skip prompts)
#   -h | --help         usage
#
# Env overrides (mostly for testing): PI_AGENT_HOME (same as --dest),
# PI_HOME_REPO (clone URL).

set -euo pipefail

REPO_URL="${PI_HOME_REPO:-https://github.com/marklauyq/pi-home.git}"
DEST="${PI_AGENT_HOME:-}"
[ -n "$DEST" ] || DEST="${HOME:-}/.pi/agent"
DRY=0
BOOT_ARGS=""

usage() {
  cat <<'EOF'
pi-home installer — bootstrap the public pi agent home.

  curl -fsSL https://raw.githubusercontent.com/marklauyq/pi-home/main/install.sh | bash

Flags:
  --dry-run           print the full plan, change nothing
  --dest <path>       install target instead of ~/.pi/agent (also PI_AGENT_HOME env)
  --skip-verify       forward to pi-install.mjs (skip headless pi smoke test)
  --non-interactive   forward to pi-install.mjs (skip prompts)
  -h | --help         usage
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) DRY=1 ;;
    --dest)
      shift
      [ $# -gt 0 ] || { echo "install.sh: --dest requires a path" >&2; exit 1; }
      DEST="$1"
      ;;
    --dest=*) DEST="${1#--dest=}" ;;
    --skip-verify) BOOT_ARGS="$BOOT_ARGS --skip-verify" ;;
    --non-interactive) BOOT_ARGS="$BOOT_ARGS --non-interactive" ;;
    -h | --help) usage; exit 0 ;;
    *) echo "install.sh: unknown flag: $1 (see --help)" >&2; exit 1 ;;
  esac
  shift
done

case "$DEST" in
  /*) ;;
  *) echo "install.sh: install target must be an absolute path (got: '$DEST'; is HOME set?)" >&2; exit 1 ;;
esac
if [ "$DEST" = "/" ]; then echo "install.sh: refusing to install into /" >&2; exit 1; fi

say()  { printf '%s\n' "$*"; }
fail() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
run()  { if [ "$DRY" = 1 ]; then say "[dry] $*"; else "$@"; fi; }

DRY_LABEL=""
if [ "$DRY" = 1 ]; then DRY_LABEL=" (dry run)"; fi
say "pi-home installer$DRY_LABEL — target: $DEST"

# ---- prerequisites --------------------------------------------------------

if ! command -v git >/dev/null 2>&1; then
  fail "git not found — install git first (macOS: xcode-select --install or brew install git)"
fi
say "[ok] git $(git --version 2>/dev/null | awk '{print $3}')"

if ! command -v node >/dev/null 2>&1; then
  fail "node not found — need Node >= 22 (nvm: nvm install 22 && nvm use 22)"
fi
NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])' 2>/dev/null || echo 0)
if [ "$NODE_MAJOR" -lt 22 ]; then
  fail "node $(node --version) too old — need >= 22 (nvm: nvm install 22 && nvm use 22)"
fi
say "[ok] node $(node --version)"

if ! command -v npm >/dev/null 2>&1; then
  fail "npm not found (comes with node)"
fi

# ---- pi CLI ---------------------------------------------------------------

if command -v pi >/dev/null 2>&1; then
  say "[ok] pi already on PATH"
elif [ "$DRY" = 1 ]; then
  say "[dry] would run: npm install -g @earendil-works/pi-coding-agent"
else
  say "[..] installing pi globally via npm (may need sudo on some Linux setups)"
  if npm install -g @earendil-works/pi-coding-agent; then
    say "[ok] installed @earendil-works/pi-coding-agent"
  else
    say "[warn] global pi install failed — bootstrap continues anyway; install later with: npm install -g @earendil-works/pi-coding-agent"
  fi
fi

# ---- landing zone ---------------------------------------------------------

MODE="clone"
if [ -e "$DEST/.git" ]; then
  MODE="repair"
  say "[skip] $DEST is already a git checkout — repair mode (no clone)"
elif [ -d "$DEST" ] && [ -n "$(ls -A "$DEST" 2>/dev/null || true)" ]; then
  BAK="$DEST.bak-$(date +%F)"
  if [ -e "$BAK" ]; then BAK="$BAK-$(date +%H%M%S)"; fi
  if [ "$DRY" = 1 ]; then
    say "[dry] would move existing non-git dir aside: $DEST -> $BAK"
  else
    mv "$DEST" "$BAK"
    say "moved existing non-git dir aside: $DEST -> $BAK (machine-local state like sessions/ and auth.json lives there — copy back if wanted)"
  fi
fi

# ---- clone ----------------------------------------------------------------

if [ "$MODE" = "clone" ]; then
  run mkdir -p "$(dirname "$DEST")"
  if [ "$DRY" = 1 ]; then
    say "[dry] would clone $REPO_URL -> $DEST"
  else
    git clone "$REPO_URL" "$DEST"
    say "cloned $REPO_URL -> $DEST"
  fi
fi

# ---- bootstrap ------------------------------------------------------------

BOOT="$DEST/scripts/pi-install.mjs"
[ -t 0 ] || BOOT_ARGS="$BOOT_ARGS --non-interactive"

if [ "$DRY" = 1 ]; then
  if [ -f "$BOOT" ]; then
    say "[dry] would run: node $BOOT --dry-run$BOOT_ARGS"
    say ""
    node "$BOOT" --dry-run $BOOT_ARGS
  else
    say "[dry] would run: node $BOOT$BOOT_ARGS"
    say ""
    say "pi-install.mjs would then (all idempotent):"
    say "  - preflight: node >= 22, npm, git"
    say "  - npm install + node_modules/.pi-lock-hash marker"
    say "  - write npm/.npmrc (allow-remote=all)"
    say "  - create settings.json / mcp.json from .dist templates if missing"
    say "  - prompt for MODEL_HOST, SEARXNG_HOST, optional MCP token and remoteControl (TTY only; skipped when non-interactive)"
    say "  - verify: pi -p smoke test (report-only)"
  fi
  say ""
  say "dry run complete — nothing changed."
  exit 0
fi

[ -f "$BOOT" ] || fail "clone present but $BOOT missing — broken checkout?"
exec node "$BOOT" $BOOT_ARGS
