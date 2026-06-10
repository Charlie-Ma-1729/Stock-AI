// bot.js
require('dotenv').config(); 

const { Client, GatewayIntentBits, ActivityType } = require('discord.js');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const db = require('./db');
const ai_analyzer = require('./services/ai_analyzer');
const marketApi = require('./services/market_api');

let scheduler;

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID ? process.env.TARGET_CHANNEL_ID.trim() : null;
// 過濾掉未設定的環境變數，並加上 trim() 防止複製貼上產生的空白
const WATCH_CHANNELS = [process.env.WATCH_CHANNEL_1, process.env.WATCH_CHANNEL_2]
    .filter(Boolean)
    .map(id => id.trim());
const TOPIC_UPDATE_CHANNEL = process.env.TOPIC_UPDATE_CHANNEL ? process.env.TOPIC_UPDATE_CHANNEL.trim() : null;

if (!DISCORD_TOKEN || DISCORD_TOKEN.trim() === '') {
    logger.error('❌ [致命錯誤] 未在 .env 檔案中找到 DISCORD_TOKEN！');
    process.exit(1);
}

// ==========================================
// 🌟 核心修改 6：自訂 Base Prompt 投資風格與對話要求
// ==========================================
const BASE_PROMPT = process.env.BASE_PROMPT || 
    "你是一個專業的投資顧問，現在正在一個公開頻道與多位使用者進行股市相關群聊。請用語氣輕鬆、日常的「對話式」來回覆，保持聊天的感覺，並根據資料內容給予專業的投資建議。核心設定：使用者在遇到下跌時「不會」設定停損點賣出綠字，而是會耐心抱著直到翻紅才賣出。請配合這個投資心態給予專業投資建議。";

// ==========================================
// 🌟 核心修改 4：全頻道共用上下文記憶庫 (10分鐘無接續則清空)
// ==========================================
const channelSessions = new Map();
const SESSION_EXPIRY_MS = 10 * 60 * 1000; // 10分鐘

// 載入台美股字典檔，用於對話內容偵測
let allStocks = {};
try {
    const twData = require('./tw_stocks.json');
    const usData = require('./us_stocks.json');
    
    // 🌟 核心修改 5：自動清除字典檔內股票名稱的特殊字元 (例如 國巨*)
    const cleanName = (str) => {
        if (!str) return '';
        // 替換掉星號(*)等無關緊要的註記符號
        return str.toString().replace(/[*＊+＋]/g, '').trim();
    };

    const parseDict = (data) => {
        const result = {};
        if (Array.isArray(data)) {
            data.forEach(item => {
                const sym = item.symbol || item.Symbol || item.Ticker || item.代號;
                const name = item.name || item.Name || item.名稱 || item.股名;
                if (sym && name) {
                    const pureSym = sym.toString().replace(/\.TW|\.TWO/gi, '');
                    result[pureSym] = cleanName(name);
                    result[sym.toString()] = cleanName(name);
                }
            });
        } else if (typeof data === 'object' && data !== null) {
            // 處理 {"2330": "台積電"} 或是 {"雙鴻": "3324"} 這種 Object 格式
            for (const [k, v] of Object.entries(data)) {
                let name, sym;
                if (/^[A-Za-z0-9.]+$/.test(k) && !/^[A-Za-z0-9.]+$/.test(v)) {
                    sym = k; name = v;
                } else if (!/^[A-Za-z0-9.]+$/.test(k) && /^[A-Za-z0-9.]+$/.test(v)) {
                    sym = v; name = k;
                } else {
                    sym = v; name = k; // 預設
                }
                const pureSym = sym.toString().replace(/\.TW|\.TWO/gi, '');
                result[pureSym] = cleanName(name);
                result[sym.toString()] = cleanName(name);
            }
        }
        return result;
    };
    
    allStocks = { ...parseDict(twData), ...parseDict(usData) };

    allStocks['^TWII'] = '加權指數';
    allStocks['^DJI'] = '道瓊工業';
    allStocks['^IXIC'] = '納斯達克';
    allStocks['^SOX'] = '費半指數';
    allStocks['^GSPC'] = '標普500';

    logger.info(`📖 [對話偵測] 字典載入完成，共掛載 ${Object.keys(allStocks).length} 筆辨識關鍵字。`);

} catch (e) {
    logger.warn(`⚠️ 字典檔載入失敗，部分股票偵測功能可能受限: ${e.message}`);
}

// ==========================================
// 🌟 核心修改 1：移除熱門股，只保留五大指數與對話中提及的股票
// ==========================================
const BASE_INDICES = ['^TWII', '^DJI', '^IXIC', '^SOX', '^GSPC'];
const dynamicStocks = new Map(); 
const EXPIRY_MS = 3 * 24 * 60 * 60 * 1000; // 3 天沒人理的股票就淘汰

