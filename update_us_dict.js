const axios = require('axios');
const fs = require('fs');

async function updateUsDict() {
    console.log('🔄 開始連線 NASDAQ FTP，更新美股字典...');
    const dict = {};
    let count = 0;

    try {
        // 1. 抓取 NASDAQ 上市清單 (蘋果、輝達、微軟等)
        console.log('📥 抓取 NASDAQ 清單...');
        const nasdaqRes = await axios.get('https://www.nasdaqtrader.com/dynamic/symdir/nasdaqlisted.txt');
        const nasdaqLines = nasdaqRes.data.split('\n');
        
        for (let i = 1; i < nasdaqLines.length; i++) {
            const cols = nasdaqLines[i].trim().split('|');
            // 欄位3是 Test Issue，'N' 代表正常交易的股票，排除測試用代號
            if (cols.length >= 7 && cols[3] === 'N') { 
                dict[cols[0]] = cols[1];
                count++;
            }
        }

        // 2. 抓取 NYSE, AMEX 等其他上市清單 (台積電ADR、傳統產業巨頭等)
        console.log('📥 抓取 NYSE/AMEX 清單...');
        const otherRes = await axios.get('https://www.nasdaqtrader.com/dynamic/symdir/otherlisted.txt');
        const otherLines = otherRes.data.split('\n');
        
        for (let i = 1; i < otherLines.length; i++) {
            const cols = otherLines[i].trim().split('|');
            // 欄位6是 Test Issue
            if (cols.length >= 7 && cols[6] === 'N') { 
                dict[cols[0]] = cols[1];
                count++;
            }
        }

        // 3. 寫入 JSON 字典檔
        fs.writeFileSync('us_stocks.json', JSON.stringify(dict, null, 2), 'utf8');
        console.log(`✅ 美股字典更新完成！共萃取出 ${count} 檔美股與ETF，已儲存至 us_stocks.json`);

    } catch (error) {
        console.error('❌ 更新美股字典失敗:', error.message);
    }
}

// 執行
updateUsDict();