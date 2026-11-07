# Project History & Architecture Evolution

## v2.0.0 — Dual-Mode Global News Intelligence Engine & Antigravity Automation (Current)
- **Antigravity Path A Pipeline & 3x/Day Automated Updates**:
  - Added external publishing endpoint `POST /api/agent/publish` (`routes/api.js`) with optional `PUBLISH_SECRET` authentication (`Authorization: Bearer` / `X-Publish-Secret`), payload validation, atomic persistence to `data/{news,summary,state}.json`, and instant Socket.IO broadcast (`agent-stage-update`, `news-updated`, `summary-updated`, `agent-patrol-completed`).
  - Built CLI pipeline tools: `scripts/ag-harvest.js` (`npm run ag:harvest`), `scripts/ag-publish.js` (`npm run ag:publish`), and `scripts/ag-auto-update.js` (`npm run ag:auto`), plus the 7-test E2E suite in `tests/ag_pipeline.test.js` (`npm test`).
  - Configured 3x/day automated updates at `08:00, 12:30, 19:30` Beijing Time (`Asia/Shanghai`) in `utils/schedule_manager.js` and `config/index.js`, with a 10-minute freshness guard to prevent duplicate patrols.
- **Two-Stage Progressive Agent Architecture (`services/news_agent_service.js`)**:
  - Replaced legacy passive scrapers with a progressive workflow:
    1. **Scout Agent**: High-concurrency patrol across 30 global authoritative sources (`config/global_sources.js` v2.2) with automatic 3-tier fallback (Official RSS → Google News domain proxy `site:domain` → Jina Reader markdown scraping).
    2. **Curator Agent**: Cross-source event clustering that merges duplicate coverage across outlets into `relatedSources` cross-verification badges and ranks events by source authority, freshness, and multi-outlet heat.
    3. **Deep-Reader & Compiler Agent**: Uses Jina Reader (`r.jina.ai`) and local Cheerio Readability (`services/agent_tools.js`) to extract full article text and lead images, followed by structured JSON batch compilation (`services/ai_service.js`) and keyless fast Chinese translation fallback.
    4. **Chief Editor & Deep-Read Agent**: Generates structured Global Executive Briefings (`summaryArticle`) with clickable `[NEWS_k]` source citations and single-article full-text deep-reads (`POST /api/agent/deep-read`).
- **Codebase Cleanup & Modernization**:
  - Removed fragile site-specific scrapers and legacy audio/EPUB modules to focus on a streamlined, fast Kami (紙) editorial web reader (`views/index.ejs`, `public/js/main.js`, `public/css/style.css`).

## v1.3.0 — Legacy Version
- Added `/api/latest-data` endpoint and CORS support.
- Introduced `data/settings.json` persistence and basic regional classification.
