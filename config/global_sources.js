const fs = require('fs');
const path = require('path');

/**
 * 全球知名信源矩阵 (Global Authoritative News Source Matrix)
 * 预置全球顶级通讯社、欧美主流大报、亚太权威媒体及科技财经信源。
 * 支持多种采集策略自动降级：
 * 1. rss: 官方RSS/Atom订阅源（最快速稳定）
 * 2. gnews_proxy: Google News 站点定向RSS检索（突破Cloudflare/SPA反爬，如Reuters/AP/Nikkei）
 * 3. jina_scrape: Jina Reader (r.jina.ai) 智能网页Markdown抽取 + 本地Cheerio回退
 */
const DEFAULT_GLOBAL_SOURCES = [
    // ==================== 1. 全球顶级通讯社与综合门户 (Wire & Global) ====================
    {
        id: 'reuters-world',
        name: 'Reuters (路透社)',
        category: 'wire',
        region: '国际',
        authority: 99,
        enabled: true,
        maxArticles: 8,
        strategy: 'gnews_proxy',
        domain: 'reuters.com',
        url: 'https://www.reuters.com/world/',
        rssUrl: 'https://news.google.com/rss/search?q=site:reuters.com+when:1d&hl=en-US&gl=US&ceid=US:en',
        description: '全球最大国际通讯社之一，以快速、客观的全球政经与突发报道著称'
    },
    {
        id: 'ap-news',
        name: 'AP News (美联社)',
        category: 'wire',
        region: '国际',
        authority: 98,
        enabled: true,
        maxArticles: 8,
        strategy: 'gnews_proxy',
        domain: 'apnews.com',
        url: 'https://apnews.com/hub/world-news',
        rssUrl: 'https://news.google.com/rss/search?q=site:apnews.com+when:1d&hl=en-US&gl=US&ceid=US:en',
        description: '美国联合通讯社，全球最具影响力的中立事实核查与突发新闻源之一'
    },
    {
        id: 'bbc-world',
        name: 'BBC World (英国广播公司)',
        category: 'wire',
        region: '国际',
        authority: 97,
        enabled: true,
        maxArticles: 8,
        strategy: 'rss',
        domain: 'bbc.co.uk',
        url: 'https://www.bbc.com/news/world',
        rssUrl: 'https://feeds.bbci.co.uk/news/world/rss.xml',
        description: 'BBC全球新闻频道，覆盖全球地缘政治、外交与社会重大事件'
    },
    {
        id: 'al-jazeera',
        name: 'Al Jazeera (半岛电视台)',
        category: 'wire',
        region: '中东',
        authority: 91,
        enabled: true,
        maxArticles: 6,
        strategy: 'rss',
        domain: 'aljazeera.com',
        url: 'https://www.aljazeera.com/news/',
        rssUrl: 'https://www.aljazeera.com/xml/rss/all.xml',
        description: '中东及全球南方视角最具代表性的国际新闻机构'
    },
    {
        id: 'france-24',
        name: 'FRANCE 24 (法国24台)',
        category: 'wire',
        region: '欧洲',
        authority: 90,
        enabled: true,
        maxArticles: 5,
        strategy: 'rss',
        domain: 'france24.com',
        url: 'https://www.france24.com/en/',
        rssUrl: 'https://www.france24.com/en/rss',
        description: '法国国际新闻频道，提供欧洲、非洲及中东深度报道'
    },
    {
        id: 'dw-world',
        name: 'DW (德国之声)',
        category: 'wire',
        region: '欧洲',
        authority: 90,
        enabled: true,
        maxArticles: 5,
        strategy: 'rss',
        domain: 'dw.com',
        url: 'https://www.dw.com/en/top-stories/s-9097',
        rssUrl: 'https://rss.dw.com/rdf/rss-en-world',
        description: '德国公共国际广播机构，聚焦欧洲与全球事务'
    },

    // ==================== 2. 欧美权威大报与政经媒体 (US & Europe) ====================
    {
        id: 'nyt-world',
        name: 'The New York Times (纽约时报)',
        category: 'western',
        region: '美国',
        authority: 97,
        enabled: true,
        maxArticles: 7,
        strategy: 'rss',
        domain: 'nytimes.com',
        url: 'https://www.nytimes.com/section/world',
        rssUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
        description: '美国最具影响力的严肃大报，深度调查与全球局势分析'
    },
    {
        id: 'bloomberg-politics',
        name: 'Bloomberg (彭博社)',
        category: 'finance',
        region: '国际',
        authority: 96,
        enabled: true,
        maxArticles: 7,
        strategy: 'rss',
        domain: 'bloomberg.com',
        url: 'https://www.bloomberg.com',
        rssUrl: 'https://feeds.bloomberg.com/politics/news.rss',
        description: '全球金融市场、宏观经济与地缘政治权威信息源'
    },
    {
        id: 'wsj-world',
        name: 'Wall Street Journal (华尔街日报)',
        category: 'finance',
        region: '美国',
        authority: 96,
        enabled: true,
        maxArticles: 6,
        strategy: 'rss',
        domain: 'wsj.com',
        url: 'https://www.wsj.com/news/world',
        rssUrl: 'https://feeds.a.dj.com/rss/RSSWorldNews.xml',
        description: '聚焦美国及全球商业、金融与政策走向的核心报刊'
    },
    {
        id: 'the-guardian',
        name: 'The Guardian (英国卫报)',
        category: 'western',
        region: '欧洲',
        authority: 93,
        enabled: true,
        maxArticles: 6,
        strategy: 'rss',
        domain: 'theguardian.com',
        url: 'https://www.theguardian.com/world',
        rssUrl: 'https://www.theguardian.com/world/rss',
        description: '英国主流严肃媒体，国际报道覆盖面极广'
    },
    {
        id: 'ft-world',
        name: 'Financial Times (英国金融时报)',
        category: 'finance',
        region: '欧洲',
        authority: 96,
        enabled: true,
        maxArticles: 5,
        strategy: 'rss',
        domain: 'ft.com',
        url: 'https://www.ft.com/world',
        rssUrl: 'https://www.ft.com/world?format=rss',
        description: '国际政治经济与欧洲金融市场权威大报'
    },
    {
        id: 'der-spiegel',
        name: 'DER SPIEGEL (德国明镜周刊)',
        category: 'western',
        region: '欧洲',
        authority: 91,
        enabled: true,
        maxArticles: 5,
        strategy: 'rss',
        domain: 'spiegel.de',
        url: 'https://www.spiegel.de/international/',
        rssUrl: 'https://www.spiegel.de/international/index.rss',
        description: '欧洲大陆最具影响力的深度新闻周刊英文版'
    },
    {
        id: 'cnn-world',
        name: 'CNN International',
        category: 'western',
        region: '美国',
        authority: 92,
        enabled: true,
        maxArticles: 5,
        strategy: 'rss',
        domain: 'cnn.com',
        url: 'https://edition.cnn.com/world',
        rssUrl: 'http://rss.cnn.com/rss/cnn_topstories.rss',
        description: '美国有线电视新闻网全球头条报道'
    },
    {
        id: 'fox-news-world',
        name: 'Fox News World (福克斯新闻)',
        category: 'western',
        region: '美国',
        authority: 82,
        enabled: true,
        maxArticles: 4,
        strategy: 'rss',
        domain: 'foxnews.com',
        url: 'https://www.foxnews.com/world',
        rssUrl: 'https://moxie.foxnews.com/google-publisher/world.xml',
        description: '美国保守派主流媒体国际新闻视角'
    },
    {
        id: 'the-independent',
        name: 'The Independent (英国独立报)',
        category: 'western',
        region: '欧洲',
        authority: 85,
        enabled: true,
        maxArticles: 4,
        strategy: 'rss',
        domain: 'independent.co.uk',
        url: 'https://www.independent.co.uk/news/world',
        rssUrl: 'https://www.independent.co.uk/news/world/rss',
        description: '英国知名综合新闻媒体'
    },
    {
        id: 'global-news-ca',
        name: 'Global News CA (加拿大环球新闻)',
        category: 'western',
        region: '美国',
        authority: 83,
        enabled: true,
        maxArticles: 4,
        strategy: 'rss',
        domain: 'globalnews.ca',
        url: 'https://globalnews.ca/world/',
        rssUrl: 'https://globalnews.ca/world/feed/',
        description: '加拿大主流国际与北美新闻源'
    },

    // ==================== 3. 亚太与大中华区权威媒体 (Asia-Pacific) ====================
    {
        id: 'scmp-china',
        name: '南华早报 (SCMP)',
        category: 'asiapacific',
        region: '中国',
        authority: 93,
        enabled: true,
        maxArticles: 6,
        strategy: 'rss',
        domain: 'scmp.com',
        url: 'https://www.scmp.com',
        rssUrl: 'https://www.scmp.com/rss/91/feed/',
        description: '香港最具国际影响力的英文报刊，深度聚焦中国与亚洲政经'
    },
    {
        id: 'cna-asia',
        name: 'Channel News Asia (新加坡亚洲新闻台)',
        category: 'asiapacific',
        region: '东南亚',
        authority: 92,
        enabled: true,
        maxArticles: 6,
        strategy: 'rss',
        domain: 'channelnewsasia.com',
        url: 'https://www.channelnewsasia.com/asia',
        rssUrl: 'https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6511',
        description: '新加坡亚洲新闻台，东南亚与亚太地缘局势权威信源'
    },
    {
        id: 'nhk-world',
        name: 'NHK World (日本放送协会)',
        category: 'asiapacific',
        region: '日本',
        authority: 92,
        enabled: true,
        maxArticles: 5,
        strategy: 'gnews_proxy',
        domain: 'nhk.or.jp',
        url: 'https://www3.nhk.or.jp/nhkworld/en/news/',
        rssUrl: 'https://news.google.com/rss/search?q=site:nhk.or.jp/nhkworld+when:1d&hl=en-US&gl=US&ceid=US:en',
        description: '日本公共广播机构国际频道，覆盖日本与东亚核心动态'
    },
    {
        id: 'nikkei-asia',
        name: 'Nikkei Asia (日经亚洲)',
        category: 'asiapacific',
        region: '亚洲',
        authority: 93,
        enabled: true,
        maxArticles: 5,
        strategy: 'gnews_proxy',
        domain: 'asia.nikkei.com',
        url: 'https://asia.nikkei.com',
        rssUrl: 'https://news.google.com/rss/search?q=site:asia.nikkei.com+when:2d&hl=en-US&gl=US&ceid=US:en',
        description: '日本经济新闻社旗下英文刊物，专注亚洲产业链、半导体与宏观经济'
    },
    {
        id: 'japan-times',
        name: 'The Japan Times (日本时报)',
        category: 'asiapacific',
        region: '日本',
        authority: 88,
        enabled: true,
        maxArticles: 5,
        strategy: 'rss',
        domain: 'japantimes.co.jp',
        url: 'https://www.japantimes.co.jp',
        rssUrl: 'https://www.japantimes.co.jp/feed/',
        description: '日本历史最悠久的英文日报'
    },
    {
        id: 'japan-today',
        name: 'Japan Today (今日日本)',
        category: 'asiapacific',
        region: '日本',
        authority: 82,
        enabled: true,
        maxArticles: 4,
        strategy: 'rss',
        domain: 'japantoday.com',
        url: 'https://japantoday.com',
        rssUrl: 'https://japantoday.com/feed',
        description: '日本社会、商业与时事新闻门户'
    },
    {
        id: 'yonhap-korea',
        name: 'Yonhap News (韩联社)',
        category: 'asiapacific',
        region: '韩国',
        authority: 91,
        enabled: true,
        maxArticles: 5,
        strategy: 'gnews_proxy',
        domain: 'en.yna.co.kr',
        url: 'https://en.yna.co.kr',
        rssUrl: 'https://news.google.com/rss/search?q=site:en.yna.co.kr+when:1d&hl=en-US&gl=US&ceid=US:en',
        description: '韩国国家通讯社，朝鲜半岛局势与韩国科技产业权威来源'
    },
    {
        id: 'times-of-india',
        name: 'The Times of India (印度时报)',
        category: 'asiapacific',
        region: '亚洲',
        authority: 86,
        enabled: true,
        maxArticles: 5,
        strategy: 'rss',
        domain: 'indiatimes.com',
        url: 'https://timesofindia.indiatimes.com/world',
        rssUrl: 'https://timesofindia.indiatimes.com/rssfeeds/296589292.cms',
        description: '印度发行量最大的英文日报，南亚及国际动态'
    },
    {
        id: 'smh-world',
        name: 'Sydney Morning Herald (悉尼先驱晨报)',
        category: 'asiapacific',
        region: '澳洲',
        authority: 87,
        enabled: true,
        maxArticles: 4,
        strategy: 'rss',
        domain: 'smh.com.au',
        url: 'https://www.smh.com.au/world',
        rssUrl: 'https://www.smh.com.au/rss/world.xml',
        description: '澳大利亚权威大报，大洋洲与印太地区视角'
    },
    {
        id: 'taipei-times',
        name: 'Taipei Times (台北时报)',
        category: 'asiapacific',
        region: '中国',
        authority: 80,
        enabled: true,
        maxArticles: 4,
        strategy: 'rss',
        domain: 'taipeitimes.com',
        url: 'https://www.taipeitimes.com/News/front',
        rssUrl: 'https://www.taipeitimes.com/xml/index.rss',
        description: '台湾主要英文日报'
    },
    {
        id: 'hkfp',
        name: 'Hong Kong Free Press (HKFP)',
        category: 'asiapacific',
        region: '中国',
        authority: 80,
        enabled: true,
        maxArticles: 3,
        strategy: 'rss',
        domain: 'hongkongfp.com',
        url: 'https://hongkongfp.com',
        rssUrl: 'https://hongkongfp.com/feed/',
        description: '香港非营利英文新闻网站'
    },

    // ==================== 4. 全球科技与商业前沿 (Tech & Finance) ====================
    {
        id: 'cnbc-world',
        name: 'CNBC International',
        category: 'finance',
        region: '国际',
        authority: 92,
        enabled: true,
        maxArticles: 5,
        strategy: 'rss',
        domain: 'cnbc.com',
        url: 'https://www.cnbc.com/world/',
        rssUrl: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100727362',
        description: '全球财经与资本市场实时要闻'
    },
    {
        id: 'techcrunch',
        name: 'TechCrunch',
        category: 'tech',
        region: '美国',
        authority: 90,
        enabled: true,
        maxArticles: 4,
        strategy: 'rss',
        domain: 'techcrunch.com',
        url: 'https://techcrunch.com',
        rssUrl: 'https://techcrunch.com/feed/',
        description: '全球人工智能、创业投资与前沿科技风向标'
    },
    {
        id: 'ars-technica',
        name: 'Ars Technica',
        category: 'tech',
        region: '美国',
        authority: 89,
        enabled: true,
        maxArticles: 4,
        strategy: 'rss',
        domain: 'arstechnica.com',
        url: 'https://arstechnica.com',
        rssUrl: 'https://feeds.arstechnica.com/arstechnica/index',
        description: '深度硬核科技、芯片、科学政策与安全报道'
    }
];

