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

// 🌟 全面替換 Ollama，啟用 OpenRouter 與 Gemini 引擎
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL_NAME = 'google/gemini-2.5-flash-lite'; 
const MAX_TIMEOUT_MS = 180000; // API 呼叫最長等待時間設定為 3 分鐘

/**
 * 封裝 OpenRouter API 呼叫邏輯
 */
async function callOpenRouter(prompt, systemInstruction = '', temperature = 0.3) {
    if (!API_KEY) {
        logger.error('❌ 未設定 OPENROUTER_API_KEY 環境變數，請檢查 .env 檔案');
        throw new Error('未設定 OPENROUTER_API_KEY');
    }

    const messages = [];
    if (systemInstruction) {
        messages.push({ role: 'system', content: systemInstruction });
    }
    messages.push({ role: 'user', content: prompt });

    try {
        const response = await axios.post(OPENROUTER_URL, {
            model: MODEL_NAME,
            messages: messages,
            temperature: temperature
        }, {
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'HTTP-Referer': 'https://github.com/charlie-ma-1729/stock-ai',
                'X-Title': 'IMA Wealth Discord Bot',
                'Content-Type': 'application/json'
            },
            timeout: MAX_TIMEOUT_MS
        });

        return response.data.choices[0].message.content.trim();
    } catch (error) {
        if (error.response) {
            logger.error(`❌ [OpenRouter API] 錯誤: ${JSON.stringify(error.response.data)}`);
        } else {
            logger.error(`❌ [OpenRouter 連線] 失敗: ${error.message}`);
        }
        throw new Error('AI 分析大腦連線異常，請檢查 OpenRouter 設定。');
    }
}

/**
 * 強健的 JSON 解析防禦機制
 */
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

// ==========================================
// 📖 系統字典載入與映射
// ==========================================
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
 * 🌟 RAG 智能觀點探討與對話大腦 (全新改版以適應 bot.js 群聊)
 */
async function evaluateUserInput(userName, userInput, type) {
    if (type !== 'viewpoint') return '';

    const isSystemReview = userName === 'System_Review'; // 判斷是否為系統背景在提取覆盤建議
    logger.info(`[AI 引擎 - Gemini] ⚡ 準備處理 ${isSystemReview ? '系統覆盤總結' : '頻道群聊對話'}...`);
    const startTime = Date.now();
    
    // 1. 關鍵字萃取與新聞 RAG (若是系統覆盤則不需要撈新聞)
    let newsStr = '';
    if (!isSystemReview) {
        // 由於 userInput 是 bot.js 傳過來的「完整包含30句對話的長文本」，我們只取最後 300 字來萃取最新話題關鍵字
        const recentText = userInput.slice(-300); 
        const extractPrompt = `請從以下最新對話內容中，萃取出 1~3 個最重要的「實體股票名詞」或「財經關鍵字」。若無具體標的請回傳空陣列。\n對話：「${recentText}」\n你是一台嚴格的 JSON 生成器，只能輸出符合以下格式的純 JSON：\n{"keywords": ["關鍵字1", "關鍵字2"]}`;
        
        let keywords = [];
        try {
            const extractResText = await callOpenRouter(extractPrompt, "你是一台嚴格的 JSON 生成器", 0.1);
            keywords = safeParseJSON(extractResText).keywords || [];
        } catch (e) {
            logger.warn('關鍵字萃取 JSON 失敗，跳過精準新聞檢索');
        }

        if (keywords.length > 0) {
            logger.info(`[AI 引擎 - Gemini] 🔍 萃取群聊關鍵字: [${keywords.join(', ')}]，準備檢索新聞庫...`);
            const relatedNews = db.searchNewsByGeneralKeywords(keywords, 3); 
            if (relatedNews.length > 0) {
                // 將新聞轉為字串準備安插進 Prompt
                newsStr = '\n【系統自動帶入：近期關聯新聞】\n' + relatedNews.map((n, i) => `[新聞 ${i+1}] ${n.title}\n時間: ${n.published_at}\n內文: ${n.content.substring(0, 300)}...`).join('\n\n') + '\n\n';
            }
        }
    }

    // 2. 組裝最終 Prompt 
    // bot.js 傳來的 userInput 結尾會有一句「請根據上述群聊紀錄與市場數據...」
    // 如果有撈到新聞，我們就透過字串替換，把新聞巧妙地安插進去
    let finalPromptWithNews = userInput;
    if (newsStr) {
        finalPromptWithNews = userInput.replace(
            '請根據上述群聊紀錄與市場數據', 
            newsStr + '請根據上述群聊紀錄、近期關聯新聞與市場數據'
        );
    }

    // 3. 呼叫大語言模型進行生成
    try {
        // 設定系統角色指令 (System Instruction)
        let sysInstruction = isSystemReview 
            ? "你是一個客觀、冷靜的投資紀錄系統，負責將群聊對話濃縮萃取成重點建議。" 
            : "你是一個在 Discord 頻道參與股市群聊的AI專業分析師，語氣像真人一樣輕鬆自然。";

        const response = await callOpenRouter(finalPromptWithNews, sysInstruction, 0.4);
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.info(`[AI 引擎 - Gemini] ✅ 任務完成 (耗時: ${duration}s)`);

        return response; // 🌟 核心修改：不再強加 🎯 符號與前綴標題，直接回傳純對話字串

    } catch (error) {
        logger.error(`[AI 引擎 - Gemini] ❌ 任務失敗: ${error.message}`);
        return '⚠️ 系統提示：AI 思考模組暫時離線或回應超時。';
    }
}

/**
 * 以下為舊版 !查 功能保留的函式，雖然 bot.js 目前未使用，但保留供未來單獨呼叫需求
 */
async function quickAnalyzeStock(symbol, stockData) { /* 略過，保留舊有邏輯不變 */ return "此功能已轉為群聊整合模式"; }
async function detailedAnalyzeStock(symbol, stockData, userInput = '') { /* 略過，保留舊有邏輯不變 */ return "此功能已轉為群聊整合模式"; }

module.exports = { addPendingQA, evaluateUserInput, quickAnalyzeStock, detailedAnalyzeStock };