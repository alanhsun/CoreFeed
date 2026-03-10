# Project History & Context

This file serves as an AI-readable history and context reference for the News Aggregator project. It tracks architectural decisions, major features, and the evolution of the codebase to facilitate future maintenance and updates.

## 1. Project Overview
- **Name**: CoreFeed (聚核)
- **Current Version**: v1.3.0
- **Description**: A Node.js application that fetches news from multiple sources, processes them using AI (translation, summarization, deduplication), and generates audio/EPUB outputs.
- **Key Stack**: Node.js, Express, Socket.IO, OpenRouter AI, OpenAI-Edge-TTS, Tailwind CSS.

## 2. Documentation Index
*   `README.md`: User-facing documentation, features, and setup guide.
*   `CLAUDE.md`: AI assistant guidelines, commands, and architectural details.

## 3. Architecture Summary
*   **Entry Point**: `server.js` initializes Express app and Socket.IO.
*   **Service Layer**:
    *   `newsService.js`: Fetches data from NewsAPI, Gnews, RSS, and scrapers.
    *   `aiService.js`: Handles translation, summarization, and deduplication via MiniMax.
    *   `audioService.js`: Manages TTS generation.
    *   `stateManager.js`: Centralized state management (Pub/Sub).
    *   `webScrapingService.js`: Fallback for scraping content.
*   **Configuration**: Centralized in `config/index.js` and `.env`.

## 4. Change Log

### v1.3.0 (Current)
- **Third-party Integration**:
    - Added `/api/latest-data` endpoint for one-shot retrieval of news, summary, and podcast data.
    - Enabled CORS in `server.js` to allow cross-origin requests.
- **Data Persistence**:
    - Implemented `data/settings.json` to persist configuration changes across Docker restarts.
    - Updated `config/index.js` to prioritize settings file over environment variables.
- **News Processing**:
    - Enhanced regional classification using a hybrid approach (AI analysis + Rule-based fallback).
    - Integrated classification logic into the main news fetching pipeline.

### v1.2.0 (Previous)
- **Core Features**:
    - Multi-source fetching (NewsAPI, Gnews, RSS, Web Scraping).
    - AI-powered processing: Translation, Summarization, Deduplication.
    - Audio generation using custom OpenAI-Edge-TTS service.
    - EPUB generation and Email delivery (Kindle support).
    - Real-time updates via Socket.IO.
- **UI/UX**:
    - Glassmorphism design with Tailwind CSS.
    - Responsive layout for mobile/desktop.
    - Audio player and deep/light mode support.
- **Infrastructure**:
    - Docker & Docker Compose support.
    - PM2 process management.
    - Rate limiting and automated scheduling (Cron).

### Initial Setup
- Basic Express server setup.
- Integration with NewsAPI.
- Simple frontend with EJS.

## 5. Maintenance Notes
- **Environment Variables**: Critical configuration is in `.env`. Ensure `AI_API_KEY` and `NEWS_API_KEY` are valid.
- **Rate Limiting**: AI services have strict rate limits (`utils/rateLimiter.js`) to prevent API exhaustion.
- **State Management**: The application uses in-memory state (`stateManager.js`) which persists to JSON files in `data/` for recovery.
- **Scrapers**: Web scrapers (`services/scrapers/`) are fragile and may need updates if source HTML structures change.

## 6. Future Roadmap (Planned)
- [ ] Enhanced error handling for specific scraper failures.
- [ ] User authentication system.
- [ ] Database integration (MongoDB/PostgreSQL) to replace JSON file storage.
- [ ] More granular control over AI model selection per task.
