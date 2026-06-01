// services/ai_analyzer.js
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('../logger'); 
const db = require('../db');

let marketApi;
try {
    marketApi = require('./market_api');
    logger.info('🔌 [系統初始化] 成功載入 market_api 模組，報價聯動功能已啟用。');
} catch (e) {
    logger.warn(`⚠️ [系統初始化] market_api.js 載入失敗！真實錯誤原因: ${e.message}`);
}

const OLLAMA_URL = 'http://127.0.0.1:11434/api/generate';
const MAX_TIMEOUT_MS = 1800000; 

const MODEL_8B = 'hf.co/Qwen/Qwen3-4B-GGUF:Q8_0'; 
const MODEL_3B = 'qwen2.5:3b'; 

function safeParseJSON(rawResponse) {
    try {
        return JSON.parse(rawResponse);
    } catch (e) {
        let cleanText = rawResponse.replace(/```json/gi, '').replace(/```/g, '').trim();
        const startIndex = cleanText.indexOf('{');
        const endIndex = cleanText.lastIndexOf('}');
        
        if (startIndex !== -1 && endIndex !== -1 && endIndex >= startIndex) {
            const jsonStr = cleanText.substring(startIndex, endIndex + 1);
            try {
                return JSON.parse(jsonStr);
            } catch (err) {
                const fixedStr = jsonStr.replace(/,\s*([}\]])/g, '$1');
                return JSON.parse(fixedStr);
            }
        }
        throw new Error("無法從 AI 回應中萃取出有效的 JSON 結構");
    }
}

const twDictPath = path.join(__dirname, '../tw_stocks.json');
const usDictPath = path.join(__dirname, '../us_stocks.json');
let stockDict = {}; 

function parseDictionary(data, suffix = '') {
    if (Array.isArray(data)) {
        data.forEach(item => {
            const sym = item.symbol || item.Symbol || item.Ticker || item.代號;
            const name = item.name || item.Name || item.名稱 || item.股名;
            if (sym && name) stockDict[name] = suffix ? `${sym}${suffix}` : sym;
        });
    } else if (typeof data === 'object') {
        for (const [k, v] of Object.entries(data)) {
            if (/^[A-Za-z0-9]+$/.test(k) && !/^[A-Za-z0-9]+$/.test(v)) {
                stockDict[v] = suffix ? `${k}${suffix}` : k;
            } else if (!/^[A-Za-z0-9]+$/.test(k) && /^[A-Za-z0-9]+$/.test(v)) {
                stockDict[k] = suffix ? `${v}${suffix}` : v;
            } else {
                stockDict[v] = suffix ? `${k}${suffix}` : k; 
            }
        }
    }
}

function loadDictionaries() {
    try {
        if (fs.existsSync(twDictPath)) {
            const twData = JSON.parse(fs.readFileSync(twDictPath, 'utf-8'));
            parseDictionary(twData, '.TW'); 
            logger.info('📖 [字典系統] 台股字典載入成功');
        }
        if (fs.existsSync(usDictPath)) {
            const usData = JSON.parse(fs.readFileSync(usDictPath, 'utf-8'));
            parseDictionary(usData, ''); 
            logger.info('📖 [字典系統] 美股字典載入成功');
        }
    } catch (e) {
        logger.error(`❌ [字典系統] 載入失敗: ${e.message}`);
    }
}
loadDictionaries();

function mapNameToSymbol(name) {
    if (!name) return null;
    if (stockDict[name]) return stockDict[name];
    
    for (const [dictName, symbol] of Object.entries(stockDict)) {
        if (dictName.length >= 2) {
            if (name.includes(dictName) || dictName.includes(name)) {
                return symbol;
            }
        }
    }
    return null;
}

function getChineseNameBySymbol(targetSymbol) {
    if (!targetSymbol) return null;
    const cleanTarget = targetSymbol.replace(/\.TW|\.TWO/gi, '').toUpperCase();
    for (const [name, sym] of Object.entries(stockDict)) {
        const cleanSym = sym.replace(/\.TW|\.TWO/gi, '').toUpperCase();
        if (cleanSym === cleanTarget) {
            return name; 
        }
    }
    return null;
}

const qaFilePath = path.join(__dirname, '../output/pending_qa.json');
function addPendingQA(user, question, evaluation = '', type = 'question') {
    let qaList = [];
    if (fs.existsSync(qaFilePath)) {
        try { qaList = JSON.parse(fs.readFileSync(qaFilePath, 'utf-8')); } catch (e) {}
    }
    qaList.push({ user, question, evaluation, type });
    if (!fs.existsSync(path.dirname(qaFilePath))) fs.mkdirSync(path.dirname(qaFilePath), { recursive: true });
    fs.writeFileSync(qaFilePath, JSON.stringify(qaList, null, 2));
}

