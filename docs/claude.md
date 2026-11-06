# CLAUDE.md / AI Guide (CoreFeed v2.0)

## Project Overview

**聚核 CoreFeed v2.0** — A Global News Collector, Cross-Source Verifier & Reader built on Node.js, Express, and Socket.IO.
It uses a **Two-Stage Progressive Pipeline** (`Scout` -> `Curator` -> `Deep-Reader & Compiler` -> `Chief Editor`) to harvest, cross-verify, immediately display, deep-read (via Jina Reader `r.jina.ai` + Cheerio Readability), and progressively compile global news from 29+ world-renowned outlets (Reuters, AP, BBC, NYT, Bloomberg, WSJ, FT, SCMP, CNA, NHK, etc.).

- **Version**: v2.0.0
- **Entry Point**: `server.js`

## Quick Start Commands

```bash
# Start server (Node.js)
npm start

# Run syntax & module load check
npm test
```

## Architecture Overview

```text
server.js (Express + Socket.IO)
 ├── config/
 │    ├── index.js                 # Dynamic configuration (.env + data/settings.json)
 │    └── global_sources.js        # 29+ Global Renowned News Source Matrix & Authority Weights
 ├── services/
 │    ├── news_agent_service.js    # Two-Stage Progressive Coordinator (Patrol & Single-Article Deep-Read)
 │    ├── agent_tools.js           # Collection & Extraction Tools (RSS / Google News Proxy / Jina / Cheerio)
 │    ├── ai_service.js            # Event Clustering, Rule Pre-classification, Batch Compiler & Daily Summary
 │    ├── news_service.js          # Base News Fetcher & Local Cache Persistence
 │    └── state_manager.js         # Centralized Pub/Sub State Manager
 ├── routes/
 │    └── api.js                   # RESTful API Routes (/api/agent/*, /api/sources/matrix, /api/news, /api/summary, etc.)
 ├── utils/
 │    ├── schedule_manager.js      # Cron Scheduler for Automated Daily News Collection
 │    ├── rate_limiter.js          # Token Bucket Rate Limiter for LLM APIs
 │    ├── network_config.js        # Global HTTP Keep-Alive & Retry Setup
 │    ├── logger.js                # Structured Color Logger & Metrics
 │    └── helpers.js               # File I/O, String Cleaning & SimpleCache
 └── views/index.ejs + public/     # Kami (紙) Editorial News Reader UI
```
