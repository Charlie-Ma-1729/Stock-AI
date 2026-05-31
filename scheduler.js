// scheduler.js
const cron = require('node-cron');
const logger = require('./logger');
const db = require('./db');
const ai_analyzer = require('./services/ai_analyzer');
const { sendReportToDiscord } = require('./bot'); 

const cteeScraper = require('./ctee_scraper');
const udnScraper = require('./udn_scraper');
const cmoneyScraper = require('./cmoney_scraper');

// ==========================================
// 🚦 系統狀態鎖 (State Locks) 
// 用於控制併發，避免資源搶占與重複執行
// ==========================================
let isEtlRunning = false;         // 標記是否正在爬蟲或濃縮新聞
let isReportGenerating = false;   // 標記是否正在生成 AI 報告 (優先權最高)

// 輔助函數：暫停等待 (Sleep)
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/**
 * 🌟 核心禮讓機制：等待報告生成完畢
 * 如果發現系統正在生成報告，就卡在這裡等待，直到解鎖為止
 */
async function waitUntilReportFinished() {
    if (isReportGenerating) {
        logger.info('⏸️ [排程系統] 偵測到 8B 核心正在生成報告，ETL 流程暫停 (禮讓算力中)...');
        while (isReportGenerating) {
            await sleep(5000); // 每 5 秒檢查一次是否解鎖
        }
        logger.info('▶️ [排程系統] 報告生成完畢，ETL 流程恢復執行！');
    }
}

// ==========================================
// 🚀 ETL 核心流程 (支援單筆循序處理與暫停)
// ==========================================
async function executeNewsETL(scraperModule, sourceName) {
    logger.info(`🔄 [排程器] 啟動 [${sourceName}] 爬蟲 ETL 流程...`);
    try {
        // 抓取前先檢查是否需要禮讓報告
        await waitUntilReportFinished();

        // 1. Extract: 呼叫爬蟲抓取新聞
        const rawArticles = await scraperModule.scrape();

        if (!rawArticles || rawArticles.length === 0) {
            logger.info(`⚠️ [排程器] [${sourceName}] 沒有抓取到新文章或目前無更新。`);
            return;
        }

        const newArticles = rawArticles.filter(article => !db.isArticleExists(article.url));

        if (newArticles.length === 0) {
            logger.info(`🛑 [排程器] [${sourceName}] 抓取的文章皆已存於資料庫，無須處理。`);
            return;
        }

        logger.info(`📥 [排程器] [${sourceName}] 共有 ${newArticles.length} 篇新文章，準備進入 AI 摘要管線...`);

        let processedCount = 0;
        
        // 🌟 [優化]: 將併發數改為 1，嚴格執行「一篇一篇處理」，保護 CPU 算力不超載[cite: 3]
        const CONCURRENCY_LIMIT = 1; 

        // 2. Transform & Load: 單篇循序處理
        for (let i = 0; i < newArticles.length; i += CONCURRENCY_LIMIT) {
            
            // 🌟 核心防護：每一篇處理前，檢查是否有人在生成報告，有就暫停[cite: 3]
            await waitUntilReportFinished(); 

            const batch = newArticles.slice(i, i + CONCURRENCY_LIMIT);
            logger.info(`⚡ [排程器] 正在處理第 ${i + 1} 篇文章 (單篇循序模式)...`);

            await Promise.all(batch.map(async (article) => {
                try {
                    const summary = await ai_analyzer.summarizeNews(article.title, article.content);
                    
                    const recordToSave = {
                        url: article.url,
                        title: article.title,
                        summary: summary,
                        content: '' 
                    };

                    db.saveNewsWithTags(recordToSave, article.symbols || []);
                    processedCount++;
                } catch (err) {
                    logger.error(`❌ [排程器] 單篇文章濃縮失敗 (${article.title}): ${err.message}`);
                }
            }));
            
            // 處理完一篇後稍微休息 1 秒，讓 CPU 喘口氣
            await sleep(1000);
        }

        logger.info(`✅ [排程器] [${sourceName}] ETL 執行完畢！本次新增並濃縮了 ${processedCount} 篇新聞。`);
    } catch (error) {
        logger.error(`❌ [排程器] 執行 [${sourceName}] ETL 發生嚴重錯誤: ${error.message}`);
    }
}

