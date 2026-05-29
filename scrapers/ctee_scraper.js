const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const { isArticleExists, saveNewsWithTags } = require('../db');
const logger = require('../logger');

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
    // 台灣很多股票有 -KY，媒體常省略，所以我們建立兩組對照
    if (name.includes('-KY')) {
        nameToSymbol[name.replace('-KY', '')] = sym;
    }
}

// 必備微型黑名單：只防止與美股真實代號或財經術語撞名
const SYMBOL_BLACKLIST = new Set([
    'YOY', 'MOM', 'EPS', 'Q1', 'Q2', 'Q3', 'Q4', 
    'VIP', 'FED', 'BBU', 'CPO', 'CSP', 'APP', 'IPO', 'AI', 'ETF'
]);

// 名稱黑名單 (極度輕量化)：工商時報含金量高，只排除最容易誤判的生活名詞
const NAME_BLACKLIST = new Set([
    '統一', '幸福', '地球', '全國', '卓越', '立德', '世界', '未來'
]);

const CTEE_NEWS_URL = 'https://www.ctee.com.tw/livenews';
const BASE_URL = 'https://www.ctee.com.tw';

/**
 * 深度解析 工商時報 文章頁面
 */
async function parseCteeArticlePage(url, articleTitle) {
    try {
        const { data } = await axios.get(url);
        const $ = cheerio.load(data);
        
        // 抓取內文：工商時報內文主要包在 <article> 中的 <p> 標籤
        let content = $('article p').text().replace(/\s+/g, ' ').trim();
        // 容錯機制：如果沒有 p 標籤，直接抓整個 article
        if (!content) {
            content = $('article').text().replace(/\s+/g, ' ').trim();
        }
        
        const rawSymbols = new Set();

        // 🎯 策略 A：從文章底部標籤抓取
        $('.taglist__item a').each((i, el) => {
            const tagText = $(el).text().trim().toUpperCase();
            
            // 1. 找括號內代號
            const parenMatch = tagText.match(/[\(（]([A-Z0-9]{2,6})[\)）]/); 
            if (parenMatch) {
                rawSymbols.add(parenMatch[1]);
            } 
            // 2. 找純代號 (如 2330)
            else if (/^[A-Z0-9]{2,6}$/.test(tagText)) {
                rawSymbols.add(tagText);
            } 
            // 3. 找純名稱 (如 "東捷") -> 查反向字典
            else if (nameToSymbol[tagText]) {
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

        // 🎯 策略 D：從「標題」進行名稱直接比對 (解決小編完全沒寫代號的狀況)
        for (const [name, sym] of Object.entries(nameToSymbol)) {
            // 名字必須超過 1 個字，且不在日常詞彙黑名單內
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
        logger.error(`無法解析 工商時報 文章頁面: ${url} | 錯誤: ${error.message}`);
        return { content: '', symbols: [] };
    }
}

/**
 * 爬取 工商時報 即時新聞列表
 */
async function scrapeCteeNews() {
    logger.info(`🔍 開始掃描 工商時報 即時新聞: ${CTEE_NEWS_URL}`);
    
    try {
        const { data } = await axios.get(CTEE_NEWS_URL);
        const $ = cheerio.load(data);
        
        // 抓取列表頁的卡片
        const cards = $('.newslist__card').toArray();
        
        if (cards.length === 0) {
            logger.warn(`⚠️ [異常] 抓不到任何 工商時報 新聞卡片，請檢查 DOM 結構是否改變。`);
            return;
        }

        let newArticleCount = 0;

        for (const card of cards) {
            const $card = $(card);
            
            // 抓取連結與標題
            const $linkEl = $card.find('h3.news-title a');
            let relativeUrl = $linkEl.attr('href');
            const title = $linkEl.text().trim();
            // 工商時報的列表卡片沒有摘要段落，直接留空即可
            const summary = ''; 

            if (!relativeUrl || !title) continue;
            
            // 補全相對路徑 (例如: /news/20260529700700-430201 -> https://www.ctee.com.tw/news/...)
            const articleUrl = relativeUrl.startsWith('http') ? relativeUrl : BASE_URL + relativeUrl;

            // 防呆過濾：只允許 CTEE 內部新聞連結
            if (!articleUrl.startsWith(BASE_URL)) {
                continue;
            }
            
            // 【停止條件】遇到已存入資料庫的文章，代表後續皆為舊聞，跳出掃描
            if (isArticleExists(articleUrl)) {
                logger.info(`🛑 遇到已存入的 工商時報 新聞，掃描結束。`);
                break; 
            }

            // 進入文章解析與字典驗證引擎
            const { content, symbols } = await parseCteeArticlePage(articleUrl, title);

            const displaySymbols = symbols.map(s => {
                if (twStocks[s]) return `${twStocks[s]}(${s})`;
                if (usStocks[s]) return `${usStocks[s]}(${s})`;
                return s;
            });

            logger.info(`📥 [CTEE] 處理中: [${title}]`);
            logger.info(`   🏷️ 萃取代號: ${displaySymbols.length > 0 ? displaySymbols.join(', ') : '無'}`);

            if (!content || content.length === 0) {
                logger.warn(`⚠️ [異常] 抓取到空內文 (可能是特殊排版): ${articleUrl}`);
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

        logger.info(`✅ 工商時報 新聞掃描完畢，共新增 ${newArticleCount} 篇新聞。`);

    } catch (error) {
        logger.error(`❌ 工商時報 掃描發生錯誤 | 錯誤: ${error.message}`);
    }
}

/**
 * 爬蟲主程式啟動點
 */
async function startCteeScraper() {
    logger.info('==================================================');
    logger.info('🚀 工商時報 爬蟲啟動 (輕量化黑名單 + 全方位智慧反查)');
    logger.info('==================================================');

    await scrapeCteeNews();

    logger.info('🏁 工商時報 爬取完畢！');
}

// 執行
startCteeScraper();