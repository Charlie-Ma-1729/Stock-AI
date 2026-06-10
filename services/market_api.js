// services/market_api.js
// ==========================================================================
// 🌟 [修復]: 加入 ripHistorical 徹底壓制 API 棄用的煩人警告
// ==========================================================================
const YahooFinance = require('yahoo-finance2').default || require('yahoo-finance2');
const yahooFinance = new YahooFinance({
    suppressNotices: ['yahooSurvey', 'ripHistorical'] // 👈 靜音問卷與 Historical 棄用警告
}); 

const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('../logger');

// ==========================================
// 📖 字典載入 (供查價模組反查代號使用)
// ==========================================
const twDictPath = path.join(__dirname, '../tw_stocks.json');
const usDictPath = path.join(__dirname, '../us_stocks.json');
let stockLookupMap = {}; // 格式將為: { "雙鴻": "3324", "台積電": "2330", "輝達": "NVDA" }

// 🌟 同步 bot.js 的名稱淨化功能 (去除星號等特殊字元)
const cleanName = (str) => {
    if (!str) return '';
    return str.toString().replace(/[*＊+＋]/g, '').trim();
};

function parseDictionary(data) {
    if (Array.isArray(data)) {
        data.forEach(item => {
            const sym = item.symbol || item.Symbol || item.Ticker || item.代號;
            const rawName = item.name || item.Name || item.名稱 || item.股名;
            if (sym && rawName) {
                const name = cleanName(rawName);
                // 移除原有的 .TW 或 .TWO，保留純代號
                const cleanSym = sym.toString().replace(/\.TW|\.TWO/gi, '');
                stockLookupMap[name] = cleanSym; 
                stockLookupMap[cleanSym] = name; // 反向映射也存一份，供走馬燈使用
            }
        });
    } else if (typeof data === 'object') {
        for (const [k, v] of Object.entries(data)) {
            let name, sym;
            // 判斷誰是代號 (純英數)
            if (/^[A-Za-z0-9]+$/.test(k) && !/^[A-Za-z0-9]+$/.test(v)) {
                sym = k; name = cleanName(v);
            } else {
                sym = v; name = cleanName(k); // 預設 k 是中文
            }
            const cleanSym = sym.toString().replace(/\.TW|\.TWO/gi, '');
            stockLookupMap[name] = cleanSym;
            stockLookupMap[cleanSym] = name;
        }
    }
}

try {
    if (fs.existsSync(twDictPath)) parseDictionary(JSON.parse(fs.readFileSync(twDictPath, 'utf-8')));
    if (fs.existsSync(usDictPath)) parseDictionary(JSON.parse(fs.readFileSync(usDictPath, 'utf-8')));
    logger.info('📖 [Market API] 字典載入成功，已啟用「中文名稱反查代號」機制。');
} catch (e) {
    logger.error(`❌ [Market API] 字典載入失敗: ${e.message}`);
}

/**
 * 🇺🇸 模組 1：Yahoo Finance (全球宏觀指數)
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
 * 🇹🇼 模組 2：台股大盤權值股即時資料
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
 * 🎯 模組 4：動態標的數據查詢 (供 AI 大報告使用)
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
        let symbol = symbols[i];
        const targetName = targets[i] || symbol;
        
        logger.info(`  🔍 [查詢中] 正在獲取 ${targetName} (${symbol}) 報價與深度籌碼...`);
        try {
            let quote;
            try {
                quote = await yahooFinance.quote(symbol);
            } catch (err) {
                // 如果是台股 (.TW) 且找不到，自動轉換為上櫃 (.TWO) 進行測試
                if (symbol.endsWith('.TW') && err.message.includes('No data found')) {
                    const twoSymbol = symbol.replace('.TW', '.TWO');
                    logger.warn(`  ⚠️ 查無 ${symbol}，懷疑為上櫃股票，自動嘗試 ${twoSymbol} ...`);
                    symbol = twoSymbol; // 替換為 .TWO
                    quote = await yahooFinance.quote(symbol);
                } else {
                    throw err; // 真實錯誤，拋出
                }
            }
            
            results[targetName] = {
                symbol: symbol,                                    
                name: quote.shortName || quote.longName || targetName, 
                price: quote.regularMarketPrice,                   
                changePercent: (quote.regularMarketChangePercent || 0).toFixed(2) + '%', 
                volume: quote.regularMarketVolume,                 
                peRatio: quote.trailingPE ? quote.trailingPE.toFixed(2) : 'N/A',         
                fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh,          
                fiftyTwoWeekLow: quote.fiftyTwoWeekLow,
                chips_analysis: {
                    top_15_buyers: [],
                    top_15_sellers: [],
                    summary_status: "無" 
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
 * 📈 模組 5：個股即時走勢與報價速查 (供 Discord 擷取即時資訊)
 * 🌟 內建名稱轉代號字典查表、以及強化的上市/上櫃 (.TW / .TWO) 自動切換機制
 */
