# dsh-scratch-vault

**讓 DeepSeek Harness 以 Codex 的方式執行操作腳本——腳本跑在工作區之外，並被插件收納在內部。**

[English](README.md) | 中文

長程任務裡那些「只跑一次」的探針、轉換器、診斷腳本，不再落到你的倉庫裡：它們從一個位於工作區之外的 session scratch 根執行，並且每一份都被歸檔進插件自有的收納庫，可以列出、檢視、促升、清理。

```
之前                                       之後
repo/                                      repo/
├── src/                                   ├── src/
├── _probe_models.py        ← 雜訊        ├── package.json
├── _recon_api.py           ← 雜訊        └──（只剩交付物）
├── tmp_convert.mjs         ← 雜訊
├── apply-paths.ps1         ← 雜訊        vault/
└── package.json                           └── entries/20261012…-a1b2c3/script
```

---

## 為什麼需要它

Agent 執行長程任務會不斷產生中間檔。檔案本身在磁碟上不花錢，真正的代價是：之後每一次 `glob`、`grep`、列目錄，都要在這些檔案裡翻找一遍，把無關內容推進上下文，逼 agent 重新理解它自己剛做過的事。

DSH 其實已經有了大半機制。它的 `workspace-write` 沙箱允許寫入**工作區根目錄或平台臨時目錄**（`writableRoots` 回傳工作區根、`/tmp`、`os.tmpdir()`），而工作區變更摘要本來就排除臨時根（`isTemporaryPath`——註解原文是 *"scratch paths that never enter the change summary"*）。缺的是兩件事：把草稿導向那裡的機制，以及把它記下來的帳。

本插件就是這兩件事。

## 安裝

```sh
dsh plugin --profile desktop add github:TINGOD2006/dsh-scratch-vault
```

裝完重啟 DSH。從本機檢出安裝：

```sh
dsh plugin --profile desktop add link:C:/path/to/dsh-scratch-vault
```

Windows 路徑務必用正斜線，否則 pnpm 會把磁碟代號拼進 profile 目錄，插件裝上卻不啟用。

需求：Node ≥ 22，以及一個有掛載 `tools` 服務的 DSH。本插件**完全不宣告任何依賴**——連 `@deepseek-ai/dsh-tools` 都沒有。以 `link:` 安裝的外掛，其 bare specifier 是按**真實路徑**往上解析的，永遠到不了 profile 的 `node_modules`；只要有一個宿主 import，整個插件就會以一句 `failed to import` 收場。因此工具定義在 `lib/tools.js` 裡手工組出，形狀與 `defineTool` 的產物完全相同：不必安裝任何東西，也沒有需要同步的版本。

改動 `lib/` 底下任何檔案後，都必須**完整重啟 DSH**。載入器在開機時建好模組圖，並以解析後的 URL 為 key 快取每個模組；停用再啟用只會重跑**快取模組**的 `apply()`，不會重新 import 檔案。

## 它做什麼

### L2 —— 紀律、環境、內聯執行

- **一段系統提示詞**：告訴模型操作腳本該去 scratch 根，不是工作區。
- **`$DSH_SCRATCH` 與 `$DSH_VAULT`**：透過 `ctx.shellEnv` 注入每一次 shell 呼叫。該命名空間每次呼叫都重建，所以值永遠是當前 session 自己的目錄。
- **`run_script({ language, code, description })`**：「不寫檔就能跑」的那個工具。程式被寫到工作區外的 scratch 檔，並經 `ctx.shell` 執行，因此跑在 session 的沙箱策略之下。這才是「我只是想跑點東西」的正解。

### L3 —— 攔截

`tools/execute` 是唯一**環繞**派發的接縫，因此也是唯一能改變工具本體收到什麼的接縫：註冊表把可變的 execution 傳進瀑布，而 `dispatchToolBody` 之後才讀 `exec.arguments`。（`tools/pre-execute` 做不到——它的決策型別是 `allow | deny | cancel | ask`，沒有放引數的地方。）

當 `write` 或 `edit` 指向工作區內的一個草稿腳本時，它的 `file_path` 會被改寫到 session scratch 根，工具結果則告訴模型真實的絕對路徑與收納庫條目 id。引用該腳本的 shell 命令也會一併改寫。

兩個性質保證這件事安全：

- **映射是路徑的純函式**（`scratchPathFor`）。DSH 以平行群組派發工具呼叫，`write` 與緊接執行它的 `pwsh` 可能同時在飛；任何有順序依賴的作法都會競態。
- **只有當工作區檔案不存在時才改寫 shell token。** 真的躺在磁碟上的歷史殘留，照原樣從磁碟執行。

