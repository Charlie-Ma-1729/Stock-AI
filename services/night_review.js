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
    let stockName = prediction.symbol;

    if (marketApi) {
        // 嘗試從字典反查名稱
        const pureSym = prediction.symbol.replace(/\.TW|\.TWO/gi, '');
        if (marketApi.stockLookupMap && marketApi.stockLookupMap[pureSym]) {
            stockName = marketApi.stockLookupMap[pureSym];
        }

        try {
            // 呼叫最新版 market_api.js 的 fetchStockTrend，獲取盤勢數據
            const stockData = await marketApi.fetchStockTrend(prediction.symbol);
            
            if (!stockData.error) {
                stockName = stockData.name || stockName; // 確保拿到最正確的中文名稱

                // 組合帶有成交量的近 5 日走勢 (縮短篇幅，不需要看到 10 天)
                const trendStr = (stockData.recentTrend || []).slice(-5).map(t => 
                    `${t.date}: 收 ${t.close}`
                ).join('\n');

                // 結合月線、本益比等深度數據，精簡化提供給 AI
                marketContext = `
【最新市場數據】
- 現價：${stockData.price || stockData.currentPrice} (${stockData.changePercent})
- 月線(20MA)：${stockData.monthlyAvgPrice}
- 近 5 日走勢：
${trendStr}
                `.trim();
            } else {
                marketContext = `⚠️ 獲取報價失敗: ${stockData.message}`;
            }
        } catch (e) {
            logger.warn(`⚠️ 無法取得 ${prediction.symbol} 的真實報價，將僅依賴文字覆盤`);
        }
    }

    // 取得當初的預測文字
    const originalPrediction = prediction.prediction_text || prediction.reasoning || '無紀錄';

    // 🌟 核心修改：嚴格限制字數，強制 AI 只講重點
    const reviewPrompt = `
時間：${timeString}。這是一週前你對【${stockName} (${prediction.symbol})】做出的投資建議。

【一週前的 AI 建議】：
${originalPrediction}

${marketContext}

請以「繁體中文」給出一份極度精簡的「殘酷覆盤」(總字數嚴格控制在 150 字以內)，請直接輸出以下四點，不要廢話：
1. 🎯 評分：(1-10分，嚴格評分)
2. 🔍 檢討：(一句話點出當時看對或看錯的關鍵)
3. 📈 建議：(現階該停損、續抱還是加碼？)
4. 💡 教訓：(一句話總結經驗)
    `;

    try {
        const response = await axios.post(OPENROUTER_URL, {
            model: MODEL_NAME,
            messages: [
                { role: 'system', content: '你是一位講話極度精簡、一針見血的華爾街量化檢討專家與風控主管。' },
                { role: 'user', content: reviewPrompt }
            ],
            temperature: 0.2 // 調低溫度讓 AI 回答更具體、不發散
        }, {
            headers: {
                'Authorization': `Bearer ${API_KEY}`,
                'HTTP-Referer': 'https://github.com/charlie-ma-1729/stock-ai',
                'X-Title': 'IMA Wealth Discord Bot',
                'Content-Type': 'application/json'
            }
        });

        const lessonText = response.data.choices[0].message.content.trim();

        // 串接新版 db.js：將檢討結果化為向量 (Vector) 刻入神經網路記憶體
        if (typeof db.saveVectorMemory === 'function') {
            await db.saveVectorMemory(lessonText, { 
                predictionId: prediction.id, 
                symbol: prediction.symbol,
                name: stockName,
                type: 'night_review_lesson',
                score_extracted: 'Auto-Evaluated'
            });
            logger.info(`🧠 預言 [ID: ${prediction.id}] 的教訓已刻入 Vectra 向量神經網。`);
        }

        // 標記為已覆盤
        db.markPredictionEvaluated(prediction.id);
        logger.info(`✅ 預言 [ID: ${prediction.id} - ${stockName}] 已結案。`);

        // 回傳前包裝好標題，確保 Discord 輸出美觀且有明確股名
        return `### 🏷️ 覆盤標的：【${stockName} (${prediction.symbol})】\n${lessonText}`;

    } catch (error) {
        if (error.response) {
            logger.error(`❌ 覆盤 API 錯誤: ${JSON.stringify(error.response.data)}`);
        } else {
            logger.error(`❌ 覆盤發生錯誤: ${error.message}`);
        }
        return `### 🏷️ 覆盤標的：【${stockName} (${prediction.symbol})】\n⚠️ 覆盤因系統連線異常而失敗。`;
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

    let finalDiscordReport = `## 🦉 AI 深夜殘酷對帳與覆盤報告\n今晚共有 **${duePredictions.length}** 筆一週前的分析報告到期，以下是 AI 結合最新市場數據的精簡反省：\n\n`;

    for (const prediction of duePredictions) {
        // 取得已經包裝好標題與股名的覆盤內容
        const reviewContent = await evaluatePrediction(prediction);
        
        finalDiscordReport += `${reviewContent}\n`;
        finalDiscordReport += `━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n\n`;

        // 避免打 API 頻率過高觸發 Rate Limit，暫停 4 秒
        await new Promise(res => setTimeout(res, 4000));
    }

    return finalDiscordReport;
}

module.exports = { runWeeklyReview };