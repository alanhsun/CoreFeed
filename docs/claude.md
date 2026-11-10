# CLAUDE.md / AI Guide (CoreFeed v2.0)

## Project Overview

**聚核 CoreFeed v2.0** — A Global News Collector, Cross-Source Verifier & Editorial Reader built on Node.js, Express, and Socket.IO.
It supports **Dual-Mode Operation**:
1. **Plan 2B Multi-Client GitHub Snapshot Hub (`ag-snapshot/latest.json`)**: Antigravity clients harvest 37 authoritative global & Chinese news outlets, compile Chinese headlines/summaries/keypoints and the daily Executive Briefing (`summaryArticle`), and publish to the `ag-snapshot` orphan branch via Git plumbing 20 minutes ahead of schedule at `07:40, 12:10, 19:10` (`Asia/Shanghai`, `23:40, 04:10, 11:10` UTC; `AG_UPDATE_TIMES`). Soft-router / web instances (`GITHUB_SYNC_ENABLED=true`) automatically pull and apply the ready snapshot at startup, at `08:00, 12:30, 19:30` (`Asia/Shanghai`, `UPDATE_TIMES`), and every 60 minutes via ETag (`304 Not Modified`) polling.
2. **Standalone Two-Stage Progressive Pipeline** (`Scout` -> `Curator` -> `Compiler` -> `Chief Editor`) when `GITHUB_SYNC_ENABLED=false`.

- **Version**: v2.0.0
- **Entry Point**: `server.js` (Default port `3120`)

## Quick Start Commands

```bash
# Start server (Node.js, port 3120)
npm start

# Run 4-stage automated cooldown check -> harvest -> compile -> publish -> verify pipeline
npm run ag:auto

# Start resident background scheduled daemon (07:40, 12:10, 19:10 Asia/Shanghai, 20m pre-fetch) & check status
npm run ag:daemon
npm run ag:status

# Run step-by-step CLI tools
npm run ag:harvest
npm run ag:publish

# Run 19-test E2E automated test suite (non-destructive backup/restore of data/)
npm test
```

## Architecture Overview

```text
server.js (Express + Socket.IO)
 ├── config/
 │    ├── index.js                 # Dynamic configuration (.env + data/settings.json)
 │    └── global_sources.js        # 37 Global & Chinese Authoritative News Sources (v2.5)
 ├── services/
 │    ├── news_agent_service.js    # Two-Stage Progressive Coordinator (Patrol & Image Enrichment)
 │    ├── agent_tools.js           # Collection & Lead Image Tools (RSS / Google News Proxy / Jina / og:image)
 │    ├── ai_service.js            # Event Clustering, Rule Classification, Batch Compiler & Keyless Fallback
 │    ├── news_service.js          # Article Filtering, Cleaning & Local JSON Persistence
 │    └── state_manager.js         # Centralized Pub/Sub State Manager
 ├── scripts/
 │    ├── ag-harvest.js            # CLI Harvester -> data/ag_candidates.json
 │    ├── ag-publish.js            # CLI Publisher -> GitHub ag-snapshot/latest.json & POST /api/agent/publish
 │    └── ag-auto-update.js        # 4-Stage Automated Pipeline & Daemon (07:40, 12:10, 19:10 Asia/Shanghai) with 30m Cooldown Guard
 ├── routes/
 │    └── api.js                   # Core RESTful API Routes
 ├── utils/
 │    ├── github_sync.js           # Git Plumbing Snapshot Publisher, Cooldown Check & ETag Puller
 │    ├── schedule_manager.js      # Server/Router Snapshot Pull Scheduler (08:00, 12:30, 19:30 Asia/Shanghai + 60m Polling)
 │    ├── rate_limiter.js          # Token Bucket Rate Limiter for LLM APIs
 │    ├── network_config.js        # Global HTTP Keep-Alive Setup
 │    ├── logger.js                # Structured Color Logger & Metrics
 │    └── helpers.js               # File I/O, String Cleaning & SimpleCache
 ├── views/index.ejs + public/     # Swiss Editorial Masthead & 12-Column Asymmetric Bento Grid UI
 └── tests/                        # E2E Test Suites (ag_pipeline.test.js + deploy_router.test.js)
```
