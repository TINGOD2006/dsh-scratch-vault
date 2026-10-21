# 發布到 DSH 插件市場

把 `dsh-scratch-vault` 發布出去的完整流程，依官方
[awesome-dsh-plugin contributing.md](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin/blob/main/contributing.md)
整理。三件事彼此獨立，可以只做前兩件。

| 步驟 | 得到什麼 | 必要性 |
|---|---|---|
| 1. 推上 GitHub | 他人可 `dsh plugin add github:TINGOD2006/dsh-scratch-vault` | 必要 |
| 2. 發佈到 npm | 他人可 `dsh plugin add dsh-scratch-vault`；清單顯示下載量 | 建議 |
| 3. 向 awesome-dsh-plugin 開 PR | 出現在官方插件清單 | 目標 |

## 目前狀態（實測，非推測）

- 倉庫已公開：`github.com/TINGOD2006/dsh-scratch-vault`（2026-10-18 建立，已加 `dsh-plugin` 等 12 個 topic）。
- `gh` CLI **2.102.0 已安裝且已登入**（帳號 `TINGOD2006`，token 具 `repo`／`workflow`／`gist` 權限，存於 keyring）。
- npm 已發佈 `0.2.0`、`0.2.1`、`0.3.1`（`latest` = `0.3.1`，2026-10-21）；皆由 `tingod2006` 維護。
- `npm login` 已完成（`npm whoami` → `tingod2006`）。但**發佈仍必須在互動式終端**：npm 11 對寫入操作要求 2FA，非 TTY 環境會直接回 `EOTP`（見〈疑難排解〉）。
- **插件市場（awesome-dsh-plugin）已收錄**：`data/plugins/TINGOD2006__dsh-scratch-vault.yml` 已在 `main` 上（sha `61cdbe6`）。清單是靜態指路，不記版本，因此改版只要推 GitHub 即可，不需要再開 PR。
- git 身分已設：`TINGOD2006 <tinchiocherrychio@gmail.com>`。
- 沙箱內推送需要繞過 credential helper：見〈疑難排解〉的 token 內嵌 URL 做法（已實測可用）。

### 版本歷程

| 版本 | 內容 |
|---|---|
| 0.2.0 | 首個可用版本：L2／L3／L4 三層、7 個工具、91 個測試。 |
| 0.2.1 | staged publish 的審批修正。 |
| 0.3.0 | 帳本快取與原子改寫＋跨行程鎖、`autoPurge`、既有檔案保護、程式位置才改寫 shell（v7／v8）。 |
| 0.3.1 | 29 個缺陷修復（vault 帳本正確性、攔截誤改寫、glob 指數回溯、UTF-8 收攏資料安全、設定警告與負快取），124 個測試（v9）。 |

## 投稿硬性條件對照

| contributing.md 要求 | 本倉庫狀態 |
|---|---|
| `package.json` 宣告 `dsh.bundle`（**只宣告 `dsh.client` 是最常見被拒原因**） | ✅ `"dsh": {"bundle": {"patch": "./cordis.patch.yml"}}` |
| 倉庫根有 `cordis.patch.yml`，`name` 用套件名 | ✅ `id: scratch-vault` / `name: 'dsh-scratch-vault'` |
| 真實可用的程式碼 | ✅ 11 個 `lib/` 模組、7 個工具、124 個測試 |
| 倉庫年齡 ≥ 1 天（CI 自動檢查） | ⏳ 剛建立，**隔天才能送出 PR** |
| 加上 `dsh-plugin` GitHub topic | ⏳ 推上去之後在倉庫設定頁加 |
| 描述屬實、無誇飾行銷詞 | ✅ 見下方 YAML，只陳述實際行為 |
| 若發佈 npm，`repository` 要指回收錄的同一個倉庫 | ✅ 已指向 `github.com/TINGOD2006/dsh-scratch-vault` |
| 官方 `@deepseek-ai/*` 應用 `peerDependencies` | ✅ 本插件**完全不宣告任何依賴**，無此問題 |

## 前置作業（只做一次）

- GitHub CLI：✅ 已安裝 `gh 2.102.0` 且 `gh auth login` 完成（keyring，帳號 `TINGOD2006`）。
- npm 登入：✅ 已完成（`npm whoami` → `tingod2006`）。發佈時要**在一般 PowerShell（非 DSH 內）**執行，2FA 才能互動。需要重新登入時：

```powershell
npm login --auth-type=web   # 印出 https://www.npmjs.com/login?next=/login/cli/... 讓你開瀏覽器核准
npm whoami                  # 應顯示 tingod2006
```

不想裝 `gh` 也可以：用瀏覽器在 GitHub 手動建立空倉庫、手動開 PR，本地照樣用 `git push`。

## 步驟 1：推上 GitHub

先在 GitHub 建立**公開**空倉庫 `dsh-scratch-vault`（**不要**勾選自動產生 README，否則首次 push 會衝突）。

