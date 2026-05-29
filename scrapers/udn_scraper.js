const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const { isArticleExists, saveNewsWithTags } = require('./db');
const logger = require('./logger');

// ==========================================
// 📚 1. 載入台美股字典
// ==========================================
let twStocks = {};
let usStocks = {};

if (fs.existsSync('./tw_stocks.json')) {
    twStocks = require('./tw_stocks.json');
} else {
    logger.warn('⚠️ 找不到 tw_stocks.json！請先執行 update_twse_dict.js');
}

if (fs.existsSync('./us_stocks.json')) {
    usStocks = require('./us_stocks.json');
} else {
    logger.warn('⚠️ 找不到 us_stocks.json！請先執行 update_us_dict.js');
}

// ==========================================
// 🔄 2. 建立「反向字典」(名稱 -> 代號)
// ==========================================
const nameToSymbol = {};
for (const [sym, name] of Object.entries(twStocks)) {
    nameToSymbol[name] = sym;
    if (name.includes('-KY')) {
        nameToSymbol[name.replace('-KY', '')] = sym;
    }
}

// 必備微型黑名單
const SYMBOL_BLACKLIST = new Set([
    'YOY', 'MOM', 'EPS', 'Q1', 'Q2', 'Q3', 'Q4', 
    'VIP', 'FED', 'BBU', 'CPO', 'CSP', 'APP', 'IPO', 'AI', 'ETF'
]);

// 名稱黑名單 (極度輕量化)：經濟日報含金量高，只排除最容易誤判的生活名詞
const NAME_BLACKLIST = new Set([
    '統一', '幸福', '地球', '全國', '卓越', '立德', '世界', '未來'
]);

const UDN_NEWS_URL = 'https://money.udn.com/rank/newest/1001/0/1';
const BASE_URL = 'https://money.udn.com';

/**
 * 深度解析 經濟日報 文章頁面
 */
async function parseUdnArticlePage(url, articleTitle) {
    try {
        const { data } = await axios.get(url);
        const $ = cheerio.load(data);
        
        // 抓取內文：經濟日報內文主要包在 id="article_body" 的 p 標籤中
        let content = $('#article_body p').text().replace(/\s+/g, ' ').trim();
        // 容錯機制
        if (!content) {
            content = $('#article_body').text().replace(/\s+/g, ' ').trim();
        }
        
        const rawSymbols = new Set();

        // 🎯 策略 A：從文章底部標籤抓取
        $('.article-keyword__list a').each((i, el) => {
            const tagText = $(el).text().trim().toUpperCase();
            
            const parenMatch = tagText.match(/[\(（]([A-Z0-9]{2,6})[\)）]/); 
            if (parenMatch) {
                rawSymbols.add(parenMatch[1]);
            } else if (/^[A-Z0-9]{2,6}$/.test(tagText)) {
                rawSymbols.add(tagText);
            } else if (nameToSymbol[tagText]) {
                rawSymbols.add(nameToSymbol[tagText]);
            }
        });

        const textToScan = articleTitle + " " + content;
        
        // 🎯 策略 B：代號在括號內，如: 台積電(2330) 或 群創（3481）
        const regexA = /[\(（]([A-Z0-9]{2,6})[\)）]/g;
        let match;
        while ((match = regexA.exec(textToScan)) !== null) {
            rawSymbols.add(match[1].toUpperCase());
        }

        // 🎯 策略 C：代號在括號外，如: 2330(台積電) 或 2330（台積電）
        const regexB = /([A-Z0-9]{2,6})[\(（][\u4e00-\u9fa5A-Za-z0-9\-]+[\)）]/g;
        while ((match = regexB.exec(textToScan)) !== null) {
            rawSymbols.add(match[1].toUpperCase());
        }

        // 🎯 策略 D：從「標題」進行名稱直接比對
        for (const [name, sym] of Object.entries(nameToSymbol)) {
            if (name.length >= 2 && !NAME_BLACKLIST.has(name) && articleTitle.includes(name)) {
                rawSymbols.add(sym);
            }
        }

        // ==========================================
        // 🛡️ 雙字典終極驗證階段
        // ==========================================
        const verifiedSymbols = [];

        for (const sym of rawSymbols) {
            if (SYMBOL_BLACKLIST.has(sym)) continue;

            if (twStocks[sym]) {
                verifiedSymbols.push(sym);
            } else if (usStocks[sym]) {
                verifiedSymbols.push(sym);
            }
        }

        return { content, symbols: verifiedSymbols };

    } catch (error) {
        logger.error(`無法解析 經濟日報 文章頁面: ${url} | 錯誤: ${error.message}`);
        return { content: '', symbols: [] };
    }
}

