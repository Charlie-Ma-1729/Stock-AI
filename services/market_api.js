// services/market_api.js
// ==========================================================================
// 🌟 [修復]: 依照 v2 最新規範執行實例化，並傳入 suppressNotices 徹底壓制問卷提示
// ==========================================================================
const YahooFinance = require('yahoo-finance2').default || require('yahoo-finance2');
const yahooFinance = new YahooFinance({
    suppressNotices: ['yahooSurvey'] // 👈 完美修復並隱藏終端機的煩人調查提示
}); 

const axios = require('axios');
const logger = require('../logger');

/**
 * 🇺🇸 模組 1：Yahoo Finance (全球宏觀指數)
 * 抓取台美股重要指數、權值股 ADR，用以輔助大腦研判全球大局情緒與泡沫化跡象
 */
async function getGlobalIndices() {
    logger.info('📊 [Market API] 🌐 正在獲取全球重要指數與 ADR...');
    const symbols = ['^TWII', '^DJI', '^IXIC', '^SOX', 'TSM', 'NVDA'];
    const results = {};
    const startTime = Date.now();
    try {
        for (const sym of symbols) {
            const quote = await yahooFinance.quote(sym);
            results[sym] = {
                name: quote.shortName || sym,
                price: quote.regularMarketPrice,
                change: quote.regularMarketChange,
                changePercent: (quote.regularMarketChangePercent || 0).toFixed(2) + '%',
                marketState: quote.marketState
            };
        }
        logger.info(`📊 [Market API] ✅ 全球指數獲取完成 (耗時: ${((Date.now() - startTime) / 1000).toFixed(2)}s)`);
        return results;
    } catch (error) {
        logger.error(`❌ [Market API] 全球指數獲取錯誤: ${error.message}`);
        return null;
    }
}

/**
 * 🇹🇼 模組 2：直接抓取 Yahoo Finance 台股預設指標即時資料
 * 提供大盤最核心的三大權值走勢快照
 */
async function getTaiwanStocksRealtime(stockIds = ['2330', '2317', '2454']) {
    logger.info(`📊 [Market API] 🇹🇼 正在獲取台股預設指標即時報價: [${stockIds.join(', ')}]...`);
    const results = {};
    const startTime = Date.now();
    try {
        for (const id of stockIds) {
            const symbol = `${id}.TW`;
            const quote = await yahooFinance.quote(symbol);
            results[id] = {
                name: quote.shortName || id,
                price: quote.regularMarketPrice,
                change: quote.regularMarketChange,
                changePercent: (quote.regularMarketChangePercent || 0).toFixed(2) + '%',
                time: new Date().toLocaleTimeString()
            };
        }
        logger.info(`📊 [Market API] ✅ 台股指標獲取完成 (耗時: ${((Date.now() - startTime) / 1000).toFixed(2)}s)`);
        return results;
    } catch (error) {
        logger.error(`❌ [Market API] 台股即時報價失敗: ${error.message}`);
        return null;
    }
}

/**
 * 🏦 模組 3：證交所 OpenAPI (三大法人買賣超)
 * 用於盤後推理主力與散戶對做、利多出盡或主力鎖碼的底層數據
 */
async function getInstitutionalInvestors() {
    logger.info('📊 [Market API] 🏦 正在向證交所請求三大法人數據...');
    try {
        const response = await axios.get('https://www.twse.com.tw/fund/BFI82U?response=json', {
            headers: { 'User-Agent': 'Mozilla/5.0' },
            timeout: 5000 
        });
        const data = response.data;
        if (data.stat !== 'OK') {
            logger.warn('⚠️ [Market API] 證交所回傳格式不符或今日尚未公布數據。');
            return '今日三大法人數據尚未公布。';
        }
        logger.info('📊 [Market API] ✅ 三大法人數據獲取成功。');
        return data.data.map(row => `${row[0]}: 買賣超 ${row[3]} 元`).join(' | ');
    } catch (error) {
        logger.error(`❌ [Market API] 獲取三大法人失敗: ${error.message}`);
        return '無法獲取三大法人數據。';
    }
}

/**
 * 🎯 模組 4：動態標的數據查詢 (AI 精選個股後，專用精準查詢版)
 * 為 AI 預留買賣超前 15 名主力分點與地緣分點追蹤結構
 */
