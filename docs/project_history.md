# Project History & Architecture Evolution

## v2.0.0 — Multi-Agent Global News Intelligence Engine (Current)
- **Multi-Agent Architecture (`services/news_agent_service.js`)**:
  - Replaced legacy passive scrapers with a 4-stage collaborative Agent workflow:
    1. **Scout Agent**: High-concurrency patrol across 30+ global authoritative sources (`config/global_sources.js`) with automatic 3-tier fallback (Official RSS → Google News domain proxy `site:domain` to bypass Cloudflare → Jina Reader markdown scraping).
    2. **Curator Agent**: Cross-source event clustering that merges duplicate coverage across outlets into `relatedSources` cross-verification badges and ranks events by source authority, freshness, and multi-outlet heat.
    3. **Deep-Reader & Compiler Agent**: Uses Jina Reader (`r.jina.ai`) and local Cheerio Readability (`services/agent_tools.js`) to extract full article text for top breaking stories, followed by single-pass structured JSON batch compilation (`services/ai_service.js`), reducing LLM API requests by ~85%.
    4. **Chief Editor & Investigator Agent**: Generates structured Global Executive Briefings (`summaryArticle`), dual-host podcast scripts, on-demand Topic Research reports (`POST /api/agent/research`), and single-article full-text deep-reads (`POST /api/agent/deep-read`).
- **Codebase Cleanup & Modernization**:
  - Removed fragile site-specific Cheerio scrapers (`services/scrapers/*`, `services/web_scraping_service.js`, `public/js/settings_manager.js`).
  - Extracted EPUB generation and Kindle SMTP delivery into `services/epub_email_service.js`.
  - Rebuilt Web UI (`views/index.ejs`, `public/js/main.js`, `public/css/style.css`) with live Agent pipeline telemetry, on-demand topic investigation, and visual Source Matrix management.

## v1.3.0 — Legacy Version
- Added `/api/latest-data` endpoint and CORS support.
- Introduced `data/settings.json` persistence and basic regional classification.