async function fetchStockTrend(rawInput) {
    let input = rawInput.trim();
    
    // 1. 字典反查：如果你輸入「雙鴻」，這裡會直接幫你轉成「3324」
    if (stockLookupMap[input]) {
        logger.info(`📖 [Market API] 觸發字典轉換: "${input}" -> 代號 "${stockLookupMap[input]}"`);
        input = stockLookupMap[input];
    }
    
    let symbol = input.toUpperCase();
    let isTaiwan = false;
    let baseCode = symbol;

    // 2. 判斷是否為台股 (純數字，或數字加A/B/C等)
    if (/^\d{4,6}[A-Z]?$/.test(symbol)) {
        isTaiwan = true;
        symbol = `${symbol}.TW`; // 預設給予上市後綴 (.TW)
    }

    logger.info(`🔍 [Market API] 啟動即時查價，初始解析標的: ${symbol}...`);

    const executeFetch = async (targetSymbol) => {
        // A. 抓取即時報價
        const quote = await yahooFinance.quote(targetSymbol);
        if (!quote) throw new Error('No data found');
        
        // B. 抓取歷史走勢 (近 30 天)
        const period1 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const period2 = new Date().toISOString().split('T')[0]; 
        
        const historical = await yahooFinance.historical(targetSymbol, { period1, period2 });
        if (!historical || historical.length === 0) {
            throw new Error('No data found');
        }

        // C. 整理近期的收盤價走勢
        const recentTrend = historical.slice(-10).map(day => ({
            date: day.date.toISOString().split('T')[0],
            close: day.close.toFixed(2),
            volume: day.volume
        }));

        // D. 計算月線簡單均價 (20MA)
        const closes = historical.map(d => d.close);
        const monthlyAvg = closes.length > 0 ? (closes.reduce((sum, val) => sum + val, 0) / closes.length).toFixed(2) : 'N/A';

        logger.info(`✅ [Market API] 成功獲取 ${targetSymbol} 走勢資料，現價: ${quote.regularMarketPrice}`);
        
        return {
            symbol: targetSymbol,
            name: quote.shortName || quote.longName || targetSymbol,
            price: quote.regularMarketPrice,         // 🌟 新增 price 以相容 bot.js
            currentPrice: quote.regularMarketPrice,  // 舊有 currentPrice 保留
            change: quote.regularMarketChange,
            changePercent: (quote.regularMarketChangePercent || 0).toFixed(2) + '%',
            volume: quote.regularMarketVolume,
            peRatio: quote.trailingPE ? quote.trailingPE.toFixed(2) : 'N/A',
            fiftyTwoWeekHigh: quote.fiftyTwoWeekHigh,
            fiftyTwoWeekLow: quote.fiftyTwoWeekLow,
            monthlyAvgPrice: monthlyAvg,
            recentTrend: recentTrend
        };
    };

    try {
        // 先嘗試原始標的 (例如 3324.TW 或 NVDA)
        return await executeFetch(symbol);
    } catch (error) {
        // 🌟 核心修復：如果原始標的失敗，且是台股 (.TW)，自動重試上櫃 (.TWO)
        if (isTaiwan && symbol.endsWith('.TW') && error.message.includes('No data found')) {
            logger.warn(`⚠️ 查無 ${symbol} 歷史資料，確認是否為上櫃股票，自動嘗試 ${baseCode}.TWO ...`);
            try {
                return await executeFetch(`${baseCode}.TWO`);
            } catch (twoError) {
                logger.error(`❌ [Market API] 獲取 ${baseCode}.TWO 走勢失敗: ${twoError.message}`);
                return { error: true, message: twoError.message };
            }
        }
        
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

/**
 * 🚀 從 Yahoo Finance 獲取熱門股票 (Trending) 
 */
async function getTrendingSymbols() {
    try {
        const result = await yahooFinance.trendingSymbols('TW');
        if (result && result.quotes) {
            return result.quotes.map(q => q.symbol).filter(Boolean);
        }
        return ['2330.TW', '2317.TW', '2454.TW'];
    } catch (error) {
        logger.warn(`獲取熱門股失敗，使用預設備用名單。原因: ${error.message}`);
        // 回退至預設的台美股熱門標的
        return ['2330.TW', '2454.TW', '0050.TW', 'NVDA', 'TSLA', 'AAPL'];
    }
}

/**
 * 🚀 批量獲取股票報價，並格式化為 Discord 走馬燈字串
 * 格式範例：台積電 2,355.00▲30.00      旺宏 143.0▼13.50
 */
async function getFormattedQuotes(symbols, customDictionary = {}) {
    if (!symbols || symbols.length === 0) return "暫無數據";

    try {
        const quotes = await yahooFinance.quote(symbols);
        const quotesArray = Array.isArray(quotes) ? quotes : [quotes];

        const formattedStrings = quotesArray.map(quote => {
            if (!quote || !quote.regularMarketPrice) return null;

            const symbol = quote.symbol;
            const pureSym = symbol.split('.')[0];
            
            // 嘗試從外部傳入字典、內部 stockLookupMap 尋找名稱，找不到則使用代號
            let name = customDictionary[symbol] || customDictionary[pureSym] || stockLookupMap[pureSym] || stockLookupMap[symbol] || pureSym;
            
            const price = quote.regularMarketPrice.toFixed(2);
            const change = quote.regularMarketChange || 0;
            
            const changeIcon = change >= 0 ? '▲' : '▼';
            const changeValue = Math.abs(change).toFixed(2);

            return `${name} ${price}${changeIcon}${changeValue}`;
        }).filter(Boolean);

        return formattedStrings.join('      ');
    } catch (error) {
        logger.error(`獲取走馬燈報價發生錯誤: ${error.message}`);
        return "報價連線異常";
    }
}

module.exports = { 
    getMarketSnapshot, 
    fetchTargetsData, 
    fetchStockTrend,
    getGlobalIndices,
    getTaiwanStocksRealtime,
    getInstitutionalInvestors,
    getTrendingSymbols,
    getFormattedQuotes,
    stockLookupMap 
};