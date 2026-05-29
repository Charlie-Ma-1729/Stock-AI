const yahooFinance = require('yahoo-finance2').default;
const twstock = require('node-twstock');
const axios = require('axios');
const logger = require('../logger');

// ==========================================
// 🇺🇸 模組 1：Yahoo Finance (專攻美股、大盤指數、ADR)
// ==========================================
async function getGlobalIndices() {
    logger.info('📊 [Market API] 正在獲取全球重要指數與 ADR...');
    // 定義要觀察的總經指標與重要 ADR
    const symbols = [
        '^TWII', // 台灣加權指數
        '^DJI',  // 道瓊工業指數
        '^IXIC', // 那斯達克指數
        '^SOX',  // 費城半導體指數
        'TSM',   // 台積電 ADR
        'NVDA'   // 輝達
    ];

    const results = {};
    try {
        for (const sym of symbols) {
            const quote = await yahooFinance.quote(sym);
            results[sym] = {
                name: quote.shortName || sym,
                price: quote.regularMarketPrice,
                change: quote.regularMarketChange,
                changePercent: (quote.regularMarketChangePercent || 0).toFixed(2) + '%',
                marketState: quote.marketState // 判斷目前是開盤(REGULAR)還是收盤(CLOSED)
            };
        }
        return results;
    } catch (error) {
        logger.error(`❌ [Market API] 獲取 Yahoo Finance 數據失敗: ${error.message}`);
        return null;
    }
}

// ==========================================
// 🇹🇼 模組 2：Node-Twstock (專攻台股特定個股即時報價)
// ==========================================
async function getTaiwanStocksRealtime(stockIds = ['2330', '2317', '2454']) {
    logger.info(`📊 [Market API] 正在獲取台股即時報價: ${stockIds.join(', ')}...`);
    try {
        // 使用 node-twstock 抓取台股即時資料
        const stocks = await twstock.realtime.get(stockIds);
        
        if (!stocks.success) {
            throw new Error(stocks.rtmessage);
        }

        const results = {};
        for (const [id, data] of Object.entries(stocks.data)) {
            const info = data.info;
            const realtime = data.realtime;
            
            // 計算漲跌幅
            const currentPrice = parseFloat(realtime.latest_trade_price) || parseFloat(realtime.best_bid_price[0]);
            const openPrice = parseFloat(realtime.open);
            const change = currentPrice - openPrice;
            const changePercent = ((change / openPrice) * 100).toFixed(2) + '%';

            results[info.symbol] = {
                name: info.name,
                price: currentPrice,
                change: change.toFixed(2),
                changePercent: changePercent,
                time: info.time
            };
        }
        return results;
    } catch (error) {
        logger.error(`❌ [Market API] 獲取台股即時報價失敗: ${error.message}`);
        return null;
    }
}

// ==========================================
// 🏦 模組 3：證交所 OpenAPI (專攻三大法人籌碼)
// ==========================================
async function getInstitutionalInvestors() {
    logger.info('📊 [Market API] 正在獲取台股三大法人買賣超數據...');
    try {
        // 直接打證交所 API 拿最準的官方資料
        const response = await axios.get('https://www.twse.com.tw/fund/BFI82U?response=json');
        const data = response.data;
        
        if (data.stat !== 'OK') {
            return '今日三大法人數據尚未公布或獲取失敗。';
        }

        // data.data 陣列最後一筆是「三大法人買賣超總計」
        // 格式通常為: ['自營商(自行買賣)', '買進', '賣出', '差額']
        const summary = data.data.map(row => `${row[0]}: 買賣超 ${row[3]} 元`).join(' | ');
        return summary;
    } catch (error) {
        logger.error(`❌ [Market API] 獲取三大法人數據失敗: ${error.message}`);
        return '無法獲取三大法人數據。';
    }
}

// ==========================================
// 🚀 統整輸出接口：供 AI 報告排程器呼叫
// ==========================================
/**
 * 統整當下所需的市場數據切片
 * @param {boolean} includeInstitutional - 是否需要抓取三大法人 (通常 18:00 盤後報告才需要)
 * @param {boolean} includeTwStock - 是否需要抓取台股三雄即時狀態 (盤中報告用)
 */
async function getMarketSnapshot(includeInstitutional = false, includeTwStock = true) {
    const snapshot = {
        timestamp: new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' }),
        global_indices: await getGlobalIndices()
    };

    // 盤中/收盤 觀察台股三雄 (台積電、鴻海、聯發科) 當作台股溫度計
    if (includeTwStock) {
        snapshot.taiwan_top_stocks = await getTaiwanStocksRealtime(['2330', '2317', '2454']);
    }

    // 盤後 觀察三大法人動向
    if (includeInstitutional) {
        snapshot.institutional_investors = await getInstitutionalInvestors();
    }

    return snapshot;
}

module.exports = {
    getMarketSnapshot
};