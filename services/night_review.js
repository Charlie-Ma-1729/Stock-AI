// services/night_review.js
const axios = require('axios');
const db = require('../db');
const logger = require('../logger');

let marketApi;
try {
    marketApi = require('./market_api');
} catch (e) {
    logger.warn(`⚠️ [Night Review] market_api.js 載入失敗！無法獲取真實報價進行對帳。`);
}

const OLLAMA_URL = 'http://127.0.0.1:11434/api/generate';
const MODEL_NAME = 'hf.co/lianghsun/Llama-3.2-Taiwan-3B-Instruct-GGUF:Q8_0';

async function evaluatePrediction(prediction) {
    logger.info(`🦉 正在對預言 [ID: ${prediction.id} - ${prediction.symbol}] 進行開獎與覆盤...`);
    
    // 取得當前時間，賦予 AI 時間概念
    const timeString = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });

    let stockData = {};
    let trendStr = '無法取得即時走勢';
    if (marketApi) {
        try {
            stockData = await marketApi.fetchStockTrend(prediction.symbol);
            if (!stockData.error) {
                trendStr = (stockData.recentTrend || []).map(t => `${t.date}: 收盤 ${t.close}`).join('\n');
            }
        } catch (e) {
            logger.warn(`⚠️ 無法取得 ${prediction.symbol} 的真實報價，將僅依賴文字進行覆盤。`);
        }
    }

    const symbolNews = db.searchNewsByKeyword('', prediction.symbol, 3);
    let realityContext = '目前資料庫暫無該標的之近期重大新聞。';
    if (symbolNews && symbolNews.length > 0) {
        realityContext = symbolNews.map((n, i) => `[新聞 ${i+1}] ${n.title}\n時間: ${n.published_at}\n內文: ${n.content}`).join('\n\n');
    }

    const prompt = `你是一位嚴格且毒舌的華爾街量化交易檢討員。請對以下「一週前的詳查報告」進行殘酷的「反身性」覆盤：

【當前系統時間】：${timeString} (請以此為基準判斷新聞與價格的時效性)

【一週前的預測紀錄】
- 標的：${prediction.symbol}
- 立下預言時間：${prediction.created_at}
- 當時的預測內容：
${prediction.prediction_text}

【今日市場現實 (開獎結果參考)】
- 目前現價：${stockData.currentPrice || '未知'} (${stockData.changePercent || '未知'})
- 近期收盤走勢：
${trendStr}
- 近期關聯新聞：
${realityContext}

【強制任務要求】：
1. 殘酷對帳：一週前的報告看多還是看空？跟現在的「真實走勢與現價」吻合嗎？
2. 盲點抓漏：如果預測錯誤，無情指出當時的「情緒盲點」、「過度樂觀/悲觀」或「被新聞帶風向」的狀況。如果預測正確，總結成功的核心邏輯。
3. 經驗法則：請淬鍊出一段 100 字以內的「經驗法則(Lesson)」，這段話未來會在遇到類似狀況時用來警告你自己。
4. 語系強制使用「繁體中文 (zh-TW)」。
5. 直接以 Markdown 格式輸出覆盤結果，不需多餘的問候語。`;

    try {
        const response = await axios.post(OLLAMA_URL, {
            model: MODEL_NAME,
            prompt: prompt,
            stream: false,
            options: { temperature: 0.6, num_ctx: 8192 } 
        }, { timeout: 1800000 }); 

        const lessonText = response.data.response.trim();
        logger.info(`💡 覆盤結論產出完成。`);

        await db.saveVectorMemory(`關於 ${prediction.symbol} 的市場教訓：${lessonText}`, { 
            type: '覆盤教訓', 
            symbol: prediction.symbol 
        });

        db.markPredictionEvaluated(prediction.id);
        logger.info(`✅ 預言 [ID: ${prediction.id}] 已結案並刻入記憶體。`);

        return lessonText;

    } catch (error) {
        logger.error(`❌ 覆盤發生錯誤: ${error.message}`);
        return `⚠️ 針對 ${prediction.symbol} 的覆盤因系統超時或錯誤而失敗。`;
    }
}

async function runWeeklyReview() {
    logger.info('==================================================');
    logger.info('🦉 啟動深夜反身性覆盤作業 (Night Review)');
    logger.info('==================================================');

    const duePredictions = db.getDuePredictions();

    if (!duePredictions || duePredictions.length === 0) {
        logger.info('🛌 今晚沒有需要開獎的預言，AI 繼續休息。');
        return null; 
    }

    logger.info(`🔍 發現 ${duePredictions.length} 筆到期的預言，準備開獎...`);

    let finalDiscordReport = `今晚共有 **${duePredictions.length}** 筆一週前的詳查報告到期，以下是 AI 的殘酷對帳與覆盤總結：\n\n`;

    for (const prediction of duePredictions) {
        const reviewContent = await evaluatePrediction(prediction);
        
        finalDiscordReport += `### 🎯 標的：${prediction.symbol}\n`;
        finalDiscordReport += `${reviewContent}\n\n`;
        finalDiscordReport += `------------------------------------\n\n`;

        await new Promise(res => setTimeout(res, 5000));
    }

    logger.info('🏁 深夜覆盤作業全部完成！');
    return finalDiscordReport;
}

module.exports = { runWeeklyReview };

if (require.main === module) {
    runWeeklyReview().then(report => {
        if (report) console.log(report);
    });
}