/**
 * 🌟 RAG 智能觀點探討 (!觀點)
 */
async function evaluateUserInput(userName, userInput, type) {
    if (type !== 'viewpoint') return '';

    logger.info(`[AI 觀點探索 - 8B] 🕵️ 正在解析散戶 (${userName}) 的發言意圖...`);
    const startTime = Date.now();
    
    // 取得當前時間，賦予 AI 時間概念
    const timeString = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
    
    try {
        const extractPrompt = `請從以下用戶發言中，萃取出 2~4 個最重要的「實體名詞」或「事件關鍵字」（例如人名、公司名、產品名、事件）。
用戶發言：「${userInput}」
你現在是一台嚴格的 JSON 生成器，只能輸出符合以下格式的純 JSON：
{
  "keywords": ["關鍵字1", "關鍵字2"]
}`;
        
        const extractRes = await axios.post(OLLAMA_URL, {
            model: MODEL_8B, prompt: extractPrompt, stream: false, format: 'json', options: { temperature: 0.1, num_ctx: 1024 }
        }, { timeout: MAX_TIMEOUT_MS });
        
        let keywords = [];
        try {
            keywords = safeParseJSON(extractRes.data.response).keywords || [];
        } catch (e) {
            logger.warn('關鍵字萃取 JSON 失敗，改用原句切割');
            keywords = userInput.split(' ').slice(0, 3);
        }

        logger.info(`[AI 觀點探索 - 8B] 🔍 萃取關鍵字: [${keywords.join(', ')}]，準備檢索新聞庫...`);

        let relatedNews = [];
        let uniqueSymbols = new Set();
        if (keywords.length > 0) {
            relatedNews = db.searchNewsByGeneralKeywords(keywords, 5); 
            relatedNews.forEach(n => {
                if (n.symbols) n.symbols.forEach(s => uniqueSymbols.add(s));
            });
        }

        let marketDataStr = '目前無特定關聯的股票報價。';
        const symbolsArr = Array.from(uniqueSymbols).slice(0, 5); 
        if (symbolsArr.length > 0 && marketApi) {
            const quotes = await marketApi.fetchTargetsData(symbolsArr, symbolsArr);
            marketDataStr = Object.values(quotes).map(q => typeof q === 'string' ? q : `- ${q.name}(${q.symbol}): 現價 ${q.price} (${q.changePercent})`).join('\n');
            logger.info(`[AI 觀點探索 - 8B] 📈 成功獲取關聯標的報價: ${symbolsArr.join(', ')}`);
        }

        const newsStr = relatedNews.length > 0 ? relatedNews.map((n, i) => `[新聞 ${i+1}] ${n.title}\n時間: ${n.published_at}\n內文: ${n.content.substring(0, 300)}...`).join('\n\n') : '無相關新聞。';

        const evalPrompt = `你是一位專業且具備反身性思考的台美股分析師。
【當前系統時間】：${timeString} (請以此為基準判斷新聞與價格的時效性)

用戶（${userName}）發表了以下觀點或提問：「${userInput}」

我們從系統資料庫中，透過關鍵字 [${keywords.join(', ')}] 找到了以下關聯資訊：

【相關新聞】：
${newsStr}

【相關標的即時報價】：
${marketDataStr}

【強制任務要求】：
1. 請「直接且明確地」回答或點評使用者的觀點與疑問。
2. 請善用上方提供的「相關新聞」與「即時報價」來佐證你的看法。若有提到具體股票，請幫忙分析一下目前的位階狀態。
3. 若資料庫沒有新聞，請單純依據你的常識與邏輯回覆。
4. 語系強制使用「繁體中文 (zh-TW)」。
5. 語氣像是一位有經驗的導師，請直接給出結論，不要 Markdown 大標題，字數約 300 字以內。`;

        const evalRes = await axios.post(OLLAMA_URL, {
            model: MODEL_8B, prompt: evalPrompt, stream: false, options: { temperature: 0.3, num_ctx: 8192 }
        }, { timeout: MAX_TIMEOUT_MS });
        
        const evaluation = evalRes.data.response.trim();
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.info(`[AI 觀點探索 - 8B] ✅ 探討完成 (耗時: ${duration}s)`);

        let instantEval = `🎯 **AI 觀點深度探討** (檢索關鍵字: ${keywords.join(', ')})\n\n${evaluation}`;
        
        addPendingQA(userName, userInput, evaluation, type);
        return instantEval;

    } catch (error) {
        logger.error(`[AI 觀點探索 - 8B] ❌ 評估失敗: ${error.message}`);
        return '⚠️ 系統提示：觀點探討模組暫時離線或回應超時。';
    }
}

