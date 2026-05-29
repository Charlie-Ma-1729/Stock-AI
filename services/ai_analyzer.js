const axios = require('axios');
const fs = require('fs');
const path = require('path');
const logger = require('../logger'); // 注意路徑
const db = require('../db');

const OLLAMA_URL = 'http://127.0.0.1:11434/api/generate';
// 使用老闆成功下載的 3B Q8_0 量化模型
const MODEL_NAME = 'hf.co/lianghsun/Llama-3.2-Taiwan-3B-Instruct-GGUF:Q8_0'; 

const systemPromptPath = path.join(__dirname, '../config/system_prompt.txt');
let SYSTEM_PROMPT = '';
if (fs.existsSync(systemPromptPath)) {
    SYSTEM_PROMPT = fs.readFileSync(systemPromptPath, 'utf-8');
    logger.info(`📜 已成功載入系統提示詞 (System Prompt)，長度: ${SYSTEM_PROMPT.length} 字`);
} else {
    logger.warn('⚠️ 找不到 system_prompt.txt，將使用預設系統提示。');
    SYSTEM_PROMPT = '你是一位具備反身性思考的華爾街資深風向分析師。';
}

const qaFilePath = path.join(__dirname, '../output/pending_qa.json');

// ==========================================
// 📥 提問暫存區管理
// ==========================================
function addPendingQA(user, question, evaluation = '') {
    let qaList = [];
    if (fs.existsSync(qaFilePath)) {
        try { qaList = JSON.parse(fs.readFileSync(qaFilePath, 'utf-8')); } catch (e) {
            logger.warn(`⚠️ 讀取 QA 暫存檔失敗，將建立新陣列: ${e.message}`);
        }
    }
    qaList.push({ user, question, evaluation });
    if (!fs.existsSync(path.dirname(qaFilePath))) fs.mkdirSync(path.dirname(qaFilePath), { recursive: true });
    fs.writeFileSync(qaFilePath, JSON.stringify(qaList, null, 2));
    logger.info(`📝 已將用戶 [${user}] 的提問/觀點加入暫存區 (pending_qa.json)`);
}

function getPendingQA() {
    if (!fs.existsSync(qaFilePath)) return [];
    try { return JSON.parse(fs.readFileSync(qaFilePath, 'utf-8')); } catch (e) { return []; }
}

function clearPendingQA() {
    fs.writeFileSync(qaFilePath, JSON.stringify([]));
    logger.info(`🧹 QA 暫存區已清空`);
}

// ==========================================
// 🛠️ 核心處理模組
// ==========================================

async function summarizeNews(title, content) {
    const prompt = `請以「3個重點列點」總結以下新聞核心資訊，總字數不可超過 60 字。不要廢話。
    標題：${title}\n內文：${content}`;
    
    logger.info(`📰 [新聞濃縮] 準備發送給 Ollama... 標題: ${title}`);
    logger.info(`📤 [新聞濃縮] 發送 Prompt 長度: ${prompt.length} 字`);
    
    const startTime = Date.now();
    try {
        const response = await axios.post(OLLAMA_URL, {
            model: MODEL_NAME, 
            prompt: prompt, 
            stream: false, 
            options: { temperature: 0.1 } 
        });
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        
        const result = response.data.response.trim();
        logger.info(`📥 [新聞濃縮] 完成！耗時 ${duration} 秒。AI 回覆長度: ${result.length} 字`);
        return result;
    } catch (error) {
        logger.error(`❌ [新聞濃縮] 失敗: ${error.message}`);
        return '無法產生摘要';
    }
}

/**
 * 構建給 AI 的最終 Prompt
 */
