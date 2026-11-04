# CLAUDE.md / AI Guide (CoreFeed v2.0)

## Project Overview

**聚核 CoreFeed v2.0** — A Multi-Agent Global News Aggregator & Intelligence Engine built on Node.js, Express, and Socket.IO.
It coordinates 4 specialized AI Agents (`Scout Agent`, `Curator Agent`, `Deep-Reader & Compiler Agent`, `Chief Editor & Investigator Agent`) to harvest, cross-verify, deep-read (via Jina Reader `r.jina.ai` + Cheerio Readability), compile, and distribute global news from 30+ world-renowned outlets (Reuters, AP, BBC, NYT, Bloomberg, WSJ, FT, SCMP, CNA, NHK, etc.).

- **Version**: v2.0.0
- **Entry Point**: `server.js`

## Quick Start Commands

```bash
# Start server (Node.js)
npm start

# Start server (Deno Node-compatibility mode)
deno run -A server.js

# Windows startup script (auto-detects Node or Deno)
.\scripts\start.bat

# Docker Compose
npm run compose:up
```

## Architecture Overview

```text
server.js (Express + Socket.IO)
 ├── config/
 │    ├── index.js                 # Dynamic configuration (.env + data/settings.json)
 │    └── global_sources.js        # 30+ Global Renowned News Source Matrix & Authority Weights
 ├── services/
 │    ├── news_agent_service.js    # Multi-Agent Coordinator (Patrol / Topic Research / Deep-Read)
 │    ├── agent_tools.js           # Agent Tools (RSS / Google News Site Proxy / Jina Reader / Global Search)
 │    ├── ai_service.js            # LLM Inference, Structured Batch Compiler, Event Clustering & Tool-Use Loop
 │    ├── news_service.js          # Base News Fetcher & Local Cache Persistence
 │    ├── epub_email_service.js    # EPUB 3 Ebook Generator & Kindle SMTP Delivery
 │    ├── audio_service.js         # OpenAI-Edge-TTS Dual-Host Podcast Synthesizer
 │    ├── ftp_service.js           # Automatic FTP Audio Uploader
 │    └── state_manager.js         # Centralized Pub/Sub State Manager
 ├── routes/
 │    └── api.js                   # RESTful API Routes (/api/agent/*, /api/sources/matrix, /api/latest-data, etc.)
 ├── utils/
 │    ├── schedule_manager.js      # Cron Scheduler for Automated Daily Agent Patrols
 │    ├── rate_limiter.js          # Token Bucket Rate Limiter for LLM APIs
 │    ├── network_config.js        # Global HTTP Keep-Alive & Retry Setup
 │    ├── logger.js                # Structured Color Logger & Metrics
 │    └── helpers.js               # File I/O, String Cleaning & SimpleCache
 └── views/index.ejs + public/     # Responsive Glassmorphism Intelligence Dashboard
```