shell 改寫刻意保守，因為**漏改一次只是少收一個檔，誤改一次會弄壞一條本來能跑的命令**。以下情形一律不動：緊鄰 glob 萬用字元的 token、更長檔名的前綴（`x.py.bak`）、shell 變數參照的一部分（`$env:X\a.py`、`$DSH_SCRATCH/a.py`、`%TEMP%\a.py`），以及**相對路徑而它的工作目錄無法靜態得知**（`cd $env:WORK`、`cd %WORK%`、裸 `cd` 回到家目錄、`cd ~/proj`）。

出現在 `cd`／`Set-Location`／`pushd` 之後的相對 token，會依那個目錄切換**實際把 shell 帶到的位置**解析，而不是一律當成相對於工作區根目錄：`cd <工作區>` 之後 `python _probe.py` 是最常見的形狀，仍會被改寫成 write 產生的那個 scratch 路徑；而 `cd …\lib` 之後的 `Get-ChildItem notes.js` 指的是真實存在的檔案，會被放過。絕對路徑沒有歧義，一律改寫（磁碟機字母完整保留）。

改寫只發生在**程式位置**：直譯器／runner（`python`、`node`、`pwsh`、`bash`、`ruby`、`lua`…）的引數位置，或命令字本身（`.\_probe.ps1`）。出現在 `#` 註解、commit message、`grep` pattern 或單引號 payload 裡的檔名是**資料**——命令不是執行它，就是在另一個工作目錄下執行它——改寫這些地方只會弄壞本來能跑的命令，或把某台機器的暫存路徑烙進產出檔案。

### L4 —— 收納庫

每一份被攔下的腳本都會帶 JSONL 帳本歸檔到 vault 目錄，並提供 `scratch_list`、`scratch_show`、`scratch_promote`（複製回工作區成為真正的交付物）、`scratch_purge`。

`scratch_import` 用來**事後收攏**：把插件還不存在時就已經躺在工作區裡的殘留收進 vault。它會逐檔比對收納副本的位元組，確認一致之後才刪除原檔（`keepOriginal: true` 保留原檔，`dryRun: true` 兩邊都不動）。這裡有兩道護欄：只收「能在 UTF-8 下逐位元組往返」的檔案——有損解碼會被存成 U+FFFD，而拿同一份解碼結果去比對永遠會過——以及**絕不刪除分類器判定受保護的檔案**，`src/`、`node_modules/` 或 `excludeGlobs` 白名單裡的路徑會被回報為 refused 並原地不動。

所有對 vault 的寫入都發生在插件自己的行程裡，這點是結構性的：`<vaultDir>` 位於 `DSH_HOME` 之下，在工作區之外，因此也在沙箱可寫根之外——**agent 透過 shell 執行的程式無法寫入 vault**，沙箱內的任何工具也不行。收攏只可能在邊界的宿主這一側成立，而這些工具正好就跑在那一側。

帳本本身是 append-only；唯二必須整檔改寫的操作——定期清理與 `maxVaultEntries` 裁切——都先寫暫存檔再 rename 就位，所以改寫中途被打斷也**不會截斷歷史**。讀取由一份以帳本 `stat` 為鍵的記憶體快取供應；任何其他寫入者（包括共用同一個 vault 的另一個 DSH 視窗）都會改變那個簽章，下一次讀取就重新載入。`ledger.lock` 讓跨視窗的改寫互斥：鎖被持有時，清理會**拒絕**（`busy: true`）而不是先刪掉條目目錄、再讓另一個行程把那些條目重新寫回帳本；鎖會記下持有者的 pid，所以**死行程留下的鎖會被搶**，而只是慢、但還活著的持有者不會被硬搶。

有兩種失效模式是明確處理的，不靠運氣。**讀不出來的帳本不會被當成空帳本**：回報空、不快取、也拒絕改寫——從「讀不到」重寫出去，等於把空的內容蓋掉真實歷史。而**被截斷的最後一行**（append 途中斷電唯一能損壞的東西）會在下一次 append 前先補上換行，而不是讓兩筆記錄黏成一行無法解析的內容。

清理會在**每次掛載**時套用一次（`autoPurge`）：保留期限是政策，不是待辦事項，收納庫不會再一直長大直到有人想起 `scratch_purge`。要完全手動就設 `autoPurge: false`。

