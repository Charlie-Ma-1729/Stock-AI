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
const WATCH_CHANNELS = [process.env.WATCH_CHANNEL_1, process.env.WATCH_CHANNEL_2]
    .filter(Boolean)
    .map(id => id.trim());
const TOPIC_UPDATE_CHANNEL = process.env.TOPIC_UPDATE_CHANNEL ? process.env.TOPIC_UPDATE_CHANNEL.trim() : null;

if (!DISCORD_TOKEN || DISCORD_TOKEN.trim() === '') {
    logger.error('❌ [致命錯誤] 未在 .env 檔案中找到 DISCORD_TOKEN！');
    process.exit(1);
}

// ==========================================
// 🌟 全新框架：高冷專業分析師，嚴格規範總經與個股分析架構
// ==========================================
const BASE_PROMPT = process.env.BASE_PROMPT || 
    "你是一位具備深度金融知識的專業台美股分析師。請用語氣專業、客觀且精要的風格回覆，絕對不要有「喔，XXX你在問...」這類無意義的招呼語或重複使用者的提問。\n" +
    "【核心回答架構與原則】：\n" +
    "1. 若用戶詢問【總經、大盤或事件 (如 CPI、升降息)】：\n" +
    "   - 直接回答該事件的預期與可能的連鎖反應。\n" +
    "   - 詳細分析對「台股」的可能影響（為主）。\n" +
    "   - 簡單帶過對「美股」的影響（若有關聯再提，無關可省略）。\n" +
    "2. 若用戶詢問【單一個股 (如 某檔股票大漲/大跌)】，請強制依序回答：\n" +
    "   - 1. 【異動原因】：為什麼今天會有這個走勢（找尋新聞或題材原因）。\n" +
    "   - 2. 【近期走勢】：結合提供的市場數據與近期新聞，解釋該股「過去一週」的走勢邏輯。\n" +
    "   - 3. 【未來走向】：預判該股未來的可能走向與位階分析。\n" +
    "   - 4. 【補充觀點】：其他籌碼、基本面或市場面的觀察（若有）。\n" +
    "3. 若使用者在對話中遭遇虧損，適度帶入「不輕易停損，耐心等翻紅」的心態建議，但不要硬塞在無關的總經話題中。";

const channelSessions = new Map();
const SESSION_EXPIRY_MS = 10 * 60 * 1000; 

