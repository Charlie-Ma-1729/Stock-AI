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
 * 🌟 RAG 智能觀點探討與對話大腦 (精準適應 bot.js 最新提示詞)
 */
async function evaluateUserInput(userName, userInput, type) {
    if (type !== 'viewpoint') return '';

    const isSystemReview = userName === 'System_Review'; 
    logger.info(`[AI 引擎 - Gemini] ⚡ 準備處理 ${isSystemReview ? '系統覆盤總結' : '頻道群聊對話'}...`);
    const startTime = Date.now();
    
    // 1. 關鍵字萃取與新聞 RAG
    let newsStr = '';
    if (!isSystemReview) {
        const recentText = userInput.slice(-300); 
        
        // 🌟 核心修復 3：嚴格防堵 AI 亂提普通詞彙去搜新聞
        const extractPrompt = `請從以下最新對話內容中，萃取出最重要的「實體股票名稱」或「具體企業名稱」（如：台積電、奇鋐、蘋果）。
【極度重要警告】：如果對話中沒有出現具體的公司或股票名稱，請務必回傳空陣列 []！絕對不可以把「走勢、未來、大盤、財報、股票、怎麼看」這種廣泛的普通詞彙當作關鍵字提取。
對話：「${recentText}」
你是一台嚴格的 JSON 生成器，只能輸出符合以下格式的純 JSON：
{"keywords": ["股票名1"]} 或 {"keywords": []}`;
        
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
                newsStr = '\n【系統自動帶入：近期關聯新聞】\n' + relatedNews.map((n, i) => `[新聞 ${i+1}] ${n.title}\n時間: ${n.published_at}\n內文: ${n.content.substring(0, 300)}...`).join('\n\n') + '\n\n';
            }
        }
    }

    // 2. 組裝最終 Prompt (修復字串替換錨點)
    let finalPromptWithNews = userInput;
    if (newsStr) {
        // 🌟 核心修復：精準對應 bot.js 傳來的最後一句指令，並強制注入新聞過濾原則
        finalPromptWithNews = userInput.replace(
            '請你根據上述群聊紀錄的「最後一句話」進行直接且專業的回答。', 
            newsStr + '【重要過濾指令】：以上新聞是由系統演算法自動帶入，可能包含與問題無關的雜訊。你必須具備獨立判斷能力，若新聞與使用者最新的問題無關，請【直接無視該新聞】，絕對不要硬塞進回覆中！\n請你根據上述群聊紀錄的「最後一句話」進行直接且專業的回答。'
        );
    }

    // 3. 呼叫大語言模型進行生成
    try {
        // 🌟 核心修改：徹底拔除聊天客服人格，改成高冷專業操盤手
        let sysInstruction = isSystemReview 
            ? "你是一個客觀、冷靜的投資紀錄系統，負責將群聊對話濃縮萃取成重點建議。" 
            : "你是一位專業、客觀的台美股分析師與資深操盤手。請直接切入重點回答，絕對禁止以「喔，某某某」或是重複使用者的名字與問題作為開頭。拒絕說廢話。";

        const response = await callOpenRouter(finalPromptWithNews, sysInstruction, 0.4);
        
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.info(`[AI 引擎 - Gemini] ✅ 任務完成 (耗時: ${duration}s)`);

        return response;

    } catch (error) {
        logger.error(`[AI 引擎 - Gemini] ❌ 任務失敗: ${error.message}`);
        return '⚠️ 系統提示：AI 思考模組暫時離線或回應超時。';
    }
}

/**
 * 舊版功能保留
 */
async function quickAnalyzeStock(symbol, stockData) { return "此功能已轉為群聊整合模式"; }
async function detailedAnalyzeStock(symbol, stockData, userInput = '') { return "此功能已轉為群聊整合模式"; }

module.exports = { addPendingQA, evaluateUserInput, quickAnalyzeStock, detailedAnalyzeStock };