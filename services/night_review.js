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

// 使用 OpenRouter Gemini-2.5-flash-lite 作為反思大腦
const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
const API_KEY = process.env.OPENROUTER_API_KEY;
const MODEL_NAME = 'google/gemini-2.5-flash-lite'; 

/**
 * 針對單一預言進行覆盤與檢討
 */
async function evaluatePrediction(prediction) {
    logger.info(`🦉 正在對預言 [ID: ${prediction.id} - ${prediction.symbol}] 進行開獎與覆盤...`);
    
    // 取得當前時間，賦予 AI 時間概念
    const timeString = new Date().toLocaleString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });

    let marketContext = '⚠️ 無法取得即時走勢與市場詳細數據';

    if (marketApi) {
        try {
            // 呼叫最新版 market_api.js 的 fetchStockTrend，獲取極度詳細的盤勢數據
            const stockData = await marketApi.fetchStockTrend(prediction.symbol);
            
            if (!stockData.error) {
                // 組合帶有成交量的近 10 日走勢
                const trendStr = (stockData.recentTrend || []).map(t => 
                    `${t.date}: 收盤價 ${t.close} (成交量: ${t.volume || '未知'})`
                ).join('\n');

                // 結合月線、本益比、52週高低點等深度數據
                marketContext = `
【目前市場最新狀態】
- 標的名稱：${stockData.name || prediction.symbol}
- 最新收盤價：${stockData.currentPrice || 'N/A'} (${stockData.changePercent || 'N/A'})
- 20日均價(月線)：${stockData.monthlyAvgPrice || 'N/A'}
- 本益比(PE)：${stockData.peRatio || 'N/A'}
- 52週高低點區間：${stockData.fiftyTwoWeekLow || 'N/A'} ~ ${stockData.fiftyTwoWeekHigh || 'N/A'}

【近 10 日實際量價走勢】：
${trendStr}
                `.trim();
            } else {
                marketContext = `⚠️ 獲取報價失敗: ${stockData.message}`;
            }
        } catch (e) {
            logger.warn(`⚠️ 無法取得 ${prediction.symbol} 的真實報價，將僅依賴文字覆盤`);
        }
    }

    // 針對新的資料庫欄位，取得當初的預測文字 (相容 prediction_text 或 reasoning)
    const originalPrediction = prediction.prediction_text || prediction.reasoning || '無紀錄';

    const reviewPrompt = `
現在時間是 ${timeString}。這是一週前你（AI 分析師）對【${prediction.symbol}】做出的分析預測。
請根據一週前你的預言，對比這幾天的實際量價走勢與目前的市場基本面數據，給出極度嚴格且客觀的「殘酷對帳與反省」。

【一週前的 AI 預測內容】：
${originalPrediction}

${marketContext}

請以繁體中文 (zh-TW)，給出一份詳細的量化檢討報告，必須包含以下結構與標題：
1. 🎯 預測準確度評分 (滿分 10 分，請嚴格評分，不可自我寬容)
2. 🔍 覆盤檢討 (當時看對或看錯的關鍵盲點在哪？市場是否發生了未預期的反轉？乖離率是否過大？)
3. 📈 現狀解讀與建議 (結合目前的月線、本益比與近期走勢，現在該標的處於什麼位階？建議停損、續抱還是加碼？)
4. 💡 經驗學習 (將這次的成功或失敗教訓，濃縮成一句深刻的交易法則)
    `;

    try {
        const response = await axios.post(OPENROUTER_URL, {
            model: MODEL_NAME,
            messages: [
                { role: 'system', content: '你是一位極度嚴格、不留情面的華爾街量化檢討專家與風控主管。' },
                { role: 'user', content: reviewPrompt }
            ],
            temperature: 0.3
        }, {
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'HTTP-Referer': 'https://github.com/charlie-ma-1729/stock-ai',
                'X-Title': 'IMA Wealth Discord Bot',
                'Content-Type': 'application/json'
            }
        });

        const lessonText = response.data.choices[0].message.content.trim();

        // 🌟 串接新版 db.js：將檢討結果化為向量 (Vector) 刻入神經網路記憶體，供未來 RAG 檢索
        if (typeof db.saveVectorMemory === 'function') {
            await db.saveVectorMemory(lessonText, { 
                predictionId: prediction.id, 
                symbol: prediction.symbol,
                type: 'night_review_lesson',
                score_extracted: 'Auto-Evaluated'
            });
            logger.info(`🧠 預言 [ID: ${prediction.id}] 的教訓已刻入 Vectra 向量神經網。`);
        } else {
            logger.warn('⚠️ 找不到 db.saveVectorMemory 函數，跳過向量記憶庫寫入。');
        }

        // 標記為已覆盤
        db.markPredictionEvaluated(prediction.id);
        logger.info(`✅ 預言 [ID: ${prediction.id}] 已結案。`);

        return lessonText;

    } catch (error) {
        if (error.response) {
            logger.error(`❌ 覆盤 API 錯誤: ${JSON.stringify(error.response.data)}`);
        } else {
            logger.error(`❌ 覆盤發生錯誤: ${error.message}`);
        }
        return `⚠️ 針對 ${prediction.symbol} 的覆盤因系統連線異常而失敗。`;
    }
}

/**
 * 執行每週的夜間自動覆盤程序
 */
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

    let finalDiscordReport = `## 🦉 AI 深夜殘酷對帳與覆盤報告\n今晚共有 **${duePredictions.length}** 筆一週前的分析報告到期，以下是 AI 結合最新市場數據的自我反省：\n\n`;

    for (const prediction of duePredictions) {
        const reviewContent = await evaluatePrediction(prediction);
        
        finalDiscordReport += `### 🏷️ 覆盤標的：【${prediction.symbol}】 (預言單號 #${prediction.id})\n`;
        finalDiscordReport += `${reviewContent}\n\n`;
        finalDiscordReport += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

        // 避免打 API 頻率過高觸發 Rate Limit，暫停 4 秒
        await new Promise(res => setTimeout(res, 4000));
    }

    return finalDiscordReport;
}

module.exports = { runWeeklyReview };