const NewsService = require('./news_service');
const AIService = require('./ai_service');
const AudioService = require('./audio_service');
const stateManager = require('./state_manager');
const WebScrapingService = require('./web_scraping_service');
const FtpService = require('./ftp_service');

module.exports = {
    NewsService,
    AIService,
    AudioService,
    stateManager,
    WebScrapingService,
    FtpService
};