function buildPrompt(reportType, marketData, compressedNews, userQA, pastMemories, duePredictions) {
    const now = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei' });
    let prompt = `現在時間是：${now}。你要產出【${reportType}】。\n\n`;

    if (duePredictions && duePredictions.length > 0) {
        prompt += `【🔔 歷史預言開獎與驗證】\n以下是過去立下的預言，現在已經到期。請結合現在的市場狀況，客觀檢討這些預言是否成真，並分析當時的盲點：\n`;
        duePredictions.forEach(p => {
            prompt += `- 預言來源: ${p.source} | 標的: ${p.symbol} | 當時說法: ${p.prediction_text} | 立下時間: ${p.created_at}\n`;
        });
        prompt += `\n`;
    }

    if (pastMemories && pastMemories.length > 0) {
        prompt += `【⚠️ 歷史記憶與覆盤教訓】\n請務必將以下你在深夜覆盤時學到的教訓納入本次分析：\n`;
        pastMemories.forEach(mem => prompt += `- ${mem}\n`);
        prompt += `\n`;
    }
    
    prompt += `【市場數據切片 (截稿前 15~30 分鐘數據)】\n${JSON.stringify(marketData, null, 2)}\n\n`;

    prompt += `【今日核心新聞濃縮】\n`;
    compressedNews.forEach((news, index) => {
        prompt += `${index + 1}. [${news.symbol}] ${news.title}\n重點: ${news.compressed_summary}\n\n`;
    });

    const viewpoints = (userQA || []).filter(q => q.type === 'viewpoint');
    const questions = (userQA || []).filter(q => q.type === 'question');

    if (viewpoints.length > 0) {
        prompt += `【💬 散戶情緒與市場觀點分析】\n以下是 Discord 群友提出的個人觀點。請在你的「正文分析環節」中納入考量，評估其邏輯合理性、是否有情緒過熱或盲目跟風的風險：\n`;
        viewpoints.forEach((vp, index) => {
            const content = vp.content || vp.question; 
            prompt += `- 用戶 ${vp.user} 認為: 「${content}」\n  (AI初步判定: ${vp.evaluation})\n`;
        });
        prompt += `\n`;
    }

    if (questions.length > 0) {
        prompt += `【📌 讀者提問 QA 環節】\n請在報告的「最尾端」獨立建立一個 QA 區塊，專業且客觀地解答以下讀者提問：\n`;
        questions.forEach((qa, index) => {
            const content = qa.content || qa.question;
            prompt += `Q${index + 1}: ${qa.user} 問：「${content}」\n`;
        });
        prompt += `\n`;
    }

    prompt += `請開始撰寫報告：`;
    return prompt;
}

