const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const { isArticleExists, saveNewsWithTags } = require('../db');
const logger = require('../logger');

// ==========================================
// 📚 載入台美股字典 (確保已執行過更新字典腳本)
// ==========================================
let twStocks = {};
let usStocks = {};

if (fs.existsSync('./tw_stocks.json')) {
    twStocks = require('./tw_stocks.json');
} else {
    logger.warn('⚠️ 找不到 tw_stocks.json！請確認是否已執行 update_twse_dict.js');
}

if (fs.existsSync('./us_stocks.json')) {
    usStocks = require('./us_stocks.json');
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
        logger.error(`無法解析文章頁面: ${url} | 錯誤: ${error.message}`);
        return { content: '', symbols: [] };
    }
}

/**
 * 爬取單一板塊
 */
async function scrapeCategory(listUrl) {
    logger.info(`🔍 開始掃描板塊: ${listUrl}`);
    
    try {
        const { data } = await axios.get(listUrl);
        const $ = cheerio.load(data);
        const cards = $('.articleCard').toArray();
        
        if (cards.length === 0) {
            logger.warn(`⚠️ [異常] 此板塊抓不到任何新聞卡片，請檢查網頁是否改版: ${listUrl}`);
            return;
        }

        let newArticleCount = 0;

        for (const card of cards) {
            const $card = $(card);
            let relativeUrl = $card.find('a.z-link').attr('href');
            if (!relativeUrl) continue;
            
            const articleUrl = relativeUrl.startsWith('http') ? relativeUrl : BASE_URL + relativeUrl;
            
            // 【停止條件】遇到已存入資料庫的文章，代表後續皆為舊聞，跳出此板塊
            if (isArticleExists(articleUrl)) {
                logger.info(`🛑 遇到已存入的新聞，跳出本板塊掃描。`);
                break; 
            }

            const title = $card.find('.articleCard__title').text().trim();
            const summary = $card.find('.articleCard__desc').text().trim();

            // 進入文章解析與字典驗證引擎
            const { content, symbols } = await parseArticlePage(articleUrl, title);

            // 組合顯示文字 (若在字典中可順便印出公司名稱方便肉眼檢查)
            const displaySymbols = symbols.map(s => {
                if (twStocks[s]) return `${twStocks[s]}(${s})`;
                if (usStocks[s]) return `${usStocks[s]}(${s})`;
                return s;
            });

            logger.info(`📥 處理中: [${title}]`);
            logger.info(`   🏷️ 萃取代號: ${displaySymbols.length > 0 ? displaySymbols.join(', ') : '無'}`);

            if (!content || content.length === 0) {
                logger.warn(`⚠️ [異常] 抓取到空內文: ${articleUrl}`);
            }

            // 存入資料庫
            saveNewsWithTags({
                url: articleUrl,
                title: title,
                summary: summary,
                content: content
            }, symbols);

            newArticleCount++;
            
            // 防禦性延遲 (隨機 1~3 秒)
            await new Promise(res => setTimeout(res, 1000 + Math.random() * 2000));
        }

        logger.info(`✅ 板塊掃描完畢，共新增 ${newArticleCount} 篇新聞。`);

    } catch (error) {
        logger.error(`❌ 板塊掃描發生錯誤: ${listUrl} | 錯誤: ${error.message}`);
    }
}

/**
 * 爬蟲主程式啟動點
 */
async function startCMoneyScraper() {
    logger.info('==================================================');
    logger.info('🚀 CMoney 多板塊爬蟲啟動 (搭載台美雙字典驗證)');
    logger.info('==================================================');

    for (const url of TARGET_URLS) {
        await scrapeCategory(url);
        // 切換板塊時休息 2~4 秒
        await new Promise(res => setTimeout(res, 2000 + Math.random() * 2000));
    }

    logger.info('🏁 所有板塊爬取完畢！');
}

// 執行
startCMoneyScraper();