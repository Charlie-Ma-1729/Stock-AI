# Stock-AI: 台灣標案與法說會自動化爬蟲

本專案包含兩個主要的自動化爬蟲工具，用於抓取政府電子採購網（PCC）的決標紀錄以及公開資訊觀測站（MOPS）的法說會簡報。

## 專案結構

- `pcc_scraper/index.js`: PCC 決標公告爬蟲（使用 Puppeteer）。
- `pcc_scraper/mops_scraper.js`: MOPS 法說會簡報爬蟲（使用 Puppeteer 與 pdf-parse）。
- `pcc_scraper/output/`: PCC 爬蟲的抓取結果儲存目錄。
- `pcc_scraper/downloads/`: MOPS 爬蟲的 PDF 檔案與文字提取結果儲存目錄。
- `pcc_scraper/setup_ubuntu.sh`: 在 Ubuntu 伺服器上部署環境的腳本。

## 環境安裝

確保您的環境已安裝 Node.js (建議 v18+)。

1. 安裝專案依賴：
   ```bash
   npm run install:all
   ```
2. 本專案統一使用 **Puppeteer**，無需額外安裝 Playwright。

## 使用說明

您可以在專案根目錄直接執行以下命令：

### 1. PCC 決標公告爬蟲

此工具會根據預設的廠商清單，抓取過去三個月內的決標紀錄。

- **工作目錄執行**:
  ```bash
  npm run pcc
  ```
- **伺服器執行 (無頭模式)**:
  ```bash
  npm run pcc:ubuntu
  ```

### 2. MOPS 法說會簡報爬蟲

此工具會抓取指定公司的法說會簡報，並自動將 PDF 轉成純文字。

- **執行命令**:
  ```bash
  npm run mops
  ```

---

## 部署至 Ubuntu

如果您要在 Linux 伺服器（如 Ubuntu）上執行，可以使用提供的部署腳本：

```bash
cd pcc_scraper
chmod +x setup_ubuntu.sh
./setup_ubuntu.sh
```
此腳本會自動安裝必要的套件、Node.js 以及相依的系統函式庫。
