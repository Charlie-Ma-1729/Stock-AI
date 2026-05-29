require('dotenv').config();
const { Client, GatewayIntentBits } = require('discord.js');
const logger = require('./logger');
const aiAnalyzer = require('./services/ai_analyzer');
const marketApi = require('./services/market_api');
const db = require('./db');

const client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent] });

client.once('ready', () => logger.info(`🤖 Discord Bot 已連線！`));

client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    const content = message.content.trim();

    // 處理指令
    if (content.startsWith('!觀點') || content.startsWith('?提問')) {
        const type = content.startsWith('!觀點') ? 'viewpoint' : 'question';
        const text = content.replace(type === 'viewpoint' ? '!觀點' : '?提問', '').trim();
        
        if (!text) return message.reply('請輸入內容。');
        const reply = await message.reply('⏳ 處理中...');
        const evaluation = await aiAnalyzer.evaluateUserInput(message.author.username, text, type);
        await reply.edit(type === 'viewpoint' ? `🧠 **觀點點評：**\n${evaluation}` : `✅ **提問已收錄：**\n將於下一份報告解答！`);
    }

    // 🚀 強制生成報告測試 Trigger
    if (content === '!test報告') {
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

async function sendReportToDiscord(reportText) {
    const channel = await client.channels.fetch(process.env.DISCORD_CHANNEL_ID);
    const chunks = reportText.match(/[\s\S]{1,1900}/g) || [];
    for (const chunk of chunks) await channel.send(chunk);
}

module.exports = { sendReportToDiscord };