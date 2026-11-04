## 摘要

國泰世華連接器的貸款資訊改由官方 API 取得，並新增信用卡與貸款的扣款帳戶（`autopayAccount`），讓繳款提醒能依扣款帳戶餘額判斷是否需要提醒。

- 貸款總覽：改呼叫官方 `L_ACCT_Q_OverView`，不再開啟貸款總覽頁解析 DOM；API 失敗或格式不符時才退回原本的頁面解析。
- 信用卡：從 `C_BILL_Q_RecentBillInfo` 讀取自動扣繳狀態與帳戶，臺幣與外幣帳單各自回報。
- 貸款扣款帳戶：總覽未揭露扣款帳號，改呼叫官方明細 API `L_ACCT_Q_OverViewDetail` 讀取扣款行庫與帳號，與總覽共用同一組 API session；API 對所有貸款都失敗時才逐筆開啟貸款明細頁（`L0101_LoanInqDetail?account=`）作為後備。

## 變更內容

### 貸款總覽改用 API

- 使用目前已登入的 OnlineBanking 頁面（不在該網域時以 `domcontentloaded` 開啟存款總覽 `B0101_DepInq`），透過既有的 `getCathayApiSession()`（GetJWT → 必要時 `G_COMM_Q_UserProfile`）取得 session 後呼叫 `POST /OnlineBankingApi/ClientLoan/Api/ClientLoan/L_ACCT_Q_OverView`，`content` 為 `{ customerId, idType }`。無回應或非 JSON 時重試一次。
- API 與頁面兩條路徑共用同一個對應函式，sourceId、名稱、`raw` 與快照欄位一致：
  - `account` → `accountNumber`（sourceId `loan:cathaybk:<account>`）、`accountLast4`、`accountName`
  - `loanType` → `loanCategory`：依官方前端列舉，houseLoan 群組（`HouseLoan`、`CycleHouseLoan`、`SecondPlaceLoan`、`NetValueLoan`）為 `housing`，otherLoan 群組為 `other`，trustLoan 群組不設分類（與頁面路徑相同）
  - `interestRate`、`amountPayable`、`loanBalance` → 利率、本期應繳、餘額
  - `nextDeductionDate`（`YYYY-MM-DDTHH:mm:ss`）→ `paymentDueDate`（`YYYY-MM-DD`）；`overTimePeriod > 0` 時為未完成扣款，不設到期日
  - `alreadyPayPeriod`／`loanTerm` → 已繳／總期數，只在銀行頁面也會顯示期數的類型填入
  - `isBadDebt: true` 略過該筆並標記總覽不完整（與頁面路徑相同）
- 幣別：API 無幣別欄位，比照官方頁面固定顯示的「幣別：TWD」。
- 完整性：API 無「貸款總餘額」可對帳，改以「每筆都成功對應且無略過的呆帳」判定完整。
- `returnCode: "0000"`、`status: "Normal"` 且 `accountList` 為空時視為沒有貸款。
- 退回頁面解析的情況：取不到 session、頁面已登出、無回應、非 `0000`、`status: "MaintainTime"`、或格式不符（未知 `loanType`、帳號重複或格式錯、型別錯、負數金額、日期錯誤等）。
- 記錄：每次同步一筆 `cathaybk_loan_overview`（`method: "api"|"page"`、筆數、`complete`、`returnCode`、`status`、`fallbackReason`），不含帳號、金額、日期、token 或 `customerId`。

### 信用卡自動扣繳帳戶

- 讀取 `twBillInfo`／`foreignBillInfo` 的 `autoDebitStatus`、`bankId`、`account`，分別寫入臺幣主帳戶與外幣帳單帳戶（`<sourceId>:<幣別>`）的 `autopayAccount`。
- 狀態依官方 C0102 前端列舉判斷：
  - `Enable` 且有三碼銀行代碼與末四碼 → `{ bankCode, last4 }`
  - `NotApply`（未申請）、`Disable`（官方顯示扣繳帳號失效）→ `null`
  - `Close`、缺欄或未知值 → `undefined`（保留既有資料）
- 記錄 `cathaybk_card_autopay`（幣別、狀態、結果），不含帳號。

### 貸款明細扣款帳戶

- 主要方式（不載入頁面），在貸款總覽完成後於同一個 OnlineBanking 頁面內執行，並沿用總覽取得的 session（GetJWT 只呼叫一次）：
  1. `POST /MyBank/Customized/GetJWT` 取得 JWT 與 `customerId`。
  2. GetJWT 未帶 `IdType` 時，依官方前端呼叫 `POST /OnlineBankingApi/Common/Api/ClientCommon/G_COMM_Q_UserProfile` 取得 `content.idType`（未送 `idType` 時明細 API 會回 `A602`）。
  3. 依序對每筆貸款呼叫 `POST /OnlineBankingApi/ClientLoan/Api/ClientLoan/L_ACCT_Q_OverViewDetail`，`content` 為 `{ customerId, idType?, account }`，`account` 補零至 16 碼。
