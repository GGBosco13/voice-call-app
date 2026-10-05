# WhisperWeb — Anonymous Voice Consultation Platform

A secure, privacy-first web application enabling two-way voice consultations between anonymous callers and support staff. Built with WebRTC for real-time audio communication.

## 🛡️ Privacy First

- **No PII stored** — No IP addresses, names, phone numbers, or contact details
- **Ephemeral sessions** — Caller sessions auto-delete after call ends
- **No recordings** — Audio flows peer-to-peer; never touches the server
- **No transcripts** — Conversation content is not stored
- **Temporary IDs** — Random UUIDs generated on session start, destroyed on session end

## 🏗️ Project Structure

```
whisperweb/
├── package.json              # Root scripts (dev, install)
├── backend/
│   ├── .env                  # Backend configuration
│   ├── .env.example          # Configuration template
│   ├── package.json
│   └── src/
│       └── index.js          # Express + Socket.IO server
│           ├── Auth routes (login, admin)
│           ├── WebSocket signaling
│           ├── WebRTC relay (SDP + ICE)
│           └── Call routing & queue
├── frontend/
│   ├── .env                  # Frontend configuration
│   ├── index.html
│   ├── vite.config.js
│   └── src/
│       ├── main.jsx          # Entry point
│       ├── App.jsx           # Role-based routing
│       ├── index.css         # Global styles
│       ├── Router.jsx        # Auth provider wrapper
│       ├── components/
│       │   ├── CallerCallScreen.jsx    # Messenger-style caller UI
│       │   ├── StaffLogin.jsx          # Staff authentication
│       │   └── StaffDashboard.jsx      # Real-time staff dispatch panel
│       ├── hooks/
│       │   ├── useAuth.jsx     # Authentication context
│       │   └── useWebRTC.js    # WebRTC peer connection manager
│       └── utils/
│           └── socket.js       # Socket.IO client helpers
```

## 🚀 Quick Start

### Prerequisites

- **Node.js 18+**
- **Redis** (optional — app runs in-memory without it)
- **TURN Server** (required for production — see below)

### 1. Install Dependencies

```bash
npm run install:all
```

### 2. Configure

Edit `backend/.env` and `frontend/.env` as needed.

For production, add TURN server credentials:
```env
TURN_SERVERS=["turn:your-turn-server.com:3478?transport=tcp"]
TURN_USERNAME=your-username
TURN_PASSWORD=your-password
```

### 3. Start Development Servers

```bash
# From project root — starts both backend and frontend
npm run dev
```

Or start individually:
```bash
npm run dev:backend    # Backend on port 3001
npm run dev:frontend   # Frontend on port 5173
```

### 4. Access the App

- **Caller (Anonymous):** Open `http://localhost:5173` — no login required
- **Staff Dashboard:** Open `http://localhost:5173/?role=staff` — login required

## 👥 Default Credentials

### Super Admin (creates staff accounts)
- **Employee ID:** `whisper-admin`
- **Password:** `whisper-admin-2024`

> ⚠️ Change these credentials immediately in production.

### Creating Staff Accounts

Admin credentials are **hardcoded** in `.env`. After starting the server:

```bash
# 1. Login as admin to get token
curl -X POST http://localhost:3001/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"employeeId":"whisper-admin","password":"whisper-admin-2024"}'

# 2. Use the returned token to create a staff account
curl -X POST http://localhost:3001/api/admin/create-staff \
  -H "Content-Type: application/json" \
  -H "Authorization: <TOKEN_FROM_STEP_1>" \
  -d '{"employeeId":"staff001","name":"Jane Doe","password":"staff-pass-123"}'

# 3. Staff can then login with their credentials
```

The admin token is sent in the `Authorization` header (not `x-admin-token`).

## 🔧 API Endpoints

### Authentication
| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/login` | Staff login — returns JWT-like token |
| POST | `/api/admin/create-staff` | Create staff account (admin auth required) |
| GET | `/api/staff/status` | Check available staff count |

### WebRTC Signaling (WebSocket)

The app uses Socket.IO for WebRTC signaling:
- **SDP exchange** — Offers and answers are relayed through the server
- **ICE candidates** — Routed between caller and staff
- **TURN config** — Server provides STUN/TURN server list

## 🏃 How It Works

### Caller Flow
1. Visit the app → anonymous session created (random UUID)
2. Click "Start Call" → microphone permission requested
3. System finds available staff → ringing state
4. Call connects → WebRTC peer-to-peer audio
5. Call ends → all session data immediately deleted

### Staff Flow
1. Login with Employee ID + Password
2. Set status to "Available"
3. Incoming call notification appears
4. Accept → WebRTC audio connection established
5. Controls: mute, end call, duration timer

### Call Routing
- **Queue-based** — Calls are queued and matched to the least-busy available staff
- **Round-robin fallback** — When tied, first available is selected
- Staff can toggle between Available / Busy status

## 🔒 Security & Privacy Details

### No PII Architecture
```javascript
// Caller session: random UUID only
const callerId = crypto.randomUUID(); // No identity tied

