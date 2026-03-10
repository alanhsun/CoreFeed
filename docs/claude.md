# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**News Aggregator** - A Node.js application that fetches news from multiple sources (NewsAPI, Gnews, RSS), processes them using AI (translation, summarization, deduplication), and provides audio generation, EPUB export, and email delivery. Features a glassmorphism UI with Tailwind CSS and real-time updates via Socket.IO.

For detailed project history and architectural context, see [PROJECT_HISTORY.md](PROJECT_HISTORY.md).

- **Version**: v1.3.0
- **Entry Point**: `server.js:1`
- **Key Dependencies**: Express, Socket.IO, MiniMax AI, RSS-parser, PM2, cors

## Quick Start Commands

### Development
```bash
npm run dev          # Start with auto-reload (nodemon)
nodemon server.js    # Direct nodemon
```

### Production
```bash
npm start            # Production mode
npm run prod         # Explicit production mode

# PM2 (recommended for production)
npm run pm2:start
pm2 restart news-aggregator
pm2 logs news-aggregator
pm2 monit            # Monitor panel
```

### Docker
```bash
npm run compose:up   # Start with Docker Compose (recommended)
npm run compose:down
npm run compose:logs

# Manual Docker
npm run docker:build
npm run docker:run
```

### Health Check
```
curl http://localhost:3120/api/health
```

### Maintenance
```bash
npm run setup        # Install + copy .env.example
npm run clean        # Clean reinstall
npm run backup       # Create backup
```

### Testing & Debugging
```bash
# Test scripts (in project root)
# Note: Test scripts are currently under maintenance
# Use manual testing via API endpoints
```

## Architecture Overview

### System Components

```
server.js (Express + Socket.IO)
    │
    ├── Routes (/routes/api.js)
    │   ├── News endpoints (/api/news, /api/refresh)
    │   ├── AI features (/api/generate-summary, /api/generate-podcast)
    │   ├── Integration (/api/latest-data)
    │   └── System (/api/health, /api/status)
    │
    ├── Services Layer
    │   ├── newsService.js - News fetching from multiple sources
    │   ├── aiService.js - AI translation, summarization, deduplication
    │   ├── audioService.js - TTS audio generation
    │   ├── epubService.js - EPUB export
    │   ├── emailService.js - Email delivery
    │   ├── stateManager.js - Centralized state management
    │   └── webScrapingService.js - Web scraping fallback
    │
    └── Utilities
        ├── scheduleManager.js - Cron-based automated updates
        ├── rateLimiter.js - Token bucket rate limiting
        ├── logger.js - Logging utility
        └── helpers.js - Common utilities
```

### Key Design Patterns

1. **Service Layer Architecture** - Business logic separated into dedicated services
2. **State Management** - `stateManager.js:1` provides centralized pub/sub state
3. **Rate Limiting** - `utils/rateLimiter.js:24` uses token bucket for AI API calls
4. **Modular Configuration** - `config/index.js` loads env vars and persists dynamic settings to `data/settings.json`
5. **Unified API** - `/api/latest-data` provides aggregated news, summary, and podcast info for third-party clients

### Data Flow

```
News Sources (NewsAPI, Gnews, RSS, Web Scraping)
    ↓
newsService.js (fetches, deduplicates, caches)
    ↓
aiService.js (translation, summarization via MiniMax)
    ↓
Real-time updates via Socket.IO
    ↓
Cache: data/news.json + data/summary.json
    ↓
Display in UI or generate outputs (EPUB/Audio/Email)
```

## Configuration

### Critical: `.env` (copy from `.env.example:1`)

**Required API Keys:**
- `NEWS_API_KEY` - NewsAPI.org (news fetching)
- `AI_API_KEY` - MiniMax API (AI features)
- `TTS_BASE_URL` - Custom TTS service endpoint

**Rate Limiting** (prevents 429 errors):
```env
AI_RATE_LIMIT_RPM=10      # Requests per minute
AI_RATE_LIMIT_BURST=3     # Max burst requests
```

**Update Schedule:**
- `NEWS_UPDATE_INTERVAL` - Cron expression (default: `0 */2 * * *`)
- `UPDATE_TIMES` - Multiple times format: `08:00,12:00,18:00`

See `config/index.js:87-111` for parsing logic and `QUICKSTART_RATE_LIMIT.md` for detailed configuration.

## Core Services

### newsService.js
- **Purpose**: Fetch news from multiple sources, deduplicate, merge
- **Key Methods**:
  - `fetchAllNews()` - Main entry point for news fetching
  - `setSocketIO(io)` - Enable real-time progress updates
- **Sources**: NewsAPI, Gnews, RSS, Web Scraping
- **Cache**: `data/news.json`