const MATRIX_STORAGE_PATH = path.join(__dirname, '..', 'data', 'sources_matrix.json');

/**
 * 获取完整的全球信源矩阵（合并持久化配置与用户自定义源）
 */
function getGlobalSourceMatrix() {
    let customState = {};
    try {
        if (fs.existsSync(MATRIX_STORAGE_PATH)) {
            customState = JSON.parse(fs.readFileSync(MATRIX_STORAGE_PATH, 'utf8'));
        }
    } catch (e) {
        // 忽略读取异常
    }

    const overrides = customState.overrides || {};
    const customSources = Array.isArray(customState.customSources) ? customState.customSources : [];

    // 合并预置信源与覆盖设置
    const mergedBuiltIn = DEFAULT_GLOBAL_SOURCES.map(src => {
        const override = overrides[src.id] || {};
        return {
            ...src,
            enabled: override.enabled !== undefined ? Boolean(override.enabled) : src.enabled,
            maxArticles: override.maxArticles !== undefined ? Number(override.maxArticles) : src.maxArticles,
            rssUrl: override.rssUrl || src.rssUrl,
            strategy: override.strategy || src.strategy,
            isCustom: false
        };
    });

    return [...mergedBuiltIn, ...customSources.map(s => ({ ...s, isCustom: true }))];
}

