# 測試指南 / Testing dsh-scratch-vault

三層測試：**離線單元測試**（不用 DSH）、**載入驗證**（要重啟 DSH）、**端到端行為驗證**（要重啟 DSH）。
前兩層我可以直接跑給你看；第三層必須在重啟後的會話裡跑，因為外掛的 `apply()` 只在宿主啟動時載入。

---

## 為什麼「重載外掛」不算數（先讀這段）

`cordis.patch.yml` 用相對說明符 `./lib/index.js` 載入本外掛，載入器把它變成檔案 URL，
而 **Node 的 ESM 以 URL 為 key 快取模組**。所以 `plugin_manager set_bundle false→true`
確實會重新執行 `apply()`，但執行的是**開機時載入的那個模組實例**，不是磁碟上最新的檔案。

這是我實測出來的，不是推論：

| 時間 | 動作 | `shell-roots.log` 的 `apply` 行 |
|---|---|---|
| 07:34:21 | 使用者重啟 | `apply build=shellroots-v1` |
| 07:49:44 | `set_bundle false` 再 `true` | `apply build=shellroots-v1` ← 同一份舊程式碼 |

**結論：任何 `lib/` 改動都必須完整重啟 DSH。**
為了讓「跑的是哪一版」一眼可辨，`lib/index.js` 匯出 `BUILD_TAG` 並在每次 `apply()` 寫進
`<vaultDir>/shell-roots.log`。改 `lib/` 時**一定要同時 bump 這個 tag**。

---

## 第 1 層：離線單元測試（不需要 DSH）

```powershell
cd C:\Users\TINGOD\Documents\deepseek-harness\default-workspace\dsh-scratch-vault
npm test
```

目前：**91 tests / 91 pass / 0 fail**（exit 0）。

| 檔案 | 數量 | 覆蓋 |
|---|---|---|
| `test/classify.test.mjs` | 13 | 六條分類規則、最壞情況優先、保護目錄勝過可疑檔名 |
| `test/intercept.test.mjs` | 22 | 改寫決策、glob 不被破壞、**shell 變數不被破壞**、**cd 後相對路徑按有效工作目錄解析**、**磁碟機字母完整保留**、**workspace root 解析**（見下方迴歸） |
| `test/paths.test.mjs` | 7 | `scratchPathFor` 純函式映射、工作區內目錄結構保留 |
| `test/plugin.test.mjs` | 4 | 直接 `import` + `apply(stubCtx)`，走宿主載入時的同一條模組圖 |
| `test/shellroots.test.mjs` | 13 | per-session 探針、快取、失敗回退 |
| `test/shellscratch.test.mjs` | 6 | `%TEMP%` 解析、`isUsableDirectory` |
| `test/tools.test.mjs` | 15 | 七個工具、`scratch_import` 的 dryRun / keepOriginal、`run_script` 傳遞 `dshEnv` |
| `test/vault.test.mjs` | 8 | JSONL 帳本、去重、purge、容量上限 |

### 陷阱：`node --test test/` 會失敗，這是正常的

```powershell
node --test test/          # ✖ Error: spawn EPERM
```

`node --test` 的 runner 用**管道 stdio 生成子行程**，而 DSH 的檔案沙箱（`workspace-write`）
禁止開啟具名管道。這是**已知的沙箱邊界，不是本外掛的缺陷**——`npm test` 之所以可行，
是因為 `package.json` 的 `test` 腳本用 `&&` 串起每個檔案，每個檔案在**自身行程內**跑 runner。

### 迴歸測試：這次真的抓到的 bug

這一節的每一條測試，都對應一個**在真實使用中弄壞我自己的命令**、而原本的測試沒抓到的缺陷。
它們全是先寫測試、看到紅燈、才修程式碼——不是先宣告修好再補測試。

#### (1) workspace root 靜默全失效

`test/intercept.test.mjs` 的 `'the workspace root comes from session.header.cwd, not the host cwd'`
與 `'a realistically-shaped execution is intercepted end to end'` 是為這個 bug 加的：

