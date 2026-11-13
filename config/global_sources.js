const fs = require('fs');
const path = require('path');

/**
 * 信源矩阵配置版本号（升级此版本号将自动刷新内置信源的 RSS 地址与采集策略，同时保留用户的启用开关与自定义源）
 */
const MATRIX_SCHEMA_VERSION = '2.2';

/**
 * 聚核 CoreFeed v2.0 — 全球 37 大权威信源矩阵定义与采集策略 (config/global_sources.js, v2.2)
 *
 * 覆盖五大领域 (`wire`, `western`, `asiapacific`, `finance`, `tech`) 共 37 家国际权威媒体：
 * - 剔除已停更/冻结源（如 2023 年停更的旧版 CNN RSS、失效的旧版 DowJones/AP 地址及低质边缘站点）
 * - 优先选用原生携带高清配图 (media:content / media:thumbnail / enclosure) 及多段导语摘要的官方源
 * - 支持多级自动降级：官方 RSS/Atom -> 页面 og:image / Bing News 配图补全 -> Google News 定向检索兜底
 */
const DEFAULT_GLOBAL_SOURCES = [
    // ==================== 1. 全球顶级通讯社与国际全天候新闻台 (Wire & Global Broadcasters) ====================
    {
        id: 'bbc-world',
        name: 'BBC World (英国广播公司)',
        category: 'wire',
        region: '国际',
        authority: 98,
        enabled: true,
        maxArticles: 8,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'bbc.com',
        url: 'https://www.bbc.com/news/world',
        rssUrl: 'https://feeds.bbci.co.uk/news/world/rss.xml',
        description: 'BBC 全球新闻旗舰频道，全天候覆盖国际地缘政治、外交与突发重大事件（原生带高清缩略图）'
    },
    {
        id: 'ap-news',
        name: 'AP News (美联社)',
        category: 'wire',
        region: '国际',
        authority: 98,
        enabled: true,
        maxArticles: 8,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'apnews.com',
        url: 'https://apnews.com/hub/world-news',
        rssUrl: 'https://flipboard.com/@associatedpress/international-news-miluvhmaz.rss',
        backupRssUrl: 'https://flipboard.com/@associatedpress/top-stories-u7govdf1z.rss',
        description: '美国联合通讯社官方认证聚合源，直连 apnews.com 原文并原生附带新闻配图与导语摘要'
    },
    {
        id: 'reuters-world',
        name: 'Reuters (路透社)',
        category: 'wire',
        region: '国际',
        authority: 99,
        enabled: true,
        maxArticles: 7,
        strategy: 'gnews_proxy',
        hasNativeImages: false,
        domain: 'reuters.com',
        url: 'https://www.reuters.com/world/',
        rssUrl: 'https://news.google.com/rss/search?q=when:24h+site:reuters.com/world&ceid=US:en&hl=en-US&gl=US',
        description: '全球最大国际通讯社，以快速客观的全球政经与金融突发报道著称（配合智能搜图引擎自动补全题图）'
    },
    {
        id: 'sky-news-world',
        name: 'Sky News World (天空新闻国际台)',
        category: 'wire',
        region: '国际',
        authority: 92,
        enabled: true,
        maxArticles: 6,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'news.sky.com',
        url: 'https://news.sky.com/world',
        rssUrl: 'https://feeds.skynews.com/feeds/rss/world.xml',
        description: '英国天空新闻 24 小时国际突发新闻源，更新极快且每条均附带高清现场题图'
    },
    {
        id: 'france-24',
        name: 'FRANCE 24 (法国24台)',
        category: 'wire',
        region: '欧洲',
        authority: 92,
        enabled: true,
        maxArticles: 6,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'france24.com',
        url: 'https://www.france24.com/en/',
        rssUrl: 'https://www.france24.com/en/rss',
        description: '法国国际新闻旗舰频道，提供欧洲、中东与全球多极视角深度报道（原生带高清大图与详实摘要）'
    },
    {
        id: 'euronews-world',
        name: 'Euronews (欧洲新闻台)',
        category: 'wire',
        region: '欧洲',
        authority: 91,
        enabled: true,
        maxArticles: 5,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'euronews.com',
        url: 'https://www.euronews.com/news/international',
        rssUrl: 'https://www.euronews.com/rss',
        description: '泛欧洲最具影响力的多语种国际新闻电视网，聚焦欧洲与全球事务'
    },
    {
        id: 'al-jazeera',
        name: 'Al Jazeera (半岛电视台)',
        category: 'wire',
        region: '中东',
        authority: 92,
        enabled: true,
        maxArticles: 6,
        strategy: 'rss',
        hasNativeImages: false,
        domain: 'aljazeera.com',
        url: 'https://www.aljazeera.com/news/',
        rssUrl: 'https://www.aljazeera.com/xml/rss/all.xml',
        description: '中东及全球南方视角最具代表性的国际新闻机构，支持页面 og:image 自动提图'
    },
    {
        id: 'dw-world',
        name: 'DW (德国之声)',
        category: 'wire',
        region: '欧洲',
        authority: 91,
        enabled: true,
        maxArticles: 5,
        strategy: 'rss',
        hasNativeImages: false,
        domain: 'dw.com',
        url: 'https://www.dw.com/en/top-stories/s-9097',
        rssUrl: 'https://rss.dw.com/xml/rss-en-world',
        backupRssUrl: 'https://rss.dw.com/rdf/rss-en-all',
        description: '德国公共国际广播机构，聚焦欧洲政经、俄乌局势与全球事务'
    },

    // ==================== 2. 欧美权威大报与深度政经媒体 (US & Europe Flagship Press) ====================
    {
        id: 'nyt-world',
        name: 'The New York Times (纽约时报)',
        category: 'western',
        region: '美国',
        authority: 97,
        enabled: true,
        maxArticles: 7,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'nytimes.com',
        url: 'https://www.nytimes.com/section/world',
        rssUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/World.xml',
        backupRssUrl: 'https://rss.nytimes.com/services/xml/rss/nyt/HomePage.xml',
        description: '美国最具影响力的严肃大报，深度国际调查与全球局势分析（原生携带高清配图）'
    },
    {
        id: 'the-guardian',
        name: 'The Guardian (英国卫报)',
        category: 'western',
        region: '欧洲',
        authority: 95,
        enabled: true,
        maxArticles: 7,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'theguardian.com',
        url: 'https://www.theguardian.com/world',
        rssUrl: 'https://www.theguardian.com/world/rss',
        description: '英国主流严肃大报，RSS 原生提供多段详实正文（约900词）及多尺寸高清署名配图'
    },
    {
        id: 'axios-top',
        name: 'Axios (美国政经与全球快讯)',
        category: 'western',
        region: '美国',
        authority: 93,
        enabled: true,
        maxArticles: 5,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'axios.com',
        url: 'https://www.axios.com/world',
        rssUrl: 'https://api.axios.com/feed/',
        description: '美国高密度政经与科技情报媒体，RSS 原生输出完整全文（Smart Brevity 结构）及高清头图'
    },
    {
        id: 'politico-news',
        name: 'POLITICO (美国政经与外交)',
        category: 'western',
        region: '美国',
        authority: 93,
        enabled: true,
        maxArticles: 5,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'politico.com',
        url: 'https://www.politico.com',
        rssUrl: 'https://rss.politico.com/politics-news.xml',
        description: '华盛顿与欧美政界核心风向标，RSS 原生包含完整报道正文与高清新闻图片'
    },
    {
        id: 'semafor-global',
        name: 'Semafor (全球地缘与政商情报)',
        category: 'western',
        region: '国际',
        authority: 91,
        enabled: true,
        maxArticles: 5,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'semafor.com',
        url: 'https://www.semafor.com',
        rssUrl: 'https://www.semafor.com/rss.xml',
        description: '由前彭博与纽时高层创办的全球深度政商媒体，RSS 原生提供多段核心观点与高清配图'
    },
    {
        id: 'npr-world',
        name: 'NPR World (美国国家公共广播)',
        category: 'western',
        region: '美国',
        authority: 93,
        enabled: true,
        maxArticles: 5,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'npr.org',
        url: 'https://www.npr.org/sections/world/',
        rssUrl: 'https://feeds.npr.org/1004/rss.xml',
        description: '美国国家公共广播电台国际频道，客观深度的驻外记者一线报道（原生带高清图）'
    },
    {
        id: 'nbc-news',
        name: 'NBC News (美国全国广播公司)',
        category: 'western',
        region: '美国',
        authority: 91,
        enabled: true,
        maxArticles: 5,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'nbcnews.com',
        url: 'https://www.nbcnews.com/world',
        rssUrl: 'https://feeds.nbcnews.com/nbcnews/public/news',
        description: '美国三大广播电视网之一，全天候更新北美与全球重点事件（原生带高清配图）'
    },
    {
        id: 'der-spiegel',
        name: 'DER SPIEGEL (德国明镜周刊)',
        category: 'western',
        region: '欧洲',
        authority: 92,
        enabled: true,
        maxArticles: 5,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'spiegel.de',
        url: 'https://www.spiegel.de/international/',
        rssUrl: 'https://www.spiegel.de/international/index.rss',
        description: '欧洲大陆最具影响力的深度调查周刊英文版（原生带 enclosure 高清题图）'
    },
    {
        id: 'lemonde-en',
        name: 'Le Monde English (法国世界报)',
        category: 'western',
        region: '欧洲',
        authority: 93,
        enabled: true,
        maxArticles: 5,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'lemonde.fr',
        url: 'https://www.lemonde.fr/en/',
        rssUrl: 'https://www.lemonde.fr/en/rss/une.xml',
        description: '法国最具权威性的严肃日报英文版，覆盖欧洲外交、安全与全球政经（原生带高清图）'
    },
    {
        id: 'fox-news-world',
        name: 'Fox News World (福克斯国际)',
        category: 'western',
        region: '美国',
        authority: 86,
        enabled: true,
        maxArticles: 4,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'foxnews.com',
        url: 'https://www.foxnews.com/world',
        rssUrl: 'https://moxie.foxnews.com/google-publisher/world.xml',
        description: '美国保守派主流媒体国际频道，Google Publisher 接口原生输出完整全文与高清配图'
    },
    {
        id: 'cbc-world',
        name: 'CBC World (加拿大广播公司)',
        category: 'western',
        region: '美国',
        authority: 88,
        enabled: true,
        maxArticles: 4,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'cbc.ca',
        url: 'https://www.cbc.ca/news/world',
        rssUrl: 'https://www.cbc.ca/webfeed/rss/rss-world',
        description: '加拿大国家公共广播公司国际新闻源（原生携带图片与摘要）'
    },

    // ==================== 3. 亚太与大中华区权威媒体 (Asia-Pacific & Greater China) ====================
    {
        id: 'scmp-china',
        name: '南华早报 (SCMP)',
        category: 'asiapacific',
        region: '中国',
        authority: 94,
        enabled: true,
        maxArticles: 7,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'scmp.com',
        url: 'https://www.scmp.com/news/china',
        rssUrl: 'https://www.scmp.com/rss/91/feed/',
        backupRssUrl: 'https://www.scmp.com/rss/2/feed/',
        description: '香港最具国际影响力的英文旗舰大报，深度聚焦中国与亚太政经科技（原生带高清大图）'
    },
    {
        id: 'cna-asia',
        name: 'Channel News Asia (新加坡亚洲新闻台)',
        category: 'asiapacific',
        region: '东南亚',
        authority: 93,
        enabled: true,
        maxArticles: 6,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'channelnewsasia.com',
        url: 'https://www.channelnewsasia.com/asia',
        rssUrl: 'https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml&category=6511',
        backupRssUrl: 'https://www.channelnewsasia.com/api/v1/rss-outbound-feed?_format=xml',
        description: '新加坡亚洲新闻台，东南亚、东亚与印太地缘局势权威信源（原生带高清缩略图）'
    },
    {
        id: 'straits-times-asia',
        name: 'The Straits Times (新加坡海峡时报)',
        category: 'asiapacific',
        region: '东南亚',
        authority: 91,
        enabled: true,
        maxArticles: 5,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'straitstimes.com',
        url: 'https://www.straitstimes.com/asia',
        rssUrl: 'https://www.straitstimes.com/news/asia/rss.xml',
        backupRssUrl: 'https://www.straitstimes.com/news/world/rss.xml',
        description: '新加坡历史最悠久的英文旗舰日报，深度覆盖东盟、中国与亚洲政商动态'
    },
    {
        id: 'nikkei-asia',
        name: 'Nikkei Asia (日经亚洲)',
        category: 'asiapacific',
        region: '亚洲',
        authority: 94,
        enabled: true,
        maxArticles: 5,
        strategy: 'gnews_proxy',
        hasNativeImages: false,
        domain: 'asia.nikkei.com',
        url: 'https://asia.nikkei.com',
        rssUrl: 'https://news.google.com/rss/search?q=when:2d+site:asia.nikkei.com&hl=en-US&gl=US&ceid=US:en',
        description: '日本经济新闻社旗下英文旗舰刊物，专注亚洲产业链、半导体供应链与宏观经济'
    },
    {
        id: 'japan-times',
        name: 'The Japan Times (日本时报)',
        category: 'asiapacific',
        region: '日本',
        authority: 89,
        enabled: true,
        maxArticles: 5,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'japantimes.co.jp',
        url: 'https://www.japantimes.co.jp',
        rssUrl: 'https://www.japantimes.co.jp/feed/',
        description: '日本最具代表性的英文日报，覆盖日本政经、防务与东亚外交'
    },
    {
        id: 'abc-australia',
        name: 'ABC News Australia (澳洲广播公司)',
        category: 'asiapacific',
        region: '澳洲',
        authority: 90,
        enabled: true,
        maxArticles: 5,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'abc.net.au',
        url: 'https://www.abc.net.au/news/world',
        rssUrl: 'https://www.abc.net.au/news/feed/51120/rss.xml',
        description: '澳大利亚国家公共广播机构，印太与南太平洋地区权威新闻源（原生带高清配图）'
    },
    {
        id: 'the-hindu-world',
        name: 'The Hindu (印度教徒报国际版)',
        category: 'asiapacific',
        region: '亚洲',
        authority: 88,
        enabled: true,
        maxArticles: 4,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'thehindu.com',
        url: 'https://www.thehindu.com/news/international/',
        rssUrl: 'https://www.thehindu.com/news/international/feeder/default.rss',
        backupRssUrl: 'https://timesofindia.indiatimes.com/rssfeeds/296589292.cms',
        description: '南亚最具公信力的严肃英文大报，聚焦南亚地缘与全球外交（原生带高清配图）'
    },

    // ==================== 4. 全球财经与商业市场 (Global Finance & Markets) ====================
    {
        id: 'wsj-world',
        name: 'Wall Street Journal (华尔街日报)',
        category: 'finance',
        region: '美国',
        authority: 97,
        enabled: true,
        maxArticles: 6,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'wsj.com',
        url: 'https://www.wsj.com/news/world',
        rssUrl: 'https://feeds.content.dowjones.io/public/rss/RSSWorldNews',
        backupRssUrl: 'https://feeds.content.dowjones.io/public/rss/RSSMarketsMain',
        description: '道琼斯旗下全球财经旗舰大报，新版 DowJones 接口原生附带高清图片与导语'
    },
    {
        id: 'marketwatch-top',
        name: 'MarketWatch (道琼斯全球市场)',
        category: 'finance',
        region: '美国',
        authority: 92,
        enabled: true,
        maxArticles: 5,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'marketwatch.com',
        url: 'https://www.marketwatch.com',
        rssUrl: 'https://feeds.content.dowjones.io/public/rss/mw_topstories',
        description: '道琼斯旗下实时金融市场与宏观经济分析门户（原生带高清配图且无严格付费墙阻断）'
    },
    {
        id: 'bbc-business',
        name: 'BBC Business (BBC 全球财经)',
        category: 'finance',
        region: '国际',
        authority: 95,
        enabled: true,
        maxArticles: 5,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'bbc.com',
        url: 'https://www.bbc.com/news/business',
        rssUrl: 'https://feeds.bbci.co.uk/news/business/rss.xml',
        description: 'BBC 全球商业、央行政策、国际贸易与能源市场报道（原生带高清图）'
    },
    {
        id: 'bloomberg-markets',
        name: 'Bloomberg (彭博社全球市场)',
        category: 'finance',
        region: '国际',
        authority: 96,
        enabled: true,
        maxArticles: 6,
        strategy: 'rss',
        hasNativeImages: false,
        domain: 'bloomberg.com',
        url: 'https://www.bloomberg.com/markets',
        rssUrl: 'https://feeds.bloomberg.com/markets/news.rss',
        backupRssUrl: 'https://feeds.bloomberg.com/politics/news.rss',
        description: '全球金融市场、主权债汇、大宗商品与宏观政策权威信息源'
    },
    {
        id: 'fortune-global',
        name: 'Fortune (财富全球商业)',
        category: 'finance',
        region: '美国',
        authority: 90,
        enabled: true,
        maxArticles: 4,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'fortune.com',
        url: 'https://fortune.com',
        rssUrl: 'https://fortune.com/feed/fortune-feeds/?id=3230629',
        description: '《财富》杂志全球跨国企业、华尔街与宏观商业深度报道（原生带高清图）'
    },
    {
        id: 'cnbc-world',
        name: 'CNBC International (全球财经)',
        category: 'finance',
        region: '国际',
        authority: 92,
        enabled: true,
        maxArticles: 5,
        strategy: 'rss',
        hasNativeImages: false,
        domain: 'cnbc.com',
        url: 'https://www.cnbc.com/world/',
        rssUrl: 'https://search.cnbc.com/rs/search/combinedcms/view.xml?partnerId=wrss01&id=100727362',
        backupRssUrl: 'https://www.cnbc.com/id/100003114/device/rss/rss.html',
        description: '全球资本市场、美联储动向与跨国公司财报实时要闻'
    },

    // ==================== 5. 前沿科技、人工智能与科学探索 (Tech, AI & Science) ====================
    {
        id: 'ars-technica',
        name: 'Ars Technica (硬核科技与科学)',
        category: 'tech',
        region: '美国',
        authority: 92,
        enabled: true,
        maxArticles: 5,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'arstechnica.com',
        url: 'https://arstechnica.com',
        rssUrl: 'https://feeds.arstechnica.com/arstechnica/index',
        description: '深度硬核科技、芯片架构、AI 算力、航天与安全报道（RSS 原生输出千字长文与高清大图）'
    },
    {
        id: 'the-verge',
        name: 'The Verge (前沿科技与AI生态)',
        category: 'tech',
        region: '美国',
        authority: 91,
        enabled: true,
        maxArticles: 5,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'theverge.com',
        url: 'https://www.theverge.com',
        rssUrl: 'https://www.theverge.com/rss/index.xml',
        description: '硅谷科技巨头、人工智能产品与数字生态核心媒体（Atom 源原生包含多段正文与高清大图）'
    },
    {
        id: 'mit-tech-review',
        name: 'MIT Technology Review (麻省理工科技评论)',
        category: 'tech',
        region: '美国',
        authority: 94,
        enabled: true,
        maxArticles: 4,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'technologyreview.com',
        url: 'https://www.technologyreview.com',
        rssUrl: 'https://www.technologyreview.com/feed/',
        description: '全球最权威的前沿科技与人工智能学术/产业评论刊物（RSS 原生携带完整深度长文与配图）'
    },
    {
        id: 'wired-tech',
        name: 'WIRED (连线杂志)',
        category: 'tech',
        region: '美国',
        authority: 90,
        enabled: true,
        maxArticles: 4,
        strategy: 'rss',
        hasNativeImages: true,
        domain: 'wired.com',
        url: 'https://www.wired.com',
        rssUrl: 'https://www.wired.com/feed/rss',
        description: '聚焦人工智能、网络安全、科学突破与全球科技文化（原生携带 media:thumbnail 高清图）'
    },
    {
        id: 'techcrunch',
        name: 'TechCrunch (硅谷创投风向标)',
        category: 'tech',
        region: '美国',
        authority: 90,
        enabled: true,
        maxArticles: 4,
        strategy: 'rss',
        hasNativeImages: false,
        domain: 'techcrunch.com',
        url: 'https://techcrunch.com',
        rssUrl: 'https://techcrunch.com/feed/',
        description: '全球人工智能初创企业、风险投资与前沿科技产品首发阵地'
    }
];

