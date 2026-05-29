const Database = require('better-sqlite3');
const db = new Database('stock_ai.db');

// 初始化資料庫結構 (如果檔案或資料表不存在，會自動建立)
function initDB() {
    // 新聞主檔
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

    // 個股與新聞的多對多映射表
    db.exec(`
      CREATE TABLE IF NOT EXISTS stock_news_map (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        article_url TEXT NOT NULL,
        FOREIGN KEY(article_url) REFERENCES articles(url)
      );
    `);
    console.log('✅ [DB] 資料庫與資料表檢查/初始化完成');
}

// 執行初始化
initDB();

// 預先編譯 SQL 語句 (Prepared Statements)，提升效能與防範 SQL 注入
const stmts = {
    checkArticleExists: db.prepare(`SELECT 1 FROM articles WHERE url = ?`),
    insertArticle: db.prepare(`INSERT OR IGNORE INTO articles (url, title, summary, content) VALUES (?, ?, ?, ?)`),
    insertStockMap: db.prepare(`INSERT OR IGNORE INTO stock_news_map (symbol, article_url) VALUES (?, ?)`),
};

// 封裝「寫入新聞與標籤」的交易 (Transaction) 操作
// 確保主檔與關聯檔要嘛一起成功，要嘛一起失敗
const saveNewsWithTags = db.transaction((articleData, symbols) => {
    // 1. 寫入新聞主檔
    stmts.insertArticle.run(articleData.url, articleData.title, articleData.summary, articleData.content);
    
    // 2. 寫入個股代號映射
    for (const symbol of symbols) {
        stmts.insertStockMap.run(symbol, articleData.url);
    }
});

// 封裝檢查文章是否存在的函式
function isArticleExists(url) {
    return stmts.checkArticleExists.get(url) !== undefined;
}

// 匯出爬蟲或其他模組會用到的方法
module.exports = {
    isArticleExists,
    saveNewsWithTags
};