```js
// Session 是 class Session { readonly header: SessionHeader } —— 沒有頂層 cwd。
workspaceRootOf({ agent: { session: { header: { cwd: ROOT } } } })  // → ROOT
```

舊程式碼讀 `agent.session.cwd`（不存在），於是 fallback 到**宿主自己的 cwd**（profile 目錄），
每個工作區路徑都被判成 `outside-workspace`，**整個 L3 攔截默默關閉**，而所有工具仍然回報成功。
原本的單元測試因為直接傳 `workspaceRoot` 而完全遮住了它——只有**貼近真實形狀的 execution** 才暴露。
`scratch_status` 也看不出來，所以它現在會回報 live 解析出的 `workspaceRoot` / `sessionShape`。

#### (2) shell 變數被改寫摧毀

`'shell variable references are never rewritten'`。舊版把
`python $env:DSH_SCRATCH\workspace\_probe.py` 改成 `python $env:C:\...\dsh-scratch\...\_probe.py`
（`$env:` 後面被塞進路徑），失敗原文：

```
can't open file 'C:\...\dsh-scratch\...\workspace\DSH_SCRATCH\workspace\_probe.py': [Errno 2] No such file or directory
```

這比不改寫更糟：`$DSH_SCRATCH` 的**文件化用法就是絕對路徑執行**。
修法需要兩道防線，缺一不可——`before` 檢查（`$env:`、`%TEMP%`）與 token 自身檢查（`$DSH_SCRATCH/`，
匹配就從 `$` 開始、沒有前導字元可看）。第一版只加了前者，被新測試當場抓出。

#### (3) `cd` 之後的相對路徑被錯誤重定基

`'a directory change outside the workspace leaves relative tokens alone'`。舊版把

```powershell
cd 'C:\...\dsh-scratch-vault\lib'
Get-ChildItem intercept.js,index.js,tools.js
```

的相對檔名改成 scratch 路徑——但那三個檔**就在 `lib\` 底下、本來就存在**。
`cd` 之後 token 已不再相對於工作區根目錄。

**第一版修法本身又是一個 bug**：一旦命令裡出現 `cd` 就整條命令的相對 token 全不改寫。
這當場被端到端測試打臉——`cd <workspace>` 之後 `python _probe_v4.py` 是最常見的形狀，
而該檔只存在於 scratch，漏改導致 `exit=2`：

```
can't open file 'C:\...\default-workspace\_probe_v4.py': [Errno 2] No such file or directory
```

正確做法是**逐 token 解析該點的有效工作目錄**（`cwdBefore`）：跟著 `cd`/`Set-Location`/`pushd`
的目標走，`cd <workspace>` 之後的相對草稿仍被改寫成它真正的 scratch 路徑
（`'a directory change inside the workspace rebases the token onto its real scratch path'`）；
只有當工作目錄**無法靜態得知**時才放手——`cd $env:WORK`、`cd %WORK%`、裸 `cd`（回到家目錄）、`cd ~/proj`
（`'an unresolvable working directory leaves relative tokens alone'`）。
絕對路徑在任何情況下都仍可安全改寫（`'an absolute reference is still redirected even when the command changes directory'`）。

> 這條的教訓：為修一個 bug 加的守衛，本身會製造下一個 bug。
> 兩種形狀都是真實用法，端到端跑一次就抓到，單元測試沒抓到。

#### (4) 磁碟機字母被吃掉

`'a Windows absolute path is redirected with its drive letter intact'`。`:` 不在 token 字元類裡，
所以 `C:\dir\_probe.py` 只匹配到 `\dir\_probe.py`，替換後變成

```
python C:C:\scratch\sess-1\workspace\_probe.py
```

一個無法解析的路徑。修法是把 `(?:[A-Za-z]:)?` 併入 pattern，讓磁碟機字母留在匹配之內。

---

## 第 2 層：載入驗證（重啟後第一步）

```powershell
# 1. 開機足跡：確認跑的是新 build
Get-Content C:\Users\TINGOD\.dsh\scratch-vault\shell-roots.log -Tail 5