/**
 * 爬取 經濟日報 最新新聞列表
 */
async function scrapeUdnNews() {
    logger.info(`🔍 開始掃描 經濟日報 最新新聞: ${UDN_NEWS_URL}`);
    
    try {
        const { data } = await axios.get(UDN_NEWS_URL);
        const $ = cheerio.load(data);
        
        // 經濟日報的列表卡片 class
        const cards = $('li.story-headline-wrapper').toArray();
        
        if (cards.length === 0) {
            logger.warn(`⚠️ [異常] 抓不到任何 經濟日報 新聞卡片，請檢查 DOM 結構是否改變。`);
            return;
        }

        let newArticleCount = 0;

        for (const card of cards) {
            const $card = $(card);
            
            // 抓取連結與標題
            const $linkEl = $card.find('.story__content a');
            let relativeUrl = $linkEl.attr('href');
            const title = $card.find('h3.story__headline').text().trim();
            // 抓取摘要
            const summary = $card.find('p.story__text').text().trim();

            if (!relativeUrl || !title) continue;
            
            // 補全相對路徑 (例如: /money/story/... -> https://money.udn.com/money/story/...)
            const articleUrl = relativeUrl.startsWith('http') ? relativeUrl : BASE_URL + relativeUrl;

            // 防呆過濾：只允許 UDN 內部新聞連結
            if (!articleUrl.startsWith('https://money.udn.com')) {
                continue;
            }
            
            // 【停止條件】遇到已存入資料庫的文章，代表後續皆為舊聞，跳出掃描
            if (isArticleExists(articleUrl)) {
                logger.info(`🛑 遇到已存入的新聞，經濟日報 掃描結束。`);
                break; 
            }

            // 進入文章解析與字典驗證引擎
            const { content, symbols } = await parseUdnArticlePage(articleUrl, title);

            const displaySymbols = symbols.map(s => {
                if (twStocks[s]) return `${twStocks[s]}(${s})`;
                if (usStocks[s]) return `${usStocks[s]}(${s})`;
                return s;
            });

            logger.info(`📥 [UDN] 處理中: [${title}]`);
            logger.info(`   🏷️ 萃取代號: ${displaySymbols.length > 0 ? displaySymbols.join(', ') : '無'}`);

            if (!content || content.length === 0) {
                logger.warn(`⚠️ [異常] 抓取到空內文 (可能是會員付費文章或特殊排版): ${articleUrl}`);
            }

            // 存入共用的資料庫模組
            saveNewsWithTags({
                url: articleUrl,
                title: title,
                summary: summary,
                content: content
            }, symbols);

            newArticleCount++;
            
            // 防禦性延遲 (隨機 1~3 秒)，避免被當成惡意攻擊阻擋
            await new Promise(res => setTimeout(res, 1000 + Math.random() * 2000));
        }

        logger.info(`✅ 經濟日報 掃描完畢，共新增 ${newArticleCount} 篇新聞。`);

    } catch (error) {
        logger.error(`❌ 經濟日報 掃描發生錯誤 | 錯誤: ${error.message}`);
    }
}

async function startUdnScraper() {
    logger.info('==================================================');
    logger.info('🚀 經濟日報 爬蟲啟動 (搭載名稱智能反查系統)');
    logger.info('==================================================');

    await scrapeUdnNews();

    logger.info('🏁 經濟日報 爬取完畢！');
}

// 執行
startUdnScraper();