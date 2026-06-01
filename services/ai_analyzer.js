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
const MAX_TIMEOUT_MS = 1800000; // 30 分鐘超時保護

// 輕重雙引擎配置 (依需求替換為輕量化模型以提升效能)
const MODEL_8B = 'hf.co/Qwen/Qwen3-4B-GGUF:Q8_0'; 
const MODEL_3B = 'qwen2.5:3b'; 

// ==========================================
// 🛠️ 專屬 JSON 解析防護網
// ==========================================
/**
 * 解決 AI 經常輸出 Markdown 標記或不標準 JSON 的問題
 */
function safeParseJSON(rawResponse) {
    try {
        // 1. 先嘗試最直接的解析
        return JSON.parse(rawResponse);
    } catch (e) {
        // 2. 清理常見的 Markdown 語法與頭尾廢話
        let cleanText = rawResponse.replace(/```json/gi, '').replace(/```/g, '').trim();
        const startIndex = cleanText.indexOf('{');
        const endIndex = cleanText.lastIndexOf('}');
        
        if (startIndex !== -1 && endIndex !== -1 && endIndex >= startIndex) {
            const jsonStr = cleanText.substring(startIndex, endIndex + 1);
            try {
                return JSON.parse(jsonStr);
            } catch (err) {
                // 3. 容錯處理：移除陣列或物件結尾多餘的逗號 (Trailing commas)
                const fixedStr = jsonStr.replace(/,\s*([}\]])/g, '$1');
                return JSON.parse(fixedStr);
            }
        }
        throw new Error("無法從 AI 回應中萃取出有效的 JSON 結構");
    }
}

// ==========================================
// 📖 字典載入與後處理機制 (解決代號對不上的問題)
// ==========================================
const twDictPath = path.join(__dirname, '../tw_stocks.json');
const usDictPath = path.join(__dirname, '../us_stocks.json');
let stockDict = {}; // 格式統一為: { "台積電": "2330.TW", "輝達": "NVDA" }

/**
 * 🌟 高兼容性字典解析器：支援陣列與物件等多種常見 JSON 格式
 */
function parseDictionary(data, suffix = '') {
    if (Array.isArray(data)) {
        data.forEach(item => {
            const sym = item.symbol || item.Symbol || item.Ticker || item.代號;
            const name = item.name || item.Name || item.名稱 || item.股名;
            if (sym && name) stockDict[name] = suffix ? `${sym}${suffix}` : sym;
        });
    } else if (typeof data === 'object') {
        for (const [k, v] of Object.entries(data)) {
            // 判斷 k 和 v 哪個是代號、哪個是中文名稱 (代號通常是純英數)
            if (/^[A-Za-z0-9]+$/.test(k) && !/^[A-Za-z0-9]+$/.test(v)) {
                stockDict[v] = suffix ? `${k}${suffix}` : k;
            } else if (!/^[A-Za-z0-9]+$/.test(k) && /^[A-Za-z0-9]+$/.test(v)) {
                stockDict[k] = suffix ? `${v}${suffix}` : v;
            } else {
                stockDict[v] = suffix ? `${k}${suffix}` : k; // 預設 k為代號, v為名稱
            }
        }
    }
}

function loadDictionaries() {
    try {
        if (fs.existsSync(twDictPath)) {
            const twData = JSON.parse(fs.readFileSync(twDictPath, 'utf-8'));
            parseDictionary(twData, '.TW'); // 台股強制加 .TW 讓 Yahoo Finance 看得懂
            logger.info('📖 [字典系統] 台股字典載入成功');
        }
        if (fs.existsSync(usDictPath)) {
            const usData = JSON.parse(fs.readFileSync(usDictPath, 'utf-8'));
            parseDictionary(usData, ''); // 美股不加
            logger.info('📖 [字典系統] 美股字典載入成功');
        }
    } catch (e) {
        logger.error(`❌ [字典系統] 載入失敗: ${e.message}`);
    }
}
loadDictionaries();

/**
 * 🌟 強化版模糊比對股票名稱轉換代號
 */