# 2. 外掛是否掛上
Get-Content C:\Users\TINGOD\.dsh\profiles\desktop\package.json | Select-String 'dsh-scratch-vault'
```

`shell-roots.log` 應該出現 `apply build=marketready-v6`。
若仍是更早的 tag（`shellroots-v1`、`workspaceroot-v2`、`shellvar-dsh-env-v3`、`shellrewrite-v4`、`cwdresolve-v5`），代表跑的是舊模組 → 沒有真正重啟。

## 第 3 層：端到端行為驗證（重啟後）

### 3a. `$DSH_SCRATCH` 指向 shell 真的寫得進去的目錄

```powershell
$env:DSH_SCRATCH
# 必須用 -ErrorAction Stop 實寫，New-Item 的非終止錯誤會騙過你
New-Item -ItemType Directory -Force -Path $env:DSH_SCRATCH -ErrorAction Stop | Out-Null
Set-Content "$env:DSH_SCRATCH\write-test.txt" 'ok' -ErrorAction Stop
Get-Content "$env:DSH_SCRATCH\write-test.txt"
Remove-Item "$env:DSH_SCRATCH\write-test.txt" -Force
```

**修好之前**：`$DSH_SCRATCH` 指向宿主行程 `os.tmpdir()` 算出的真實 temp，而 Windows ACL 沙箱
只讓 shell 寫自己的私有 temp → `Access to the path 'dsh-scratch' is denied`。
**修好之後**：指向 `...\Temp\dsh-XXXXXX\dsh-scratch\<sessionId>`（shell 私有 temp），可寫。

### 3b. L3 攔截（核心功能）

在**工作區**寫一個草稿檔，然後看它有沒有被搬走：

```powershell
Set-Content 'C:\Users\TINGOD\Documents\deepseek-harness\default-workspace\_probe_e2e.py' 'print(1)'
Test-Path 'C:\Users\TINGOD\Documents\deepseek-harness\default-workspace\_probe_e2e.py'
```

- 用 DSH 的 `write` 工具寫 → 預期**工作區沒有這個檔**，工具結果附上真實的 scratch 路徑與 vault id。
- 用上面的 `Set-Content`（shell 直接寫）→ 預期**檔案會存在**：L3 攔的是工具呼叫，不是 shell 的寫入。
  這是已知限制，不是 bug。

### 3c. `scratch_status` 回報 live 解析

重啟後呼叫 `scratch_status`，檢查：

```json
{ "workspaceRoot": "C:\\Users\\TINGOD\\Documents\\deepseek-harness\\default-workspace",
  "sessionShape": { "hasHeaderCwd": true, "hasFlatCwd": false } }
```

`workspaceRoot` 必須是**工作區**，不是 profile 目錄。這是 3b 的前提。

### 3d. `run_script` 完全不落工作區

用 `run_script` 跑一段程式，確認 `scriptPath` 在 `$DSH_SCRATCH` 底下、工作區沒有任何新檔。

---

## 目前狀態

- 第 1 層：**91/91 綠**（可立刻重跑）。
- 第 2、3 層：**待重啟**。程式碼已修好並測過，但依上面的模組快取結論，不重啟不會生效。
  判斷方式只有一個：`shell-roots.log` 最後一行是不是 `apply build=marketready-v6`。

## 已知限制

1. **只攔工具呼叫，不攔 shell 寫入**——`Set-Content`、`>`、`Out-File` 寫進工作區的草稿不受影響。
2. **啟發式分類**——使用者真的要的交付物若長得像草稿（`build.py`），分類器可能誤判；`excludeGlobs` 可白名單。
3. **收納庫在沙箱外**——`<vaultDir>` 在 `DSH_HOME` 底下，agent 透過 shell 跑的程式**寫不進去**；
   收攏只可能在宿主側發生，所以才有 `scratch_import` 這個工具。
4. **shell 指令改寫是保守的**——glob 旁的匹配、已存在的檔案、含空白的替換路徑、
   `cd` 之後的相對路徑、任何 shell 變數形式，一律跳過。這是刻意的：**漏改一次只是少收一個檔，
   誤改一次會弄壞一條本來能跑的命令。**
5. **需要完整重啟**才能載入 `lib/` 改動。
