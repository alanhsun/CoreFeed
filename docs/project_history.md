# Project History & Architecture Evolution

## v2.0.0 — Plan 2B Multi-Client GitHub Snapshot Hub & Swiss Editorial Bento UI (Current)
- **Plan 2B Multi-Client Coordination & Router Protection (`utils/github_sync.js`)**:
  - Uses Git plumbing (`hash-object`, `mktree`, `commit-tree`, `push --force`) to publish compiled Chinese snapshots to the single-commit orphan branch `ag-snapshot/latest.json` without touching the working tree.
  - Built-in 30-minute multi-client cooldown check (`checkRemoteSnapshotCooldown`), `ETag` (`304 Not Modified`) polling, and automatic self-healing against untranslated English RSS pollution on soft-router deployments.
- **37 Global & Chinese Authoritative Sources (`config/global_sources.js` v2.5)**:
  - High-concurrency patrol across 37 international and Chinese outlets with 3-tier fallback (Official RSS → Google News domain proxy `site:domain` → Jina Reader list extraction) and cross-source `relatedSources` event clustering.
- **Swiss Editorial & 12-Column Asymmetric Bento Grid (`views/index.ejs`, `public/css/style.css`, `public/js/main.js`)**:
  - Warm Editorial Paper (`#F6F5F1`) and Deep Obsidian Carbon (`#090A0C`) palette with International Vermilion (`#C83214`) accent, 12-column asymmetric Bento layout, clickable `[NEWS_k]` executive briefing citations, and direct links to original authoritative articles.

## v1.3.0 — Legacy Version
- Added `/api/latest-data` endpoint and CORS support.
- Introduced `data/settings.json` persistence and basic regional classification.
