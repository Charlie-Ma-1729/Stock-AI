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

async function evaluateUserInput(userName, userInput, type) {
    let instantEval = '';
    if (type === 'viewpoint') {
        const prompt = `你現在是一位精通台股暗語的主力操盤手。
用戶發表了一段含糊的市場觀察：「${userInput}」。

【任務與強制約束】：
1. 語系強制：必須且只能使用「繁體中文 (zh-TW)」撰寫點評，絕對禁止出現任何簡體字。
2. 禁猜代號：你只能抓出「公司名稱」，絕對不准自己猜測或捏造股票代號。
3. 輸出強制：你現在是一台嚴格的 JSON 生成器，絕對禁止輸出 Markdown 標記，只能輸出符合以下格式的純 JSON：

{
  "company_name": "雙鴻",
  "evaluation": "以 60 字內犀利點出該觀點是否有「情緒過熱/盲目跟風」或「具備反身性深思考」的特質。"
}`;
        
        const startTime = Date.now();
        try {
            const response = await axios.post(OLLAMA_URL, {
                model: MODEL_8B, 
                prompt, 
                stream: false, 
                format: 'json', 
                options: { temperature: 0.1, num_ctx: 2048 }
            }, { timeout: MAX_TIMEOUT_MS });
            
            const rawResponse = response.data.response;
            
            let parsed;
            try {
                parsed = safeParseJSON(rawResponse);
            } catch (parseError) {
                throw new Error("無法解析出正確的 JSON 結構");
            }
            
            const compName = parsed.company_name || '未定';
            let finalTargetDisplay = compName;
            
            if (compName !== '未定') {
                const mappedSymbol = mapNameToSymbol(compName);
                if (mappedSymbol) {
                    finalTargetDisplay = `${compName} (${mappedSymbol})`; 
                }
            }

            instantEval = `🎯 **標的識別**：${finalTargetDisplay}\n💡 **觀點速評**：${parsed.evaluation || '無'}`;
        } catch (error) {
            logger.error(`[AI 情緒與個股識別 - 8B] ❌ 評估失敗: ${error.message}`);
            instantEval = '個股模糊識別離線，暫無初步評估';
        }
    }
    
    addPendingQA(userName, userInput, instantEval, type);
    return instantEval;
}

async function quickAnalyzeStock(symbol, stockData) {
    logger.info(`[AI 即時速評 - 3B] ⚡ 啟動 ${symbol} 走勢與新聞關聯分析...`);
    const startTime = Date.now();

    const trendStr = (stockData.recentTrend || []).map(t => `${t.date}: 收盤 ${t.close}, 成交量 ${t.volume}`).join('\n');
    
    const allRecentNews = db.getRecentNews(48);
    const cleanSymbol = symbol.replace(/\.TW|\.TWO/gi, ''); 
    const chineseName = getChineseNameBySymbol(symbol); 
    const stockName = stockData.name || symbol;

    const relatedNews = allRecentNews.filter(news => {
        const symbolStr = (news.symbols || news.tags || '').toString();
        const matchSymbol = symbolStr.includes(cleanSymbol);
        // 🌟 核心修改：判斷是否命中 content 
        const matchChineseName = chineseName && (news.title.includes(chineseName) || (news.content && news.content.includes(chineseName)));
        const matchName = stockName && (news.title.includes(stockName) || (news.content && news.content.includes(stockName)));
        const matchCleanName = news.title.includes(cleanSymbol) || (news.content && news.content.includes(cleanSymbol));
        return matchSymbol || matchChineseName || matchName || matchCleanName;
    }).slice(0, 5); 

    let newsContext = '目前資料庫中無該標的之近期關聯新聞。';
    if (relatedNews.length > 0) {
        // 🌟 核心修改：輸出完整的 n.content 而不是 n.summary
        newsContext = relatedNews.map((n, i) => `[新聞 ${i + 1}] ${n.title}\n內文: ${n.content}`).join('\n\n');
    }

    const prompt = `你是一位專業台美股分析師。請根據以下即時數據、歷史走勢與近期新聞，給出一段簡潔有力的「個股速評」(大約 150-200 字)。
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
            model: MODEL_3B, 
            prompt: prompt, 
            stream: false, 
            options: { temperature: 0.2, num_ctx: 4096 } // 🌟 放大 3B 模型的記憶體以容納完整新聞
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

async function detailedAnalyzeStock(symbol, stockData) {
    logger.info(`[AI 深度詳查 - 8B] 🧠 啟動 ${symbol} 深度解析...`);
    const startTime = Date.now();

    const trendStr = (stockData.recentTrend || []).map(t => `${t.date}: 收盤 ${t.close}, 成交量 ${t.volume}`).join('\n');
    
    const allRecentNews = db.getRecentNews(72); 
    const cleanSymbol = symbol.replace(/\.TW|\.TWO/gi, ''); 
    const chineseName = getChineseNameBySymbol(symbol); 
    const stockName = stockData.name || symbol;

    const relatedNews = allRecentNews.filter(news => {
        const symbolStr = (news.symbols || news.tags || '').toString();
        const matchSymbol = symbolStr.includes(cleanSymbol);
        // 🌟 核心修改：判斷是否命中 content 
        const matchChineseName = chineseName && (news.title.includes(chineseName) || (news.content && news.content.includes(chineseName)));
        const matchName = stockName && (news.title.includes(stockName) || (news.content && news.content.includes(stockName)));
        const matchCleanName = news.title.includes(cleanSymbol) || (news.content && news.content.includes(cleanSymbol));
        return matchSymbol || matchChineseName || matchName || matchCleanName;
    }).slice(0, 10); 

    let newsContext = '目前資料庫中無該標的之近期關聯新聞。';
    if (relatedNews.length > 0) {
        // 🌟 核心修改：輸出完整的 n.content
        newsContext = relatedNews.map((n, i) => `[新聞 ${i + 1}] ${n.title}\n內文: ${n.content}`).join('\n\n');
    }

    const prompt = `你是一位深諳反身性與行為金融學的台美股資深操盤手。請根據以下量價數據與近期新聞，為這檔股票寫一份「深度詳查報告」(約 300-500 字)。
【標的】：${chineseName || stockName} (${symbol})
【即時報價】：${stockData.currentPrice} (${stockData.changePercent})
【月線(20MA)均價】：${stockData.monthlyAvgPrice}
【本益比】：${stockData.peRatio}
【52週高低點】：高 ${stockData.fiftyTwoWeekHigh} / 低 ${stockData.fiftyTwoWeekLow}

【近 10 日歷史走勢】：
${trendStr}

【近期相關新聞 (72小時內)】：
${newsContext}

【強制任務要求】：
1. 籌碼與技術面判讀：判斷目前多空趨勢、現價與月線的乖離、支撐與壓力區在哪。
2. 消息面與基本面共振：詳細解讀「近期相關新聞」中的利多或利空，並判斷市場是否已經反映（利多出盡或利空出盡）。如果無新聞，則跳過此項。
3. 操作建議與風險預警：給出具體的短線或波段操作思維，並明確點出破局停損點或追高風險。
4. 語系強制使用「繁體中文 (zh-TW)」。
5. 專業且嚴謹，不要使用過度浮誇的詞彙，請直接以 Markdown 格式排版輸出整齊的報告。`;

    try {
        const response = await axios.post(OLLAMA_URL, {
            model: MODEL_8B, 
            prompt: prompt, 
            stream: false, 
            options: { temperature: 0.3, num_ctx: 8192 } // 🌟 放大 8B 模型記憶體至 8192，避免 10 篇新聞塞爆
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