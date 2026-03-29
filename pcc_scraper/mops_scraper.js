const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const { PDFParse } = require('pdf-parse');
const https = require('https');

(async () => {
    const downloadDir = path.resolve(__dirname, 'downloads');
    if (!fs.existsSync(downloadDir)) {
        fs.mkdirSync(downloadDir);
    }

    console.log('啟動 Puppeteer (無頭模式)...');
    const browser = await puppeteer.launch({ 
        headless: 'new',
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    
    // Set up download behavior
    const page = await browser.newPage();
    const client = await page.target().createCDPSession();
    await client.send('Page.setDownloadBehavior', {
        behavior: 'allow',
        downloadPath: downloadDir
    });

    // 使用 mopsov (Legacy) 網域確保舊版頁面完整可用，並繞開新版 Vue 的 Bug
    console.log('進入公開資訊觀測站 (MOPS) 舊版法說會頁面...');
    await page.goto('https://mopsov.twse.com.tw/mops/web/t100sb07_1', { waitUntil: 'domcontentloaded' });

    console.log('輸入公司代號 2371 並點擊查詢...');
    await page.waitForSelector('#co_id', { visible: true });
    
    await page.evaluate(() => { 
        document.querySelector('#co_id').value = '2371';
        // 在有些沒資料的情況下，為了示範我們也要搜尋年份？大同 2371 只有 112 年有資料
        const yearInput = document.querySelector('#year');
        if (yearInput) yearInput.value = '112'; // 強制抓取 112 年度，否則預設 114 年會是空的
        
        const searchBtn = Array.from(document.querySelectorAll('input[type="button"], button'))
            .find(el => (el.value || el.innerText || '').includes('查詢'));
        if (searchBtn) searchBtn.click();
    });

    console.log('等待查詢結果表格載入...');
    try {
        await page.waitForSelector('table.hasBorder', { timeout: 15000 });
    } catch(e) {
        console.log('未找到結果表格，可能是載入較慢或該公司近期無資料。');
        await browser.close();
        return;
    }

    console.log('尋找 PDF 下載網址...');
    let pdfUrl = null;
    const pdfLinks = await page.$$('a[href*=".pdf"], a[href*=".PDF"]');
    if (pdfLinks.length > 0) {
        pdfUrl = await page.evaluate(el => el.href, pdfLinks[0]);
    } else {
        console.log('未找到 PDF 連結，可能該場法說會沒有提供檔案。');
        await browser.close();
        return;
    }

    // 從 URL 提取檔名以作為唯一識別
    const urlParts = pdfUrl.split('/');
    const remoteFileName = urlParts[urlParts.length - 1];
    const fileName = `2371_法說會簡報_${remoteFileName}`;
    const destPath = path.join(downloadDir, fileName);
    const txtPath = destPath.replace('.pdf', '.txt');

    if (fs.existsSync(destPath)) {
        console.log(`檔案已存在 (跳過下載): ${destPath}`);
        // 檢查是否需要重新提取文字
        if (!fs.existsSync(txtPath)) {
            console.log('但文字檔不存在，將重新執行提取文字模式...');
        } else {
            console.log('文字檔也已存在，任務完成！');
            await browser.close();
            return;
        }
    } else {
        console.log('開始下載 PDF 檔案...');
        
        const downloadPdf = (url, dest) => new Promise((resolve, reject) => {
            const file = fs.createWriteStream(dest);
            https.get(url, response => {
                if (response.statusCode === 200) {
                    response.pipe(file);
                } else {
                    reject(new Error(`下載失敗，狀態碼: ${response.statusCode}`));
                }
            }).on('error', err => {
                fs.unlink(dest, () => reject(err));
            });
            file.on('finish', () => {
                file.close(resolve);
            });
            file.on('error', err => {
                fs.unlink(dest, () => reject(err));
            });
        });

        try {
            await downloadPdf(pdfUrl, destPath);
            console.log(`下載完成，已存至: ${destPath}`);
        } catch (e) {
            console.error('下載過程發生錯誤:', e);
            await browser.close();
            return;
        }
    }

    console.log(`開始從 PDF 提取文字 (檔案大小: ${fs.statSync(destPath).size} bytes)...`);
    try {
        const dataBuffer = fs.readFileSync(destPath);
        console.log('正在呼叫 PDFParse...');
        const parser = new PDFParse({ data: dataBuffer });
        const result = await parser.getText();
        await parser.destroy();
        console.log('PDFParse 執行成功！');

        const txtPath = destPath.replace('.pdf', '.txt');
        fs.writeFileSync(txtPath, result.text, 'utf8');
        console.log(`文字提取大功告成！檔案已存至: ${txtPath}`);
    } catch (e) {
        console.error('解析 PDF 發生錯誤:', e);
    }

    await browser.close();
    console.log('🎉 爬蟲腳本執行完畢！');
})();