## 設定

**刻意不宣告 Cordis `Config` schema。** 若 profile 解析不到 schema 庫的 peer 依賴，整個插件會掛載失敗——而一個載不起來的衛生插件，比一個沒有設定表單的插件更糟。設定改用純 JSON 檔：

```
<vaultDir>/scratch-vault.json      # 預設 ~/.dsh/scratch-vault/scratch-vault.json
$DSH_SCRATCH_VAULT_CONFIG          # 或指向任意 JSON 檔
```

每個鍵都可省略，缺的走內建預設。

| 鍵 | 預設 | 說明 |
|---|---|---|
| `enabled` | `true` | 總開關。 |
| `interceptMode` | `"redirect"` | `"redirect"` 搬走寫入；`"deny"` 直接拒絕並說明替代作法；`"report"` **什麼都不改**，只記錄「本來會被攔截」的檔案。 |
| `scratchRoot` | `""` → `<os.tmpdir()>/dsh-scratch` | 草稿檔所在。必須在工作區之外。 |
| `vaultDir` | `""` → `<DSH_HOME>/scratch-vault` | 收納庫目錄。 |
| `interceptWrites` | `true` | 是否檢查 `write`/`edit`。 |
| `rewriteShell` | `true` | shell 命令中的引用是否跟隨被改寫的寫入。 |
| `injectPrompt` | `true` | 是否注入紀律段落。 |
| `exposeEnv` | `true` | 是否注入 `DSH_SCRATCH`/`DSH_VAULT`。 |
| `registerRunScript` | `true` | 是否提供 `run_script`。 |
| `interpreters` / `extensions` | `{python,node,powershell,bash}` | 各語言的直譯器與草稿副檔名。 |
| `scriptExtensions` | 27 項 | 哪些副檔名可能是草稿腳本。 |
| `scriptNamePatterns` | 保守三條 | 標記草稿腳本的檔名 regex。 |
| `scratchDirNames` | `_scratch`、`tmp` 等 | 這些目錄底下的一切都算草稿。 |
| `protectDirs` | `src`、`lib`、`test` 等 | 絕不觸碰——專案真正的原始碼。 |
| `excludeGlobs` | `[]` | 交付物白名單（工作區相對路徑）。 |
| `treatBareRootScriptsAsScratch` | `true` | 無專案 manifest 的工作區，根目錄的腳本檔算草稿。 |
| `autoPurge` | `true` | 插件掛載時先套用一次保留期限清理。 |
| `retainDays` | `14` | 清理門檻。 |
| `maxVaultEntries` | `2000` | 帳本上限，超出丟最舊。 |
| `maxEntryBytes` | `4194304` | 超過則記帳但不存內容。 |

設定檔的搜尋順序與文件一致：`<vaultDir>/scratch-vault.json` 優先，其次是 `$DSH_SCRATCH_VAULT_CONFIG` 指向的檔案，最後才是內建預設。值裡引用了**未設定**的環境變數是設定錯誤，不是目錄名：該設定會退回預設值並在掛載時記一條警告，而不是造出一個字面上叫 `%VAR%` 的目錄（shell 之後會把它展開成別的東西）。`scratch_status` 的 `configWarnings` 會列出這些被忽略的值。

### 先用 `report` 模式

面對不熟的倉庫，先把 `"interceptMode"` 設成 `"report"`。它會記錄分類器「本來會怎麼做」，一個檔案都不搬——這是驗證 `scriptNamePatterns` 是否需要為你的目錄結構調校的最省成本方式。

## 分類器怎麼判斷

誤判成草稿會**悄悄搬走**一個使用者真的要的檔案；漏判只是留下一個助手腳本，也就是現狀。因此每個預設都偏向保留，規則順序是「最壞情況優先」：

1. 命中 `excludeGlobs` → **保留**（使用者點名了這個檔案）。
2. 目的地**已經存在於磁碟上** → **保留**。存在的檔案是成品不是探針：被改寫到 scratch 的寫入事後在工作區裡不會存在，所以還躺在那裡的檔案只可能是使用者的。這條撐住了「腳本本身就是交付物」的流程——覆寫交付物、或第一次寫入後再 `edit`，都不會被搬走。
3. 目錄段落落在 `protectDirs` → **保留**（真實原始碼勝過任何草稿啟發式）。Windows 上段落比對大小寫不敏感——`SRC` 與 `src` 是同一個目錄。
4. 目錄段落落在 `scratchDirNames` → **收納**（同樣的大小寫規則）。
5. 檔名命中 `scriptNamePatterns`（`_probe.py`、`.check.mjs`、`tmp_x.sh`、`recon_*.py`）**且**副檔名在 `scriptExtensions` 內 → **收納**。副檔名閘門是必要的：少了它，`.gitignore`、`.env`、`.editorconfig` 這些正常倉庫檔都會被當成草稿名。
6. 副檔名屬於腳本、且直接躺在**沒有專案 manifest** 的工作區根目錄 → **收納**。這條就是「草稿資料夾」與「倉庫」的分界。
7. 其餘 → **保留**。