const MATRIX_STORAGE_PATH = path.join(__dirname, '..', 'data', 'sources_matrix.json');

/**
 * 获取完整的全球信源矩阵（合并持久化配置与用户自定义源，并在版本升级时自动刷新内置源地址）
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

    const isCurrentSchema = customState.schemaVersion === MATRIX_SCHEMA_VERSION;
    const overrides = customState.overrides || {};
    const customSources = Array.isArray(customState.customSources) ? customState.customSources : [];

    // 合并预置信源与覆盖设置（若旧版缓存的 schemaVersion 不同，仅保留用户的 enabled/maxArticles 偏好，强制更新最新的官方 rssUrl 与 strategy）
    const mergedBuiltIn = DEFAULT_GLOBAL_SOURCES.map(src => {
        const override = overrides[src.id] || {};
        return {
            ...src,
            enabled: override.enabled !== undefined ? Boolean(override.enabled) : src.enabled,
            maxArticles: override.maxArticles !== undefined ? Number(override.maxArticles) : src.maxArticles,
            rssUrl: (isCurrentSchema && override.rssUrl) ? override.rssUrl : src.rssUrl,
            strategy: (isCurrentSchema && override.strategy) ? override.strategy : src.strategy,
            isCustom: false
        };
    });

    return [...mergedBuiltIn, ...customSources.map(s => ({ ...s, isCustom: true }))];
}

/**
 * 根据来源名称获取权威度评分 (0-100)
 */