async function generateMarketReport(reportType, marketData = {}, compressedNews = []) {
    logger.info(`==================================================`);
    logger.info(`🧠 [報告生成] 啟動 AI 大腦，準備生成報告類型: [${reportType}]`);
    
    const userQA = getPendingQA();
    let pastMemories = [];
    let duePredictions = [];

    // 注意：這裡的 getDuePredictions 與 queryVectorMemory 目前可能還未在系統內實作完整
    // 加上 try-catch 防止錯誤中斷主流程
    try {
        logger.info(`🔍 [報告生成] 正在向向量資料庫索取「歷史記憶」與「到期預言」...`);
        if (typeof getDuePredictions === 'function') {
            duePredictions = await getDuePredictions();
        }
        if (typeof queryVectorMemory === 'function') {
            const contextQuery = `市場環境: ${reportType}。焦點: ${compressedNews.slice(0, 3).map(n=>n.title).join(', ')}`;
            const memoryResults = await queryVectorMemory(contextQuery, 3);
            pastMemories = memoryResults.map(m => m.text);
        }
        logger.info(`🔍 [報告生成] 取得 ${duePredictions.length} 筆預言, ${pastMemories.length} 筆歷史教訓`);
    } catch (e) {
        logger.warn(`⚠️ [報告生成] 記憶庫連線或檢索失敗，本次跳過記憶與預言。原因: ${e.message}`);
    }

    const finalPrompt = buildPrompt(reportType, marketData, compressedNews, userQA, pastMemories, duePredictions);

    // ==========================================
    // 記錄發送給 Ollama 的詳細 Payload
    // ==========================================
    const requestOptions = { temperature: 0.3, top_p: 0.6 };
    logger.info(`📤 [Ollama 連線] 目標節點: ${OLLAMA_URL}`);
    logger.info(`📤 [Ollama 連線] 使用模型: ${MODEL_NAME}`);
    logger.info(`📤 [Ollama 連線] 參數設定: ${JSON.stringify(requestOptions)}`);
    logger.info(`📤 [Ollama 連線] System Prompt 長度: ${SYSTEM_PROMPT.length} 字`);
    logger.info(`📤 [Ollama 連線] User Prompt 總字數: ${finalPrompt.length} 字`);
    logger.info(`📝 [Ollama 連線] User Prompt 內容預覽 (前300字):\n${finalPrompt.substring(0, 300)} ... (省略)`);
    logger.info(`⏳ [Ollama 連線] AI 正在思考中，請稍候...`);

    const startTime = Date.now();
    try {
        const response = await axios.post(OLLAMA_URL, {
            model: MODEL_NAME,
            system: SYSTEM_PROMPT,
            prompt: finalPrompt,
            stream: false, 
            options: requestOptions
        });

        const duration = ((Date.now() - startTime) / 1000).toFixed(2);

        if (response.data && response.data.response) {
            logger.info(`📥 [Ollama 連線] 接收成功！耗時 ${duration} 秒。回傳報表長度: ${response.data.response.length} 字`);
            logger.info(`✅ [報告生成] [${reportType}] 報告生成完畢！`);
            
            clearPendingQA(); 
            
            if (typeof markPredictionEvaluated === 'function') {
                duePredictions.forEach(p => markPredictionEvaluated(p.id));
            }
            return response.data.response;
        } else {
            throw new Error('Ollama 回傳資料結構異常 (缺少 response 欄位)');
        }
    } catch (error) {
        const duration = ((Date.now() - startTime) / 1000).toFixed(2);
        logger.error(`❌ [Ollama 連線] 發生致命錯誤 (耗時 ${duration} 秒): ${error.message}`);
        if (error.response) {
            logger.error(`❌ [Ollama 連線] API 回傳狀態碼: ${error.response.status}`);
            logger.error(`❌ [Ollama 連線] API 錯誤詳情: ${JSON.stringify(error.response.data)}`);
        } else if (error.request) {
            logger.error(`❌ [Ollama 連線] 伺服器無回應，請確認 Ollama 服務是否已啟動於 127.0.0.1:11434`);
        }
        return `⚠️ 系統提示：AI 模組生成報告時發生連線或推論錯誤。`;
    }
}

// 處理用戶的「!觀點」或「?提問」
async function evaluateUserInput(userName, userInput, type) {
    logger.info(`👤 [用戶輸入] 收到用戶 [${userName}] 的 ${type === 'viewpoint' ? '觀點' : '提問'}: ${userInput}`);
    
    let instantEval = '';
    if (type === 'viewpoint') {
        const prompt = `你現在要即時評估一位散戶投資人的觀點。用戶發言：「${userInput}」。請識別提到的股票，並以 50 字內點出該觀點是否有「情緒過熱/盲目跟風」的風險。`;
        
        logger.info(`📤 [即時評估] 準備交由 AI 評估用戶觀點...`);
        const startTime = Date.now();
        try {
            const response = await axios.post(OLLAMA_URL, {
                model: MODEL_NAME, prompt, stream: false, options: { temperature: 0.4 }
            });
            instantEval = response.data.response.trim();
            const duration = ((Date.now() - startTime) / 1000).toFixed(2);
            logger.info(`📥 [即時評估] 評估完成！耗時 ${duration} 秒。AI 評語: ${instantEval}`);
        } catch (error) {
            logger.error(`❌ [即時評估] 連線 Ollama 失敗: ${error.message}`);
            instantEval = '系統離線，暫無初步評估';
        }
    }
    
    let qaList = [];
    if (fs.existsSync(qaFilePath)) {
        try { qaList = JSON.parse(fs.readFileSync(qaFilePath, 'utf-8')); } catch (e) {}
    }
    qaList.push({ user: userName, content: userInput, evaluation: instantEval, type: type });
    fs.writeFileSync(qaFilePath, JSON.stringify(qaList, null, 2));
    logger.info(`📝 [用戶輸入] 已將資料寫入 ${qaFilePath}`);

    return instantEval;
}

module.exports = { summarizeNews, generateMarketReport, evaluateUserInput };