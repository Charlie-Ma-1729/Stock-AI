// db.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { LocalIndex } = require('vectra');
const logger = require('./logger'); // 請確保路徑正確

// ==========================================
// 1. 初始化 SQLite 關聯式資料庫 (使用 better-sqlite3)
// ==========================================
const dbPath = path.join(__dirname, 'stock_ai.db');
const db = new Database(dbPath);

// 啟動外鍵約束，確保資料庫關聯乾淨
db.pragma('foreign_keys = ON');

// 初始化資料庫結構
function initDB() {
    // 1. 新聞主檔
    db.exec(`
      CREATE TABLE IF NOT EXISTS articles (
        url TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        summary TEXT, -- 這裡未來將只存放 AI 濃縮後的心血結晶
        content TEXT, -- 將會保持為空，不佔用空間
        published_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        ai_importance_score INTEGER DEFAULT 0
      );
    `);

    // 2. 個股與新聞的多對多映射表
    db.exec(`
      CREATE TABLE IF NOT EXISTS stock_news_map (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        article_url TEXT NOT NULL,
        FOREIGN KEY(article_url) REFERENCES articles(url) ON DELETE CASCADE
      );
    `);

    // 3. 預言追蹤表 (追蹤短期/長期預測)
    db.exec(`
        CREATE TABLE IF NOT EXISTS predictions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT,            -- 來源 (例如 'AI' 或 'User: Charlie')
            symbol TEXT,            -- 相關股票/標的
            prediction_text TEXT,   -- 預測內容
            created_at DATETIME,    -- 立下預言的時間
            target_date DATETIME,   -- 預計開獎(驗證)的時間
            status TEXT DEFAULT 'PENDING' -- 狀態: PENDING, EVALUATED
        );
    `);
    
    logger.info('✅ [DB] SQLite 資料庫與資料表初始化完成');
}
initDB();

// ==========================================
// 2. 初始化 Vectra 向量資料庫 (儲存抽象的覆盤教訓)
// ==========================================
const vectorDbPath = path.join(__dirname, 'output/vectra_store');
if (!fs.existsSync(vectorDbPath)) {
    fs.mkdirSync(vectorDbPath, { recursive: true });
}
const vectorIndex = new LocalIndex(vectorDbPath);

async function initVectorDB() {
    if (!(await vectorIndex.isIndexCreated())) {
        await vectorIndex.createIndex();
        logger.info('✅ [DB] Vectra 向量記憶庫初始化完成');
    }
}
initVectorDB();

// ==========================================
// 🗞️ 模組 A：新聞與標籤儲存系統
// ==========================================
const stmts = {
    checkArticleExists: db.prepare(`SELECT 1 FROM articles WHERE url = ?`),
    // 現在存入 DB 時，summary 裝的會是 AI 已經濃縮好的精華，content 直接放空字串即可
    insertArticle: db.prepare(`INSERT OR IGNORE INTO articles (url, title, summary, content) VALUES (?, ?, ?, ?)`),
    insertStockMap: db.prepare(`INSERT OR IGNORE INTO stock_news_map (symbol, article_url) VALUES (?, ?)`),
    
    getRecentNews: db.prepare(`
        SELECT a.url, a.title, a.summary, a.content, GROUP_CONCAT(m.symbol) as symbols
        FROM articles a
        LEFT JOIN stock_news_map m ON a.url = m.article_url
        WHERE a.published_at >= datetime('now', '-' || ? || ' hours')
        GROUP BY a.url
    `),
    
    // 🌟 [新增]: 給詳查指令用的深度檢索 SQL (包含關聯代號與標題、摘要的模糊比對)
    searchNewsByKeyword: db.prepare(`
        SELECT a.url, a.title, a.summary, a.content, GROUP_CONCAT(m.symbol) as symbols
        FROM articles a
        LEFT JOIN stock_news_map m ON a.url = m.article_url
        WHERE m.symbol = ? 
           OR a.title LIKE ? OR a.summary LIKE ? 
           OR a.title LIKE ? OR a.summary LIKE ?
        GROUP BY a.url
        ORDER BY a.published_at DESC
        LIMIT ?
    `),
    
    // [優化]: 修改成動態吃參數的小時數，配合排程器的 15 小時
    deleteOldArticles: db.prepare(`DELETE FROM articles WHERE published_at < datetime('now', '-' || ? || ' hours')`),
    deleteOrphanMaps: db.prepare(`DELETE FROM stock_news_map WHERE article_url NOT IN (SELECT url FROM articles)`),

    // 🌟 [修復]: 補齊漏掉的預言系統 SQL 語法
    insertPrediction: db.prepare(`INSERT INTO predictions (source, symbol, prediction_text, created_at, target_date) VALUES (?, ?, ?, ?, ?)`),
    getPendingPredictions: db.prepare(`SELECT * FROM predictions WHERE status = 'PENDING' AND target_date <= ?`),
    updatePredictionStatus: db.prepare(`UPDATE predictions SET status = 'EVALUATED' WHERE id = ?`)
};

