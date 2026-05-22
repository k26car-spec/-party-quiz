# 部署到 Railway

## 步驟

1. 前往 https://railway.app 註冊（用 GitHub 登入最快）

2. 點 **New Project → Deploy from GitHub repo**
   - 先把 party-quiz 資料夾 push 到你的 GitHub（或用 Railway CLI）

3. Railway 會自動偵測 Node.js，直接點 **Deploy**

4. 部署完成後，Railway 會給你一個網址，例如：
   `https://party-quiz-xxxx.up.railway.app`

5. 把這個網址貼到主持人後台的 QR Code 就會自動更新

## 三個頁面

| 頁面       | 網址                   | 用途           |
|-----------|------------------------|---------------|
| 玩家手機   | `你的網址/`            | 掃 QR Code 進入 |
| 主持人後台 | `你的網址/host.html`   | 輸入題目、控制遊戲 |
| 大螢幕     | `你的網址/screen.html` | 投影到大螢幕    |

## 活動前準備

1. 打開 `/host.html` 輸入題目，按「儲存並更新」
2. 打開 `/screen.html` 投影到大螢幕
3. 讓大家掃 QR Code 或輸入網址加入
4. 人數到齊後按「▶ 開始遊戲」
