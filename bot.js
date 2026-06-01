// 🌟 核心修正：載入 .env 檔案中的環境變數
require('dotenv').config(); 

const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const db = require('./db');
const ai_analyzer = require('./services/ai_analyzer');

// 延遲載入 scheduler，避免與 scheduler.js 互相 require 產生循環依賴 (Circular Dependency)
let scheduler;

// ==========================================
// 🔑 環境與金鑰設定
// ==========================================
// 直接從環境變數讀取
const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;

// 🛑 嚴格防呆機制：如果根本沒讀到 Token，立刻中斷並報錯，不向 Discord 發送無效請求
if (!DISCORD_TOKEN || DISCORD_TOKEN.trim() === '') {
    logger.error('❌ [致命錯誤] 未在 .env 檔案中找到 DISCORD_TOKEN！請確認 .env 檔案存在且格式正確。');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

// ==========================================
// 🚀 機器人啟動與排程掛載
// ==========================================
client.once('ready', () => {
    logger.info(`🤖 [Discord Bot] 已成功登入為 ${client.user.tag}`);
    // 機器人登入成功後，載入排程器，這樣 scheduler 就可以使用下方匯出的 sendReportToDiscord
    scheduler = require('./scheduler');
});

// ==========================================
// 💬 Discord 指令監聽與工作流
// ==========================================
client.on('messageCreate', async (message) => {
    // 略過機器人自身的訊息，避免無窮迴圈
    if (message.author.bot) return;

    const content = message.content.trim();

    // 💡 優化：加入 try-catch 區塊，避免任一指令處理中發生例外錯誤導致 Bot 崩潰
    try {
        // --------------------------------------------------
        // 功能一：用戶 QA 累積 (!問)
        // --------------------------------------------------
        if (content.startsWith('!問 ')) {
            const question = content.replace('!問 ', '').trim();
            
            // 防呆：確保用戶有輸入內容
            if (!question) {
                return message.reply('⚠️ 內容不能為空喔！請輸入你想問的問題，例如：`!問 台積電現在能買嗎？`');
            }

            // 🛠️ 核心修復：加上第 4 個參數 'question'，解決 AI 報告漏答的問題
            ai_analyzer.addPendingQA(message.author.username, question, '', 'question');
            await message.reply('✅ 你的問題已經收錄，AI 將在下一份定時報告的 QA 環節為你客觀解答！');
        }

        // --------------------------------------------------
        // 功能二：用戶觀點即時識別與回饋 (!觀點)
        // --------------------------------------------------
        else if (content.startsWith('!觀點 ')) {
            const viewpoint = content.replace('!觀點 ', '').trim();
            
            // 防呆：確保用戶有輸入內容
            if (!viewpoint) {
                return message.reply('⚠️ 內容不能為空喔！請輸入你的觀點，例如：`!觀點 我覺得降息會讓資金流入傳產`');
            }

            await message.reply('⏳ 收到觀點！AI 正在檢視你的邏輯與情緒風險，請稍候...');
            
            // 呼叫 AI 進行即時情緒風險評估 (走 Q8 模型)
            const evaluation = await ai_analyzer.evaluateUserInput(message.author.username, viewpoint, 'viewpoint');
            
            // 🛠️ 核心修復：將觀點評估結果寫入 JSON 時，明確標記 type 為 'viewpoint'
            ai_analyzer.addPendingQA(message.author.username, viewpoint, evaluation, 'viewpoint');
            
            await message.reply(`🤖 **AI 觀點速評：**\n${evaluation}\n\n*(此觀點已永久紀錄，將納入後續大盤情緒分析與覆盤)*`);
        }

        // --------------------------------------------------
        // 功能三：強制啟動 ETL 濃縮管線 (!抓新聞) [開發者專用]
        // --------------------------------------------------
        else if (content === '!抓新聞') {
            await message.reply('🕸️ [開發者模式] 正在啟動全網強制抓取與 AI 新聞濃縮 (Q4)，請稍候...');
            
            if (scheduler && scheduler.triggerAllETL) {
                // 呼叫第一軌 ETL
                await scheduler.triggerAllETL();
                await message.reply('✅ 所有新聞已抓取並濃縮完畢，精華摘要已寫入 SQLite 資料庫！');
            } else {
                await message.reply('⚠️ 排程器尚未就緒，請檢查 Console 狀態。');
            }
        }

        // --------------------------------------------------
        // 功能四：強制產出綜合報告 (!test報告) [開發者專用]
        // --------------------------------------------------
        else if (content === '!test報告') {
            await message.reply('⏳ [開發者模式] 正在啟動高階大腦 (Q8) 撰寫市場報告，請稍候...');
            
            // 直接從 DB 撈取「已經處理好的 60 字精華」
            const recentNews = db.getRecentNews(12);
            
            // [擴充預留] 串接 market_api 獲取量化數據
            const marketData = {}; 

            // 呼叫第二軌 Q8 模型進行高精度分析
            const reportContent = await ai_analyzer.generateMarketReport('手動測試報告', marketData, recentNews);

            const finalMessage = `\n========== 【手動測試報告】 ==========\n${reportContent}\n====================================\n`;
            
            // 防呆機制：Discord 單則訊息有 2000 字元限制，若報告太長需切片發送
            if (finalMessage.length > 1900) {
                const chunks = finalMessage.match(/[\s\S]{1,1900}/g) || [];
                for (const chunk of chunks) {
                    await message.channel.send(chunk);
                }
            } else {
                await message.channel.send(finalMessage);
            }
        }

        // --------------------------------------------------
        // 功能五：🌟 個股即時查價與 AI 走勢速評 (!查)
        // --------------------------------------------------
        else if (content.startsWith('!查') && !content.startsWith('!詳查')) {
            // 支援 "!查2330" 或 "!查 NVDA" 格式，去除指令並轉大寫
            const symbol = content.replace('!查', '').trim().toUpperCase();
            
            if (!symbol) {
                return message.reply('⚠️ 請輸入要查詢的股票代號，例如：`!查 2330`、`!查0050` 或 `!查 NVDA`');
            }

            // 發送初步回應，讓使用者知道系統已經收到並正在優先處理
            const waitMsg = await message.reply(`⏳ 正在攔截系統資源... 優先為您獲取 **${symbol}** 的即時報價與近期走勢，並交由 AI 輕量模型速評中，請稍候...`);
            
            try {
                // 載入 market_api 模組
                const marketApi = require('./services/market_api');
                
                // 呼叫市場 API 抓取個股走勢與報價資料
                const stockData = await marketApi.fetchStockTrend(symbol);
                
                if (!stockData || stockData.error) {
                    return waitMsg.edit(`❌ 查詢失敗：無法獲取 **${symbol}** 的報價與走勢資料。\n(台股請確認代號，美股請確認 Ticker 是否正確)`);
                }

                // 呼叫 AI 進行輕量快速分析
                const analysisResult = await ai_analyzer.quickAnalyzeStock(symbol, stockData);

                // 將最終結果回傳至 Discord
                await waitMsg.edit(`📊 **【${symbol}】即時報價與 AI 走勢速評**\n\n${analysisResult}`);

            } catch (err) {
                logger.error(`❌ [Discord Bot] 查價指令 (!查 ${symbol}) 失敗: ${err.message}`);
                await waitMsg.edit(`❌ 系統查詢或分析過程中發生未預期錯誤，請檢查系統後台紀錄。`);
            }
        }

        // --------------------------------------------------
        // 功能六：🚀 深度查價與新聞綜合分析 (!詳查)
        // --------------------------------------------------
        else if (content.startsWith('!詳查')) {
            // 預期格式: !詳查 2330 什麼時候可能要注意退場
            const inputStr = content.replace('!詳查', '').trim();
            const firstSpaceIndex = inputStr.indexOf(' ');
            
            if (firstSpaceIndex === -1) {
                return message.reply('⚠️ 格式錯誤！請輸入「代號」與「你想問的問題」，例如：`!詳查 2330 什麼時候可能要注意退場`');
            }

            const rawSymbol = inputStr.substring(0, firstSpaceIndex).trim().toUpperCase();
            const userQuestion = inputStr.substring(firstSpaceIndex + 1).trim();

            if (!rawSymbol || !userQuestion) {
                return message.reply('⚠️ 代號或問題不能為空，例如：`!詳查 NVDA 可以買嗎`');
            }

            const waitMsg = await message.reply(`⏳ **【深度檢索啟動】**\n1️⃣ 正在獲取 **${rawSymbol}** 即時報價與走勢...\n2️⃣ 正在資料庫調閱關聯新聞...\n3️⃣ 即將交由高階大腦 (8B) 進行推理，大約需時 1~2 分鐘，請稍候...`);
            
            try {
                const marketApi = require('./services/market_api');
                
                // 1. 抓取量化走勢資料 (這跟!查一樣，能拿到現價與20MA)
                const stockData = await marketApi.fetchStockTrend(rawSymbol);
                
                if (!stockData || stockData.error) {
                    return waitMsg.edit(`❌ 查詢失敗：無法獲取 **${rawSymbol}** 的報價與走勢資料，請確認代號是否正確。`);
                }

                const correctSymbol = stockData.symbol; // 取得校正後的代號 (例如 2330 -> 2330.TW)
                
                // 2. 抓取關聯新聞 (預留給 db.js 的新函式)
                let relatedNews = [];
                if (typeof db.searchNewsByKeyword === 'function') {
                    // 同時用股票名稱跟代號去資料庫裡面掃描近期新聞
                    relatedNews = db.searchNewsByKeyword(stockData.name, correctSymbol, 15); // 最多取 15 篇
                }

                // 3. 呼叫 AI 進行高階深度分析 (預留給 ai_analyzer 的新函式)
                const analysisResult = await ai_analyzer.detailedAnalyzeStock(correctSymbol, stockData, relatedNews, userQuestion);

                // 將最終結果回傳至 Discord
                const finalMessage = `🎯 **【${stockData.name} (${correctSymbol})】AI 深度診斷報告**\n💬 **你的提問**：_${userQuestion}_\n\n${analysisResult}`;
                
                // 防呆機制：Discord 訊息字數上限 2000
                if (finalMessage.length > 1900) {
                    await waitMsg.edit(`🎯 **【${stockData.name} (${correctSymbol})】AI 深度診斷報告**\n💬 **你的提問**：_${userQuestion}_\n\n(報告生成完畢，長度較長，正在分段傳送...)`);
                    const chunks = finalMessage.match(/[\s\S]{1,1900}/g) || [];
                    for (const chunk of chunks) {
                        await message.channel.send(chunk);
                    }
                } else {
                    await waitMsg.edit(finalMessage);
                }

            } catch (err) {
                logger.error(`❌ [Discord Bot] 詳查指令 (!詳查 ${rawSymbol}) 失敗: ${err.message}`);
                await waitMsg.edit(`❌ 系統分析過程中發生未預期錯誤，請檢查系統後台紀錄。`);
            }
        }

    } catch (error) {
        // 全域捕捉指令錯誤，避免掛掉
        logger.error(`❌ 處理 Discord 訊息時發生未預期錯誤: ${error.message}`);
        await message.reply('❌ 抱歉，系統處理你的指令時發生了錯誤，請查看後台 Log。');
    }
});

// ==========================================
// 📡 外部推播接口 (供 Scheduler 調度)
// ==========================================
/**
 * 定時排程時間到時，會呼叫此函數將報告發送到指定的頻道
 */
async function sendReportToDiscord(reportText) {
    try {
        if (!TARGET_CHANNEL_ID) {
             logger.error('❌ 尚未設定 TARGET_CHANNEL_ID，無法發送報告。');
             return;
        }

        const channel = await client.channels.fetch(TARGET_CHANNEL_ID);
        if (!channel) {
            logger.error('❌ 找不到指定的 Discord 頻道，請確認 TARGET_CHANNEL_ID 設定。');
            return;
        }

        // 超長訊息切片處理
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

// 執行登入
client.login(DISCORD_TOKEN).catch(err => {
    logger.error(`❌ Discord 登入失敗: ${err.message}`);
});

// 將主動推播功能匯出，讓 scheduler.js 能夠使用
module.exports = { sendReportToDiscord };