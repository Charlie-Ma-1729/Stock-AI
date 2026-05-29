const marketApi = require('./services/market_api');

async function testMarketData() {
    console.log('🔍 開始測試市場數據獲取能力...');
    console.log('-----------------------------------');
    
    // 參數設定 true, true 代表「要抓三大法人」且「要抓台股即時三雄」
    const data = await marketApi.getMarketSnapshot(true, true);
    
    console.log(JSON.stringify(data, null, 2));
    console.log('-----------------------------------');
    console.log('✅ 如果上面有出現台積電(2330)的價格、道瓊指數，以及三大法人買賣超，代表你的市場 API 運作完美！');
}

testMarketData();