### aiService.js
- **Purpose**: AI translation, summarization, deduplication via MiniMax
- **Key Methods**:
  - `translateText()` - Translation with rate limiting
  - `summarizeNews()` - Generate Chinese summaries
  - `deduplicateNews()` - AI-based deduplication
- **Rate Limiting**: Built-in token bucket (`utils/rateLimiter.js:24`)
- **Primary Model**: `MiniMax-M2.5` (cost-effective)

### audioService.js
- **Purpose**: TTS audio generation for podcasts
- **Backend**: Custom OpenAI-Edge-TTS service
- **Voices**: `TTS_HOST_VOICE`, `TTS_GUEST_VOICE` (Chinese voices)
- **Output**: `data/podcast/` directory
- **Merging**: Uses ffmpeg if available, falls back to concatenation

### stateManager.js
- **Purpose**: Centralized state management with pub/sub pattern
- **Stores**: `newsData`, `summaryArticle`, `isProcessing`, `podcastInfo`
- **Usage**: Services call `setStateManager()` to register

### scheduleManager.js
- **Purpose**: Cron-based automated news updates
- **Features**: Multiple update times, disabled source tracking
- **Integration**: Works with `newsService.js` for background updates

## API Endpoints

### News
- `GET /api/news` - Get first 30 news items
- `GET /api/news/more?offset=30` - Paginated loading
- `POST /api/refresh` - Manual news refresh

### AI Features
- `POST /api/generate-summary` - Generate AI summary article
- `POST /api/generate-podcast` - Generate audio dialogue

### File Generation
- `POST /api/generate-epub` - Generate EPUB ebook
- `POST /api/send-email` - Send summary to Kindle

### System
- `GET /api/health` - Basic health check
- `GET /api/health/detailed` - Detailed system status
- `GET /api/status` - Service status including TTS configuration
- `GET /api/latest-data` - **NEW** Aggregated data for third-party integration

## Environment-Specific Behavior

### Development
- `NODE_ENV=development` - Debug logging, cache disabled, hot reload

### Production
- `NODE_ENV=production` - JSON logs (PM2 compatible), cache enabled, config validation
- Fails fast on missing required API keys

See `config/index.js:347-388` for environment-specific configurations.

## Common Development Tasks

### Adding New News Source
1. Add source-specific fetcher in `newsService.js:19`
2. Update configuration parsing in `config/index.js:123-139`
3. Test with manual refresh: `POST /api/refresh`

### Adding New AI Feature
1. Implement in `aiService.js:9` with rate limiting via `rateLimiter.execute()`
2. Add API route in `routes/api.js:20`
3. Update rate limits in `.env` if needed

### Modifying Rate Limits
1. Update `.env`: `AI_RATE_LIMIT_RPM` and `AI_RATE_LIMIT_BURST`
2. Restart application
3. Monitor logs for rate limit statistics
4. See `QUICKSTART_RATE_LIMIT.md:153` for recommended values

## Troubleshooting

### Most Common Issues

1. **429 Rate Limit Errors** - Lower `AI_RATE_LIMIT_RPM` in `.env`
2. **News Not Loading** - Check `NEWS_API_KEY` and `config/news.newsApiEnabled`
3. **AI Features Failing** - Verify `AI_API_KEY`, check `/api/status`
4. **Audio Not Generating** - Verify `TTS_BASE_URL` reachable
5. **Updates Not Running** - Check `NEWS_UPDATE_INTERVAL` cron syntax

**For Rate Limiting Issues**: Always check `QUICKSTART_RATE_LIMIT.md:111-195`

## Important Files

- **Config**: `config/index.js:114`
- **Environment**: `.env` (copy from `.env.example:1`)
- **Main Server**: `server.js:1`
- **API Routes**: `routes/api.js:20`
- **State Management**: `services/stateManager.js:1`
- **Rate Limiter**: `utils/rateLimiter.js:1`
- **Scheduler**: `utils/scheduleManager.js:1`
- **Logs**: `logs/` directory (auto-created)

## Best Practices

1. **Configure rate limiting** before using AI features (see `QUICKSTART_RATE_LIMIT.md`)
2. **Use PM2** for production (process management, logs, auto-restart)
3. **Monitor logs** for rate limit statistics and 429 errors
4. **Verify APIs** with `/api/health` and `/api/status` endpoints
5. **Use Socket.IO** for real-time UI updates during long operations
6. **Cache results** in `data/` directory to reduce API calls

## Documentation Files

- **README.md** - Comprehensive project documentation (Chinese)
- **QUICKSTART_RATE_LIMIT.md** - Rate limiting configuration guide (critical)
- **.env.example** - Environment variables template