/**
 * 保存信源矩阵修改（启用/禁用、单源数量、新增自定义源）
 */
function saveGlobalSourceMatrixUpdate({ overrides = {}, customSources = null }) {
    let current = { overrides: {}, customSources: [] };
    try {
        if (fs.existsSync(MATRIX_STORAGE_PATH)) {
            current = JSON.parse(fs.readFileSync(MATRIX_STORAGE_PATH, 'utf8'));
        }
    } catch (e) {
        current = { overrides: {}, customSources: [] };
    }

    current.overrides = { ...(current.overrides || {}), ...overrides };
    if (Array.isArray(customSources)) {
        current.customSources = customSources;
    }
    current.updatedAt = new Date().toISOString();

    const dir = path.dirname(MATRIX_STORAGE_PATH);
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
    fs.writeFileSync(MATRIX_STORAGE_PATH, JSON.stringify(current, null, 2), 'utf8');
    return getGlobalSourceMatrix();
}

/**
 * 根据来源名称获取权威度评分 (0-100)
 */
function getSourceAuthorityScore(sourceName = '') {
    if (!sourceName) return 65;
    const lower = sourceName.toLowerCase();
    for (const src of DEFAULT_GLOBAL_SOURCES) {
        if (
            lower.includes(src.name.toLowerCase()) ||
            src.name.toLowerCase().includes(lower) ||
            (src.domain && lower.includes(src.domain.replace('.com', '').replace('.co.uk', '')))
        ) {
            return src.authority;
        }
    }

    // 常见权威媒体补充映射
    const extraScores = {
        'reuters': 99,
        '路透': 99,
        'associated press': 98,
        'ap news': 98,
        '美联社': 98,
        'bbc': 97,
        'new york times': 97,
        '纽约时报': 97,
        'bloomberg': 96,
        '彭博': 96,
        'wall street journal': 96,
        'wsj': 96,
        '华尔街日报': 96,
        'financial times': 96,
        '金融时报': 96,
        'economist': 95,
        '经济学人': 95,
        'washington post': 94,
        '华盛顿邮报': 94,
        'guardian': 93,
        '卫报': 93,
        'scmp': 93,
        'south china morning post': 93,
        '南华早报': 93,
        'nikkei': 93,
        '日经': 93,
        'nhk': 92,
        'channel news asia': 92,
        'cna': 92,
        'cnbc': 92,
        'al jazeera': 91,
        '半岛电视台': 91,
        'yonhap': 91,
        '韩联社': 91,
        'spiegel': 91,
        'france 24': 90,
        'dw': 90,
        'techcrunch': 90
    };

    for (const [key, score] of Object.entries(extraScores)) {
        if (lower.includes(key)) return score;
    }

    return 70;
}

module.exports = {
    DEFAULT_GLOBAL_SOURCES,
    getGlobalSourceMatrix,
    saveGlobalSourceMatrixUpdate,
    getSourceAuthorityScore
};

