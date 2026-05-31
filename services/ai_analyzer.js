// ai_analyzer.js
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
const MAX_TIMEOUT_MS = 1800000; // 🌟 [優化] 超時時間延長為 30 分鐘，給予 AI 充分時間處理

// 輕重雙引擎配置
const MODEL_8B = 'hf.co/Qwen/Qwen3-8B-GGUF:Q8_0'; 
const MODEL_3B = 'hf.co/Qwen/Qwen3-4B-GGUF:Q8_0'; 

const systemPromptPath = path.join(__dirname, '../config/system_prompt.txt');
let SYSTEM_PROMPT = '';
if (fs.existsSync(systemPromptPath)) {
    SYSTEM_PROMPT = fs.readFileSync(systemPromptPath, 'utf-8');
    logger.info(`📜 [系統初始化] 成功載入系統提示詞 (System Prompt)，長度: ${SYSTEM_PROMPT.length} 字`);
} else {
    logger.warn('⚠️ [系統初始化] 找不到 system_prompt.txt，將使用預設系統提示。');
    SYSTEM_PROMPT = '你是一位具備反身性思考的台股資深操盤手，講話絕不說死，富有機率思維。';
}

const qaFilePath = path.join(__dirname, '../output/pending_qa.json');

// --- QA 暫存管理區 ---
function addPendingQA(user, question, evaluation = '') {
    let qaList = [];
    if (fs.existsSync(qaFilePath)) {
        try { qaList = JSON.parse(fs.readFileSync(qaFilePath, 'utf-8')); } catch (e) {
            logger.warn(`⚠️ [QA 管理] 讀取 QA 暫存檔失敗: ${e.message}`);
        }
    }
    qaList.push({ user, question, evaluation });
    if (!fs.existsSync(path.dirname(qaFilePath))) fs.mkdirSync(path.dirname(qaFilePath), { recursive: true });
    fs.writeFileSync(qaFilePath, JSON.stringify(qaList, null, 2));
    logger.info(`📝 [QA 管理] 已新增用戶提問: ${user} - ${question.substring(0, 15)}...`);
}

function getPendingQA() {
    if (!fs.existsSync(qaFilePath)) return [];
    try { return JSON.parse(fs.readFileSync(qaFilePath, 'utf-8')); } catch (e) { return []; }
}

function clearPendingQA() {
    fs.writeFileSync(qaFilePath, JSON.stringify([]));
    logger.info(`🧹 [QA 管理] 已清空待處理的 QA 暫存檔。`);
}

// --- 核心 AI 邏輯區 ---

/**
 * 3B 引擎：單篇新聞摘要
 */
async function summarizeNews(title, content) {
    logger.info(`[AI 摘要引擎 - 3B] 📝 開始處理新聞摘要: 《${title.substring(0, 20)}...》`);
    const prompt = `請以「3個重點列點」總結以下新聞核心資訊，總字數不可超過 60 字。不要廢話。
    標題：${title}\n內文：${content}`;
    
    const startTime = Date.now();
    try {
        const response = await axios.post(OLLAMA_URL, {
            model: MODEL_3B, prompt: prompt, stream: false, options: { temperature: 0.1 } 
        }, { timeout: MAX_TIMEOUT_MS });
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.info(`[AI 摘要引擎 - 3B] ✅ 完成摘要 (耗時: ${duration}s)`);
        return response.data.response.trim();
    } catch (error) {
        logger.error(`[AI 摘要引擎 - 3B] ❌ 摘要失敗: ${error.message}`);
        return '無法產生摘要';
    }
}

/**
 * 8B 萃取大腦：多空實戰標的萃取與危機預警
 * 🌟 [重磅升級]: 採取「少量多次 (Batching)」機制，確保 AI 能看完「所有」新聞！
 */
