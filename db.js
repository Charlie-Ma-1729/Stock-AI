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

// 初始化資料庫結構
function initDB() {
    // 1. 新聞主檔
    db.exec(`
      CREATE TABLE IF NOT EXISTS articles (
        url TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        summary TEXT,
        content TEXT,
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
        FOREIGN KEY(article_url) REFERENCES articles(url)
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
    insertArticle: db.prepare(`INSERT OR IGNORE INTO articles (url, title, summary, content) VALUES (?, ?, ?, ?)`),
    insertStockMap: db.prepare(`INSERT OR IGNORE INTO stock_news_map (symbol, article_url) VALUES (?, ?)`),
    getRecentNews: db.prepare(`
        SELECT a.url, a.title, a.summary, a.content, GROUP_CONCAT(m.symbol) as symbols
        FROM articles a
        LEFT JOIN stock_news_map m ON a.url = m.article_url
        WHERE a.published_at >= datetime('now', '-' || ? || ' hours')
        GROUP BY a.url
    `),
    insertPrediction: db.prepare(`INSERT INTO predictions (source, symbol, prediction_text, created_at, target_date) VALUES (?, ?, ?, ?, ?)`),
    getPendingPredictions: db.prepare(`SELECT * FROM predictions WHERE status = 'PENDING' AND target_date <= ?`),
    updatePredictionStatus: db.prepare(`UPDATE predictions SET status = 'EVALUATED' WHERE id = ?`)
};

function isArticleExists(url) {
    return stmts.checkArticleExists.get(url) !== undefined;
}

const saveNewsWithTags = db.transaction((articleData, symbols) => {
    stmts.insertArticle.run(articleData.url, articleData.title, articleData.summary, articleData.content);
    for (const symbol of symbols) {
        stmts.insertStockMap.run(symbol, articleData.url);
    }
});

/**
 * 取得最近 X 小時內抓取的新聞 (供 AI 濃縮分析用)
 */
function getRecentNews(hours = 12) {
    const rows = stmts.getRecentNews.all(hours);
    return rows.map(row => ({
        ...row,
        symbols: row.symbols ? row.symbols.split(',') : [] // 把逗號分隔的字串轉回陣列
    }));
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
    // 只取相似度 > 0.7 的記憶
    return results.filter(r => r.score > 0.7).map(r => r.item.metadata);
}

module.exports = {
    isArticleExists,
    saveNewsWithTags,
    getRecentNews,
    savePrediction,
    getDuePredictions,
    markPredictionEvaluated,
    saveVectorMemory,
    queryVectorMemory
};