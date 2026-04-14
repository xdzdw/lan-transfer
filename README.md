# Quick Transfer

**Transfer files and text between devices instantly — no app install required.**

Open [t.sum.pub](https://t.sum.pub) on both devices, enter the 4-digit code, and start transferring. That's it.

![Quick Transfer Screenshot](https://d2xsxph8kpxj0f.cloudfront.net/310519663270995274/CzjekiD5eeTZHjCPKJbady/quick-transfer-screenshot_9f749c5f.png)

## Features

- **Instant pairing** — 4-digit code connects two devices in seconds
- **WebRTC P2P** — Direct peer-to-peer transfer on the same network for maximum speed
- **WebSocket relay fallback** — Automatic fallback when P2P is unavailable (cross-network, firewalls)
- **Zero storage** — Files stream through server memory only; nothing is written to disk or database
- **Ephemeral sessions** — Rooms are destroyed on disconnect, auto-purged after 30 minutes
- **Bilingual UI** — English and Simplified Chinese with auto-detection
- **Mobile-first** — Responsive design, works on any modern browser
- **No account required** — No login, no registration, just open and transfer

## How It Works

1. Open **t.sum.pub** on your PC — a 4-digit code appears
2. Open **t.sum.pub** on your phone (or another PC) — enter the code
3. Send files and text in both directions

The connection first establishes via WebSocket for signaling. When both devices are on the same network, WebRTC upgrades the connection to P2P for direct, faster transfers. If P2P fails (different networks, strict firewalls), data flows through the WebSocket relay — all in-memory, never persisted.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 19, Tailwind CSS 4, Framer Motion |
| Backend | Express 4, tRPC 11, WebSocket (ws) |
| Transport | WebRTC DataChannel (P2P) + WebSocket (relay) |
| Build | Vite 6, TypeScript 5, ESBuild |
| Testing | Vitest (42 tests) |
| Database | MySQL / TiDB (session metadata only) |

## Architecture

```
┌─────────────┐     WebSocket (signaling)     ┌─────────────┐
│   Device A  │◄──────────────────────────────►│   Server    │
│  (Host/PC)  │                                │  (Express)  │
│             │◄──────────────────────────────►│             │
└──────┬──────┘     WebSocket (relay fallback) └──────┬──────┘
       │                                              │
       │         WebRTC DataChannel (P2P)             │
       │◄────────────────────────────────────►┌───────┴──────┐
       │            (same network)            │   Device B   │
       └──────────────────────────────────────│  (Client)    │
                                              └──────────────┘
```

**Signaling flow:**
1. Host registers a room with a random 4-digit token via WebSocket
2. Client joins the room by sending the token
3. Server relays WebRTC SDP offers/answers and ICE candidates between peers
4. If WebRTC DataChannel opens successfully → P2P mode (server only relays signaling)
5. If WebRTC fails within 6 seconds → falls back to WebSocket relay (data through server memory)

## Project Structure

```
client/src/
├── pages/Home.tsx          # Main page with host/client modes
├── components/
│   ├── TransferPanel.tsx   # File & text transfer UI
│   ├── TransferItemRow.tsx # Individual transfer item display
│   └── LangSwitch.tsx      # Language toggle
├── hooks/
│   ├── usePeerHost.ts      # Host-side connection logic
│   ├── usePeerClient.ts    # Client-side connection logic
│   └── useMobile.tsx       # Mobile detection
├── lib/
│   ├── webrtc.ts           # WebRTC P2P transport layer
│   └── format.ts           # File size formatting
└── contexts/
    └── I18nContext.tsx      # Internationalization

server/
├── signaling.ts            # WebSocket relay + WebRTC signaling server
├── routers.ts              # tRPC API routes
└── db.ts                   # Database helpers
```

## Development

```bash
# Install dependencies
pnpm install

# Start dev server
pnpm dev

# Run tests
pnpm test

# Build for production
pnpm build
```

## Environment Variables

The app requires the following environment variables (provided automatically on the Manus platform):

| Variable | Description |
|----------|-------------|
| `DATABASE_URL` | MySQL/TiDB connection string |
| `JWT_SECRET` | Session cookie signing secret |
| `VITE_APP_ID` | OAuth application ID |
| `OAUTH_SERVER_URL` | OAuth backend base URL |

## Privacy & Security

- **No files stored** — Data streams through server memory only, zero disk writes
- **No analytics on content** — Transfer content is never logged or analyzed
- **Ephemeral sessions** — Rooms destroyed on disconnect, auto-purge after 30 min
- **P2P when possible** — Same-network transfers bypass the server entirely via WebRTC
- **Protocol** — WSS (encrypted WebSocket) + WebRTC with DTLS encryption

## License

[MIT](LICENSE)
