const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// 查詢的廠商清單
const COMPANIES = ['大同股份有限公司', '大同智能股份有限公司'];
const OUTPUT_DIR = path.join(__dirname, 'output');
const HISTORY_FILE = path.join(OUTPUT_DIR, 'history.json');

// 確保輸出目錄存在
if (!fs.existsSync(OUTPUT_DIR)) {
    fs.mkdirSync(OUTPUT_DIR);
}

// 取得西元年份字串 (格式: 2026/03/26)
function getWesternDateString(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${year}/${month}/${day}`;
}

// 載入歷史紀錄
function loadHistory() {
    if (fs.existsSync(HISTORY_FILE)) {
        try {
            return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
        } catch (e) {
            return [];
        }
    }
    return [];
}

// 儲存歷史紀錄
function saveHistory(historyArray) {
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(historyArray, null, 2), 'utf8');
}

// 輔助函式：等候指定毫秒數 (Puppeteer 20+ 已移除 waitForTimeout)
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

async function run() {
    console.log('啟動 Puppeteer 瀏覽器中...');
    // 自動判斷是否使用無頭模式
    const isHeadless = process.env.HEADLESS === 'true' || process.platform === 'linux' ? 'new' : false;
    
    const browser = await puppeteer.launch({ 
        headless: isHeadless,
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    const page = await browser.newPage();

    let history = loadHistory();

    const today = new Date();
    const threeMonthsAgo = new Date();
    threeMonthsAgo.setMonth(today.getMonth() - 3);
    const startDateStr = getWesternDateString(threeMonthsAgo);
    const endDateStr = getWesternDateString(today);

    for (const company of COMPANIES) {
        console.log(`\n================================`);
        console.log(`準備查詢廠商：${company}`);
        console.log(`- 決標公告日期: ${startDateStr} ~ ${endDateStr}`);
        console.log(`================================\n`);

        const params = new URLSearchParams({
            pageSize: '',
            firstSearch: 'false',
            isQuery: '',
            isBinding: 'N',
            isLogIn: 'N',
            orgName: '',
            orgId: '',
            tenderName: '',
            tenderId: '',
            tenderStatus: 'TENDER_STATUS_1',
            tenderWay: 'TENDER_WAY_ALL_DECLARATION',
            awardAnnounceStartDate: startDateStr,
            awardAnnounceEndDate: endDateStr,
            radProctrgCate: '',
            tenderRange: 'TENDER_RANGE_ALL',
            minBudget: '',
            maxBudget: '',
            item: '',
            gottenVendorName: company,
            gottenVendorId: '',
            submitVendorName: '',
            submitVendorId: '',
            execLocation: '',
            priorityCate: '',
            radReConstruct: '',
            policyAdvocacy: '',
            isCpp: ''
        });

        const searchUrl = `https://web.pcc.gov.tw/prkms/tender/common/agent/readTenderAgent?${params.toString()}`;
        console.log('直接前往搜尋結果網址等待畫面載入...');
        await page.goto(searchUrl, { waitUntil: 'domcontentloaded' });
        
        // 尋找是否包含搜尋結果表格
        try {
            await page.waitForSelector('#atm', { timeout: 10000 });
            console.log('\n成功載入查詢結果！開始自動爬取每筆紀錄...');
        } catch (e) {
            console.log(`\n未找到符合的決標公告表格。代表這三個月內沒有資料，前往下一家廠商...`);
            continue;
        }

        let hasNextPage = true;
        let pageCount = 1;

        while (hasNextPage) {
            await delay(2000); 
            
            // 從這頁的表格中抓取決標公告的專屬連結
            const hrefs = await page.$$eval('#atm tbody tr', rows => {
                const links = [];
                rows.forEach(row => {
                    const anchors = Array.from(row.querySelectorAll('a[href*="urlSelector/common/atm"]'));
                    if (anchors.length > 0) {
                        links.push(anchors[0].href);
                    }
                });
                return links;
            });
            
            const uniqueHrefs = Array.from(new Set(hrefs));
            console.log(`  -> 第 ${pageCount} 頁共找到 ${uniqueHrefs.length} 筆不重複的標案連結`);

            for (const href of uniqueHrefs) {
                let recordId = '';
                try {
                    const u = new URL(href);
                    recordId = u.searchParams.get('pk') || Buffer.from(href).toString('base64').substring(0, 20);
                } catch {
                    recordId = encodeURIComponent(href).substring(0, 20);
                }
                
                if (history.includes(recordId)) {
                    console.log(`  -> 自動跳過已抓取過的標案 [ ID: ${recordId} ]`);
                    continue;
                }

                console.log(`處理新標案 [ ID: ${recordId} ]，進入決標公告詳細頁面...`);
                
                const detailPage = await browser.newPage();
                try {
                    detailPage.on('dialog', async dialog => await dialog.accept());
                    
                    // 攔截並略過原生的系統列印呼叫
                    await detailPage.evaluateOnNewDocument(() => {
                        window.print = () => console.log('Bypassed window.print');
                    });

                    await detailPage.goto(href, { waitUntil: 'domcontentloaded' });
                    await delay(1500);

                    console.log('    -> 準備抓取內容...');
                    
                    let textContent = '';
                    let popupPage = null;
                    
                    // Puppeteer 尋找按鈕 (使用 evaluate 較為彈性)
                    const printBtnExists = await detailPage.evaluate(() => {
                        const selectors = ['input[value*="列印"]', 'button', 'a', 'img[alt*="列印"]'];
                        for (const s of selectors) {
                            const els = Array.from(document.querySelectorAll(s));
                            const target = els.find(el => (el.value || el.innerText || el.alt || el.title || '').includes('列印'));
                            if (target) {
                                // @ts-ignore
                                target.id = 'target_print_btn';
                                return true;
                            }
                        }
                        return false;
                    });
                    
                    if (printBtnExists) {
                        try {
                            console.log('    -> 點擊列印按鈕，等待彈出視窗...');
                            // 監聽新視窗
                            const popupTargetPromise = new Promise(x => browser.once('targetcreated', target => x(target)));
                            
                            await detailPage.click('#target_print_btn');
                            
                            const popupTarget = await popupTargetPromise;
                            popupPage = await popupTarget.page();
                            
                            if (popupPage) {
                                await popupPage.evaluateOnNewDocument(() => {
                                    window.print = () => console.log('Bypassed window.print');
                                });
                                await popupPage.waitForSelector('body', { timeout: 8000 });
                                await delay(1500);
                            }
                        } catch (e) {
                            console.log('    !! 等待彈出視窗失敗，改為從原頁面抓取...');
                        }
                    }
                    
                    const targetPage = popupPage || detailPage;
                    
                    // 嘗試抓取特定區域
                    textContent = await targetPage.evaluate(() => {
                        const area = document.querySelector('#printArea');
                        return area ? (area.innerText || area.textContent) : document.body.innerText;
                    });
                    
                    const safeCompanyName = company.replace(/[^a-zA-Z0-9\u4e00-\u9fa5]/g, '');
                    const fileName = `${safeCompanyName}_決標紀錄_${recordId}.txt`;
                    
                    fs.writeFileSync(path.join(OUTPUT_DIR, fileName), textContent, 'utf8');
                    console.log(`    => 儲存成功：${fileName}`);
                    
                    history.push(recordId);
                    saveHistory(history);
                    
                    if (popupPage) await popupPage.close();
                } catch (err) {
                    console.error(`    !! 處理時發生錯誤：${err.name} - ${err.message}`);
                } finally {
                    await detailPage.close();
                }
            }
            
            // 下一頁推動 (使用 Puppeteer 式選擇器與點擊)
            const nextBtnExists = await page.evaluate(() => {
                const anchors = Array.from(document.querySelectorAll('a'));
                const next = anchors.find(a => (a.innerText || '').includes('下一頁'));
                if (next) {
                    // @ts-ignore
                    next.id = 'pcc_next_page_btn';
                    return true;
                }
                return false;
            });

            if (nextBtnExists) {
                console.log('\n👉 前往下一頁...\n');
                await Promise.all([
                    page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
                    page.click('#pcc_next_page_btn')
                ]);
                pageCount++;
            } else {
                hasNextPage = false;
                console.log(`👍 廠商 [${company}] 該區間所有決標紀錄爬取完成！\n`);
            }
        }
    }

    console.log('🎉 === 全部爬取作業完畢 === 🎉');
    await browser.close();
}

run().catch(err => {
    console.error('=== 發生未捕獲的錯誤 ===');
    console.error(err);
    process.exit(1);
});