/**
 * 🌟 個股即時走勢速評 (!查)
 */
async function quickAnalyzeStock(symbol, stockData) {
    logger.info(`[AI 即時速評 - 3B] ⚡ 啟動 ${symbol} 走勢與新聞關聯分析...`);
    const startTime = Date.now();
    
    // 取得當前時間
    const timeString = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });

    const trendStr = (stockData.recentTrend || []).map(t => `${t.date}: 收盤 ${t.close}, 成交量 ${t.volume}`).join('\n');
    const allRecentNews = db.getRecentNews(48);
    const cleanSymbol = symbol.replace(/\.TW|\.TWO/gi, ''); 
    const chineseName = getChineseNameBySymbol(symbol); 
    const stockName = stockData.name || symbol;

    const relatedNews = allRecentNews.filter(news => {
        const symbolStr = (news.symbols || news.tags || '').toString();
        const matchSymbol = symbolStr.includes(cleanSymbol);
        const matchChineseName = chineseName && (news.title.includes(chineseName) || (news.content && news.content.includes(chineseName)));
        const matchName = stockName && (news.title.includes(stockName) || (news.content && news.content.includes(stockName)));
        const matchCleanName = news.title.includes(cleanSymbol) || (news.content && news.content.includes(cleanSymbol));
        return matchSymbol || matchChineseName || matchName || matchCleanName;
    }).slice(0, 5); 

    let newsContext = '目前資料庫中無該標的之近期關聯新聞。';
    if (relatedNews.length > 0) {
        newsContext = relatedNews.map((n, i) => `[新聞 ${i + 1}] ${n.title}\n時間: ${n.published_at}\n內文: ${n.content.substring(0, 500)}...`).join('\n\n');
    }

    const prompt = `你是一位專業台美股分析師。請根據以下即時數據、歷史走勢與近期新聞，給出一段簡潔有力的「個股速評」(大約 150-200 字)。
【當前系統時間】：${timeString} (請以此為基準判斷新聞與價格的時效性)
【標的】：${chineseName || stockName} (${symbol})
【即時報價】：${stockData.currentPrice} (${stockData.changePercent})
【月線(20MA)均價】：${stockData.monthlyAvgPrice}
【本益比】：${stockData.peRatio}

【近 10 日歷史走勢】：
${trendStr}

【近期相關新聞】：
${newsContext}

【強制任務要求】：
1. 判斷目前趨勢是多頭、空頭還是盤整。
2. 點出現價與月線(20MA)的乖離關係。
3. 如果有提供「近期相關新聞」，請將新聞的「利多/利空題材」與股價走勢結合解讀。
4. 語系強制使用「繁體中文 (zh-TW)」。
5. 語氣客觀專業，直接給結論，不要 Markdown 大標題。`;

    try {
        const response = await axios.post(OLLAMA_URL, {
            model: MODEL_3B, prompt: prompt, stream: false, options: { temperature: 0.2, num_ctx: 4096 } 
        }, { timeout: MAX_TIMEOUT_MS });

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.info(`[AI 即時速評 - 3B] ✅ 速評完成 (耗時: ${duration}s)`);
        
        const baseInfo = `**💰 現價**：${stockData.currentPrice} (${stockData.changePercent})\n**📈 月線 (20MA)**：${stockData.monthlyAvgPrice}\n**📊 本益比 (PE)**：${stockData.peRatio}\n**📰 關聯新聞**：參考了 ${relatedNews.length} 篇\n\n`;
        return baseInfo + `**💡 AI 走勢與題材解讀：**\n${response.data.response.trim()}`;

    } catch (error) {
        logger.error(`[AI 即時速評 - 3B] ❌ 速評失敗: ${error.message}`);
        return `**💰 現價**：${stockData.currentPrice} (${stockData.changePercent})\n**📈 月線 (20MA)**：${stockData.monthlyAvgPrice}\n\n⚠️ 系統提示：AI 走勢解讀模組暫時離線或回應超時。`;
    }
}

/**
 * 🌟 深度詳查報告 (!詳查)
 */
