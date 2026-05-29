const axios = require('axios');
const db = require('./db');
const logger = require('../logger');

const OLLAMA_URL = 'http://127.0.0.1:11434/api/generate';
// 使用老闆成功下載的 3B Q8_0 量化模型
const MODEL_NAME = 'hf.co/lianghsun/Llama-3.2-Taiwan-3B-Instruct-GGUF:Q8_0';

/**
 * 對單筆預言進行開獎與檢討
 */
async function evaluatePrediction(prediction) {
    logger.info(`🦉 正在對預言 [ID: ${prediction.id} - ${prediction.symbol}] 進行開獎與覆盤...`);

    // 撈取最近 24 小時與該標的相關的新聞，作為「現實結果」的依據
    const allRecentNews = db.getRecentNews(24);
    const symbolNews = allRecentNews.filter(n => n.symbols && n.symbols.includes(prediction.symbol));

    let realityContext = '目前市場暫無該標的之重大新聞，請依據你對市場的總體理解評估。';
    if (symbolNews.length > 0) {
        realityContext = symbolNews.map((n, i) => `${i+1}. ${n.title}`).join('\n');
    }

    const prompt = `你是一位嚴格的華爾街量化交易檢討員。請進行「反身性」覆盤：

【預言紀錄】
- 來源：${prediction.source}
- 標的：${prediction.symbol}
- 當時的預測內容：${prediction.prediction_text}
- 立下預言的時間：${prediction.created_at}

【今日市場現實 (開獎結果參考)】
${realityContext}

【任務】
1. 判斷該預測是否準確？(若資訊不足，請基於一般市場常理推斷)
2. 如果預測錯誤，指出當時的「情緒盲點」、「過度樂觀/悲觀」或「被新聞帶風向」的狀況。
3. 如果預測正確，總結這次成功的核心邏輯。
4. 最後，請淬鍊出一段 100 字以內的「經驗法則(Lesson)」，這段話未來會在遇到類似狀況時用來警告你自己。
`;

    try {
        const response = await axios.post(OLLAMA_URL, {
            model: MODEL_NAME,
            prompt: prompt,
            stream: false,
            options: { temperature: 0.6 } // 檢討需要一點發散思維與反思能力
        });

        const lessonText = response.data.response.trim();
        logger.info(`💡 覆盤結論：\n${lessonText}`);

        // 將教訓寫入向量記憶庫 (海馬迴)
        await db.saveVectorMemory(`關於 ${prediction.symbol} 的市場教訓：${lessonText}`, { 
            type: '覆盤教訓', 
            symbol: prediction.symbol 
        });

        // 將預言標記為「已結案」，避免明天半夜重複檢討
        db.markPredictionEvaluated(prediction.id);
        logger.info(`✅ 預言 [ID: ${prediction.id}] 已結案並刻入記憶體。`);

    } catch (error) {
        logger.error(`❌ 覆盤發生錯誤: ${error.message}`);
    }
}

/**
 * 深夜覆盤主程式
 */
async function runNightReview() {
    logger.info('==================================================');
    logger.info('🦉 啟動深夜反身性覆盤作業 (Night Review)');
    logger.info('==================================================');

    // 從資料庫撈出狀態為 PENDING 且 target_date 已經到期的預言
    const duePredictions = db.getDuePredictions();

    if (!duePredictions || duePredictions.length === 0) {
        logger.info('🛌 今晚沒有需要開獎的預言，AI 繼續休息。');
        return;
    }

    logger.info(`🔍 發現 ${duePredictions.length} 筆到期的預言，準備開獎...`);

    for (const prediction of duePredictions) {
        await evaluatePrediction(prediction);
        // 延遲一下避免高頻率呼叫 LLM 導致機器過熱
        await new Promise(res => setTimeout(res, 5000));
    }

    logger.info('🏁 深夜覆盤作業全部完成！');
}

module.exports = { runNightReview };

// 支援直接在終端機執行測試: node services/night_review.js
if (require.main === module) {
    runNightReview();
}