#!/bin/sh
# Anvil installer for macOS / Linux.
#   curl -fsSL https://anvil.horvans.com/install.sh | sh
# Downloads one pinned version, verifies its SHA256, installs it globally with npm, and installs the Anvil skills
# for Claude Code (~/.claude/skills) and Codex (~/.codex/skills) when those tools are present.
# Testing overrides (optional):
#   ANVIL_BASE_URL    folder that holds anvil-<ver>.tgz and SHA256SUMS (default https://anvil.horvans.com/dl)
#   ANVIL_NPM_PREFIX  install into this npm prefix instead of the global one
#   ANVIL_HOME        use this folder instead of $HOME for .claude / .codex
set -eu

ANVIL_VERSION="0.2.0"
FILE="anvil-${ANVIL_VERSION}.tgz"
BASE="${ANVIL_BASE_URL:-https://anvil.horvans.com/dl}"
BASE="${BASE%/}"
HOME_DIR="${ANVIL_HOME:-$HOME}"

fail() { printf 'anvil install: %s\n' "$1" >&2; exit 1; }

echo "Installing Anvil ${ANVIL_VERSION}"

command -v node >/dev/null 2>&1 || fail "Node.js 20 or newer is required. Install it from https://nodejs.org and run this again."
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] 2>/dev/null || fail "Node.js 20 or newer is required (found $(node -v))."
command -v npm >/dev/null 2>&1 || fail "npm was not found. Reinstall Node.js with npm."

TMP=$(mktemp -d 2>/dev/null || mktemp -d -t anvil)
trap 'rm -rf "$TMP"' EXIT INT TERM

fetch() {
  if command -v curl >/dev/null 2>&1; then curl -fsSL "$1" -o "$2"
  elif command -v wget >/dev/null 2>&1; then wget -q "$1" -O "$2"
  else fail "curl or wget is required."; fi
}

echo "Downloading ${BASE}/${FILE}"
fetch "${BASE}/${FILE}" "$TMP/$FILE" || fail "download failed: ${BASE}/${FILE}"
fetch "${BASE}/SHA256SUMS" "$TMP/SHA256SUMS" || fail "download failed: ${BASE}/SHA256SUMS"

EXPECTED=$(awk -v f="$FILE" '{ n=$2; sub(/^\*/, "", n); if (n == f && length($1) == 64) { print tolower($1); exit } }' "$TMP/SHA256SUMS")
[ -n "$EXPECTED" ] || fail "SHA256SUMS has no entry for ${FILE}."
if command -v sha256sum >/dev/null 2>&1; then ACTUAL=$(sha256sum "$TMP/$FILE" | awk '{print tolower($1)}')
elif command -v shasum >/dev/null 2>&1; then ACTUAL=$(shasum -a 256 "$TMP/$FILE" | awk '{print tolower($1)}')
else ACTUAL=$(node -e 'const c=require("crypto"),f=require("fs");process.stdout.write(c.createHash("sha256").update(f.readFileSync(process.argv[1])).digest("hex"))' "$TMP/$FILE"); fi
[ "$ACTUAL" = "$EXPECTED" ] || fail "checksum mismatch for ${FILE} (expected ${EXPECTED}, got ${ACTUAL}). Nothing was installed."
echo "SHA256 verified: ${ACTUAL}"

if [ -n "${ANVIL_NPM_PREFIX:-}" ]; then
  npm install -g --no-fund --no-audit --prefix "$ANVIL_NPM_PREFIX" "$TMP/$FILE" || fail "npm install failed."
else
  npm install -g --no-fund --no-audit "$TMP/$FILE" || fail "npm install failed. If this is a permissions error, set an npm prefix you own (npm config set prefix ~/.npm-global) or use a Node version manager, then run this again."
fi

# Skills come from the same verified tarball (npm's own output can redact parts of paths, so we do not parse it).
mkdir -p "$TMP/x"
tar -xzf "$TMP/$FILE" -C "$TMP/x" package/skill || fail "could not unpack the skills from ${FILE}."
SKILL_SRC="$TMP/x/package/skill"
[ -d "$SKILL_SRC" ] || fail "skills missing from ${FILE}"
INSTALLED=""
for agent in .claude .codex; do
  [ -d "$HOME_DIR/$agent" ] || continue
  for s in anvil anvil-fix; do
    [ -d "$SKILL_SRC/$s" ] || continue
    mkdir -p "$HOME_DIR/$agent/skills/$s"
    cp -R "$SKILL_SRC/$s/." "$HOME_DIR/$agent/skills/$s/"
    INSTALLED="$INSTALLED
  skill: $HOME_DIR/$agent/skills/$s"
  done
done

echo ""
echo "Anvil ${ANVIL_VERSION} is installed."
if [ -n "$INSTALLED" ]; then printf '%s\n' "$INSTALLED" | sed '/^$/d'; else echo "  No ~/.claude or ~/.codex folder found, so no skills were copied."; fi
echo ""
echo "Connect your agent (run once):"
echo "  claude mcp add anvil -- anvil-mcp"
echo "  codex mcp add anvil -- anvil-mcp"
echo ""
echo "Then open your project and say \"check my app before launch\" (or \"start anvil\")."
echo "Without an agent:  anvil scan http://localhost:3000"
