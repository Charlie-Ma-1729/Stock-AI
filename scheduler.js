const cron = require('node-cron');
const { exec } = require('child_process');
const logger = require('./logger'); 
const marketApi = require('./services/market_api');
const aiAnalyzer = require('./services/ai_analyzer');
const db = require('./db'); 
const { sendReportToDiscord } = require('./bot'); // 引入剛剛寫好的推播功能
const { runNightReview } = require('./services/night_review'); // 引入深夜覆盤功能

let isAiProcessing = false;

function runScrapers() {
    // if (isAiProcessing) {
    //     logger.warn('⏸️ AI 正在執行高耗能任務，暫停本次爬蟲排程以保留算力。');
    //     return;
    // }
    logger.info('🕷️ 啟動例行性爬蟲任務...');
    exec('node scrapers/cmoney_scraper.js', (err) => { if (err) logger.error(err.message); });
    exec('node scrapers/ctee_scraper.js', (err) => { if (err) logger.error(err.message); });
    exec('node scrapers/udn_scraper.js', (err) => { if (err) logger.error(err.message); });
}

/**
 * 核心大腦：生成並派發報告
 */
async function triggerReport(reportName, requiresInstitutionalData = false) {
    logger.info(`🚨 [排程觸發] 準備生成報告：${reportName}`);
    isAiProcessing = true; // 鎖定算力

    try {
        // 1. 獲取市場數據切片
        const marketData = await marketApi.getMarketSnapshot(requiresInstitutionalData);

        // 2. 獲取最近 12 小時新聞並濃縮
        let recentNews = [];
        if (typeof db.getRecentNews === 'function') {
            recentNews = db.getRecentNews(12) || []; 
        }

        const compressedNews = [];
        logger.info(`🗞️ 正在濃縮 ${recentNews.length} 篇新聞...`);
        for (const news of recentNews) {
            const summary = await aiAnalyzer.summarizeNews(news.title, news.content);
            compressedNews.push({ title: news.title, symbol: news.symbols, compressed_summary: summary });
        }

        // 3. 呼叫大腦產出報告 (這步會自動處理 QA、觀點與開獎預言)
        const finalReport = await aiAnalyzer.generateMarketReport(reportName, marketData, compressedNews);

        // 4. 將 finalReport 發送到 Discord
        const header = `\n========== 【${reportName}】 ==========\n`;
        const footer = `\n====================================\n`;
        await sendReportToDiscord(header + finalReport + footer);

        logger.info(`✅ 報告已生成並派發完畢。`);

    } catch (error) {
        logger.error(`❌ 報告生成流程中斷: ${error.message}`);
    } finally {
        isAiProcessing = false; // 解除鎖定
    }
}

// ==========================================
// 🕒 排程設定區 (使用 node-cron)
// ==========================================

// 🔄 爬蟲：每小時的 15 分和 45 分
cron.schedule('15,45 * * * *', runScrapers, { timezone: "Asia/Taipei" });

// 📝 06:00 美股收盤與晨間風向
cron.schedule('0 6 * * 2-6', () => triggerReport('06:00 美股收盤與晨間風向'), { timezone: "Asia/Taipei" });

// 📝 07:30 盤前戰略指南 (提早半小時給 AI 算力)
cron.schedule('30 7 * * 1-5', () => triggerReport('08:00 盤前戰略指南'), { timezone: "Asia/Taipei" });

// 📝 09:45 早盤異動雷達
cron.schedule('45 9 * * 1-5', () => triggerReport('10:00 早盤異動雷達'), { timezone: "Asia/Taipei" });

// 📝 11:45 午盤情緒觀測
cron.schedule('45 11 * * 1-5', () => triggerReport('12:00 午盤情緒觀測'), { timezone: "Asia/Taipei" });

// 📝 13:45 台股收盤總結
cron.schedule('45 13 * * 1-5', () => triggerReport('14:00 台股收盤總結'), { timezone: "Asia/Taipei" });

// 📝 17:45 籌碼與夜盤前瞻 (開啟三大法人數據抓取)
cron.schedule('45 17 * * 1-5', () => triggerReport('18:00 籌碼解析與夜盤前瞻', true), { timezone: "Asia/Taipei" });

// 📝 20:45 美股開盤熱度
cron.schedule('45 20 * * 1-5', () => triggerReport('21:00 美股開盤風向'), { timezone: "Asia/Taipei" });

// 📝 22:45 夜間風向與 QA 總結
cron.schedule('45 22 * * 1-5', () => triggerReport('23:00 夜間總結'), { timezone: "Asia/Taipei" });

// 🦉 02:30 深夜覆盤作業 (Night Review)
cron.schedule('30 2 * * *', async () => {
    isAiProcessing = true;
    try {
        await runNightReview();
    } finally {
        isAiProcessing = false;
    }
}, { timezone: "Asia/Taipei" });

logger.info('🤖 Stock-AI 自動排程司令部已上線！等待任務觸發...');