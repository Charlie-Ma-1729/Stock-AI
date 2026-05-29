const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
// 注意：移除了 saveNewsWithTags，寫入資料庫由 scheduler (ETL Load 階段) 負責
const { isArticleExists } = require('./db');
const logger = require('./logger');

// ==========================================
// 📚 1. 載入台美股字典
// ==========================================
let twStocks = {};
let usStocks = {};

// 使用 path.join 確保相對路徑在不同執行環境下皆正確
const twDictPath = path.join(__dirname, 'tw_stocks.json');
const usDictPath = path.join(__dirname, 'us_stocks.json');

if (fs.existsSync(twDictPath)) {
    twStocks = require(twDictPath);
} else {
    logger.warn('⚠️ 找不到 tw_stocks.json！請先執行 update_twse_dict.js');
}

if (fs.existsSync(usDictPath)) {
    usStocks = require(usDictPath);
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

const BASE_URL = 'https://money.udn.com';

// 🎯 更新：將原本單一網址替換成陣列，包含使用者指定的 5 個新目標板塊
const TARGET_URLS = [
    'https://money.udn.com/rank/newest/1001/5591/1',
    'https://money.udn.com/rank/newest/1001/5590/1',
    'https://money.udn.com/rank/newest/1001/12017/1',
    'https://money.udn.com/rank/newest/1001/11111/1',
    'https://money.udn.com/rank/newest/1001/5592/1'
];

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
        logger.error(`❌ [Extract] 無法解析 經濟日報 文章頁面: ${url} | 錯誤: ${error.message}`);
        return { content: '', symbols: [] };
    }
}

/**
 * 爬取 單一 經濟日報 板塊，回傳萃取陣列
 * @param {string} listUrl 要掃描的目標板塊網址
 */
async function scrapeCategory(listUrl) {
    logger.info(`🔍 [Extract] 開始掃描 經濟日報 板塊: ${listUrl}`);
    const scrapedArticles = [];
    
    try {
        const { data } = await axios.get(listUrl);
        const $ = cheerio.load(data);
        
        // 經濟日報的列表卡片 class
        const cards = $('li.story-headline-wrapper').toArray();
        
        if (cards.length === 0) {
            logger.warn(`⚠️ [異常] 抓不到任何 經濟日報 新聞卡片，請檢查 DOM 結構是否改變。網址: ${listUrl}`);
            return scrapedArticles;
        }

        for (const card of cards) {
            const $card = $(card);
            
            // 抓取連結與標題
            const $linkEl = $card.find('.story__content a');
            let relativeUrl = $linkEl.attr('href');
            const title = $card.find('h3.story__headline').text().trim();

            if (!relativeUrl || !title) continue;
            
            // 補全相對路徑
            const articleUrl = relativeUrl.startsWith('http') ? relativeUrl : BASE_URL + relativeUrl;

            // 防呆過濾：只允許 UDN 內部新聞連結
            if (!articleUrl.startsWith('https://money.udn.com')) {
                continue;
            }
            
            // 【停止條件】遇到已存入資料庫的文章，代表後續皆為舊聞，跳出目前這個板塊的掃描
            if (isArticleExists(articleUrl)) {
                logger.info(`🛑 [Extract] 遇到已存在 DB 的舊新聞，停止本板塊掃描。`);
                break; 
            }

            // 進入文章解析與字典驗證引擎
            const { content, symbols } = await parseUdnArticlePage(articleUrl, title);

            const displaySymbols = symbols.map(s => {
                if (twStocks[s]) return `${twStocks[s]}(${s})`;
                if (usStocks[s]) return `${usStocks[s]}(${s})`;
                return s;
            });

            logger.info(`📥 [Extract] UDN 萃取成功: [${title}]`);
            logger.info(`   🏷️ 關聯代號: ${displaySymbols.length > 0 ? displaySymbols.join(', ') : '無'}`);

            if (!content || content.length === 0) {
                logger.warn(`⚠️ [異常] 抓取到空內文 (可能是會員付費文章或特殊排版): ${articleUrl}`);
            }

            // 將資料推入陣列交接給 Scheduler
            scrapedArticles.push({
                url: articleUrl,
                title: title,
                content: content,
                symbols: symbols
            });
            
            // 防禦性延遲 (隨機 1~3 秒)
            await new Promise(res => setTimeout(res, 1000 + Math.random() * 2000));
        }

        logger.info(`✅ [Extract] 經濟日報 本板塊掃描完畢，共萃取 ${scrapedArticles.length} 篇新新聞。`);

    } catch (error) {
        logger.error(`❌ [Extract] 經濟日報 掃描發生錯誤 | 錯誤: ${error.message}`);
    }

    return scrapedArticles;
}

/**
 * 爬蟲主程式 (供 Scheduler 呼叫)
 * @returns {Array} 包含所有新爬取文章的陣列
 */
async function scrape() {
    logger.info('==================================================');
    logger.info('🚀 經濟日報 爬蟲啟動 (啟動 ETL Extract 階段 - 多板塊)');
    logger.info('==================================================');

    let allNewArticles = [];

    // 依序掃描陣列中的每個目標網址
    for (const url of TARGET_URLS) {
        const articles = await scrapeCategory(url);
        
        // 如果有抓到新文章，就合併進總陣列
        if (articles && articles.length > 0) {
            allNewArticles = allNewArticles.concat(articles);
        }
        
        // 切換板塊時休息 2~4 秒，避免被當成攻擊封鎖 IP
        await new Promise(res => setTimeout(res, 2000 + Math.random() * 2000));
    }

    logger.info(`🏁 [Extract] 經濟日報 全板塊爬取完畢！共將交接 ${allNewArticles.length} 篇原始新聞給 AI 進行 Q4 濃縮。`);
    
    return allNewArticles;
}

// 匯出 scrape 函數給 scheduler 統一調度
module.exports = { scrape };