async function extractMarketTargets(compressedNews, userQA) {
    if (!compressedNews || compressedNews.length === 0) {
        logger.warn(`[AI 萃取大腦 - 8B] ⚠️ 收到 0 篇新聞，略過萃取。`);
        return { targets: [], symbols: [], filteredNews: [] };
    }

    logger.info(`[AI 萃取大腦 - 8B] 🎯 啟動「少量多次」全面分析。總新聞量: ${compressedNews.length} 篇`);
    
    const BATCH_SIZE = 15; // 每次餵 15 篇，確保 AI 不會因文字過多而失焦
    let allMergedSelections = [];
    let finalFilteredNews = [];
    let uniqueSymbolsCheck = new Set();
    
    const userTopics = userQA.length > 0 ? userQA.map(q => q.content || q.question).join('; ') : '無特別話題';

    // 🌟 少量多次循環：跑完全部新聞
    for (let i = 0; i < compressedNews.length; i += BATCH_SIZE) {
        const currentBatch = compressedNews.slice(i, i + BATCH_SIZE);
        logger.info(`⚡ [少量多次進行中] 正在深度分析第 ${i + 1} 到 ${i + currentBatch.length} 篇新聞...`);
        
        const newsCatalog = currentBatch.map((n, idx) => `[索引 ${idx}]: ${n.title}`).join('\n');

        const prompt = `你是一位實戰派台股分析師。請從以下新聞找出最值得關注的具體潛力股或即將崩跌的危險股。
【嚴重警告】：
1. 只能輸出具體的公司或 ETF 名稱。禁止輸出宏觀指標或產業鏈名稱 (如: 新台幣、大盤)。
2. 你必須推斷出該標的之「股票代號」。台股務必加 .TW (例如 2330.TW, 1513.TW)；美股維持原代號 (例如 NVDA)。
3. 嚴格回傳 JSON 格式，絕不允許任何廢話。

【散戶話題】：${userTopics}
【當前新聞區塊】：
${newsCatalog}

請務必將結果包裝在 JSON 格式中回傳，確保包含大括號 { }，不要遺漏：
{
  "selections": [
    { "name": "中興電", "symbol": "1513.TW", "news_indices": [0], "reason": "潛力股/崩跌危機簡述" }
  ]
}`;

        const batchStartTime = Date.now();
        try {
            const response = await axios.post(OLLAMA_URL, {
                model: MODEL_8B,       
                prompt: prompt, 
                stream: false, 
                //format: 'json', 
                options: { 
                    temperature: 0.1, 
                    num_ctx: 4096,
                    num_predict: 1024 // 限制它不要一直講廢話，最多吐 1024 個 Token 就好
                }
            }, { timeout: MAX_TIMEOUT_MS });

            const duration = ((Date.now() - batchStartTime) / 1000).toFixed(2);
            
            // 🌟 【新增】：抓出 AI 的原始完整回覆
            const rawResponse = response.data.response;
            logger.info(`  └─ 🤖 [AI 原始回覆 Log]:\n${rawResponse}`);
            logger.info(`  └─ ✅ 當前批次推論結束 (耗時: ${duration}s)`);
            
            // 🌟 【新增防彈 JSON 萃取器】：不管 AI 包了什麼 Markdown 或廢話，硬挖出 { ... }
            let cleanJsonString = rawResponse;
            const firstBrace = rawResponse.indexOf('{');
            const lastBrace = rawResponse.lastIndexOf('}');
            
            if (firstBrace !== -1 && lastBrace !== -1 && lastBrace >= firstBrace) {
                cleanJsonString = rawResponse.substring(firstBrace, lastBrace + 1);
            } else {
                throw new Error("AI 回傳的內容完全找不到 JSON 大括號");
            }

            // 嘗試解析我們挖出來的乾淨 JSON
            const parsedData = JSON.parse(cleanJsonString);
            
            if (parsedData.selections && Array.isArray(parsedData.selections)) {
                for (const item of parsedData.selections) {
                    if (!['新台幣', 'CPI', '通膨', '降息', '大盤', '稅收', '台股'].includes(item.name) && item.symbol) {
                        if (!uniqueSymbolsCheck.has(item.symbol)) {
                            uniqueSymbolsCheck.add(item.symbol);
                            allMergedSelections.push(item);
                            
                            item.news_indices.forEach(idx => {
                                const safeIdx = parseInt(idx, 10);
                                if (safeIdx >= 0 && safeIdx < currentBatch.length) {
                                    finalFilteredNews.push(currentBatch[safeIdx]);
                                }
                            });
                        }
                    }
                }
            }
        } catch (e) {
            logger.warn(`  └─ ⚠️ 當前批次解析失敗: ${e.message}，自動跳過，不影響全局。`);
        }
    }

    // 彙整去重後的最終實戰結果
    let targets = [];
    let symbols = [];
    
    if (allMergedSelections.length > 0) {
        // 取出關注度最高的前 8 檔標的，避免最終報告過於冗長
        const finalSelections = allMergedSelections.slice(0, 8);
        finalSelections.forEach(item => {
            targets.push(item.name);
            symbols.push(item.symbol);
        });
        
        logger.info(`[AI 萃取大腦 - 8B] 🏁 少量多次全數看完！鎖定潛力/風險標的: [${targets.join(', ')}]，代號: [${symbols.join(', ')}]`);
        return { targets, symbols, filteredNews: finalFilteredNews.length > 0 ? finalFilteredNews : compressedNews.slice(0, 3) };
    } else {
        logger.warn(`[AI 萃取大腦 - 8B] ⚠️ 全數新聞未篩選出有效標的。全面降級使用大盤。`);
        return { targets: ['大盤權值股'], symbols: ['^TWII'], filteredNews: compressedNews.slice(0, 5) };
    }
}