// Session stored with TTL:
await redisSet(`caller:${callerId}`, { socketId }, 3600);

// On disconnect:
await redisDel(`caller:${callerId}`); // Immediate cleanup
```

### Audio Isolation
- Audio flows directly between browser clients via WebRTC
- Server only relays signaling data (SDP + ICE candidates)
- No audio recordings are made or stored
- No call transcripts are generated

### Staff Authentication
- Passwords hashed with bcrypt (cost factor 10)
- Session tokens stored in Redis with 24h TTL
- Admin accounts role-restricted

## 🌐 TURN Server Setup

WebRTC peer-to-peer connections may fail behind NAT/firewalls. For production:

### Option 1: Self-hosted Coturn
```bash
# Install coturn
brew install coturn  # macOS
apt install coturn   # Ubuntu

# Configure /etc/turnserver.conf
turnserver \
  --listening-port 3478 \
  --tls-listening-port 5349 \
  --realm whisperweb \
  --user your-username:your-password
```

### Option 2: Twilio Network Traversal
Sign up at [twilio.com](https://twilio.com) and use their TURN server URLs in `.env`.

## 📱 Browser Support

- Chrome 72+
- Firefox 66+
- Safari 12.1+
- Edge 79+

All browsers support the required WebRTC and MediaStream APIs.

## 🔮 Future Enhancements

- [ ] Text chat alongside voice
- [ ] Call summary notes (staff-only)
- [ ] Analytics dashboard (anonymous aggregates only)
- [ ] Multi-language support
- [ ] Mobile app (React Native)
- [ ] Video call option
- [ ] Integration with existing support ticketing systems

## 🚀 Deployment

### Docker (Recommended)

Requires [Docker](https://docker.com) and [Docker Compose](https://docs.docker.com/compose/).

```bash
# 1. Customize credentials
cp .env.example .env
nano .env  # Change SUPER_ADMIN_PASSWORD!

# 2. Deploy
./deploy.sh

# 3. Manage
docker compose logs -f    # View logs
docker compose down       # Stop all services
docker compose restart    # Restart
```

This starts 3 containers:
| Container | Port | Purpose |
|-----------|------|---------|
| `redis` | 6379 | Ephemeral session storage |
| `backend` | 3001 | Node.js API + Socket.IO |
| `frontend` | 80 | Nginx + React SPA |

The Nginx proxy routes `/api/*` and `/socket.io/*` to the backend automatically.

### Production Checklist

- [ ] Change `SUPER_ADMIN_PASSWORD` in `.env`
- [ ] Configure a TURN server for NAT traversal
- [ ] Serve over HTTPS (use nginx reverse proxy or cloud load balancer)
- [ ] Set Redis to a managed service (e.g., Redis Cloud)
- [ ] Restrict the staff portal with WAF/rate limiting
- [ ] Back up the `.env` file securely

### Cloud Deployment

**Railway / Render / Fly.io** — push to GitHub and connect your repo.
The app works out of the box with `docker-compose.yml`.

**Kubernetes** — generate manifests with:
```bash
kubectl create deployment whisperweb-backend --image=your-repo/backend --port=3001
kubectl create deployment whisperweb-frontend --image=your-repo/frontend --port=80
```

## 🌐 TURN Server Setup

WebRTC peer-to-peer connections may fail behind NAT/firewalls. For production:

### Option 1: Coturn (Self-hosted)
```bash
# macOS
brew install coturn

# Ubuntu/Debian
sudo apt install coturn
```

Configure `/etc/turnserver.conf`:
```ini
listening-port=3478
tls-listening-port=5349
realm=whisperweb
user=your-username:your-password
```

Then add to `.env`:
```env
TURN_SERVERS=["turn:your-server-ip:3478?transport=tcp"]
TURN_USERNAME=your-username
TURN_PASSWORD=your-password
```

### Option 2: Twilio Network Traversal Services
Sign up at [twilio.com](https://www.twilio.com/docs/stun-turn) and use their credentials in `.env`.