function isArticleExists(url) {
    return stmts.checkArticleExists.get(url) !== undefined;
}

const saveNewsWithTags = db.transaction((articleData, symbols) => {
    // 存入文章 (content 預期為空字串，以節省空間)
    stmts.insertArticle.run(articleData.url, articleData.title, articleData.summary, articleData.content);
    for (const symbol of symbols) {
        stmts.insertStockMap.run(symbol, articleData.url);
    }
});

/**
 * 取得最近 X 小時內的新聞 (現在拿出來的直接是 AI 濃縮過的 summary)
 */
function getRecentNews(hours = 12) {
    const rows = stmts.getRecentNews.all(hours);
    return rows.map(row => ({
        ...row,
        symbols: row.symbols ? row.symbols.split(',') : []
    }));
}

/**
 * 🌟 [新增功能] 針對個股的專屬新聞檢索
 * @param {string} stockName 股票名稱 (例如: 台積電)
 * @param {string} symbol 股票代號 (例如: 2330.TW 或 NVDA)
 * @param {number} limit 抓取上限
 */
function searchNewsByKeyword(stockName, symbol, limit = 15) {
    // 把 .TW 或 .TWO 拔掉，因為新聞常常只會寫純數字 2330
    const baseSymbol = symbol ? symbol.split('.')[0] : '';
    
    const namePattern = stockName ? `%${stockName}%` : '%未提供%';
    const symbolPattern = baseSymbol ? `%${baseSymbol}%` : '%未提供%';
    
    try {
        const rows = stmts.searchNewsByKeyword.all(
            symbol, 
            namePattern, namePattern,  // 比對標題與摘要是否含名稱
            symbolPattern, symbolPattern, // 比對標題與摘要是否含代號
            limit
        );
        
        return rows.map(row => ({
            ...row,
            symbols: row.symbols ? row.symbols.split(',') : []
        }));
    } catch (err) {
        logger.error(`❌ [DB] 檢索專屬新聞失敗: ${err.message}`);
        return [];
    }
}

/**
 * 🧹 [優化功能] 清理老舊新聞，維持系統輕量化 (預設改為 15 小時)
 */
function cleanOldNews(hours = 15) {
    try {
        const info1 = stmts.deleteOldArticles.run(hours);
        const info2 = stmts.deleteOrphanMaps.run();
        if (info1.changes > 0 || info2.changes > 0) {
            logger.info(`🗑️ [DB] 自動清理完成：已刪除 ${info1.changes} 篇過期(${hours}小時前)新聞，及 ${info2.changes} 筆無效標籤。`);
        }
    } catch (err) {
        logger.error(`❌ [DB] 清理舊新聞失敗: ${err.message}`);
    }
}

// ==========================================
// 🔮 模組 B：預言追蹤系統 (Time-Horizon Predictions)
// ==========================================

function savePrediction(source, symbol, text, daysToVerify) {
    const now = new Date();
    const targetDate = new Date(now.getTime() + daysToVerify * 24 * 60 * 60 * 1000);
    
    try {
        stmts.insertPrediction.run(source, symbol, text, now.toISOString(), targetDate.toISOString());
        logger.info(`🔮 已記錄 [${source}] 對 [${symbol}] 的預言，將於 ${daysToVerify} 天後驗證。`);
    } catch (err) {
        logger.error(`儲存預言失敗: ${err.message}`);
    }
}

function getDuePredictions() {
    const now = new Date().toISOString();
    return stmts.getPendingPredictions.all(now);
}

function markPredictionEvaluated(id) {
    stmts.updatePredictionStatus.run(id);
}

// ==========================================
// 🧠 模組 C：向量記憶系統 (Vector Reflexivity Memory)
// ==========================================

async function getEmbedding(text) {
    try {
        const response = await axios.post('http://127.0.0.1:11434/api/embeddings', {
            model: 'nomic-embed-text',
            prompt: text
        });
        return response.data.embedding;
    } catch (error) {
        logger.error(`向量轉換失敗: ${error.message}`);
        return null;
    }
}

async function saveVectorMemory(text, metadata = {}) {
    const vector = await getEmbedding(text);
    if (!vector) return false;

    await vectorIndex.insertItem({
        vector: vector,
        metadata: { text, date: new Date().toISOString(), ...metadata }
    });
    logger.info(`🧠 歷史教訓已刻入向量神經網: [${metadata.symbol || '宏觀'}]`);
    return true;
}

async function queryVectorMemory(text, topK = 3) {
    const vector = await getEmbedding(text);
    if (!vector) return [];

    const results = await vectorIndex.queryItems(vector, topK);
    return results.filter(r => r.score > 0.7).map(r => r.item.metadata);
}

module.exports = {
    isArticleExists,
    saveNewsWithTags,
    getRecentNews,
    searchNewsByKeyword, // 🌟 匯出供 bot.js 呼叫
    cleanOldNews, 
    savePrediction,
    getDuePredictions,
    markPredictionEvaluated,
    saveVectorMemory,
    queryVectorMemory
};