#!/usr/bin/env bash
# setup-deps.sh -- Verify and install required dependencies for knowledge-engine

set -euo pipefail

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

ok()   { echo -e "  ${GREEN}[OK]${NC}   $1"; }
warn() { echo -e "  ${YELLOW}[WARN]${NC} $1"; }
fail() { echo -e "  ${RED}[MISS]${NC} $1"; }

echo ""
echo "=== Knowledge Engine: Dependency Check ==="
echo ""

MISSING=0

# ── yt-dlp ──────────────────────────────────────────────────────────────
if command -v yt-dlp &>/dev/null; then
  VERSION=$(yt-dlp --version 2>/dev/null || echo "unknown")
  ok "yt-dlp ($VERSION) at $(which yt-dlp)"
else
  fail "yt-dlp not found"
  echo "       Installing via Homebrew..."
  if brew install yt-dlp; then
    ok "yt-dlp installed"
  else
    fail "Could not install yt-dlp"
    MISSING=$((MISSING + 1))
  fi
fi

# ── ffmpeg ──────────────────────────────────────────────────────────────
if command -v ffmpeg &>/dev/null; then
  VERSION=$(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')
  ok "ffmpeg ($VERSION) at $(which ffmpeg)"
else
  fail "ffmpeg not found"
  echo "       Installing via Homebrew..."
  if brew install ffmpeg; then
    ok "ffmpeg installed"
  else
    fail "Could not install ffmpeg"
    MISSING=$((MISSING + 1))
  fi
fi

# ── whisper (openai-whisper) ────────────────────────────────────────────
if command -v whisper &>/dev/null; then
  ok "whisper at $(which whisper)"
else
  fail "whisper not found"
  echo "       Installing via pip (openai-whisper)..."
  if pip3 install openai-whisper 2>/dev/null || pip install openai-whisper 2>/dev/null; then
    ok "whisper installed"
  else
    warn "Could not install whisper automatically"
    echo "       Try: pip3 install openai-whisper"
    MISSING=$((MISSING + 1))
  fi
fi

# ── Node.js ─────────────────────────────────────────────────────────────
if command -v node &>/dev/null; then
  VERSION=$(node --version)
  ok "Node.js ($VERSION) at $(which node)"
else
  fail "Node.js not found"
  MISSING=$((MISSING + 1))
fi

# ── openclaw ────────────────────────────────────────────────────────────
if command -v openclaw &>/dev/null; then
  ok "openclaw at $(which openclaw)"
else
  warn "openclaw not found (needed for LLM analysis)"
  MISSING=$((MISSING + 1))
fi

echo ""
if [ "$MISSING" -eq 0 ]; then
  echo -e "${GREEN}All dependencies satisfied.${NC}"
else
  echo -e "${YELLOW}${MISSING} dependency(ies) need attention.${NC}"
fi
echo ""
