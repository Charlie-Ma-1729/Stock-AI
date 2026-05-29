const cron = require('node-cron');
const logger = require('./logger');
const db = require('./db');
const ai_analyzer = require('./services/ai_analyzer');
// 🌟 恢復引入 bot.js，這樣只要執行 scheduler.js 就會連帶啟動 Discord 機器人
const { sendReportToDiscord } = require('./bot'); 

// 引入已經改造為 Extract 模式的爬蟲模組
const cteeScraper = require('./ctee_scraper');
const udnScraper = require('./udn_scraper');
const cmoneyScraper = require('./cmoney_scraper');

// ==========================================
// 🚀 ETL 核心流程 (支援批次併發處理)
// ==========================================
async function executeNewsETL(scraperModule, sourceName) {
    logger.info(`🔄 [排程器] 啟動 [${sourceName}] 爬蟲 ETL 流程...`);
    try {
        // 1. Extract: 呼叫爬蟲抓取新聞
        const rawArticles = await scraperModule.scrape();

        if (!rawArticles || rawArticles.length === 0) {
            logger.info(`⚠️ [排程器] [${sourceName}] 沒有抓取到新文章或目前無更新。`);
            return;
        }

        // 過濾出尚未存在 DB 的新文章，避免浪費算力
        const newArticles = rawArticles.filter(article => !db.isArticleExists(article.url));

        if (newArticles.length === 0) {
            logger.info(`🛑 [排程器] [${sourceName}] 抓取的文章皆已存於資料庫，無須處理。`);
            return;
        }

        logger.info(`📥 [排程器] [${sourceName}] 共有 ${newArticles.length} 篇新文章，準備進入 AI 併發濃縮管線...`);

        let processedCount = 0;
        
        // ⚡ 設定併發上限 (Concurrency Limit)
        const CONCURRENCY_LIMIT = 3; 

        // 2. Transform & Load: 批次併發處理 (Batching)
        for (let i = 0; i < newArticles.length; i += CONCURRENCY_LIMIT) {
            const batch = newArticles.slice(i, i + CONCURRENCY_LIMIT);
            logger.info(`⚡ [排程器] 正在併發處理第 ${i + 1} 到 ${i + batch.length} 篇文章...`);

            // 使用 Promise.all 讓同一批次的文章「同時」發送給 Ollama
            await Promise.all(batch.map(async (article) => {
                try {
                    const summary = await ai_analyzer.summarizeNews(article.title, article.content);
                    
                    const recordToSave = {
                        url: article.url,
                        title: article.title,
                        summary: summary,
                        content: '' // 原文清空
                    };

                    // 存入 SQLite
                    db.saveNewsWithTags(recordToSave, article.symbols || []);
                    processedCount++;
                } catch (err) {
                    logger.error(`❌ [排程器] 單篇文章濃縮失敗 (${article.title}): ${err.message}`);
                }
            }));
        }

        logger.info(`✅ [排程器] [${sourceName}] ETL 執行完畢！本次新增並濃縮了 ${processedCount} 篇新聞。`);
    } catch (error) {
        logger.error(`❌ [排程器] 執行 [${sourceName}] ETL 發生嚴重錯誤: ${error.message}`);
    }
}

// ==========================================
// 🛠️ 手動觸發器 (供 Discord 指令調用)
// ==========================================
async function triggerAllETL() {
    logger.info('==================================================');
    logger.info('🛠️ [手動觸發] 啟動全網新聞強制抓取與 AI 濃縮作業');
    logger.info('==================================================');
    
    // 依序執行三大爬蟲
    await executeNewsETL(udnScraper, '經濟日報');
    await executeNewsETL(cteeScraper, '工商時報');
    await executeNewsETL(cmoneyScraper, 'CMoney');
    
    logger.info('🏁 [手動觸發] 所有平台的 ETL 濃縮作業已完成！');
}

// ==========================================
// ⏰ 系統任務排程管理 (主程式進入點)
// ==========================================
logger.info('⏰ [排程器] 核心排程引擎已啟動，開始監控市場與資料流。');

// --------------------------------------------------
// 任務一：自動清理過期記憶 (每天凌晨 02:00 執行)
// --------------------------------------------------
cron.schedule('0 2 * * *', () => {
    logger.info('🧹 [排程器] 觸發例行維護：開始清理 36 小時前的過期新聞與孤兒標籤...');
    db.cleanOldNews();
}, { timezone: "Asia/Taipei" });

// --------------------------------------------------
// 任務二：全網情報巡邏與 ETL (每 15 分鐘執行一次)
// 🌟 已更新頻率：0, 15, 30, 45 分皆會觸發，確保不錯過即時新聞
// --------------------------------------------------
cron.schedule('*/15 * * * *', async () => {
    logger.info('🕸️ [排程器] 開始執行全網財經新聞巡邏與 ETL...');
    await triggerAllETL(); 
}, { timezone: "Asia/Taipei" });

// --------------------------------------------------
// 任務三：AI 自動化定時報告生成與發布
// --------------------------------------------------
const reportSchedules = [
    { time: '0 6 * * 2-6', name: '06:00 美股收盤與晨間風向' }, // 配合你原本的台美股作息時間
    { time: '30 7 * * 1-5', name: '08:00 盤前戰略指南' },
    { time: '45 9 * * 1-5', name: '10:00 早盤異動雷達' },
    { time: '45 11 * * 1-5', name: '12:00 午盤情緒觀測' },
    { time: '45 13 * * 1-5', name: '14:00 台股收盤總結' },
    { time: '45 17 * * 1-5', name: '18:00 籌碼解析與夜盤前瞻' },
    { time: '45 20 * * 1-5', name: '21:00 美股開盤風向' },
    { time: '45 22 * * 1-5', name: '23:00 夜間總結' }
];

reportSchedules.forEach(schedule => {
    cron.schedule(schedule.time, async () => {
        logger.info(`📢 [排程器] 觸發定時報告發布流程: 【${schedule.name}】`);

        try {
            // 從資料庫撈取最近 12 小時內「已經被 AI Q4 濃縮過」的新聞
            const recentNews = db.getRecentNews(12);
            
            // 串接市場數據 (未來串接 market_api 使用)
            const marketData = {}; 

            // 呼叫 Q8 模型進行高精度分析
            const reportContent = await ai_analyzer.generateMarketReport(schedule.name, marketData, recentNews);

            // 組合排版並透過 bot.js 推播至 Discord
            const header = `\n========== 【${schedule.name}】 ==========\n`;
            const footer = `\n====================================\n`;
            await sendReportToDiscord(header + reportContent + footer);
            
            logger.info(`✅ [排程器] 報告已成功推播至 Discord`);

        } catch (error) {
            logger.error(`❌ [排程器] 定時報告生成流程中斷: ${error.message}`);
        }
    }, { timezone: "Asia/Taipei" });
});

// 匯出功能供 bot.js (例如 Discord 手動輸入 !抓新聞) 使用
module.exports = { executeNewsETL, triggerAllETL };
