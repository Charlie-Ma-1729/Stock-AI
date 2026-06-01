// bot.js
require('dotenv').config(); 

const { Client, GatewayIntentBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const logger = require('./logger');
const db = require('./db');
const ai_analyzer = require('./services/ai_analyzer');

let scheduler;

const DISCORD_TOKEN = process.env.DISCORD_TOKEN;
const TARGET_CHANNEL_ID = process.env.TARGET_CHANNEL_ID;

if (!DISCORD_TOKEN || DISCORD_TOKEN.trim() === '') {
    logger.error('❌ [致命錯誤] 未在 .env 檔案中找到 DISCORD_TOKEN！');
    process.exit(1);
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent
    ]
});

client.once('ready', () => {
    logger.info(`🤖 [Discord Bot] 已成功登入為 ${client.user.tag}`);
    scheduler = require('./scheduler');
});

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const content = message.content.trim();

    try {
        // --------------------------------------------------
        // 功能一：用戶 QA 累積 (!問)
        // --------------------------------------------------
        if (content.startsWith('!問 ')) {
            const question = content.replace('!問 ', '').trim();
            if (!question) {
                return message.reply('⚠️ 內容不能為空喔！請輸入你想問的問題。');
            }
            ai_analyzer.addPendingQA(message.author.username, question, '', 'question');
            await message.reply('✅ 你的問題已經收錄！');
        }

        // --------------------------------------------------
        // 功能二：用戶觀點即時識別與檢索回饋 (!觀點)
        // --------------------------------------------------
        else if (content.startsWith('!觀點 ')) {
            const viewpoint = content.replace('!觀點 ', '').trim();
            if (!viewpoint) {
                return message.reply('⚠️ 內容不能為空喔！請輸入你的觀點，例如：`!觀點 黃仁勳今天演講...`');
            }

            const waitMsg = await message.reply('⏳ 收到觀點！正在為您檢索相關新聞與即時報價，並交由 AI 分析中...');
            const evaluation = await ai_analyzer.evaluateUserInput(message.author.username, viewpoint, 'viewpoint');
            await waitMsg.edit(evaluation);
        }

        // --------------------------------------------------
        // 功能三：強制啟動 ETL (!抓新聞)
        // --------------------------------------------------
        else if (content === '!抓新聞') {
            await message.reply('🕸️ [開發者模式] 正在啟動全網強制抓取，請稍候...');
            if (scheduler && scheduler.triggerAllETL) {
                await scheduler.triggerAllETL();
                await message.reply('✅ 新聞已完整抓取並寫入 SQLite 資料庫！');
            } else {
                await message.reply('⚠️ 排程器尚未就緒。');
            }
        }

        // --------------------------------------------------
        // 功能四：🌟 個股即時查價與速評 (!查)
        // --------------------------------------------------
        else if (content.startsWith('!查')) {
            const inputStr = content.replace('!查', '').trim();
            if (!inputStr) {
                return message.reply('⚠️ 請輸入要查詢的股票代號或名稱，例如：`!查 雙鴻` 或 `!查 NVDA`');
            }

            const waitMsg = await message.reply(`⏳ 優先為您獲取 **${inputStr}** 的即時報價與近期走勢，並交由 3B 模型速評中...`);
            try {
                const marketApi = require('./services/market_api');
                const stockData = await marketApi.fetchStockTrend(inputStr);
                
                if (!stockData || stockData.error) {
                    return waitMsg.edit(`❌ 查詢失敗：無法獲取 **${inputStr}** 的報價與走勢資料。`);
                }
                const analysisResult = await ai_analyzer.quickAnalyzeStock(stockData.symbol, stockData);
                await waitMsg.edit(analysisResult);
            } catch (err) {
                logger.error(`❌ [Discord Bot] 查價指令失敗: ${err.message}`);
                await waitMsg.edit(`❌ 系統查詢或分析過程中發生未預期錯誤。`);
            }
        }
        
        // --------------------------------------------------
        // 功能五：🌟 附帶提問的深度詳查 (!詳查)
        // --------------------------------------------------
        else if (content.startsWith('!詳查')) {
            const inputStr = content.replace('!詳查', '').trim();
            const firstSpaceIdx = inputStr.indexOf(' ');
            
            let rawSymbol = inputStr;
            let userQuestion = '';
            
            // 完美切出「代號」與後面的「疑問」
            if (firstSpaceIdx !== -1) {
                rawSymbol = inputStr.substring(0, firstSpaceIdx).trim();
                userQuestion = inputStr.substring(firstSpaceIdx + 1).trim();
            }

            if (!rawSymbol) {
                return message.reply('⚠️ 請輸入要詳查的股票代號，例如：`!詳查 2330 覺得最近營收好嗎`');
            }

            const waitMsg = await message.reply(`⏳ 啟動 8B 重裝大腦... 正在為您深度檢索 **${rawSymbol}** 的相關資訊，請稍候...`);
            
            try {
                const marketApi = require('./services/market_api');
                const stockData = await marketApi.fetchStockTrend(rawSymbol);
                
                if (!stockData || stockData.error) {
                    return waitMsg.edit(`❌ 查詢失敗：無法獲取 **${rawSymbol}** 的報價資料。`);
                }

                // 將代號、報價資料與「使用者的提問」一併傳入大腦
                const analysisResult = await ai_analyzer.detailedAnalyzeStock(stockData.symbol, stockData, userQuestion);
                
                // 防呆機制：Discord 限制
                if (analysisResult.length > 1900) {
                    await waitMsg.delete(); // 先刪除等待訊息
                    const chunks = analysisResult.match(/[\s\S]{1,1900}/g) || [];
                    for (const chunk of chunks) {
                        await message.channel.send(chunk);
                    }
                } else {
                    await waitMsg.edit(analysisResult);
                }
            } catch (err) {
                logger.error(`❌ [Discord Bot] 詳查指令失敗: ${err.message}`);
                await waitMsg.edit(`❌ 系統深度分析過程中發生未預期錯誤。`);
            }
        }
    } catch (error) {
        logger.error(`❌ 處理 Discord 訊息時發生未預期錯誤: ${error.message}`);
        await message.reply('❌ 抱歉，系統處理你的指令時發生了錯誤。');
    }
});

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

client.login(DISCORD_TOKEN).catch(err => {
    logger.error(`❌ Discord 登入失敗: ${err.message}`);
});

module.exports = { sendReportToDiscord };