/**
 * 實戰報告模板生成器
 */
function buildPrompt(reportType, globalMarketData, specificMarketData, targets, filteredNews, userQA, pastMemories, duePredictions) {
    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    
    let prompt = `現在時間是：${now}。你要產出【${reportType}】。
你是一位深諳反身性與行為金融學的台股操盤大師。投資人看你的報告是為了確認「題材潛力股、主力大戶動向、崩跌預警與操作機率」。

【當前全球大盤即時快照 (你必須深入結合看盤數據分析)】：
${JSON.stringify(globalMarketData, null, 2)}

【精選潛力/危機個股即時報價與深度主力分點籌碼】：
${JSON.stringify(specificMarketData, null, 2)}

【核心標的關聯財經新聞摘要】：\n`;

    filteredNews.forEach((news, index) => {
        prompt += `${index + 1}. [${news.symbol || '焦點'}] ${news.title}\n關鍵重點: ${news.compressed_summary || news.summary}\n\n`;
    });

    if (duePredictions && duePredictions.length > 0) {
        prompt += `【🔔 歷史分析師預言與對帳覆盤】：\n`;
        duePredictions.forEach(p => prompt += `- ${p.symbol} | 當時預測: ${p.prediction_text}\n`);
    }

    const viewpoints = (userQA || []).filter(q => q.type === 'viewpoint');
    const questions = (userQA || []).filter(q => q.type === 'question');

    if (viewpoints.length > 0 || questions.length > 0) {
        prompt += `【💬 Discord 社群即時情緒與微觀觀點】：\n`;
        viewpoints.forEach(vp => prompt += `- 用戶觀點: ${vp.user} 描述「${vp.content || vp.question}」 -> (AI 初步診斷: ${vp.evaluation})\n`);
        questions.forEach(qa => prompt += `- 用戶提問: ${qa.user} 問「${qa.content || qa.question}」\n`);
    }

    prompt += `\n請你**嚴格依照以下 Markdown 格式**產出報告，絕不可更改大標題：
【強烈要求 - 反過擬合與機率操作律條】：
1. 嚴禁使用「絕對會」、「必然跌」等斷言。趨勢必須以多空機率對稱呈現。
2. 必須給出明確的「崩跌預警」或「潛力入手點」，並強制附上破局停損條件。

========== 【${reportType}】 ==========
### 一、 盤勢資金流向與崩跌預警總結
(結合即時大盤指數與三大法人，判斷當前市場是健康多頭還是散戶接盤的泡沫期，資金流向哪裡)

### 二、 個股實戰推演、深度分點與入手機會
(針對精選潛力或危機標的，結合即時價格與分點籌碼進行推演。給出帶有機率思維的方向判定與明確破局停損條件)

### 三、 潛在風險預警 (反市場心理思維)
(現在新聞最瘋什麼？有何利多出盡的崩跌風險？或哪些標的正處於黃金坑？)

### 四、 讀者互動 QA 與社群觀點回饋
(針對群友觀點進行客觀批判，並回答 QA 提問)
====================================`;

    return prompt;
}

/**
 * 最終綜合報告生成
 */
