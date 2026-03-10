
const BaseScraper = require('./base_scraper');
const cheerio = require('cheerio');

/**
 * Donga News Scraper
 * Scrapes news from https://www.donga.com/en
 */
class DongaNewsScraper extends BaseScraper {
    constructor(config = {}) {
        super({
            name: 'Donga News',
            baseUrl: 'https://www.donga.com/en',
            ...config
        });
    }

    getSelectors() {
        return {
            articleLinks: [
                '.main_headline .title a',
                '.main_bot .title a',
                '.headline_news li a'
            ],
            title: [
                '#view_title h1',
                '.article_title',
                'h1'
            ],
            content: [
                '#article_text',
                '.article_txt',
                '.news_view'
            ],
            publishedAt: [
                '.date',
                '#view_title .date'
            ],
            image: [
                '#article_text img',
                '.photo_center img'
            ]
        };
    }

    isValidArticleUrl(url) {
        return url.includes('donga.com/en/article/all/');
    }
}

module.exports = DongaNewsScraper;