let allStocks = {};
try {
    const twData = require('./tw_stocks.json');
    const usData = require('./us_stocks.json');
    
    const cleanName = (str) => {
        if (!str) return '';
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
            for (const [k, v] of Object.entries(data)) {
                let name, sym;
                if (/^[A-Za-z0-9.]+$/.test(k) && !/^[A-Za-z0-9.]+$/.test(v)) {
                    sym = k; name = v;
                } else if (!/^[A-Za-z0-9.]+$/.test(k) && /^[A-Za-z0-9.]+$/.test(v)) {
                    sym = v; name = k;
                } else {
                    sym = v; name = k; 
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
    logger.warn(`⚠️ 字典檔載入失敗: ${e.message}`);
}

const BASE_INDICES = ['^TWII', '^DJI', '^IXIC', '^SOX', '^GSPC'];
const dynamicStocks = new Map(); 
const EXPIRY_MS = 3 * 24 * 60 * 60 * 1000; 

let trendingRotationIndex = 0; 
let topicRotationIndex = 0;    

function getActiveSymbols() {
    const now = Date.now();
    for (const [sym, lastSeen] of dynamicStocks.entries()) {
        if (now - lastSeen > EXPIRY_MS) {
            dynamicStocks.delete(sym);
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

    setInterval(updateTickerStatus, 3 * 1000);
    setInterval(updateChannelTopic, 10 * 60 * 1000);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const content = message.content.trim();
    const channelId = message.channel.id;
    const now = Date.now();

    // 🌟 嚴格頻道分離：Watch Channel 只聽不回，Target Channel 才會講話
    const isWatchChannel = WATCH_CHANNELS.length === 0 || WATCH_CHANNELS.includes(channelId);
    const isTargetChannel = TARGET_CHANNEL_ID && channelId === TARGET_CHANNEL_ID;

    // 只要是這兩種頻道之一，我們就默默抓取代號放進跑馬燈
    let detectedSymbols = [];
    if (isWatchChannel || isTargetChannel) {
        detectedSymbols = detectStocksInMessage(content); 
    }

    // 🌟 如果「不是」對話目標頻道，到這裡就結束，絕對不准回覆
    if (!isTargetChannel) return; 

    try {
        let session = channelSessions.get(channelId);
        
        if (session && (now - session.lastUpdated > SESSION_EXPIRY_MS)) {
            logger.info(`[記憶清空] 頻道 ${channelId} 閒置超過10分鐘，準備清空記憶並提取這輪的投資建議。`);
            extractAndSaveAdvice(session.history, channelId);
            session = null; 
        }

        if (!session) {
            session = { history: [], lastUpdated: now };
        }

        const waitMsg = await message.reply('💬 **分析中...**');
        
        // 🌟 注入過去一週走勢，讓 AI 能回答架構的第 2 點
        let marketContext = "";
        if (detectedSymbols.length > 0) {
            marketContext += "【系統自動帶入：用戶剛提及的股票最新報價與過去一週走勢】\n";
            for (const sym of detectedSymbols) {
                try {
                    const stockData = await marketApi.fetchStockTrend(sym);
                    if (!stockData.error) {
                        const trendStr = (stockData.recentTrend || []).slice(-7).map(t => `${t.date.slice(5)}收${t.close}`).join(', ');
                        marketContext += `- ${stockData.symbol} (${stockData.name}): 現價 ${stockData.price || '未知'} (${stockData.changePercent || '未知'}%) | 月線: ${stockData.monthlyAvgPrice} | 近一週走勢: ${trendStr}\n`;
                    }
                } catch(e) {
                    logger.warn(`自動抓取 ${sym} 報價失敗: ${e.message}`);
                }
            }
        }

        session.history.push({ role: 'user', name: message.author.username, content: content });

        const recentHistory = session.history.slice(-30); 
        let chatLog = recentHistory.map(m => `${m.role === 'user' ? m.name : '你(AI)'}: ${m.content}`).join('\n');

        const finalPrompt = `
【核心設定與提示】
${BASE_PROMPT}

${marketContext}
【最近群聊紀錄】
${chatLog}

請你根據上述群聊紀錄的「最後一句話」進行直接且專業的回答。
(再次強調：請嚴格遵守上方的回答架構，絕對不要加上自己的名字前綴，也不要說出「XXX你在問...」等無意義的廢話，直接切入重點分析)：`;

        const answer = await ai_analyzer.evaluateUserInput(message.author.username, finalPrompt, 'viewpoint');
        
        session.history.push({ role: 'assistant', name: 'AI', content: answer });
        session.lastUpdated = Date.now();
        channelSessions.set(channelId, session); 

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

async function extractAndSaveAdvice(history, channelId) {
    if (!history || history.length === 0) return;
    try {
        const chatLog = history.map(m => `${m.role === 'user' ? m.name : 'AI'}: ${m.content}`).join('\n');
        const summaryPrompt = `請總結以下對話紀錄中，你(AI)給予使用者的具體「投資建議」、「提到的股票標的」與「後市看法」。\n請以簡短的條列式輸出，這個總結將存入資料庫，作為未來夜間覆盤與經驗學習的參考資料。\n\n【對話紀錄】\n${chatLog}`;
        
        const adviceSummary = await ai_analyzer.evaluateUserInput('System_Review', summaryPrompt, 'viewpoint');
        
        if (typeof db.saveAdvice === 'function') {
            await db.saveAdvice({ channelId, summary: adviceSummary, timestamp: new Date() });
        }
    } catch (error) {
        logger.error(`[覆盤存檔] 提取對話投資建議失敗: ${error.message}`);
    }
}

function detectStocksInMessage(content) {
    const now = Date.now();
    const matchedSymbols = new Set(); 
    const lookupTargets = new Set();

    for (const [symbol, name] of Object.entries(allStocks)) {
        const isValidName = typeof name === 'string' && name.length >= 2;
        const isValidSymbol = typeof symbol === 'string' && symbol.length >= 2;

        if ((isValidName && content.includes(name)) || (isValidSymbol && content.includes(symbol))) {
            const standardSymbol = symbol.includes('.') || symbol.startsWith('^') ? symbol : `${symbol}.TW`;
            
            dynamicStocks.set(standardSymbol, now); 
            matchedSymbols.add(name);
            lookupTargets.add(symbol); 
        }
    }
    
    return Array.from(lookupTargets).slice(0, 3);
}

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