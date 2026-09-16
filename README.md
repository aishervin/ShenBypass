# SHΞN™Bypass

> تحلیل آزاد. اتصال بدون مرز.

A rebranded Cloudflare Workers deployment wizard with a **collaborative node pool** — every user's worker joins the pool, and every user's subscription includes all active nodes.

## Features

- 🔐 **User registration & login** (username/password, hashed with SHA-256 + salt)
- 🚀 **One-click deploy** — user provides their Cloudflare API token, wizard deploys a VLESS proxy worker onto their account
- 🌐 **Collaborative pool** — every deployed worker registers with the pool and sends heartbeats
- 📦 **Auto subscription** — each user gets a subscription link containing all active pool nodes
- 📡 **Multi-protocol** — VLESS over WebSocket, gRPC, and XHTTP
- 🎨 **Fully rebranded** — SHΞN™Bypass UI, dark theme, cyan/purple accents

## Architecture

```
Wizard Worker (shenbypass.workers.dev)
├── Landing page + login/register
├── Deploy panel onto user's CF account
├── Node pool (KV-backed)
├── Heartbeat receiver
└── Subscription generator (all pool nodes)

Panel Workers (on each user's account)
├── VLESS over WebSocket
├── VLESS over gRPC
├── VLESS over XHTTP
└── Heartbeat → Wizard
```

## Deploy

```bash
npm install
npm run deploy
```

## Tech

- Cloudflare Workers (ES Modules)
- Workers KV (pool state, user data, sessions)
- No Durable Objects — works on Free plan
- Pure vanilla JS frontend (no framework)
# Update
