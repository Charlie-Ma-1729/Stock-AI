const fs = require('fs');
const path = require('path');

// 確保 logs 資料夾存在
const logDir = path.join(__dirname, 'logs');
if (!fs.existsSync(logDir)) {
    fs.mkdirSync(logDir);
}

// 取得今日的檔案路徑 (例如: cmoney_scraper_2023-10-27.log)
function getTodayLogFilePath() {
    const today = new Date();
    const dateStr = new Date(today.getTime() - (today.getTimezoneOffset() * 60000))
        .toISOString()
        .split('T')[0];
    return path.join(logDir, `${dateStr}.log`);
}

// 格式化訊息
function formatMessage(level, message) {
    const now = new Date().toLocaleString('zh-TW', { hour12: false });
    return `[${now}] [${level}] ${message}`;
}

// 寫入 Log 檔案與終端機
function writeLog(level, message) {
    const formattedMessage = formatMessage(level, message);
    
    // 終端機輸出
    if (level === 'ERROR') {
        console.error(formattedMessage);
    } else if (level === 'WARN') {
        console.warn(formattedMessage);
    } else {
        console.log(formattedMessage);
    }

    // 檔案寫入
    const logFile = getTodayLogFilePath();
    fs.appendFileSync(logFile, formattedMessage + '\n', 'utf8');
}

// 供未來主程式讀取今日 Log 使用
function getTodayLogContent() {
    const logFile = getTodayLogFilePath();
    if (fs.existsSync(logFile)) {
        return fs.readFileSync(logFile, 'utf8');
    }
    return '今日尚無 Log 紀錄。';
}

module.exports = {
    info: (msg) => writeLog('INFO', msg),
    warn: (msg) => writeLog('WARN', msg),
    error: (msg) => writeLog('ERROR', msg),
    getTodayLogFilePath,
    getTodayLogContent
};