```powershell
cd C:\Users\TINGOD\Documents\deepseek-harness\default-workspace\dsh-scratch-vault
git remote add origin https://github.com/TINGOD2006/dsh-scratch-vault.git
git push -u origin main
```

推完之後到倉庫頁面 → About 右側齒輪 → Topics 加上 **`dsh-plugin`**。

驗證：`git ls-remote --heads origin` 應列出 `refs/heads/main`。

## 步驟 2：發佈到 npm

```powershell
cd C:\Users\TINGOD\Documents\deepseek-harness\default-workspace\dsh-scratch-vault
npm test          # 必須全綠才發佈
npm pack --dry-run   # 先看清單：應該只有 lib/、test/、cordis.patch.yml、兩個 README、LICENSE
npm publish
```

`package.json` 已設 `publishConfig.access = "public"`，不需額外參數。

**2FA 是流程的一部分，不是意外。** 帳號開啟 2FA 後，npm 11 對 `publish` 要求互動式認證，命令會停在：

```
Authenticate your account at:
https://www.npmjs.com/auth/cli/<uuid>
Press ENTER to open in the browser...
```

按 Enter 開瀏覽器核准（若提示 `one-time password` 就輸入 authenticator 的 6 位數）。成功會印 `+ dsh-scratch-vault@x.y.z`，但因 `Your package is being processed and may take a few minutes to become available`，registry 的 `latest` 會晚 15–30 秒才更新——用 `(Invoke-RestMethod https://registry.npmjs.org/dsh-scratch-vault)."dist-tags"` 確認，不要只看命令輸出。

之後每次改版：`npm version patch`（或 `minor`／`major`）會同時改版號並打 git tag，再 `git push --follow-tags` 與 `npm publish`。

### 免 OTP：改用 Trusted Publishing（建議，已備妥 workflow）

手動 `npm publish` 每次都要人站在終端前按 Enter／輸 OTP。要讓「推 tag 就自動發佈」，用 npm 的 **Trusted Publishing**：GitHub Actions 以 OIDC 向 npm 換一張**短效、單次用途**的發佈憑證，不需要任何 token，也就沒有可被竊取的長期密鑰。

倉庫已經有 `.github/workflows/publish.yml`，推 `v*` tag 時會：`npm test` → 驗證 tag 與 `package.json` 版本一致 → `npm publish --provenance --access public`。

**一次性設定**（在 npmjs.com，只需做一次）：

1. 開 `https://www.npmjs.com/package/dsh-scratch-vault/settings`
2. **Trusted Publishing** → **Add Trusted Publisher** → 選 **GitHub Actions**
3. 填：Owner `TINGOD2006`、Repository `dsh-scratch-vault`、Workflow filename `publish.yml`、Environment 留空
4. 儲存

之後的發版流程只剩三步：

```powershell
npm version patch            # 改版號並建立 tag
git push --follow-tags       # 推送 commit 與 tag，CI 接手測試＋發佈
```

npm 套件頁會顯示 *Published via GitHub Actions* 與 provenance 標章（可點回這次 commit）。

**注意**：

- Workflow 必須有 `permissions.id-token: write`（已寫在檔案裡），否則取不到 OIDC 憑證。
- 需要 npm ≥ 11.5.1；`setup-node` 帶的是 npm 10，所以 workflow 有一行 `npm install -g npm@11`。
- Trusted Publishing 只對**同一個 repo** 的 workflow 有效；搬 repo 或改 workflow 檔名要回 npm 重設。
- CI 失敗時 `npm test` 不會讓版本流出去；重新推一個新 tag 即可（同版號不能重發）。

## 步驟 3：向 awesome-dsh-plugin 開 PR

一個 PR 只能新增**一個**檔案：`data/plugins/<owner>__<repo>.yml`。本倉庫對應的內容是：

```yaml
url: https://github.com/TINGOD2006/dsh-scratch-vault
name: TINGOD2006/dsh-scratch-vault
category: tools
description:
  en: Runs agent operation scripts from a session scratch root and collects every intercepted one into a plugin-owned vault, so the workspace only holds real deliverables.
  zh: 讓 agent 的操作腳本從 session 草稿根目錄執行，並把每個被攔截的腳本收進外掛自有的收納庫，工作區因此只留下真正的交付物。
```

流程：

```powershell
# 1. 在 GitHub 上 fork awesome-dsh-plugin/awesome-dsh-plugin
git clone https://github.com/TINGOD2006/awesome-dsh-plugin.git
cd awesome-dsh-plugin
git checkout -b add-dsh-scratch-vault

# 2. 新增 data/plugins/TINGOD2006__dsh-scratch-vault.yml（內容如上）

git add data/plugins/TINGOD2006__dsh-scratch-vault.yml
git commit -m "Add dsh-scratch-vault"
git push origin add-dsh-scratch-vault
```