- 請求控制：一次一筆，每次請求各自產生 `functionSeqNo`，單筆逾時 15 秒；未收到回應（`httpStatus` 0）或非 JSON 時等待約 300ms 重試該筆一次，有明確 `returnCode`（含非 `0000` 業務錯誤）不重試；整體超過 45 秒後不再送新請求（`returnCode: "skipped"`）。
- 回應須為 `success: true`、`returnCode: "0000"` 且含字串 `deductionAccount`。
- 銀行代碼：`bankId` 為三碼數字時採用；缺少 `bankId` 時，只有 `isOtherBankDeduct === false`（非他行扣款）才視為國泰世華 `013`，否則為未知。
- 語意與信用卡一致：有銀行代碼與末四碼為 `{ bankCode, last4 }`；成功回應但 `deductionAccount` 為空字串為 `null`；API 失敗、非 `0000` 或缺欄為 `undefined`（保留舊資料）。部分貸款失敗時只讓該筆維持 `undefined`，不補開頁，以節省 CPU。
- JWT、`customerId` 與 `idType` 只在 `page.evaluate` 之間傳遞，不寫入記錄。
- 後備方式：只有 API 對**所有**貸款都取不到可用回應（例如取不到 JWT、全部非 `0000`）時，才逐筆開啟明細頁，依「扣款行庫」「扣款帳號」標籤讀取桌面表格與窄版清單；以 `domcontentloaded` 載入，並透過 CDP `Network.setBlockedURLs` 擋掉圖片、字型與第三方追蹤；明細頁被導向登出頁時照常中止。
- 明細只是補充資訊：單筆失敗不影響貸款同步。
- 記錄：逐筆 `cathaybk_loan_autopay_detail`（index、貸款分類、結果、`source: "api"|"page"`、`returnCode`、`attempts`、`elapsedMs`），彙總 `cathaybk_loan_autopay`（`method: "api"|"page"`、筆數、found／unset／unknown、`apiUsableCount`、`apiJwtAvailable`、`idTypeSent`、`userProfileReturnCode`）。不記帳號、金額或回應內容。

### 文件

- `docs/004-connector-development.md` 國泰世華章節補上貸款總覽 API、信用卡與貸款扣款帳戶的來源、API 呼叫順序與重試規則、銀行代碼判斷、後備明細頁與記錄說明。
- README 的國泰世華支援內容（存款・信用卡・貸款）不變，無需更新。
- 無 schema 變更（沿用既有 `autopayAccount` 欄位與扣款帳戶對應流程）。

## 隱私設計

- 只保存銀行代碼＋帳號末四碼。完整扣款帳號在瀏覽器頁面內即截成末四碼，不回傳 Worker、不寫入資料庫或 `raw`。
- 記錄只含狀態、計數與耗時，不含帳號、金額、token 或 `customerId`；測試也檢查記錄中不出現帳號數字與 token。
- 測試 fixture 皆為去識別化假資料。

## 實機驗證結果

以自架測試 Worker 真實帳戶手動同步，個人資料不列出：

- 扣款帳戶版本，先清空測試站國泰世華資料後重新全量同步：存款、交易、信用卡帳單與 5 筆貸款皆正常寫入；信用卡臺幣帳單扣繳帳戶 found，貸款扣款帳戶 5/5 found。
- 貸款總覽改用 API 後，保留既有資料再同步一次並逐筆比對：
  - `cathaybk_loan_overview`：`method: "api"`、5 筆、`returnCode: "0000"`、`complete: true`，未退回頁面。
  - 明細 API 5/5 `0000`，皆一次成功（`attempts: 1`）。
  - 5 筆貸款的帳戶欄位、`raw`、扣款帳戶與最新快照值皆與頁面解析版本完全相同，無新增或重複的 sourceId。
  - 同步 CPU 約 0.94 秒（前一版頁面解析總覽約 1.57 秒；改用明細 API 前逐筆開明細頁約 1.98 秒，逼近方案上限約 2 秒）。
- 開發過程中觀察到：未送 `idType` 時 API 回 `A602`；曾有一次明細單筆未收到回應，因此加入單次重試。

## 測試

- `tests/sources/cathaybk/credit-card-bills.test.ts`：官方狀態列舉（Enable／NotApply／Disable／Close／未知／缺欄），以及臺幣與外幣帳單各自回報扣繳帳戶。
- 新增 `tests/sources/cathaybk/loan-detail.test.ts` 與 fixture `tests/fixtures/cathay-loan-detail.html`：
  - API 方式（以假的 `XMLHttpRequest` 執行頁面內函式）：成功寫入 `{ bankCode, last4 }`、空 `deductionAccount` → `null`、非 `0000` → `undefined`、缺 `bankId` 且非明確自行扣款 → `undefined`；GetJWT 無 idType 時從 UserProfile 取得並送出，UserProfile 失敗時不送；依序一次一筆且 `functionSeqNo` 不重複；無回應或非 JSON 重試一次、業務錯誤不重試；回傳與記錄不含完整帳號與 token；`scrapeLoans` 走 API 時不開明細頁。
  - 後備：API 全部非 `0000` 或取不到 JWT 時改走明細頁。
  - 明細頁方式：桌面表格、窄版 li 版面、明確未設定為 `null`、帳號不符與缺欄位為 `undefined`，且記錄不含帳號。
- 新增 `tests/sources/cathaybk/loan-overview-api.test.ts`：所有欄位對應、14 種 `loanType`、未完成扣款、呆帳、日期與期數、空清單、19 種格式不符、重試時更換 `functionSeqNo`、各種退回頁面的原因、記錄不含帳號／金額／日期／token，以及 API 與頁面路徑對同一份 fixture 輸出完全相同。
- `connector-loans.test.ts`：頁面解析失敗的測試改為針對 DOM 步驟。
- 已通過 `npm run format:check`、`npm run lint`、`npm run typecheck`、`npm run test:backend`、`npm run test:unit`、`npm run build`。
