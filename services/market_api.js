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

function parseDictionary(data) {
    if (Array.isArray(data)) {
        data.forEach(item => {
            const sym = item.symbol || item.Symbol || item.Ticker || item.代號;
            const name = item.name || item.Name || item.名稱 || item.股名;
            if (sym && name) {
                // 移除原有的 .TW 或 .TWO，保留純代號
                const cleanSym = sym.toString().replace(/\.TW|\.TWO/gi, '');
                stockLookupMap[name] = cleanSym; 
            }
        });
    } else if (typeof data === 'object') {
        for (const [k, v] of Object.entries(data)) {
            let name, sym;
            // 判斷誰是代號 (純英數)
            if (/^[A-Za-z0-9]+$/.test(k) && !/^[A-Za-z0-9]+$/.test(v)) {
                sym = k; name = v;
            } else {
                sym = v; name = k; // 預設 k 是中文
            }
            const cleanSym = sym.toString().replace(/\.TW|\.TWO/gi, '');
            stockLookupMap[name] = cleanSym;
        }
    }
}

try {
    if (fs.existsSync(twDictPath)) parseDictionary(JSON.parse(fs.readFileSync(twDictPath, 'utf-8')));
    if (fs.existsSync(usDictPath)) parseDictionary(JSON.parse(fs.readFileSync(usDictPath, 'utf-8')));
    logger.info('📖 [Market API] 字典載入成功，已啟用「股票名稱反查代號」功能。');
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
 * 🌟 已加入上櫃股票 (.TWO) 的自動重試防護
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
 * 🌟 內建名稱轉代號字典查表、以及上市/上櫃 (.TW / .TWO) 自動切換機制
 */
async function fetchStockTrend(rawInput) {
    let input = rawInput.trim();
    
    // 1. 字典反查：如果你輸入「雙鴻」，這裡會直接幫你轉成「3324」
    if (stockLookupMap[input]) {
        logger.info(`📖 [Market API] 觸發字典轉換: "${input}" -> "${stockLookupMap[input]}"`);
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

    logger.info(`🔍 [Market API] 啟動即時查價，最終解析標的: ${symbol}...`);
    try {
        // 3. 獲取即時報價，並處理上櫃 (OTC) 股票的 Fallback
        let quote;
        try {
            quote = await yahooFinance.quote(symbol);
        } catch (err) {
            if (isTaiwan && symbol.endsWith('.TW') && err.message.includes('No data found')) {
                logger.warn(`⚠️ 查無 ${symbol}，確認是否為上櫃股票，自動嘗試 ${baseCode}.TWO ...`);
                symbol = `${baseCode}.TWO`;
                quote = await yahooFinance.quote(symbol);
            } else {
                throw err;
            }
        }
        
        // 4. 抓取歷史走勢 (近 30 天)
        const period1 = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
        const period2 = new Date().toISOString().split('T')[0]; 
        
        const historical = await yahooFinance.historical(symbol, { period1, period2 });
        
        // 5. 整理近期的收盤價走勢 (提取近 10 個交易日供 AI 速評)
        const recentTrend = historical.slice(-10).map(day => ({
            date: day.date.toISOString().split('T')[0], // 轉為 YYYY-MM-DD
            close: day.close.toFixed(2),
            volume: day.volume
        }));

        // 6. 計算月線簡單均價 (20MA) 作為趨勢支撐/壓力參考
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