function mapNameToSymbol(name) {
    if (!name) return null;
    // 1. 完全比對優先
    if (stockDict[name]) return stockDict[name];
    
    // 2. 模糊比對防呆機制
    for (const [dictName, symbol] of Object.entries(stockDict)) {
        // 防呆：字典名稱至少要2個字以上，避免 "大盤" 的 "大" 誤配到 "大立光"
        if (dictName.length >= 2) {
            if (name.includes(dictName) || dictName.includes(name)) {
                return symbol;
            }
        }
    }
    return null;
}

// ==========================================
// 系統提示詞與檔案路徑
// ==========================================
const systemPromptPath = path.join(__dirname, '../config/system_prompt.txt');
let SYSTEM_PROMPT = '你是一位具備反身性思考的台股資深操盤手，講話絕不說死，富有機率思維。';
if (fs.existsSync(systemPromptPath)) {
    SYSTEM_PROMPT = fs.readFileSync(systemPromptPath, 'utf-8');
}

const qaFilePath = path.join(__dirname, '../output/pending_qa.json');
const processedNewsPath = path.join(__dirname, '../output/processed_news.json');
const aiMemoryPath = path.join(__dirname, '../output/ai_memory.json');

// ==========================================
// 📝 記憶與 QA 管理區
// ==========================================
function addPendingQA(user, question, evaluation = '', type = 'question') {
    let qaList = [];
    if (fs.existsSync(qaFilePath)) {
        try { qaList = JSON.parse(fs.readFileSync(qaFilePath, 'utf-8')); } catch (e) {}
    }
    qaList.push({ user, question, evaluation, type });
    if (!fs.existsSync(path.dirname(qaFilePath))) fs.mkdirSync(path.dirname(qaFilePath), { recursive: true });
    fs.writeFileSync(qaFilePath, JSON.stringify(qaList, null, 2));
    logger.info(`📝 [QA 管理] 已新增紀錄 (${type}): ${user} - ${question.substring(0, 15)}...`);
}

function getPendingQA() {
    if (!fs.existsSync(qaFilePath)) return [];
    try { return JSON.parse(fs.readFileSync(qaFilePath, 'utf-8')); } catch (e) { return []; }
}

function clearPendingQA() {
    fs.writeFileSync(qaFilePath, JSON.stringify([]));
    logger.info(`🧹 [QA 管理] 已清空待處理的 QA 暫存檔。`);
}

function getProcessedNewsHashes() {
    if (!fs.existsSync(processedNewsPath)) return [];
    try { return JSON.parse(fs.readFileSync(processedNewsPath, 'utf-8')); } catch (e) { return []; }
}

function getAIMemory() {
    if (!fs.existsSync(aiMemoryPath)) return { pastTargets: [], marketView: "" };
    try { return JSON.parse(fs.readFileSync(aiMemoryPath, 'utf-8')); } catch (e) { return { pastTargets: [], marketView: "" }; }
}

// ==========================================
// 🧠 核心 AI 邏輯區
// ==========================================

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
 */