只有第 5、6 條可能猜錯，而且兩條都只對**新檔案**生效。若使用者要的就是那個檔案本身，改寫會被 `scratch_promote` 撤銷——工具結果會直接給出條目 id 與該下的那一次呼叫——所以即使猜錯也什麼都沒丟。如果這個工作區裡「腳本本身就是交付物」，把 `treatBareRootScriptsAsScratch` 設成 `false`（或把它們列進 `excludeGlobs`），第 6 條就完全不再觸發。

## 工具

| 工具 | 用途 |
|---|---|
| `run_script` | 從草稿檔執行程式，完全不寫工作區。 |
| `scratch_import` | 收攏已經在工作區裡的腳本；先驗證再刪除原檔。 |
| `scratch_list` | 新到舊列表，可限定單一 session。 |
| `scratch_show` | 單一條目與其原始碼。 |
| `scratch_promote` | 把收納的腳本複製回工作區。 |
| `scratch_purge` | 刪除超過保留期的條目；預設為 dry run。 |
| `scratch_status` | 生效中的設定與收納庫統計。 |

## 已知限制

- **收納庫不是安全邊界。** 它記錄插件搬走了什麼；它不會阻止一個執意用「分類器判定為交付物」的路徑把檔案寫進工作區的 agent。
- **攔截是逐次寫入的。** 由 shell 重導向（`python … > out.py`）或由 agent 執行的程式產生的腳本，只有在 shell token 命中改寫規則時才會被處理；檔案本身不會被搬走。
- **shell 改寫刻意少覆蓋。** shell 變數、glob、更長檔名、工作目錄無法靜態得知時的相對路徑，以及不在程式位置的一切（`#` 註解、commit message、`grep` pattern、引號內的 payload）都不動（見 L3），所以以這些形式引用的草稿腳本不會被改寫——改寫它反而會弄壞本來能跑的命令。
- **分類器只看檔名與位置**，不讀檔案內容。
- **保留期限是時間制，且只在掛載時套用。** `autoPurge` 每次 session 啟動清一次，所以很長的 session 仍可能累積條目；`maxVaultEntries` 上限負責兜底。
- **`systemPrompt.section` 拿不到 per-session 路徑**（其 text 函式只收到 scope key），所以路徑走 `$DSH_SCRATCH` 而不是提示詞。
- **`run_script` 需要 `ctx.shell`。** 沒有它就不註冊該工具，其餘各層照常運作。
- **在沙箱內寫不了收納庫。** 它位於 `DSH_HOME` 之下、工作區之外，因此也在 `writableRoots` 之外；只有插件這一側的程式碼能收攏，agent 執行的 shell 程式不行。
- **收攏不是自動的。** `scratch_import` 是明示、逐次呼叫的。插件不會自行掃描或清掃工作區——它只處理自己攔到的寫入，以及你交給它的路徑。
- **改插件要重啟。** 載入器以解析後的 URL 為 key 快取模組；停用再啟用只會重跑**快取模組**的 `apply()`，不會重新 import 檔案。

## 開發

```sh
node test/classify.test.mjs
node test/intercept.test.mjs
node test/paths.test.mjs
node test/plugin.test.mjs
node test/shellroots.test.mjs
node test/shellscratch.test.mjs
node test/tools.test.mjs
node test/vault.test.mjs
```

測試完全離線、零依賴：`lib/` 底下每個模組都在測試的 import 圖裡，`lib/tools.js` 也不例外——`registerTools` 只碰 `ctx.tools.register`、`ctx.get` 與一個 vault，所以一個只有兩個方法的 stub context 就是它的忠實測試替身。

> 請直接執行檔案，不要用 `node --test`。在受限的 DSH 沙箱下，使用 piped stdio 的子行程會 `EPERM` 失敗，而那正是測試執行器的檔案隔離機制所用的方式。

## 授權

MIT
