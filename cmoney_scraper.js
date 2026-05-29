const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
// 注意：移除了 saveNewsWithTags，因為寫入資料庫的工作已經交由 scheduler (ETL的Load階段) 處理
// 保留 isArticleExists 用於判斷是否遇到舊新聞，以提早中斷爬蟲
const { isArticleExists } = require('./db');
const logger = require('./logger');

// ==========================================
// 📚 載入台美股字典 (確保已執行過更新字典腳本)
// ==========================================
let twStocks = {};
let usStocks = {};

// 若執行目錄不同，建議使用絕對路徑或確保相對路徑正確
const twDictPath = path.join(__dirname, 'tw_stocks.json');
const usDictPath = path.join(__dirname, 'us_stocks.json');

if (fs.existsSync(twDictPath)) {
    twStocks = require(twDictPath);
} else {
    logger.warn('⚠️ 找不到 tw_stocks.json！請確認是否已執行 update_twse_dict.js');
}

if (fs.existsSync(usDictPath)) {
    usStocks = require(usDictPath);
} else {
    logger.warn('⚠️ 找不到 us_stocks.json！請確認是否已執行 update_us_dict.js');
}

// 必備微型黑名單：防止與美股真實代號或常見財經字眼撞名
const SYMBOL_BLACKLIST = new Set([
    'YOY', 'MOM', 'EPS', 'Q1', 'Q2', 'Q3', 'Q4', 
    'VIP', 'FED', 'BBU', 'CPO', 'CSP', 'APP', 'IPO', 'AI', 'ETF'
]);

const BASE_URL = 'https://cmnews.com.tw';
const TARGET_URLS = [
    'https://cmnews.com.tw/twstock/twstock_news',
    'https://cmnews.com.tw/twstock/twstock_report',
    'https://cmnews.com.tw/twstock/twstock_column',
    'https://cmnews.com.tw/twstock/twstock_fund_etf_future_material',
    'https://cmnews.com.tw/usstock/usstock_english',
    'https://cmnews.com.tw/usstock/usstock_news',
    'https://cmnews.com.tw/usstock/usstock_column'
];

/**
 * 深度解析文章頁面：抓取內文 + Regex 盲抓 + 字典驗證
 */
async function parseArticlePage(url, articleTitle) {
    try {
        const { data } = await axios.get(url);
        const $ = cheerio.load(data);
        
        // 取得內文並清洗多餘空白
        const content = $('.articleContent__textContent').text().replace(/\s+/g, ' ').trim();
        const rawSymbols = new Set();

        // 1. 抓取帶有超連結的絕對精準代號 (CMoney 編輯有上連結的個股)
        $('a[href*="/forum/stock/"]').each((i, el) => {
            const href = $(el).attr('href');
            const match = href.match(/\/forum\/stock\/([A-Z0-9]+)/i);
            if (match) rawSymbols.add(match[1].toUpperCase());
        });

        // 2. 從文章底部的標籤區塊盲抓
        $('.articleContent__tagWrapper a.tagLink__link').each((i, el) => {
            const tagText = $(el).text().trim().toUpperCase();
            const parenMatch = tagText.match(/\(([A-Z0-9]{2,6})\)/); 
            if (parenMatch) {
                rawSymbols.add(parenMatch[1]);
            } else {
                rawSymbols.add(tagText);
            }
        });

        // 3. 從標題與內文中，盲抓所有括號內的特徵，例如 "(2330)", "(AAOI)", "(2026)"
        const textToScan = articleTitle + " " + content;
        const regex = /\(([A-Z0-9]{2,6})\)/g;
        let match;
        while ((match = regex.exec(textToScan)) !== null) {
            rawSymbols.add(match[1].toUpperCase());
        }

        // ==========================================
        // 🛡️ 雙字典終極驗證階段
        // ==========================================
        const verifiedSymbols = [];

        for (const sym of rawSymbols) {
            // 排除黑名單雜訊
            if (SYMBOL_BLACKLIST.has(sym)) continue;

            // 查驗台股字典
            if (twStocks[sym]) {
                verifiedSymbols.push(sym);
            } 
            // 查驗美股字典
            else if (usStocks[sym]) {
                verifiedSymbols.push(sym);
            }
            // 若皆不在字典中 (如年份 "2026", 權證代號)，則直接捨棄，達到零假陽性
        }

        return { content, symbols: verifiedSymbols };

    } catch (error) {
        logger.error(`❌ 無法解析文章頁面: ${url} | 錯誤: ${error.message}`);
        return { content: '', symbols: [] };
    }
}

