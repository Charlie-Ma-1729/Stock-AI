#!/bin/bash

# setup_ubuntu.sh
# 此腳本用於在 Ubuntu 系統上自動安裝 Node.js 環境與 Playwright 網頁爬蟲所需的系統依賴套件

echo "=========================================="
echo "    開始設定政府採購網爬蟲的 Ubuntu 環境"
echo "=========================================="

# 1. 確保系統更新
echo "[1/4] 更新系統套件清單..."
sudo apt-get update -y

# 2. 如果尚未安裝 Node.js 與 npm，則進行安裝 (安裝 Node.js 18.x)
if ! command -v node &> /dev/null; then
    echo "[2/4] Node.js 未安裝。正在安裝 Node.js 18.x..."
    curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash -
    sudo apt-get install -y nodejs
else
    echo "[2/4] Node.js 已安裝: $(node -v)"
fi

# 3. 安裝 NPM 依賴套件
echo "[3/4] 正在安裝 / 更新專案 npm 套件..."
npm install

# 4. 安裝 Playwright 所需的系統依賴套件 (Chromium 環境)
echo "[4/4] 正在安 Playwright 需要的作業系統與瀏覽器依賴庫 (需系統管理員權限)..."
npx playwright install chromium --with-deps

echo "=========================================="
echo "   設定完畢！您現在可以直接執行爬蟲腳本"
echo "   使用指令: npm run start:ubuntu"
echo "=========================================="
