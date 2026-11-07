# CLAUDE.md / AI Guide (CoreFeed v2.0)

## Project Overview

**聚核 CoreFeed v2.0** — A Global News Collector, Cross-Source Verifier & Reader built on Node.js, Express, and Socket.IO.
It supports **Dual-Mode Operation**:
1. **Built-in Two-Stage Progressive Pipeline** (`Scout` -> `Curator` -> `Deep-Reader & Compiler` -> `Chief Editor`) with automated 3x/day Beijing Time scheduling (`08:00, 12:30, 19:30` `Asia/Shanghai`).
2. **Antigravity Client Path A Pipeline** (`scripts/ag-harvest.js`, `scripts/ag-publish.js`, `scripts/ag-auto-update.js`, and `POST /api/agent/publish`) for external agent harvesting, Chinese compilation, Union-Find cross-source deduplication, and atomic live publishing across 30 world-renowned outlets (Reuters, AP, BBC, NYT, Bloomberg, WSJ, FT, SCMP, CNA, NHK, etc.).

- **Version**: v2.0.0
- **Entry Point**: `server.js` (Default port `3120`)

## Quick Start Commands

```bash
# Start server (Node.js, port 3120)
npm start

# Run 4-stage automated harvest -> compile -> publish -> verify pipeline
npm run ag:auto

# Run Path A step-by-step CLI tools
npm run ag:harvest
npm run ag:publish

# Run 7-test E2E automated test suite (non-destructive backup/restore of data/)
npm test
```

## Architecture Overview

```text
server.js (Express + Socket.IO)
 ├── config/
 │    ├── index.js                 # Dynamic configuration (.env + data/settings.json)
 │    └── global_sources.js        # 30 Global Renowned News Source Matrix & Authority Weights (v2.2)
 ├── services/
 │    ├── news_agent_service.js    # Two-Stage Progressive Coordinator (Patrol & Single-Article Deep-Read)
 │    ├── agent_tools.js           # Collection & Extraction Tools (RSS / Google News Proxy / Jina / Cheerio)
 │    ├── ai_service.js            # Event Clustering, Rule Pre-classification, Batch Compiler & Keyless Fallback
 │    ├── news_service.js          # Base News Fetcher & Local Cache Persistence
 │    └── state_manager.js         # Centralized Pub/Sub State Manager
 ├── scripts/
 │    ├── ag-harvest.js            # CLI Harvester -> data/ag_candidates.json
 │    ├── ag-publish.js            # CLI Publisher -> POST /api/agent/publish
 │    └── ag-auto-update.js        # 4-Stage Automated Pipeline Orchestrator
 ├── routes/
 │    └── api.js                   # RESTful API Routes (/api/agent/publish, /api/schedule/*, /api/news, etc.)
 ├── utils/
 │    ├── schedule_manager.js      # Cron Scheduler (08:00, 12:30, 19:30 Asia/Shanghai + 10m freshness guard)
 │    ├── rate_limiter.js          # Token Bucket Rate Limiter for LLM APIs
 │    ├── network_config.js        # Global HTTP Keep-Alive & Retry Setup
 │    ├── logger.js                # Structured Color Logger & Metrics
 │    └── helpers.js               # File I/O, String Cleaning & SimpleCache
 ├── views/index.ejs + public/     # Kami (紙) Editorial News Reader UI
 └── tests/ag_pipeline.test.js     # E2E Test Suite (7 tests)
```
