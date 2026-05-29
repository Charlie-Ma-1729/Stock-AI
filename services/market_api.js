const yahooFinance = require('yahoo-finance2').default;
const axios = require('axios');
const logger = require('../logger');

// === 核心修正：正確實例化 ===
const yf = new yahooFinance({ suppressNotices: ['yahooSurvey'] });

// ==========================================
// 🇺🇸 模組 1：Yahoo Finance (保持原樣)
// ==========================================
async function getGlobalIndices() {
    logger.info('📊 [Market API] 正在獲取全球重要指數與 ADR...');
    const symbols = ['^TWII', '^DJI', '^IXIC', '^SOX', 'TSM', 'NVDA'];
    const results = {};
    try {
        for (const sym of symbols) {
            const quote = await yf.quote(sym);
            results[sym] = {
                name: quote.shortName || sym,
                price: quote.regularMarketPrice,
                change: quote.regularMarketChange,
                changePercent: (quote.regularMarketChangePercent || 0).toFixed(2) + '%',
                marketState: quote.marketState
            };
        }
        return results;
    } catch (error) {
        logger.error(`❌ [Market API] Yahoo Finance 錯誤: ${error.message}`);
        return null;
    }
}

// ==========================================
// 🇹🇼 模組 2：直接抓取 Yahoo Finance 台股資料 (取代 node-twstock)
// ==========================================
async function getTaiwanStocksRealtime(stockIds = ['2330', '2317', '2454']) {
    logger.info(`📊 [Market API] 正在獲取台股即時報價: ${stockIds.join(', ')}...`);
    const results = {};
    try {
        for (const id of stockIds) {
            // 台股在 Yahoo Finance 的代號需要加上 .TW
            const symbol = `${id}.TW`;
            const quote = await yf.quote(symbol);
            results[id] = {
                name: quote.shortName || id,
                price: quote.regularMarketPrice,
                change: quote.regularMarketChange,
                changePercent: (quote.regularMarketChangePercent || 0).toFixed(2) + '%',
                time: new Date().toLocaleTimeString()
            };
        }
        return results;
    } catch (error) {
        logger.error(`❌ [Market API] 台股即時報價失敗: ${error.message}`);
        return null;
    }
}

// ==========================================
// 🏦 模組 3：證交所 OpenAPI
// ==========================================
async function getInstitutionalInvestors() {
    logger.info('📊 [Market API] 正在獲取台股三大法人買賣超數據...');
    try {
        const response = await axios.get('https://www.twse.com.tw/fund/BFI82U?response=json', {
            headers: { 'User-Agent': 'Mozilla/5.0' }
        });
        const data = response.data;
        if (data.stat !== 'OK') return '今日三大法人數據尚未公布。';
        return data.data.map(row => `${row[0]}: 買賣超 ${row[3]} 元`).join(' | ');
    } catch (error) {
        logger.error(`❌ [Market API] 獲取三大法人失敗: ${error.message}`);
        return '無法獲取三大法人數據。';
    }
}

// ==========================================
// 🚀 統整輸出
// ==========================================
async function getMarketSnapshot(includeInstitutional = false, includeTwStock = true) {
    const snapshot = {
        timestamp: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
        global_indices: await getGlobalIndices()
    };
    if (includeTwStock) {
        snapshot.taiwan_top_stocks = await getTaiwanStocksRealtime();
    }
    if (includeInstitutional) {
        snapshot.institutional_investors = await getInstitutionalInvestors();
    }
    return snapshot;
}

module.exports = { getMarketSnapshot };