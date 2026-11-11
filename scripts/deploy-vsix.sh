#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════════════
# Agent VS Code extension — build & deploy the .vsix to the VPS
# ═══════════════════════════════════════════════════════════════════════════════
# Builds the extension (webview + esbuild) → packages a .vsix → ships it to the
# directory the API serves from, then verifies the API will pick it up.
#
# The API (agent.api/api/services/vscode_app_service.py) serves the NEWEST .vsix
# found in $AG_VSCODE_VSIX_DIR (default /var/www/agent/vscode) and patches the
# tenant/env defaults at download time. One shared dir feeds prod/uat/sit, so a
# single deploy updates every environment's download.
#
# Usage:
#   scripts/deploy-vsix.sh                # build + deploy + verify
#   SKIP_BUILD=1 scripts/deploy-vsix.sh   # deploy the existing .vsix (no rebuild)
#   DRY_RUN=1   scripts/deploy-vsix.sh    # build only, do not touch the VPS
#
# Env overrides:
#   REMOTE          ssh target              (default: vps)
#   AG_VSCODE_VSIX_DIR  remote vsix dir     (default: /var/www/agent/vscode)
#   API_HEALTH_URL  route to sanity-check   (default: https://ai.storeglance.com/api/v1/channels/vscode/status)
# ═══════════════════════════════════════════════════════════════════════════════
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
EXT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

REMOTE="${REMOTE:-vps}"
REMOTE_DIR="${AG_VSCODE_VSIX_DIR:-/var/www/agent/vscode}"
# Agent.API sits behind the central gateway under /api/agent (see agent.web
# environment.prod.ts); the channel routes are reachable there.
API_HEALTH_URL="${API_HEALTH_URL:-https://ai.storeglance.com/api/v1/channels/vscode/status}"

cd "$EXT_DIR"

# ── 1. Build ────────────────────────────────────────────────────────────────
if [[ "${SKIP_BUILD:-0}" != "1" ]]; then
  echo "→ Installing dependencies (extension + webview)…"
  npm ci
  ( cd webview-ui && npm ci )

  echo "→ Building extension (webview + esbuild --production)…"
  npm run package

  echo "→ Packaging .vsix (vsce)…"
  # --no-dependencies: deps are bundled by esbuild, vsce must not re-resolve them.
  npx --yes @vscode/vsce package --no-dependencies
fi

# Newest .vsix in the extension root is our freshly built artifact.
VSIX_PATH="$(ls -t "$EXT_DIR"/*.vsix 2>/dev/null | head -n1 || true)"
if [[ -z "$VSIX_PATH" ]]; then
  echo "❌ No .vsix found in $EXT_DIR — build must have failed." >&2
  exit 1
fi
VSIX_NAME="$(basename "$VSIX_PATH")"
LOCAL_SHA="$(shasum -a 256 "$VSIX_PATH" | awk '{print $1}')"
echo "✓ Built $VSIX_NAME ($(du -h "$VSIX_PATH" | cut -f1), sha256 ${LOCAL_SHA:0:12}…)"

if [[ "${DRY_RUN:-0}" == "1" ]]; then
  echo "DRY_RUN=1 → skipping deploy."
  exit 0
fi

# ── 2. Deploy (backup existing, then upload) ─────────────────────────────────
echo "→ Deploying to $REMOTE:$REMOTE_DIR …"
TS="$(date +%s)"  # expanded locally so the remote gets a literal timestamp
ssh "$REMOTE" "mkdir -p '$REMOTE_DIR'; \
  if [ -f '$REMOTE_DIR/$VSIX_NAME' ]; then \
    cp -f '$REMOTE_DIR/$VSIX_NAME' '$REMOTE_DIR/$VSIX_NAME.bak.$TS'; \
  fi; \
  ls -t '$REMOTE_DIR'/*.vsix.bak.* 2>/dev/null | tail -n +6 | xargs -r rm -f"  # keep 5 backups

rsync -avz --no-perms --no-owner --no-group "$VSIX_PATH" "$REMOTE:$REMOTE_DIR/$VSIX_NAME"

# ── 3. Verify ────────────────────────────────────────────────────────────────
echo "→ Verifying deployment…"
REMOTE_SHA="$(ssh "$REMOTE" "sha256sum '$REMOTE_DIR/$VSIX_NAME' | awk '{print \$1}'")"
if [[ "$LOCAL_SHA" != "$REMOTE_SHA" ]]; then
  echo "❌ Checksum mismatch — upload corrupted." >&2
  echo "   local:  $LOCAL_SHA" >&2
  echo "   remote: $REMOTE_SHA" >&2
  exit 1
fi
echo "✓ Checksum matches on server (${REMOTE_SHA:0:12}…)"

# The API picks the NEWEST .vsix by mtime; confirm ours wins and is a valid zip.
NEWEST="$(ssh "$REMOTE" "ls -t '$REMOTE_DIR'/*.vsix 2>/dev/null | head -n1 | xargs -n1 basename")"
if [[ "$NEWEST" != "$VSIX_NAME" ]]; then
  echo "❌ Newest .vsix on server is '$NEWEST', not '$VSIX_NAME' — API would serve the wrong one." >&2
  exit 1
fi
ssh "$REMOTE" "unzip -tq '$REMOTE_DIR/$VSIX_NAME' >/dev/null" \
  && echo "✓ Server confirms '$VSIX_NAME' is newest and a valid archive."

# Route smoke-test: /status is admin-gated, so a 401/403 (not 404/000) proves the
# channel route is live and the API is up.
CODE="$(curl -s -o /dev/null -w '%{http_code}' "$API_HEALTH_URL" || echo 000)"
case "$CODE" in
  401|403) echo "✓ API route live ($API_HEALTH_URL → $CODE, auth-gated as expected).";;
  200)     echo "✓ API route live ($API_HEALTH_URL → 200).";;
  *)       echo "⚠ API route check returned $CODE — verify $API_HEALTH_URL manually.";;
esac

echo ""
echo "═══════════════════════════════════════"
echo "  ✅ VS Code extension deployed: $VSIX_NAME"
echo "  Download → GET /v1/channels/vscode/download (per-tenant defaults baked in)"
echo "═══════════════════════════════════════"
