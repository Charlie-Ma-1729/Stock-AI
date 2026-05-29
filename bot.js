require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const logger = require('./logger');
const aiAnalyzer = require('./services/ai_analyzer');

// 初始化 Discord 客戶端
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent, // 確保 Developer Portal 有開啟此 Intent
    ]
});

// 當機器人成功連線時
client.once('ready', () => {
    logger.info(`🤖 Discord Bot 已連線！登入身分：${client.user.tag}`);
});

// 監聽群友訊息
client.on('messageCreate', async (message) => {
    // 忽略機器人自己的訊息
    if (message.author.bot) return;

    const content = message.content.trim();

    // ==========================================
    // 💡 模式一：處理「!觀點」
    // ==========================================
    if (content.startsWith('!觀點')) {
        const viewpoint = content.replace('!觀點', '').trim();
        if (!viewpoint) {
            return message.reply('請輸入您的觀點，例如：`!觀點 兩週內南亞科會漲`');
        }

        const replyMsg = await message.reply('⏳ 正在請大腦評估您的觀點，請稍候...');

        // 呼叫 AI 評估，類型標記為 'viewpoint'
        const evaluation = await aiAnalyzer.evaluateUserInput(message.author.username, viewpoint, 'viewpoint');
        await replyMsg.edit(`🧠 **AI 初步點評：**\n${evaluation}\n\n*(💡 此觀點將納入下一份市場報告的「分析環節」進行深度驗證)*`);
    }
    
    // ==========================================
    // ❓ 模式二：處理「?提問」
    // ==========================================
    else if (content.startsWith('?提問')) {
        const question = content.replace('?提問', '').trim();
        if (!question) {
            return message.reply('請輸入您的問題，例如：`?提問 現在適合加碼台積電嗎？`');
        }

        const replyMsg = await message.reply('⏳ 已收到提問！大腦正在排程處理中...');

        // 提問不需要即時長篇評估，只做簡單紀錄，類型標記為 'question'
        await aiAnalyzer.evaluateUserInput(message.author.username, question, 'question');
        await replyMsg.edit(`✅ **提問已記錄：**\n將於下一份市場報告尾端的「QA 環節」為您詳細解答！`);
    }

    // 🚀 強制生成報告測試 Trigger
    else if (content === '!test報告') {
        await message.reply('🚨 觸發強制報告生成！請稍候...');
        const marketData = await marketApi.getMarketSnapshot(true, true);
        const recentNews = db.getRecentNews(12) || [];
        const compressedNews = [];
        for (const n of recentNews) {
            const summary = await aiAnalyzer.summarizeNews(n.title, n.content);
            compressedNews.push({ symbol: n.symbols, title: n.title, compressed_summary: summary });
        }
        const report = await aiAnalyzer.generateMarketReport('強制測試報告', marketData, compressedNews);
        await message.channel.send(`\n========== 【強制測試報告】 ==========\n${report}\n====================================\n`);
    }
});

client.login(process.env.DISCORD_TOKEN);

// ==========================================
// 🚀 導出發送報告功能 (供 Scheduler 呼叫)
// ==========================================
async function sendReportToDiscord(reportText) {
    try {
        const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
        if (channel) {
            // Discord 單則訊息上限為 2000 字元，遇到長報告需進行切割
            const chunks = reportText.match(/[\s\S]{1,1900}/g) || [];
            for (const chunk of chunks) {
                await channel.send(chunk);
            }
            logger.info('✅ AI 報告已成功推播至 Discord 頻道！');
        }
    } catch (error) {
        logger.error(`❌ 發送 Discord 訊息失敗: ${error.message}`);
    }
}

module.exports = {
    client,
    sendReportToDiscord
};