async function generateMarketReport(reportType, globalMarketData = {}, compressedNews = []) {
    logger.info(`==================================================`);
    logger.info(`🧠 [總指揮大腦 - 8B] 🚀 啟動報告生成任務: 【${reportType}】`);
    
    if (!compressedNews || compressedNews.length === 0) {
        logger.error(`[總指揮大腦 - 8B] ❌ 未接收到新聞，拒絕捏造報告。`);
        return `⚠️ 【系統報告中斷】：目前未接收到有效的財經新聞。`;
    }

    const userQA = getPendingQA();
    let pastMemories = [];
    let duePredictions = [];

    // 1. 執行「少量多次」全面萃取，確保看完所有市場訊息並找出潛力股/崩跌訊號
    const { targets, symbols, filteredNews } = await extractMarketTargets(compressedNews, userQA);
    
    // 2. 聯動 market_api.js 精準抓股價與籌碼
    let specificMarketData = {};
    if (marketApi && typeof marketApi.fetchTargetsData === 'function' && symbols.length > 0) {
        logger.info(`[總指揮大腦 - 8B] 🔗 呼叫外部 API 獲取 ${symbols.length} 檔標的之報價與籌碼...`);
        try {
            specificMarketData = await marketApi.fetchTargetsData(targets, symbols);
        } catch (e) {
            logger.warn(`[總指揮大腦 - 8B] ⚠️ 報價數據聯動失敗: ${e.message}`);
        }
    }

    try {
        if (typeof getDuePredictions === 'function') duePredictions = await getDuePredictions();
    } catch (e) {}

    // 3. 組合最終 Prompt
    logger.info(`[總指揮大腦 - 8B] ⚙️ 正在組合最終看盤 Prompt，準備傳送給 8B 模型...`);
    const finalPrompt = buildPrompt(reportType, globalMarketData, specificMarketData, targets, filteredNews, userQA, pastMemories, duePredictions);

    const requestOptions = { temperature: 0.2, top_p: 0.5, num_ctx: 8192 };
    const startTime = Date.now();
    
    try {
        const response = await axios.post(OLLAMA_URL, {
            model: MODEL_8B, 
            system: SYSTEM_PROMPT, 
            prompt: finalPrompt, 
            stream: false, 
            options: requestOptions
        }, { timeout: MAX_TIMEOUT_MS }); // 🌟 [優化] 給予最終大腦 30 分鐘充足推論時間

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.info(`[總指揮大腦 - 8B] 🎉 最終綜合分析報告生成完畢！(總耗時: ${duration}s)`);

        if (response.data && response.data.response) {
            clearPendingQA(); 
            return response.data.response;
        }
        throw new Error('API 成功連線但缺少 response 欄位');
    } catch (error) {
        logger.error(`[總指揮大腦 - 8B] ❌ 報告生成嚴重錯誤: ${error.message}`);
        return `⚠️ 系統提示：AI 模組生成報告時發生錯誤。`;
    }
}

/**
 * 4. 用戶模糊個股語意分析與即時診斷
 */
async function evaluateUserInput(userName, userInput, type) {
    let instantEval = '';
    if (type === 'viewpoint') {
        const prompt = `你現在是一位精通台股暗語的主力操盤手。
用戶沒有提供代號，僅發表了一段含糊的市場觀察：「${userInput}」。

【任務】：
1. 根據他描述的關鍵字，在第一行明確指出他可能是在隱喻哪一家「公司名稱」與「股票代號」（若不知道則寫未定）。
2. 在第二行，以 60 字內犀利點出該觀點是否有「情緒過熱/盲目跟風」或「具備反身性深思考」的特質。`;
        
        logger.info(`[AI 情緒與個股識別 - 8B] 🕵️ 正在解讀散戶 (${userName}) 的發言...`);
        const startTime = Date.now();
        try {
            const response = await axios.post(OLLAMA_URL, {
                model: MODEL_8B, 
                prompt, 
                stream: false, 
                options: { temperature: 0.3, num_ctx: 2048 }
            }, { timeout: MAX_TIMEOUT_MS });
            instantEval = response.data.response.trim();
            logger.info(`[AI 情緒與個股識別 - 8B] ✅ 解讀完成 (耗時: ${((Date.now() - startTime) / 1000).toFixed(2)}s)`);
        } catch (error) {
            logger.error(`[AI 情緒與個股識別 - 8B] ❌ 評估失敗: ${error.message}`);
            instantEval = '個股模糊識別離線，暫無初步評估';
        }
    }
    
    let qaList = [];
    if (fs.existsSync(qaFilePath)) {
        try { qaList = JSON.parse(fs.readFileSync(qaFilePath, 'utf-8')); } catch (e) {}
    }
    qaList.push({ user: userName, content: userInput, evaluation: instantEval, type: type });
    fs.writeFileSync(qaFilePath, JSON.stringify(qaList, null, 2));
    return instantEval;
}

module.exports = { addPendingQA, summarizeNews, generateMarketReport, evaluateUserInput };