// ==========================================
// 🛠️ 全網新聞觸發器 (加入重複執行防護)
// ==========================================
async function triggerAllETL() {
    // 🌟 防護 1：如果有 ETL 正在進行，直接略過，避免重複啟動塞爆記憶體
    if (isEtlRunning) {
        logger.warn('⚠️ [排程系統] 發現上一個 ETL 任務尚未結束，本次觸發自動忽略。');
        return;
    }

    // 🌟 防護 2：如果報告正在生成，等待它結束後再開始
    await waitUntilReportFinished();

    isEtlRunning = true; // 鎖上 ETL 狀態鎖
    
    try {
        logger.info('==================================================');
        logger.info('🛠️ [資料管線] 啟動全網新聞強制抓取與 AI 濃縮作業');
        logger.info('==================================================');
        
        await executeNewsETL(udnScraper, '經濟日報');
        await executeNewsETL(cteeScraper, '工商時報');
        await executeNewsETL(cmoneyScraper, 'CMoney');
        
        logger.info('🏁 [資料管線] 所有平台的 ETL 濃縮作業已完成！');
    } finally {
        isEtlRunning = false; // 無論成功失敗，確保解鎖
    }
}

// ==========================================
// ⏰ 系統任務排程管理 (主程式進入點)
// ==========================================
logger.info('⏰ [排程器] 核心排程引擎已啟動，開始監控市場與資料流。');

// 任務一：自動清理過期記憶 (每天凌晨 02:00 執行)
cron.schedule('0 2 * * *', () => {
    logger.info('🧹 [排程器] 觸發例行維護：開始清理過期新聞與孤兒標籤...');
    db.cleanOldNews();
}, { timezone: "Asia/Taipei" });

// 任務二：全網情報巡邏與 ETL (每 30 分鐘執行一次)
cron.schedule('*/30 * * * *', async () => {
    logger.info('🕸️ [排程器] 定時觸發全網財經新聞巡邏與 ETL...');
    await triggerAllETL(); 
}, { timezone: "Asia/Taipei" });

// 任務三：AI 自動化定時報告生成與發布
const reportSchedules = [
    { time: '0 6 * * 2-6', name: '06:00 美股收盤與晨間風向' }, 
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

        // 🌟 啟動報告生成鎖，這會讓所有正在運行的 ETL 暫停，新的 ETL 乖乖排隊[cite: 3]
        isReportGenerating = true; 
        
        try {
            // 💡 [優化]: 嚴格限制傳給 AI 萃取的新聞總數，最多只取最新 40 篇
            // 配合 analyzer 的「少量多次(15篇一組)」，確保效能與覆蓋率平衡
            const recentNews = db.getRecentNews(40); 
            logger.info(`📰 [排程器] 從資料庫提取最新 ${recentNews.length} 篇新聞進行多空分析。`);

            // 💡 [優化]: 真正呼叫 market_api 抓取即時市場大盤快照與三大法人，讓 AI 不再閉門造車
            logger.info('📈 [排程器] 正在即時抓取台美股大盤與三大法人籌碼面數據...');
            let marketData = {};
            try {
                // 確保路徑與你的專案相符，此處假設 market_api 放在 services 資料夾下
                const marketApi = require('./services/market_api'); 
                
                // 盤前與盤後報告才需要加入三大法人數據 (避免盤中 API 取不到而報錯)
                const includeInstitutional = schedule.name.includes('06:00') || schedule.name.includes('18:00');
                marketData = await marketApi.getMarketSnapshot(includeInstitutional, true);
            } catch (apiErr) {
                logger.error(`⚠️ [排程器] 讀取即時盤勢快照失敗，改用純新聞分析: ${apiErr.message}`);
            }

            // 呼叫 8B 模型進行高精度分析
            const reportContent = await ai_analyzer.generateMarketReport(schedule.name, marketData, recentNews);

            const header = `\n========== 【${schedule.name}】 ==========\n`;
            const footer = `\n====================================\n`;
            await sendReportToDiscord(header + reportContent + footer);
            
            logger.info(`✅ [排程器] 報告已成功推播至 Discord`);

        } catch (error) {
            logger.error(`❌ [排程器] 定時報告生成流程中斷: ${error.message}`);
        } finally {
            // 🌟 報告生成結束，解除鎖定，讓暫停的 ETL 恢復運作[cite: 3]
            isReportGenerating = false; 
            logger.info(`🔓 [排程器] 報告鎖定已解除，釋放算力。`);
        }
    }, { timezone: "Asia/Taipei" });
});

module.exports = { executeNewsETL, triggerAllETL };