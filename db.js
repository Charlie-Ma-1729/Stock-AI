// db.js
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const axios = require('axios');
const { LocalIndex } = require('vectra');
const logger = require('./logger'); 

const dbPath = path.join(__dirname, 'stock_ai.db');
const db = new Database(dbPath);

db.pragma('foreign_keys = ON');

function initDB() {
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

    db.exec(`
      CREATE TABLE IF NOT EXISTS stock_news_map (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        article_url TEXT NOT NULL,
        FOREIGN KEY(article_url) REFERENCES articles(url) ON DELETE CASCADE
      );
    `);

    db.exec(`
        CREATE TABLE IF NOT EXISTS predictions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            source TEXT,            
            symbol TEXT,            
            prediction_text TEXT,   
            created_at DATETIME,    
            target_date DATETIME,   
            status TEXT DEFAULT 'PENDING' 
        );
    `);
    
    logger.info('✅ [DB] SQLite 資料庫與資料表初始化完成');
}
initDB();

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
        ORDER BY a.published_at DESC
    `),
    
    // 🌟 核心修改：改為在 a.content (完整內文) 裡面進行模糊搜尋
    searchNewsByKeyword: db.prepare(`
        SELECT a.url, a.title, a.summary, a.content, GROUP_CONCAT(m.symbol) as symbols
        FROM articles a
        LEFT JOIN stock_news_map m ON a.url = m.article_url
        WHERE m.symbol = ? 
           OR a.title LIKE ? OR a.content LIKE ? 
           OR a.title LIKE ? OR a.content LIKE ?
        GROUP BY a.url
        ORDER BY a.published_at DESC
        LIMIT ?
    `),
    
    deleteOldArticles: db.prepare(`DELETE FROM articles WHERE published_at < datetime('now', '-' || ? || ' hours')`),
    deleteOrphanMaps: db.prepare(`DELETE FROM stock_news_map WHERE article_url NOT IN (SELECT url FROM articles)`),

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

function getRecentNews(hours = 72) {
    const rows = stmts.getRecentNews.all(hours);
    return rows.map(row => ({
        ...row,
        symbols: row.symbols ? row.symbols.split(',') : []
    }));
}

function searchNewsByKeyword(stockName, symbol, limit = 15) {
    const baseSymbol = symbol ? symbol.split('.')[0] : '';
    const namePattern = stockName ? `%${stockName}%` : '%未提供%';
    const symbolPattern = baseSymbol ? `%${baseSymbol}%` : '%未提供%';
    
    try {
        const rows = stmts.searchNewsByKeyword.all(
            symbol, 
            namePattern, namePattern, 
            symbolPattern, symbolPattern, 
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

function cleanOldNews(hours = 72) {
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

function savePrediction(source, symbol, text, daysToVerify) {
    const now = new Date();
    const targetDate = new Date(now.getTime() + daysToVerify * 24 * 60 * 60 * 1000);
    
    try {
        stmts.insertPrediction.run(source, symbol, text, now.toISOString(), targetDate.toISOString());
        logger.info(`🔮 已記錄 [${source}] 對 [${symbol}] 的詳查報告，將於 ${daysToVerify} 天後進行夜間覆盤驗證。`);
    } catch (err) {
        logger.error(`儲存詳查報告預言失敗: ${err.message}`);
    }
}

function getDuePredictions() {
    const now = new Date().toISOString();
    return stmts.getPendingPredictions.all(now);
}

function markPredictionEvaluated(id) {
    stmts.updatePredictionStatus.run(id);
    logger.info(`✅ [DB] 已將預言單號 #${id} 標記為 EVALUATED (已覆盤)。`);
}

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
    searchNewsByKeyword,
    cleanOldNews, 
    savePrediction,
    getDuePredictions,
    markPredictionEvaluated,
    saveVectorMemory,
    queryVectorMemory
};