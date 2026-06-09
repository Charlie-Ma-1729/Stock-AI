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

// 載入台美股字典檔，用於對話內容偵測
let allStocks = {};
try {
    const twData = require('./tw_stocks.json');
    const usData = require('./us_stocks.json');
    
    // 🌟 核心修復：讓 parseDict 能夠同時處理 Array 與 Object 格式的 JSON 字典
    const parseDict = (data) => {
        const result = {};
        if (Array.isArray(data)) {
            data.forEach(item => {
                const sym = item.symbol || item.Symbol || item.Ticker || item.代號;
                const name = item.name || item.Name || item.名稱 || item.股名;
                if (sym && name) {
                    const pureSym = sym.toString().replace(/\.TW|\.TWO/gi, '');
                    result[pureSym] = name.toString().trim();
                    result[sym.toString()] = name.toString().trim();
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
                result[pureSym] = name.toString().trim();
                result[sym.toString()] = name.toString().trim();
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
// 🌟 核心修改：動態話題股儲存庫與淘汰機制
// ==========================================
// 1. 常駐名單 (永遠不會過期)
const BASE_INDICES = ['^TWII', '^DJI', '^IXIC', '^SOX', '^GSPC'];

// 2. 動態名單 (記錄格式: Map<代號, 最後一次被提及或抓取的時間戳記>)
const dynamicStocks = new Map(); 
const EXPIRY_MS = 3 * 24 * 60 * 60 * 1000; // 🌟 淘汰時間設定為 3 天 (可自行修改)

let trendingRotationIndex = 0; // 用於機器人狀態(每10秒單檔)
let topicRotationIndex = 0;    // 用於頻道主題(每10分五檔)

/**
 * 取得當前有效的股票陣列 (並順便清除過期的股票)
 */
function getActiveSymbols() {
    const now = Date.now();
    // 檢查動態名單，把太久沒人理的股票刪掉
    for (const [sym, lastSeen] of dynamicStocks.entries()) {
        if (now - lastSeen > EXPIRY_MS) {
            dynamicStocks.delete(sym);
            logger.info(`🗑️ [觀察庫] ${sym} 已經超過 3 天未被討論或不再熱門，自動從走馬燈中移除。`);
        }
    }
    // 回傳 常駐大盤 + 動態熱門股 的聯集 (去重複)
    return [...new Set([...BASE_INDICES, ...dynamicStocks.keys()])];
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// 負責抓取當下熱門股的函數
async function fetchTrendingStocks() {
    try {
        logger.info('正在抓取 Yahoo Finance 當下熱門股/ETF...');
        const trendingSymbols = await marketApi.getTrendingSymbols();
        let addedNew = 0;
        const now = Date.now();
        
        trendingSymbols.forEach(symbol => {
            if (!dynamicStocks.has(symbol)) {
                addedNew++;
            }
            // 🌟 將抓到的熱門股存入動態庫，並刷新它的「保鮮期」
            dynamicStocks.set(symbol, now);
        });
        
        const totalActive = getActiveSymbols().length;
        logger.info(`✅ [熱門更新] 本次捕捉了 ${addedNew} 檔新熱門股，目前共有 ${totalActive} 檔標的輪轉中。`);
    } catch (error) {
        logger.error(`抓取當下熱門股失敗: ${error.message}`);
    }
}

client.once('clientReady', async () => {
    logger.info(`🤖 [Discord Bot] 已成功登入為 ${client.user.tag}`);
    scheduler = require('./scheduler');

    // 1. 開機先抓一次熱門股
    await fetchTrendingStocks();

    // 2. 🌟 設定每 2 小時重新抓取一次最新熱門股，確保清單與市場動向同步
    setInterval(fetchTrendingStocks, 2 * 60 * 60 * 1000);

    // 3. 啟觸發馬燈 (每3秒) 與頻道主題更新 (每10分)
    setInterval(updateTickerStatus, 3 * 1000);
    setInterval(updateChannelTopic, 10 * 60 * 1000);
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const content = message.content.trim();

    // 🌟 若 .env 未設定監聽頻道，預設監聽所有文字頻道 (防呆機制)
    const shouldWatch = WATCH_CHANNELS.length === 0 || WATCH_CHANNELS.includes(message.channel.id);
    if (shouldWatch && !content.startsWith('!')) {
        detectStocksInMessage(content);
    }

    try {
        // --------------------------------------------------
        // 功能一：即時問答大腦 (!問)
        // --------------------------------------------------
        if (content.startsWith('!問 ')) {
            const question = content.replace('!問 ', '').trim();
            if (!question) {
                return message.reply('⚠️ 內容不能為空喔！請輸入你想問的問題。');
            }

            const waitMsg = await message.reply('⏳ **AI 大腦正在為您檢索新聞與思考，請稍候...**');
            try {
                // 直接呼叫 AI 的 evaluateUserInput，傳入 viewpoint 模式來即時探討
                const answer = await ai_analyzer.evaluateUserInput(message.author.username, question, 'viewpoint');
                
                if (answer.length > 1900) {
                    await waitMsg.delete(); 
                    const chunks = answer.match(/[\s\S]{1,1900}/g) || [];
                    for (const chunk of chunks) {
                        await message.channel.send(chunk);
                    }
                } else {
                    await waitMsg.edit(answer);
                }
            } catch (err) {
                logger.error(`❌ [Discord Bot] 問指令失敗: ${err.message}`);
                await waitMsg.edit(`❌ AI 思考過程中發生錯誤: ${err.message}`);
            }
        }
        // --------------------------------------------------
        // 功能二：深度詳查與報價 (!查)
        // --------------------------------------------------
        else if (content.startsWith('!查 ')) {
            const rawQuery = content.replace('!查 ', '').trim();
            if (!rawQuery) {
                return message.reply('⚠️ 請輸入你想詳查的股票代號或關鍵字！(例如：!查 台積電 該買嗎)');
            }

            // 🌟 核心修復：用空白切割指令。第一個字詞當作股票標的，後續視為問題。
            // 例如 "6116 現在很多人在賣..." -> targetStock 變成 "6116"
            const args = rawQuery.split(/\s+/);
            const targetStock = args[0];

            const waitMsg = await message.reply(`⏳ **系統正在抓取 ${targetStock} 的最新市場報價與 AI 運算中，請稍候...**`);
            
            try {
                // 只將 `targetStock` (如 6116 或 奇鋐) 交給報價系統，避免 Yahoo 搜尋不到報錯
                const stockData = await marketApi.fetchStockTrend(targetStock);

                if (stockData.error) {
                    return waitMsg.edit(`❌ 無法獲取 **${targetStock}** 的報價資料，請確認名稱或代號是否正確 (問問題請記得加空白隔開)。\n詳細訊息: ${stockData.message}`);
                }

                // 呼叫分析器，把剛剛抓到的 stockData，連同用戶「完整的原始問題 (rawQuery)」一起餵給 AI
                const analysisResult = await ai_analyzer.detailedAnalyzeStock(stockData.symbol, stockData, rawQuery); 

                if (analysisResult.length > 1900) {
                    await waitMsg.delete(); 
                    const chunks = analysisResult.match(/[\s\S]{1,1900}/g) || [];
                    for (const chunk of chunks) {
                        await message.channel.send(chunk);
                    }
                } else {
                    await waitMsg.edit(analysisResult);
                }
            } catch (err) {
                logger.error(`❌ [Discord Bot] 查指令失敗: ${err.message}`);
                await waitMsg.edit(`❌ 系統深度分析過程中發生未預期錯誤: ${err.message}`);
            }
        }
    } catch (error) {
        logger.error(`❌ 處理 Discord 訊息時發生未預期錯誤: ${error.message}`);
        await message.reply('❌ 抱歉，系統處理你的指令時發生了錯誤。');
    }
});

/**
 * 偵測訊息中的股票：有提到就加入，或「刷新其保鮮期時間」
 */
function detectStocksInMessage(content) {
    const now = Date.now();
    const matchedSymbols = new Set(); // 避免同一句話重複計算

    for (const [symbol, name] of Object.entries(allStocks)) {
        // 排除過短的名稱 (例如單字) 防止誤判
        const isValidName = typeof name === 'string' && name.length >= 2;
        const isValidSymbol = typeof symbol === 'string' && symbol.length >= 2;

        if ((isValidName && content.includes(name)) || (isValidSymbol && content.includes(symbol))) {
            const standardSymbol = symbol.includes('.') || symbol.startsWith('^') ? symbol : `${symbol}.TW`;
            
            // 🌟 刷新保鮮期或新增
            dynamicStocks.set(standardSymbol, now);
            matchedSymbols.add(name); // 印出中文名字比較直觀
        }
    }
    
    if (matchedSymbols.size > 0) {
        const caughtList = Array.from(matchedSymbols).join(', ');
        logger.info(`[頻道偵測] 從鄉民對話中捕捉並刷新了標的: ${caughtList}`);
    }
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