let trendingRotationIndex = 0; // 用於機器人狀態(每10秒單檔)
let topicRotationIndex = 0;    // 用於頻道主題(每10分五檔)

/**
 * 取得當前有效的股票陣列 (並順便清除過期的股票)
 */
function getActiveSymbols() {
    const now = Date.now();
    for (const [sym, lastSeen] of dynamicStocks.entries()) {
        if (now - lastSeen > EXPIRY_MS) {
            dynamicStocks.delete(sym);
            logger.info(`🗑️ [觀察庫] ${sym} 已經超過 3 天未被討論，自動從走馬燈中移除。`);
        }
    }
    return [...new Set([...BASE_INDICES, ...dynamicStocks.keys()])];
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.once('clientReady', async () => {
    logger.info(`🤖 [Discord Bot] 已成功登入為 ${client.user.tag}`);
    scheduler = require('./scheduler');

    // 啟觸發馬燈 (每3秒) 與頻道主題更新 (每10分)
    setInterval(updateTickerStatus, 3 * 1000);
    setInterval(updateChannelTopic, 10 * 60 * 1000);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const content = message.content.trim();
    const channelId = message.channel.id;
    const now = Date.now();

    const shouldWatch = WATCH_CHANNELS.length === 0 || WATCH_CHANNELS.includes(channelId);
    if (!shouldWatch) return; // 不在監聽頻道的訊息直接略過

    try {
        let session = channelSessions.get(channelId);
        
        // 如果有舊對話，但距離上次超過10分鐘，清除記憶並【提取投資建議留作覆盤】
        if (session && (now - session.lastUpdated > SESSION_EXPIRY_MS)) {
            logger.info(`[記憶清空] 頻道 ${channelId} 閒置超過10分鐘，準備清空記憶並提取這輪的投資建議。`);
            
            // 呼叫覆盤存檔函式 (不 await 阻塞接下來的對話反應)
            extractAndSaveAdvice(session.history, channelId);
            
            session = null; 
        }

        if (!session) {
            session = { history: [], lastUpdated: now };
        }

        // 1. 偵測字串中是否有提及股票，並取得清單
        const detectedSymbols = detectStocksInMessage(content); 

        const waitMsg = await message.reply('💬 **思考中...**');
        
        // 2. 自動抓取提及股票的 Finance 資料
        let marketContext = "";
        if (detectedSymbols.length > 0) {
            marketContext += "【系統自動帶入：用戶剛提及的股票最新報價】\n";
            for (const sym of detectedSymbols) {
                try {
                    const stockData = await marketApi.fetchStockTrend(sym);
                    if (!stockData.error) {
                        marketContext += `- ${stockData.symbol} (${stockData.name}): 目前價格 ${stockData.price || '未知'}，漲跌幅 ${stockData.changePercent || '未知'}%\n`;
                    }
                } catch(e) {
                    logger.warn(`自動抓取 ${sym} 報價失敗: ${e.message}`);
                }
            }
        }

        // 3. 組裝 Context 與 Prompt 送給 AI
        // 保存使用者的發言到歷史
        session.history.push({ role: 'user', name: message.author.username, content: content });

        // 取出最近 30 句 (擴大上下文長度，包含 AI 自己講過的話)
        const recentHistory = session.history.slice(-30); 
        let chatLog = recentHistory.map(m => `${m.role === 'user' ? m.name : '你(AI)'}: ${m.content}`).join('\n');

        const finalPrompt = `
【核心設定與提示】
${BASE_PROMPT}

${marketContext}
【最近 30 句群聊紀錄】
${chatLog}

請根據上述群聊紀錄與市場數據，直接用精簡且口語的自然對話給出你最新的回覆 (不需要加上自己的名字前綴)：`;

        // 呼叫大腦進行對話分析與回應
        const answer = await ai_analyzer.evaluateUserInput(message.author.username, finalPrompt, 'viewpoint');
        
        // 將 AI 的回覆存入記憶 (標示 role 為 assistant)
        session.history.push({ role: 'assistant', name: 'AI', content: answer });
        session.lastUpdated = Date.now();
        channelSessions.set(channelId, session); 

        // 發送訊息 (防超過2000字)
        if (answer.length > 1900) {
            await waitMsg.delete(); 
            const chunks = answer.match(/[\s\S]{1,1900}/g) || [];
            for (const chunk of chunks) {
                await message.channel.send(chunk);
            }
        } else {
            await waitMsg.edit(answer);
        }

    } catch (error) {
        logger.error(`❌ 處理 Discord 訊息時發生未預期錯誤: ${error.message}`);
    }
});

/**
 * 🌟 新增功能：在記憶清空前，將這一輪的對話丟給 AI 濃縮成投資建議，並存入資料庫
 */
async function extractAndSaveAdvice(history, channelId) {
    if (!history || history.length === 0) return;
    try {
        const chatLog = history.map(m => `${m.role === 'user' ? m.name : 'AI'}: ${m.content}`).join('\n');
        const summaryPrompt = `請總結以下對話紀錄中，你(AI)給予使用者的具體「投資建議」、「提到的股票標的」與「後市看法」。\n請以簡短的條列式輸出，這個總結將存入資料庫，作為未來夜間覆盤與經驗學習的參考資料。\n\n【對話紀錄】\n${chatLog}`;
        
        // 呼叫 AI 進行總結 (使用 summary 模式或您自訂的模式)
        const adviceSummary = await ai_analyzer.evaluateUserInput('System_Review', summaryPrompt, 'viewpoint');
        
        // 存入 DB 
        // ⚠️ 請確保您的 db.js 裡面有 saveAdvice 或對應的紀錄寫入方法
        if (typeof db.saveAdvice === 'function') {
            await db.saveAdvice({ channelId, summary: adviceSummary, timestamp: new Date() });
            logger.info(`[覆盤存檔] 成功將頻道 ${channelId} 過去 10 分鐘的投資建議總結並存入 DB。`);
        } else {
            logger.warn(`[覆盤存檔] 尚未在 db.js 實作 saveAdvice()。提取出的建議摘要如下，請在 DB 建置後寫入：\n${adviceSummary}`);
        }
    } catch (error) {
        logger.error(`[覆盤存檔] 提取對話投資建議失敗: ${error.message}`);
    }
}

/**
 * 偵測訊息中的股票：有提到就加入跑馬燈，並回傳代號以便即時查報價
 */
function detectStocksInMessage(content) {
    const now = Date.now();
    const matchedSymbols = new Set(); 
    const lookupTargets = new Set();

    for (const [symbol, name] of Object.entries(allStocks)) {
        const isValidName = typeof name === 'string' && name.length >= 2;
        const isValidSymbol = typeof symbol === 'string' && symbol.length >= 2;

        if ((isValidName && content.includes(name)) || (isValidSymbol && content.includes(symbol))) {
            const standardSymbol = symbol.includes('.') || symbol.startsWith('^') ? symbol : `${symbol}.TW`;
            
            dynamicStocks.set(standardSymbol, now); // 加入常駐輪替
            matchedSymbols.add(name);
            lookupTargets.add(symbol); 
        }
    }
    
    if (matchedSymbols.size > 0) {
        const caughtList = Array.from(matchedSymbols).join(', ');
        logger.info(`[頻道偵測] 鄉民提及了: ${caughtList}，已加入動態關注。`);
    }
    
    return Array.from(lookupTargets).slice(0, 3);
}

/**
 * 每 10 秒執行的走馬燈 (Bot 狀態：單檔)
 */
async function updateTickerStatus() {
    const symbolsArray = getActiveSymbols();
    if (symbolsArray.length === 0) return;

    if (trendingRotationIndex >= symbolsArray.length) {
        trendingRotationIndex = 0;
    }
    
    const currentBatch = [symbolsArray[trendingRotationIndex]];
    trendingRotationIndex += 1;

    try {
        const tickerString = await marketApi.getFormattedQuotes(currentBatch, allStocks);
        client.user.setActivity(tickerString, { type: ActivityType.Watching });
    } catch (error) {
        logger.error(`走馬燈報價更新失敗: ${error.message}`);
    }
}

/**
 * 每 10 分鐘執行的頻道主題更新 (每次 5 檔)
 */
async function updateChannelTopic() {
    if (!TOPIC_UPDATE_CHANNEL) return;

    try {
        const channel = await client.channels.fetch(TOPIC_UPDATE_CHANNEL);
        if (channel && channel.isTextBased()) {
            const symbolsArray = getActiveSymbols();
            if (symbolsArray.length === 0) return;

            if (topicRotationIndex >= symbolsArray.length) {
                topicRotationIndex = 0;
            }

            const batch = symbolsArray.slice(topicRotationIndex, topicRotationIndex + 5);
            topicRotationIndex += 5;

            if (batch.length > 0) {
                const topicString = await marketApi.getFormattedQuotes(batch, allStocks);
                await channel.edit({ topic: `📈 即時報價: ${topicString} (每10分更新)` });
                logger.info(`✅ 頻道主題已更新: ${topicString}`);
            }
        }
    } catch (error) {
        logger.error(`更新頻道主題失敗: ${error.message}`);
    }
}

async function sendReportToDiscord(reportText) {
    try {
        if (!TARGET_CHANNEL_ID) return;
        const channel = await client.channels.fetch(TARGET_CHANNEL_ID);
        if (!channel) return;

        if (reportText.length > 1900) {
            const chunks = reportText.match(/[\s\S]{1,1900}/g) || [];
            for (const chunk of chunks) {
                await channel.send(chunk);
            }
        } else {
            await channel.send(reportText);
        }
    } catch (error) {
        logger.error(`發送報告至 Discord 失敗: ${error.message}`);
    }
}

module.exports = { sendReportToDiscord };
client.login(DISCORD_TOKEN);