async function extractMarketTargets(compressedNews, userQA, globalMarketData) {
    if (!compressedNews || compressedNews.length === 0) {
        logger.warn(`[AI 萃取大腦 - 8B] ⚠️ 收到 0 篇新聞，略過萃取。`);
        return { targets: [], symbols: [], filteredNews: [] };
    }

    const processedHashes = getProcessedNewsHashes();
    const newNews = compressedNews.filter(n => !processedHashes.includes(n.title)); 
    const aiMemory = getAIMemory(); 

    logger.info(`[AI 萃取大腦 - 8B] 🎯 啟動「Top-Down」盤勢優先分析。`);
    logger.info(`[記憶系統] 總新聞量: ${compressedNews.length} 篇，未處理新進新聞: ${newNews.length} 篇`);
    
    if (newNews.length === 0) {
        logger.info(`[記憶系統] 💤 沒有新新聞，直接沿用歷史看盤記憶！`);
        const symbols = aiMemory.pastTargets.map(t => t.symbol);
        const names = aiMemory.pastTargets.map(t => t.name);
        return { targets: names, symbols: symbols, filteredNews: compressedNews.slice(0, 3) };
    }

    const BATCH_SIZE = 15;
    let allMergedSelections = [];
    let finalFilteredNews = [];
    let uniqueSymbolsCheck = new Set();
    const userTopics = userQA.length > 0 ? userQA.map(q => q.content || q.question).join('; ') : '無特別話題';

    const marketTrendContext = globalMarketData 
        ? `大盤指數: ${globalMarketData.twii || '未知'}，法人動向: ${globalMarketData.institutional || '未知'}` 
        : '大盤資訊暫無';

    for (let i = 0; i < newNews.length; i += BATCH_SIZE) {
        const currentBatch = newNews.slice(i, i + BATCH_SIZE);
        logger.info(`⚡ [少量多次進行中] 正在深度分析第 ${i + 1} 到 ${i + currentBatch.length} 篇新進新聞...`);
        
        const newsCatalog = currentBatch.map((n, idx) => 
            `[索引 ${idx}] 標題：${n.title}\n摘要：${n.summary || n.compressed_summary}`
        ).join('\n\n');

        const prompt = `你是一位實戰派台股分析師。
【當前大盤環境】：${marketTrendContext}
【歷史分析記憶】：${aiMemory.marketView || '無'}
【散戶話題】：${userTopics}

【當前新聞區塊】：
${newsCatalog}

【強制輸出指令】：
請根據上方資訊挑選潛力或危險股。只能輸出具體的「公司名稱」(如:緯創)。
你現在是一台嚴格的 JSON 生成器，絕對禁止輸出任何前言、結語或 Markdown 標記（如 \`\`\`json ）。你只能且必須輸出能被直接解析的 JSON 格式：
{
  "market_view": "對新批次新聞與盤勢疊加的整體看法(20字)",
  "selections": [
    { "name": "中興電", "news_indices": [0], "reason": "潛力股/崩跌危機簡述" }
  ]
}`;

        const batchStartTime = Date.now();
        try {
            const response = await axios.post(OLLAMA_URL, {
                model: MODEL_8B,       
                prompt: prompt, 
                stream: false, 
                format: 'json', 
                options: { temperature: 0.1, num_ctx: 4096, num_predict: 1024 }
            }, { timeout: MAX_TIMEOUT_MS });

            const rawResponse = response.data.response;
            
            // 🌟 導入強健的 JSON 解析器
            let parsedData;
            try {
                parsedData = safeParseJSON(rawResponse);
            } catch (parseError) {
                logger.warn(`  └─ ⚠️ 當前批次 JSON 解析失敗，原始 AI 回覆: ${rawResponse.substring(0, 100)}...`);
                throw new Error("JSON 格式損壞且無法修復");
            }
            
            if (parsedData.market_view) aiMemory.marketView = parsedData.market_view;
            
            if (parsedData.selections && Array.isArray(parsedData.selections)) {
                for (const item of parsedData.selections) {
                    if (['新台幣', 'CPI', '通膨', '降息', '大盤', '稅收', '台股'].includes(item.name)) continue;
                    
                    const mappedSymbol = mapNameToSymbol(item.name);
                    
                    if (mappedSymbol && !uniqueSymbolsCheck.has(mappedSymbol)) {
                        uniqueSymbolsCheck.add(mappedSymbol);
                        item.symbol = mappedSymbol; 
                        allMergedSelections.push(item);
                        
                        if (item.news_indices) {
                            item.news_indices.forEach(idx => {
                                const safeIdx = parseInt(idx, 10);
                                if (safeIdx >= 0 && safeIdx < currentBatch.length) {
                                    finalFilteredNews.push(currentBatch[safeIdx]);
                                }
                            });
                        }
                    } else if (!mappedSymbol) {
                        logger.warn(`  └─ ⚠️ [字典過濾] AI 提出 "${item.name}"，但在字典中找不到代號，予以剔除。`);
                    }
                }
            }
        } catch (e) {
            logger.warn(`  └─ ⚠️ 當前批次處理跳過: ${e.message}，不影響全局。`);
        }
    }

    const updatedProcessedHashes = [...processedHashes, ...newNews.map(n => n.title)].slice(-200); 
    fs.writeFileSync(processedNewsPath, JSON.stringify(updatedProcessedHashes, null, 2));

    let targets = [];
    let symbols = [];
    
    const combinedSelections = [...aiMemory.pastTargets, ...allMergedSelections];
    const uniqueSelections = combinedSelections.filter((v, i, a) => a.findIndex(t => (t.symbol === v.symbol)) === i);
    const finalSelections = uniqueSelections.slice(-8); 

    if (finalSelections.length > 0) {
        finalSelections.forEach(item => {
            targets.push(item.name);
            symbols.push(item.symbol);
        });
        
        aiMemory.pastTargets = finalSelections;
        fs.writeFileSync(aiMemoryPath, JSON.stringify(aiMemory, null, 2));
        
        logger.info(`[AI 萃取大腦 - 8B] 🏁 分析完畢！鎖定潛力/風險標的: [${targets.join(', ')}]，代號: [${symbols.join(', ')}]`);
        return { targets, symbols, filteredNews: finalFilteredNews.length > 0 ? finalFilteredNews : compressedNews.slice(0, 3) };
    } else {
        logger.warn(`[AI 萃取大腦 - 8B] ⚠️ 全數新聞未篩選出有效標的。全面降級使用大盤。`);
        return { targets: ['大盤權值股'], symbols: ['^TWII'], filteredNews: compressedNews.slice(0, 5) };
    }
}