async function fetchTargetsData(targets, symbols) {
    if (!symbols || !Array.isArray(symbols) || symbols.length === 0) {
        logger.warn('⚠️ [Market API] 收到空代號陣列，跳過動態數據抓取。');
        return {};
    }

    logger.info(`🎯 [Market API] 📥 接收到精準代號抓取請求，共 ${symbols.length} 筆: [${symbols.join(', ')}]`);
    const results = {};
    const startTime = Date.now();
    let successCount = 0;
    
    for (let i = 0; i < symbols.length; i++) {
        const symbol = symbols[i];
        const targetName = targets[i] || symbol;
        
        logger.info(`  🔍 [查詢中] 正在獲取 ${targetName} (${symbol}) 報價與深度籌碼...`);
        try {
            const quote = await yahooFinance.quote(symbol);
            
            // 基礎報價與技術指標資料
            results[targetName] = {
                symbol: symbol,                                    
                name: quote.shortName || quote.longName || targetName, 
                price: quote.regularMarketPrice,                   
                changePercent: (quote.regularMarketChangePercent || 0).toFixed(2) + '%', 
                volume: quote.regularMarketVolume,                 
                peRatio: quote.trailingPE ? quote.trailingPE.toFixed(2) : 'N/A',         
                fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh,          
                fiftyTwoWeekLow: quote.fiftyTwoWeekLow,
                
                // 深度籌碼擴充區預留欄位，未來可對接爬蟲注入
                chips_analysis: {
                    top_15_buyers: [
                        { broker: "地緣主力分點A", volume_buy: "預留欄位", strategy: "波段鎖碼" },
                        { broker: "外資分點", volume_buy: "預留欄位", strategy: "外資隔日沖" }
                    ],
                    top_15_sellers: [
                        { broker: "主力倒貨分點", volume_sell: "預留欄位", strategy: "短線倒貨" }
                    ],
                    summary_status: "籌碼高度集中 / 主力暗中出貨給散戶 / 擦鞋童過熱" 
                }
            };
            logger.info(`  ✅ [成功] ${targetName}: 現價 ${quote.regularMarketPrice} (${results[targetName].changePercent})`);
            successCount++;
        } catch (error) {
            logger.error(`  ❌ [失敗] 無法獲取 ${targetName} (${symbol}) 報價: ${error.message}`);
            results[targetName] = `獲取失敗: 代號可能有誤或查無資料`;
        }
    }
    
    const duration = ((Date.now() - startTime) / 1000).toFixed(2);
    logger.info(`🎯 [Market API] 🏁 動態抓取任務結束。成功: ${successCount}/${symbols.length} 筆 (耗時: ${duration}s)`);
    return results;
}

/**
 * 📈 模組 5：個股即時走勢與報價速查 (供 Discord !查 指令使用)
 * 智能判斷台美股，並抓取近 1 個月歷史收盤價，計算月線(20MA)供 AI 判讀
 */
async function fetchStockTrend(rawSymbol) {
    // 智能判斷：若字串全是數字，或數字開頭加上英文字母(如 00981A)，且沒有小數點，自動加上 .TW 視為台股
    let symbol = rawSymbol.toUpperCase();
    if (/^\d{4,6}[A-Z]?$/.test(symbol)) {
        symbol = `${symbol}.TW`;
    }

    logger.info(`🔍 [Market API] 啟動即時查價，目標標的: ${symbol}...`);
    try {
        // 1. 抓取即時報價
        const quote = await yahooFinance.quote(symbol);
        
        // 2. 抓取歷史走勢 (近 30 天)
        const period1 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); 
        const historical = await yahooFinance.historical(symbol, { period1 });
        
        // 3. 整理近期的收盤價走勢 (提取近 10 個交易日供 AI 速評)
        const recentTrend = historical.slice(-10).map(day => ({
            date: day.date.toISOString().split('T')[0], // 轉為 YYYY-MM-DD
            close: day.close.toFixed(2),
            volume: day.volume
        }));

        // 4. 計算月線簡單均價 (20MA) 作為趨勢支撐/壓力參考
        const closes = historical.map(d => d.close);
        const monthlyAvg = closes.length > 0 ? (closes.reduce((sum, val) => sum + val, 0) / closes.length).toFixed(2) : 'N/A';

        logger.info(`✅ [Market API] 成功獲取 ${symbol} 走勢資料，現價: ${quote.regularMarketPrice}`);
        
        return {
            symbol: symbol,
            name: quote.shortName || quote.longName || symbol,
            currentPrice: quote.regularMarketPrice,
            change: quote.regularMarketChange,
            changePercent: (quote.regularMarketChangePercent || 0).toFixed(2) + '%',
            volume: quote.regularMarketVolume,
            peRatio: quote.trailingPE ? quote.trailingPE.toFixed(2) : 'N/A',
            fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh,
            fiftyTwoWeekLow: quote.fiftyTwoWeekLow,
            monthlyAvgPrice: monthlyAvg,
            recentTrend: recentTrend
        };
    } catch (error) {
        logger.error(`❌ [Market API] 獲取 ${symbol} 走勢失敗: ${error.message}`);
        return { error: true, message: error.message };
    }
}

/**
 * 🚀 統整輸出市場快照
 */
async function getMarketSnapshot(includeInstitutional = false, includeTwStock = true) {
    logger.info('==================================================');
    logger.info('📈 [Market API] 啟動市場快照打包程序...');
    const snapshotStartTime = Date.now();

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
    
    logger.info(`📈 [Market API] 📦 市場快照打包完成 (總耗時: ${((Date.now() - snapshotStartTime) / 1000).toFixed(2)}s)`);
    logger.info('==================================================');
    return snapshot;
}

module.exports = { getMarketSnapshot, fetchTargetsData, fetchStockTrend };