function getSourceAuthorityScore(sourceName = '') {
    if (!sourceName) return 68;
    const lower = sourceName.toLowerCase();
    for (const src of DEFAULT_GLOBAL_SOURCES) {
        if (
            lower.includes(src.name.toLowerCase()) ||
            src.name.toLowerCase().includes(lower) ||
            (src.domain && lower.includes(src.domain.replace('.com', '').replace('.co.uk', '').replace('.org', '')))
        ) {
            return src.authority;
        }
    }

    const extraScores = {
        'reuters': 99,
        '路透': 99,
        'associated press': 98,
        'ap news': 98,
        '美联社': 98,
        'bbc': 98,
        'new york times': 97,
        '纽约时报': 97,
        'wall street journal': 97,
        'wsj': 97,
        '华尔街日报': 97,
        'bloomberg': 96,
        '彭博': 96,
        'financial times': 96,
        '金融时报': 96,
        'guardian': 95,
        '卫报': 95,
        'scmp': 94,
        'south china morning post': 94,
        '南华早报': 94,
        'nikkei': 94,
        '日经': 94,
        'mit technology review': 94,
        'axios': 93,
        'politico': 93,
        'npr': 93,
        'le monde': 93,
        'channel news asia': 93,
        'cna': 93,
        'sky news': 92,
        'france 24': 92,
        'al jazeera': 92,
        '半岛电视台': 92,
        'spiegel': 92,
        'marketwatch': 92,
        'cnbc': 92,
        'ars technica': 92,
        'semafor': 91,
        'euronews': 91,
        'dw': 91,
        'nbc news': 91,
        'straits times': 91,
        'the verge': 91,
        'abc news': 90,
        'fortune': 90,
        'wired': 90,
        'techcrunch': 90
    };

    for (const [key, score] of Object.entries(extraScores)) {
        if (lower.includes(key)) return score;
    }

    return 72;
}

module.exports = {
    MATRIX_SCHEMA_VERSION,
    DEFAULT_GLOBAL_SOURCES,
    getGlobalSourceMatrix,
    getSourceAuthorityScore
};