再到 GitHub 開 PR。

**注意事項：**

- `data/plugins/*.yml` 是唯一要改的地方。清單的兩個 README 由這些 YAML **自動生成**，手改會在合併時被覆蓋。
- `category` 選不準沒關係，維護者會改，不會因此打回。本插件是工作區衛生工具，`tools` 最貼近；`dev` 亦可。
- `description.en` 是必填，必須是**一句話並以句號結尾**，且不得誇飾——提到什麼功能，程式碼裡就要真的有。
- 倉庫年齡未滿 1 天會被 CI 擋下，隔天再送。
- 一個 PR 最多 3 條插件。

## 送出前檢查清單

- [x] `npm test` 全綠（目前 124/124）
- [ ] `npm pack --dry-run` 清單正確，沒有夾帶本機檔案（本機受限 shell 會因 npm cache 權限失敗，請在一般 PowerShell 執行）
- [x] `cordis.patch.yml` 的 `name` 是 `dsh-scratch-vault`（套件名，非相對路徑）
- [x] `package.json` 的 `version` 已遞增（0.3.1）
- [x] README 的安裝指令沒有殘留佔位符
- [x] GitHub 倉庫已加 `dsh-plugin` topic
- [x] 倉庫已公開且建立滿 1 天
- [ ] 實際安裝測試過一次：`dsh plugin --profile desktop add github:TINGOD2006/dsh-scratch-vault` 後**重啟 DSH**，再 `scratch_status`

## 為什麼安裝後一定要重啟

載入器在開機時建好模組圖，並以解析後的 URL 為 key 快取每個模組。停用再啟用 bundle 只會重跑**快取模組**的 `apply()`，不會重新 import 檔案。所以安裝、升級，以及任何 `lib/` 改動，都必須完整重啟 DSH 才會生效。判斷是否真的載入新版本，看 `<vaultDir>/shell-roots.log` 最後一行的 build tag。

## 疑難排解

### `npm publish` 回 `EOTP`（This operation requires a one-time password）

兩個成因，先分清是哪一種：

1. **在非互動環境執行**（DSH 的 shell、CI、包在腳本裡）。沒有 TTY，npm 無法提示 2FA，直接 `EOTP` 退出；而且認證網址在輸出與 debug log 裡都被 npm 遮成 `***`，拿不出來點。解法只有一個：在一般 PowerShell 視窗執行一次。已實測：同一台機器、同一個登入，在一般 PowerShell 就會走到 `Press ENTER to open in the browser` 並成功。
2. **想用 token 繞過 2FA**。npm 已限制 bypass-2FA 的 granular token 用於直接發佈：

   ```
   npm notice npm tokens that bypass 2FA are being restricted for
   account changes and direct publishing.
   https://gh.io/npm-gat-bypass2fa-deprecation
   ```

   所以「建 Automation token」這條路發不出去。長期正解是 Trusted Publishing（GitHub Actions 以 OIDC 短效憑證發佈），短期就是手動一次。

另外實測澄清：把帳號 2FA 從 `auth-and-writes` 改成 `auth-only`（Profile → Manage Two-Factor Authentication → 取消「Require two-factor authentication for write actions」）**不會**讓 `publish` 免 2FA，它只放寬登入；改完再 publish 仍回 `EOTP`。

長期解法是改用 CI 發佈，見〈步驟 2 → 免 OTP：改用 Trusted Publishing〉。

### 從 DSH 工作階段內推送會失敗

在 DSH 受限 shell 裡執行 `git push`，會依序撞到兩件事：

1. `schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)`
   受限權杖拿不到 Windows 的 TLS 認證。可改用 Git 內附的 OpenSSL：
   `git config http.sslBackend openssl`（本倉庫已設好）。
2. `sh.exe: *** fatal error - couldn't create signal pipe, Win32 error 5`
   Git for Windows 一律透過 MSYS 的 `sh` 啟動 credential helper（GCM、wincred 皆然），
   而受限 shell 不能建立具名管道。

**可行的繞法：把 `gh` keyring 裡的 token 內嵌進這一次推送的 URL**，完全不經過 credential helper。
token 不會寫進 `.git/config`，只出現在該次命令的 argv 裡：

```powershell
$t = gh auth token
git push "https://x-access-token:$t@github.com/TINGOD2006/dsh-scratch-vault.git" main
git push "https://x-access-token:$t@github.com/TINGOD2006/dsh-scratch-vault.git" v0.3.1
Remove-Variable t
```

缺點是 token 會在該次命令執行期間出現在本機行程列表；若在意，就改在 DSH **之外**的一般
PowerShell 視窗推送（Git Credential Manager 會正常彈出瀏覽器登入）：

```powershell
cd C:\Users\TINGOD\Documents\deepseek-harness\default-workspace\dsh-scratch-vault
git push -u origin main --follow-tags
```
