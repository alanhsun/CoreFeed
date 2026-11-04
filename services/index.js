const NewsService = require('./news_service');
const AIService = require('./ai_service');
const AudioService = require('./audio_service');
const FtpService = require('./ftp_service');
const StateManager = require('./state_manager');
const NewsAgentService = require('./news_agent_service');
const EpubEmailService = require('./epub_email_service');

module.exports = {
    NewsService,
    AIService,
    AudioService,
    FtpService,
    StateManager,
    NewsAgentService,
    EpubEmailService
};