/**
 * 🌟 實戰報告模板生成器 (包含防幻覺與防呆機制)
 */
function buildPrompt(reportType, globalMarketData, specificMarketData, targets, symbols, filteredNews, userQA, pastMemories, duePredictions) {
    const now = new Date();
    const timeString = now.toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    
    // 🛑 核心修復 1：假日判斷，防呆「成交量為0 = 假多頭」的荒唐邏輯
    const isWeekend = [0, 6].includes(now.getDay());
    const weekendNote = isWeekend 
        ? `\n【⚠️ 假日防呆警報 ⚠️】：今天是週末假日，台股未開盤！因此大盤與個股的「成交量為0」是完全正常的休市狀態。絕對不可將成交量0解讀為「市場低迷」、「假多頭」、「量縮」或「主力出貨」。` 
        : "";

    // 🛑 核心修復 2：建立已經驗證的代號對照表，堵死 AI 通靈代號的空間
    let verifiedMapping = targets.map((t, idx) => `- ${t} (正確代號: ${symbols[idx]})`).join('\n');
    if (!verifiedMapping) verifiedMapping = "無特定標的";

    let prompt = `現在時間是：${timeString}。你要產出【${reportType}】。
你是一位深諳反身性與行為金融學的台股操盤大師。投資人看你的報告是為了確認「題材潛力股、主力大戶動向、崩跌預警與操作機率」。

【系統已校正之個股代號對照表】：
${verifiedMapping}

【當前全球大盤即時快照 (Top-Down 最高決策依據)】：
${JSON.stringify(globalMarketData, null, 2)}

【精選個股即時報價與深度籌碼 (無報價則表示系統未取得，禁捏造)】：
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

【強烈要求 - 反幻覺與機率操作律條】(若違反將遭系統抹除)：
1. 嚴禁通靈股價與代號：提及個股時，【必須且只能】使用上方校正對照表的代號。絕不准憑空捏造或猜測代號 (例如 雙鴻2322是錯的，不知道代號就只寫名稱)。如果【報價區塊】沒有該股最新價格，絕對不准自己編造股價與漲跌幅！${weekendNote}
2. 機率思維：嚴禁使用「絕對會」、「必然跌」等斷言。趨勢必須以多空機率對稱呈現。
3. 盤勢主導：必須先講大盤環境，再切入個股邏輯，給出明確的破局停損條件。

========== 【${reportType}】 ==========
### 一、 盤勢資金流向與崩跌預警總結
(結合即時大盤指數與三大法人，判斷當前市場健康度與資金流向)

### 二、 個股實戰推演、深度分點與入手機會
(針對精選潛力或危機標的進行推演。給出帶有機率思維的方向判定與明確破局停損條件)

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

    const { targets, symbols, filteredNews } = await extractMarketTargets(compressedNews, userQA, globalMarketData);
    
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

    // 🌟 核心修復：把 symbols 陣列傳遞給 buildPrompt 製作防呆對照表
    logger.info(`[總指揮大腦 - 8B] ⚙️ 正在組合最終看盤 Prompt，準備傳送給 8B 模型...`);
    const finalPrompt = buildPrompt(reportType, globalMarketData, specificMarketData, targets, symbols, filteredNews, userQA, pastMemories, duePredictions);

    const requestOptions = { temperature: 0.1, top_p: 0.5, num_ctx: 8192 };
    const startTime = Date.now();
    
    try {
        const response = await axios.post(OLLAMA_URL, {
            model: MODEL_8B, 
            system: SYSTEM_PROMPT, 
            prompt: finalPrompt, 
            stream: false, 
            options: requestOptions
        }, { timeout: MAX_TIMEOUT_MS });

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
 * 🌟 [重磅修復] 導入 JSON 強制模式、字典查代號、與嚴格繁體中文約束
 */
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
        
        logger.info(`[AI 情緒與個股識別 - 8B] 🕵️ 正在解讀散戶 (${userName}) 的發言...`);
        const startTime = Date.now();
        try {
            const response = await axios.post(OLLAMA_URL, {
                model: MODEL_8B, 
                prompt, 
                stream: false, 
                format: 'json', // 🌟 解除封印：啟用 JSON 強制模式
                options: { temperature: 0.1, num_ctx: 2048 }
            }, { timeout: MAX_TIMEOUT_MS });
            
            const rawResponse = response.data.response;
            logger.info(`  └─ 🤖 [原始回覆預覽]: ${rawResponse.substring(0, 50)}...`);

            // 🌟 導入強健的 JSON 解析器
            let parsed;
            try {
                parsed = safeParseJSON(rawResponse);
            } catch (parseError) {
                logger.warn(`  └─ ⚠️ JSON 解析失敗，原始 AI 回覆: ${rawResponse.substring(0, 100)}...`);
                throw new Error("無法解析出正確的 JSON 結構");
            }
            
            // 🌟 核心修復：攔截 AI 抓出的公司名稱，交由我們的字典去查正確代號
            const compName = parsed.company_name || '未定';
            let finalTargetDisplay = compName;
            
            if (compName !== '未定') {
                const mappedSymbol = mapNameToSymbol(compName);
                if (mappedSymbol) {
                    finalTargetDisplay = `${compName} (${mappedSymbol})`; // 字典查到了，掛上正確代號 (ex: 雙鴻 (3324.TW))
                }
            }

            // 組合出精美且正確的 Discord 回應
            instantEval = `🎯 **標的識別**：${finalTargetDisplay}\n💡 **觀點速評**：${parsed.evaluation || '無'}`;
            
            logger.info(`[AI 情緒與個股識別 - 8B] ✅ 解讀完成 (耗時: ${((Date.now() - startTime) / 1000).toFixed(2)}s)`);
        } catch (error) {
            logger.error(`[AI 情緒與個股識別 - 8B] ❌ 評估失敗: ${error.message}`);
            instantEval = '個股模糊識別離線，暫無初步評估';
        }
    }
    
    // 將結果記錄到 QA 檔案中，供後續大報告使用
    addPendingQA(userName, userInput, instantEval, type);
    return instantEval;
}

/**
 * 🌟 5. 新增：個股即時走勢速評 (走輕量模型，求快)
 * 供 Discord !查 指令專用，結合 Market API 與資料庫中的關聯新聞進行極速診斷
 */
async function quickAnalyzeStock(symbol, stockData) {
    logger.info(`[AI 即時速評 - 3B] ⚡ 啟動 ${symbol} 走勢與新聞關聯分析...`);
    const startTime = Date.now();

    // 將近 10 日的走勢陣列轉為文字
    const trendStr = (stockData.recentTrend || []).map(t => `${t.date}: 收盤 ${t.close}, 成交量 ${t.volume}`).join('\n');
    
    // 🌟 核心擴充：從資料庫撈取 48 小時內的近期新聞，過濾出與該標的有關的內容
    const allRecentNews = db.getRecentNews(48);
    const cleanSymbol = symbol.replace(/\.TW|\.TWO/gi, ''); // 拔掉後綴，保留純代號
    const stockName = stockData.name || symbol;

    const relatedNews = allRecentNews.filter(news => {
        // 比對條件 1: 新聞標籤剛好有這檔股票
        const matchSymbol = news.symbols && (news.symbols.includes(symbol) || news.symbols.includes(cleanSymbol));
        // 比對條件 2: 新聞標題或摘要提到了這家公司的名字
        const matchName = stockName && (news.title.includes(stockName) || (news.summary && news.summary.includes(stockName)));
        // 比對條件 3: 新聞標題或摘要提到了純數字代號
        const matchCleanName = news.title.includes(cleanSymbol);
        
        return matchSymbol || matchName || matchCleanName;
    }).slice(0, 5); // 最多只取 5 篇，避免 Prompt 太長被截斷

    let newsContext = '目前資料庫中無該標的之近期關聯新聞。';
    if (relatedNews.length > 0) {
        newsContext = relatedNews.map((n, i) => `[新聞 ${i + 1}] ${n.title}\n摘要重點: ${n.summary}`).join('\n\n');
        logger.info(`[AI 即時速評 - 3B] 📰 成功從資料庫撈取 ${relatedNews.length} 篇關聯新聞餵給 AI。`);
    } else {
        logger.warn(`[AI 即時速評 - 3B] ⚠️ 資料庫內目前找不到 ${stockName} (${symbol}) 的相關新聞。`);
    }

    const prompt = `你是一位專業台美股分析師。請根據以下即時數據、歷史走勢與近期新聞，給出一段簡潔有力的「個股速評」(大約 150-200 字)。
【標的】：${stockName} (${symbol})
【即時報價】：${stockData.currentPrice} (${stockData.changePercent})
【月線(20MA)均價】：${stockData.monthlyAvgPrice}
【本益比】：${stockData.peRatio}

【近 10 日歷史走勢】：
${trendStr}

【近期相關新聞】：
${newsContext}

【強制任務要求】：
1. 判斷目前趨勢是多頭、空頭還是盤整。
2. 點出現價與月線(20MA)的乖離關係 (例如：已跌破月線轉弱、或站穩月線具備支撐)。
3. 如果有提供「近期相關新聞」，請務必將新聞的「利多/利空題材」與股價走勢結合解讀。如果無新聞則專注於技術面。
4. 語系強制使用「繁體中文 (zh-TW)」。
5. 語氣客觀專業，直接給結論，不要廢話，不要 Markdown 大標題。`;

    try {
        const response = await axios.post(OLLAMA_URL, {
            model: MODEL_3B, 
            prompt: prompt, 
            stream: false, 
            options: { temperature: 0.2, num_ctx: 2048 } // 稍微放大 Context 給新聞閱讀
        }, { timeout: MAX_TIMEOUT_MS });

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.info(`[AI 即時速評 - 3B] ✅ 速評完成 (耗時: ${duration}s)`);
        
        // 組合最終回傳文字，附上整理好的基礎報價數據與新聞參考篇數
        const baseInfo = `**💰 現價**：${stockData.currentPrice} (${stockData.changePercent})\n**📈 月線 (20MA)**：${stockData.monthlyAvgPrice}\n**📊 本益比 (PE)**：${stockData.peRatio}\n**📰 關聯新聞**：參考了 ${relatedNews.length} 篇\n\n`;
        return baseInfo + `**💡 AI 走勢與題材解讀：**\n${response.data.response.trim()}`;

    } catch (error) {
        logger.error(`[AI 即時速評 - 3B] ❌ 速評失敗: ${error.message}`);
        return `**💰 現價**：${stockData.currentPrice} (${stockData.changePercent})\n**📈 月線 (20MA)**：${stockData.monthlyAvgPrice}\n\n⚠️ 系統提示：AI 走勢解讀模組暫時離線或回應超時。`;
    }
}

module.exports = { addPendingQA, summarizeNews, generateMarketReport, evaluateUserInput, quickAnalyzeStock };