async function detailedAnalyzeStock(symbol, stockData, userInput = '') {
    logger.info(`[AI 深度詳查 - 8B] 🧠 啟動 ${symbol} 深度解析... (附帶用戶提問: ${userInput})`);
    const startTime = Date.now();
    
    // 取得當前時間
    const timeString = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });

    const trendStr = (stockData.recentTrend || []).map(t => `${t.date}: 收盤 ${t.close}, 成交量 ${t.volume}`).join('\n');
    
    const allRecentNews = db.getRecentNews(72); 
    const cleanSymbol = symbol.replace(/\.TW|\.TWO/gi, ''); 
    const chineseName = getChineseNameBySymbol(symbol); 
    const stockName = stockData.name || symbol;

    const relatedNews = allRecentNews.filter(news => {
        const symbolStr = (news.symbols || news.tags || '').toString();
        const matchSymbol = symbolStr.includes(cleanSymbol);
        const matchChineseName = chineseName && (news.title.includes(chineseName) || (news.content && news.content.includes(chineseName)));
        const matchName = stockName && (news.title.includes(stockName) || (news.content && news.content.includes(stockName)));
        const matchCleanName = news.title.includes(cleanSymbol) || (news.content && news.content.includes(cleanSymbol));
        return matchSymbol || matchChineseName || matchName || matchCleanName;
    }).slice(0, 10); 

    let newsContext = '目前資料庫中無該標的之近期關聯新聞。';
    if (relatedNews.length > 0) {
        newsContext = relatedNews.map((n, i) => `[新聞 ${i + 1}] ${n.title}\n時間: ${n.published_at}\n內文: ${n.content}`).join('\n\n');
    }

    let userContextPrompt = '';
    if (userInput) {
        userContextPrompt = `\n【使用者的疑問 / 觀點陳述】：\n「${userInput}」\n\n`;
    }

    const prompt = `你是一位深諳反身性與行為金融學的台美股資深操盤手。請根據以下量價數據與近期新聞，為這檔股票寫一份「深度詳查報告」(約 400-500 字)。
【當前系統時間】：${timeString} (請以此為基準判斷新聞與價格的時效性)
【標的】：${chineseName || stockName} (${symbol})
【即時報價】：${stockData.currentPrice} (${stockData.changePercent})
【月線(20MA)均價】：${stockData.monthlyAvgPrice}
【本益比】：${stockData.peRatio}
【52週高低點】：高 ${stockData.fiftyTwoWeekHigh} / 低 ${stockData.fiftyTwoWeekLow}

${userContextPrompt}

【近 10 日歷史走勢】：
${trendStr}

【近期相關新聞 (72小時內)】：
${newsContext}

【強制任務要求】：
0. 如果有提供【使用者的疑問 / 觀點陳述】，請務必在報告開頭第一段「直接且具體地」回答他的疑問或點評他的觀點！
1. 籌碼與技術面判讀：判斷目前多空趨勢、現價與月線的乖離、支撐與壓力區在哪。
2. 消息面與基本面共振：詳細解讀「近期相關新聞」中的利多或利空，並判斷市場是否已經反映。
3. 操作建議與風險預警：明確點出破局停損點或追高風險。
4. 語系強制使用「繁體中文 (zh-TW)」。
5. 直接以 Markdown 格式排版輸出整齊的報告。`;

    try {
        const response = await axios.post(OLLAMA_URL, {
            model: MODEL_8B, 
            prompt: prompt, 
            stream: false, 
            options: { temperature: 0.3, num_ctx: 8192 } 
        }, { timeout: MAX_TIMEOUT_MS });

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.info(`[AI 深度詳查 - 8B] ✅ 詳查完成 (耗時: ${duration}s)`);
        
        const reportContent = response.data.response.trim();

        if (typeof db.savePrediction === 'function') {
            db.savePrediction('AI詳查', symbol, reportContent, 7);
        }

        const baseInfo = `**💰 現價**：${stockData.currentPrice} (${stockData.changePercent})\n**📈 月線 (20MA)**：${stockData.monthlyAvgPrice}\n**📊 本益比 (PE)**：${stockData.peRatio}\n**📰 關聯新聞**：深度參考了 ${relatedNews.length} 篇\n\n`;
        return baseInfo + `**🧠 AI 深度詳查報告：**\n${reportContent}`;

    } catch (error) {
        logger.error(`[AI 深度詳查 - 8B] ❌ 詳查失敗: ${error.message}`);
        return `**💰 現價**：${stockData.currentPrice} (${stockData.changePercent})\n\n⚠️ 系統提示：AI 深度解讀模組暫時離線或回應超時。`;
    }
}

module.exports = { addPendingQA, evaluateUserInput, quickAnalyzeStock, detailedAnalyzeStock };