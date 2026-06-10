// scheduler.js
const cron = require('node-cron');
const logger = require('./logger');
const db = require('./db');

// 🌟 核心修復：因為您是從 scheduler 啟動，必須在這裡強制喚醒機器人本體！
const { sendReportToDiscord } = require('./bot'); 

const cteeScraper = require('./ctee_scraper');
const udnScraper = require('./udn_scraper');
const cmoneyScraper = require('./cmoney_scraper');

// ==========================================
// 🚦 系統狀態鎖 (State Locks) 
// ==========================================
let isEtlRunning = false; 

// ==========================================
// 🚀 超輕量 ETL 核心流程 (Zero AI Compute, Full Text)
// ==========================================
async function executeNewsETL(scraperModule, sourceName) {
    logger.info(`🔄 [排程器] 啟動 [${sourceName}] 爬蟲 ETL 流程 (純文字完整保留模式)...`);
    try {
        const rawArticles = await scraperModule.scrape();

        if (!rawArticles || rawArticles.length === 0) {
            return;
        }

        const newArticles = rawArticles.filter(article => !db.isArticleExists(article.url));

        if (newArticles.length === 0) {
            return;
        }

        logger.info(`📥 [排程器] [${sourceName}] 共有 ${newArticles.length} 篇新文章，直接完整寫入資料庫...`);

        let processedCount = 0;

        for (const article of newArticles) {
            try {
                // 🌟 核心修改：不再裁切！直接將整篇文章的完整內文存入 content 欄位，供 AI 群聊 RAG 檢索使用
                const safeContent = article.content || '';
                
                const recordToSave = {
                    url: article.url,
                    title: article.title,
                    summary: '', // 背景不再浪費算力做摘要
                    content: safeContent 
                };

                db.saveNewsWithTags(recordToSave, article.symbols || []);
                processedCount++;
            } catch (err) {
                logger.error(`❌ [排程器] 單篇文章儲存失敗 (${article.title}): ${err.message}`);
            }
        }

        logger.info(`✅ [排程器] [${sourceName}] 輕量 ETL 執行完畢！本次新增 ${processedCount} 篇新聞。`);
    } catch (error) {
        logger.error(`❌ [排程器] 執行 [${sourceName}] ETL 發生嚴重錯誤: ${error.message}`);
    }
}

// ==========================================
// 🛠️ 全網新聞觸發器
// ==========================================
async function triggerAllETL() {
    if (isEtlRunning) {
        logger.warn('⚠️ [排程系統] 上一個爬蟲任務尚未結束，本次觸發略過。');
        return;
    }

    isEtlRunning = true; 
    
    try {
        logger.info('==================================================');
        logger.info('🛠️ [資料管線] 啟動全網新聞輕量抓取作業 (完整內文保留)');
        logger.info('==================================================');
        
        await executeNewsETL(udnScraper, '經濟日報');
        await executeNewsETL(cteeScraper, '工商時報');
        await executeNewsETL(cmoneyScraper, 'CMoney');
        
        logger.info('🏁 [資料管線] 所有平台的輕量 ETL 作業已完成！');
    } finally {
        isEtlRunning = false; 
    }
}

// ==========================================
// ⏰ 系統任務排程管理
// ==========================================
logger.info('⏰ [排程器] 輕量化核心排程引擎已啟動。');

// 每 30 分鐘清理一次過期新聞 (保留 72 小時)
cron.schedule('*/30 * * * *', () => {
    logger.info('🧹 [排程器] 觸發例行維護：清理過期新聞...');
    if (typeof db.cleanOldNews === 'function') {
        db.cleanOldNews(72); 
    }
}, { timezone: "Asia/Taipei" });

// 每小時整點抓取一次新聞
cron.schedule('0 * * * *', async () => {
    logger.info('🕸️ [排程器] 定時觸發全網財經新聞輕量抓取...');
    await triggerAllETL(); 
}, { timezone: "Asia/Taipei" });

// 每天凌晨 2:00 執行夜間覆盤程序
cron.schedule('0 2 * * *', async () => {
    logger.info('🌙 [排程器] 啟動夜間覆盤程序：檢驗一週前的詳查報告...');
    try {
        const nightReview = require('./services/night_review');
        const reviewContent = await nightReview.runWeeklyReview();
        
        if (reviewContent) {
            // night_review.js 已經幫我們做好標題與排版，直接呼叫 bot.js 的發送功能
            await sendReportToDiscord(reviewContent);
        } else {
            logger.info('🌙 [排程器] 今日無一週前之報告需覆盤，跳過推播。');
        }
    } catch (error) {
        logger.error(`❌ [排程器] 夜間覆盤程序中斷: ${error.message}`);
    }
}, { timezone: "Asia/Taipei" });

module.exports = { executeNewsETL, triggerAllETL };