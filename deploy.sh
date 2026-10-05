#!/usr/bin/env bash
# ============================================================
# WhisperWeb — One-Command Deployment Script
# ============================================================
set -euo pipefail

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
NC='\033[0m'

info()  { echo -e "${CYAN}[INFO]${NC}  $1"; }
ok()    { echo -e "${GREEN}[✓]${NC}   $1"; }
warn()  { echo -e "${YELLOW}[!]${NC}   $1"; }
fail()  { echo -e "${RED}[✗]${NC}   $1"; exit 1; }

# Check prerequisites
info "Checking prerequisites..."

command -v docker >/dev/null 2>&1 || fail "Docker is required. Install from https://docker.com"
command -v docker-compose >/dev/null 2>&1 || {
  # Check if docker compose plugin is available
  docker compose version >/dev/null 2>&1 || fail "Docker Compose is required."
}

# Check if .env exists
if [[ ! -f .env ]]; then
  warn ".env not found — copying from .env.example"
  cp backend/.env.example .env 2>/dev/null || true
  if [[ ! -f .env ]]; then
    # Generate default .env
    cat > .env << 'ENVEOF'
PORT=3001
NODE_ENV=production
SUPER_ADMIN_ID=whisper-admin
SUPER_ADMIN_PASSWORD=whisper-admin-2024
STUN_SERVERS=["stun:stun.l.google.com:19302","stun:stun1.l.google.com:19302"]
FRONTEND_URL=http://localhost:80
ENVEOF
    ok "Generated default .env — customize it!"
  fi
fi

# Check if .env has changed passwords
if grep -q "whisper-admin-2024" .env 2>/dev/null; then
  warn "Default admin password detected! Change SUPER_ADMIN_PASSWORD in .env"
fi

# Build and start
info "Building and starting WhisperWeb..."
if command -v docker compose >/dev/null 2>&1; then
  docker compose up --build -d
else
  docker-compose up --build -d
fi

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
ok "WhisperWeb is running!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "  📞 Caller (anonymous):  http://localhost"
echo "  👨‍💼 Staff portal:        http://localhost/?role=staff"
echo "  🔧 Backend API:          http://localhost:3001"
echo ""
echo "  Default admin:"
echo "    ID: whisper-admin"
echo "    PW: whisper-admin-2024  (CHANGE THIS!)"
echo ""
echo "  Manage: docker compose [up|down|logs|restart]"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