/**
 * 爬取單一板塊，並將結果收集成陣列回傳
 */
async function scrapeCategory(listUrl) {
    logger.info(`🔍 [Extract] 開始掃描板塊: ${listUrl}`);
    const scrapedArticles = [];
    
    try {
        const { data } = await axios.get(listUrl);
        const $ = cheerio.load(data);
        const cards = $('.articleCard').toArray();
        
        if (cards.length === 0) {
            logger.warn(`⚠️ [異常] 此板塊抓不到任何新聞卡片，請檢查網頁是否改版: ${listUrl}`);
            return scrapedArticles; // 回傳空陣列
        }

        for (const card of cards) {
            const $card = $(card);
            let relativeUrl = $card.find('a.z-link').attr('href');
            if (!relativeUrl) continue;
            
            const articleUrl = relativeUrl.startsWith('http') ? relativeUrl : BASE_URL + relativeUrl;
            
            // 【停止條件】遇到已存入資料庫的文章，代表後續皆為舊聞，跳出此板塊
            if (isArticleExists(articleUrl)) {
                logger.info(`🛑 [Extract] 遇到已存在 DB 的舊新聞，停止掃描本板塊。`);
                break; 
            }

            const title = $card.find('.articleCard__title').text().trim();

            // 進入文章解析與字典驗證引擎
            const { content, symbols } = await parseArticlePage(articleUrl, title);

            // 組合顯示文字 (若在字典中可順便印出公司名稱方便肉眼檢查)
            const displaySymbols = symbols.map(s => {
                if (twStocks[s]) return `${twStocks[s]}(${s})`;
                if (usStocks[s]) return `${usStocks[s]}(${s})`;
                return s;
            });

            logger.info(`📥 [Extract] 萃取成功: [${title}]`);
            logger.info(`   🏷️ 關聯代號: ${displaySymbols.length > 0 ? displaySymbols.join(', ') : '無'}`);

            if (!content || content.length === 0) {
                logger.warn(`⚠️ [異常] 抓取到空內文: ${articleUrl}`);
            }

            // 將萃取好的資料推入陣列，等待回傳給排程器處理
            scrapedArticles.push({
                url: articleUrl,
                title: title,
                content: content,
                symbols: symbols
            });
            
            // 防禦性延遲 (隨機 1~3 秒) 避免被封鎖
            await new Promise(res => setTimeout(res, 1000 + Math.random() * 2000));
        }

        logger.info(`✅ [Extract] 板塊掃描完畢，本板塊共萃取 ${scrapedArticles.length} 篇新文章。`);

    } catch (error) {
        logger.error(`❌ [Extract] 板塊掃描發生錯誤: ${listUrl} | 錯誤: ${error.message}`);
    }

    return scrapedArticles;
}

/**
 * 爬蟲主程式 (供 Scheduler 呼叫)
 * @returns {Array} 包含所有新爬取文章的陣列
 */
async function scrape() {
    logger.info('==================================================');
    logger.info('🚀 CMoney 多板塊爬蟲啟動 (啟動 ETL Extract 階段)');
    logger.info('==================================================');
    
    let allNewArticles = [];

    for (const url of TARGET_URLS) {
        const articles = await scrapeCategory(url);
        if (articles && articles.length > 0) {
            allNewArticles = allNewArticles.concat(articles);
        }
        // 切換板塊時休息 2~4 秒
        await new Promise(res => setTimeout(res, 2000 + Math.random() * 2000));
    }

    logger.info(`🏁 [Extract] CMoney 全板塊爬取完畢！共將交接 ${allNewArticles.length} 篇原始新聞給 AI 進行 Q4 濃縮。`);
    
    // 回傳給 scheduler
    return allNewArticles;
}

// 匯出 scrape 函數給 scheduler 統一調度
module.exports = { scrape };