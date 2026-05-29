const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const fs = require('fs');

// 定義要抓取的市場：2=上市, 4=上櫃 (若需要興櫃可再加 5)
const TARGET_MODES = [
    { mode: 2, name: '上市' },
    { mode: 4, name: '上櫃' },
    { mode: 5, name: '興櫃' }
];

async function updateTwseDict() {
    console.log('🔄 開始連線證交所，更新台股與ETF字典...');
    const dict = {};
    let totalCount = 0;

    try {
        for (const target of TARGET_MODES) {
            console.log(`📥 正在下載 [${target.name}] 證券名單...`);
            const url = `https://isin.twse.com.tw/isin/C_public.jsp?strMode=${target.mode}`;
            
            // 必須設定 responseType 為 arraybuffer 才能正確解碼 Big5
            const response = await axios.get(url, { responseType: 'arraybuffer' });
            const html = iconv.decode(response.data, 'big5');
            const $ = cheerio.load(html);

            let count = 0;

            // 走訪每一行 <tr>
            $('table.h4 tr').each((i, el) => {
                const tds = $(el).find('td');
                
                // 確認是有效的資料列
                if (tds.length >= 6) {
                    const cfiCode = $(tds[5]).text().trim();
                    
                    // 【精準過濾】：只要股票 (ES開頭) 與 ETF (CE開頭)
                    if (cfiCode.startsWith('ES') || cfiCode.startsWith('CE')) {
                        const rawText = $(tds[0]).text().trim();
                        
                        // 利用正則分離代號與名稱
                        const match = rawText.match(/^([a-zA-Z0-9]+)[\s\u3000]+(.*)$/);
                        if (match) {
                            const symbol = match[1];
                            const name = match[2];
                            dict[symbol] = name;
                            count++;
                            totalCount++;
                        }
                    }
                }
            });
            console.log(`✅ [${target.name}] 處理完成，共抓取 ${count} 檔。`);
        }

        // 寫入 JSON 字典檔
        fs.writeFileSync('tw_stocks.json', JSON.stringify(dict, null, 2), 'utf8');
        console.log(`🎉 雙市場字典更新完畢！總計 ${totalCount} 檔台股與ETF，已儲存至 tw_stocks.json`);
        
    } catch (error) {
        console.error('❌ 更新字典發生致命錯誤:', error.message);
    }
}

// 執行
updateTwseDict();