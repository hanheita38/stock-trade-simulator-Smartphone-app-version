// ============================================================
// state-manager.js — データ管理層
// アプリ全体の状態変数・LocalStorage永続化・多言語定数を管理する
//   - アプリ状態変数（全てのグローバル let / const）
//   - LocalStorage の読み書き（saveData / loadData 系）
//   - I18N 多言語定義
//   - フォーマットユーティリティ（formatCurrency / formatClock）
//   - 言語切り替え（toggleLang / applyLang）
//   - リセット（resetGame）
// ============================================================

// ============================================================
// LocalStorage キー定数
// ============================================================
const LS = {
  STOCKS          : 'sim_stocks',
  CASH            : 'sim_cash',
  HOLDINGS        : 'sim_holdings',
  ASSET_HISTORY   : 'sim_asset_history',
  PENDING_ORDERS  : 'sim_pending_orders',
  REALIZED_TRADES : 'sim_realized_trades',
  SHORT_POSITIONS : 'sim_short_positions',
  LEVERAGE_LONGS  : 'sim_leverage_longs',
  FX_RATE         : 'sim_fx_rate',
  LANG            : 'sim_lang',
  FINNHUB_KEY     : 'sim_finnhub_api_key',
};

const FINNHUB_REGISTER_URL = 'https://finnhub.io/register';

/**
 * LocalStorage の値を安全にパースする
 * JSON が壊れている場合は fallback を返し、キーを削除してリセットする
 * @param {string} key      - LocalStorage キー
 * @param {*}      fallback - パース失敗時のデフォルト値
 * @returns {*}
 */
function safeParse(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return fallback;
    return JSON.parse(raw) ?? fallback;
  } catch (e) {
    console.warn(`[safeParse] "${key}" のデータが破損しています。リセットします。`, e);
    localStorage.removeItem(key);
    return fallback;
  }
}

// ============================================================
// アプリ状態変数（グローバル）
// ============================================================

// ── 銘柄マスタ ──
let STOCKS = safeParse(LS.STOCKS, {
  "NVDA": { name: "NVIDIA Corp",            color: "#76b900" },
  "AMD":  { name: "Advanced Micro Devices", color: "#ed1c24" },
});

// ── 財務データキャッシュ（グレアム数・PEG計算用）──
// { [symbol]: { eps, bps, pe, epsGrowth, jpy, loading, error } }
const stockFinancials = {};

// ── 決算データキャッシュ ──
// { [symbol]: { loading, history: [{period, actual, estimate, surprise, surprisePct}][], error? } }
const earningsData = {};
// { [symbol]: { date, epsEstimate, revenueEstimate } | null }
const nextEarnings = {};

// ── ポートフォリオ状態 ──
let cash         = parseFloat(localStorage.getItem(LS.CASH)) || 1_000_000;
let holdings     = safeParse(LS.HOLDINGS,      {});
let assetHistory = safeParse(LS.ASSET_HISTORY, []);
let prices       = {};   // { [symbol]: number[] }  ※セッション内のみ・永続化なし
let currentStock = Object.keys(STOCKS)[0] || '';

// ── 実現損益ログ ──
// { symbol, qty, buyAvg, sellPrice, pnl, ts, type? }[]
let realizedTrades = safeParse(LS.REALIZED_TRADES, []);

// ── 待機注文 ──
// { id, type:'limit'|'stop'|'oco', side:'buy'|'sell', symbol, qty, price, ocoRole?, groupId? }[]
let pendingOrders    = safeParse(LS.PENDING_ORDERS,  []);
let currentOrderType = 'market'; // 'market' | 'limit' | 'stop' | 'oco'

// ── 信用取引 ──
// { [id]: { id, symbol, qty, entryPrice, leverage, collateral, ts } }
let shortPositions  = safeParse(LS.SHORT_POSITIONS, {});
let leverageLongs   = safeParse(LS.LEVERAGE_LONGS,  {});
let currentMarginTab= 'short';
let marginPanelOpen = true;

// ── 為替レート ──
let fxRate          = parseFloat(localStorage.getItem(LS.FX_RATE)) || 150;
let fxRateUpdatedAt = 0;
const FX_REFRESH_MS = 5 * 60 * 1000; // 5分ごと

// ── 言語 ──
let lang = localStorage.getItem(LS.LANG) || 'ja';

// ── UI パネル開閉状態 ──
let divPanelOpen     = true;
let plPanelOpen      = true;
let ahPanelOpen      = true;
let earningsPanelOpen= true;
let ahRange      = 'all'; // 'all' | '1h' | '3h' | '1d'

// ── ポジションサイジング ──
let pszMethod    = 'fixed';
let pszPanelOpen = true;
let pszLastShares= 0;

// ============================================================
// I18N — 多言語定数
// ============================================================
const I18N = {
  ja: {
    appTitle:    '株トレードシミュレーター <small>(市場連動版)</small>',
    reset:       'リセット',
    cash:        '現金',
    syncFetching:'市場ステータス取得中...',
    syncUpdated: (t) => `最終同期: ${t} (10秒更新)`,
    qty:         '保有数',
    avg:         '取得単価',
    pnl:         '現在の損益',
    buyQty:      '買い数量',
    buyBtn:      '買い注文',
    sellQty:     '売り数量',
    sellBtn:     '売り注文',
    total:       '総資産',
    noHolding:   '保有なし',
    sharpe:      'シャープレシオ',
    drawdown:    '最大ドローダウン',
    sharpeDesc:  'リスクを取った分、どれだけ効率よく利益を出せているか。時間加重・年率換算済み。1以上で良好、2以上で優秀。',
    drawdownDesc:'資産が最大で何％減ったか。メンタル管理の練習に最適です。',
    searchPlaceholder: '企業名や銘柄コードを入力',
    searchBtn:    '検索',
    searchLoading:'検索中...',
    searchEmpty:  '該当なし',
    searchError:  '検索エラー',
    apiKeyTitle:  'Finnhub APIキー',
    apiKeyPlaceholder: 'Finnhub APIキーを入力',
    apiKeySave:   '保存',
    apiKeyDelete: '削除',
    apiKeyManage: '設定',
    apiKeySaved:  '保存済み',
    apiKeyMissing:'未保存',
    apiKeyExplain: [
      '目的: リアルタイムの株価データを取得するために使用します。',
      '理由: 開発者がAPI費用を負担せず、無料でアプリを提供し続けるためです。',
      '安全性: 入力されたキーはあなたのブラウザ内でのみ機能します。'
    ],
    apiKeyHelp:   '※キーをお持ちでない方は {link} で無料取得してください。',
    apiKeyLink:   'Finnhub公式サイト',
    apiKeyNotice: 'APIキーはブラウザの LocalStorage にのみ保存され、開発者のサーバーには一切送信されません。',
    apiKeyRequired:'Finnhub APIキーを入力して保存してください',
    apiKeySavedMessage:'APIキーを保存しました',
    apiKeyDeletedMessage:'APIキーを削除しました',
    sharesUnit:  (n) => `${n}株`,
    confirmReset:'全データをリセットしますか？',
    alertCash:   '現金不足',
    alertShares: '株数不足',
    buffettTheory:  '📐 理論値（グレアム数）',
    buffettMargin:  '🛡️ 安全域（バフェット）',
    buffettTheoryDesc: '√(22.5 × EPS × BPS) で算出。バフェット流の本質的価値。',
    buffettMarginDesc: '理論値より現在値が低いほど「割安」。+がお得、−が割高。',
    buffettNoData:  'データなし',
    pegRatio:       '📈 PEGレシオ',
    pegRatioDesc:   'PER ÷ EPS成長率(%)。1以下が割安、2以上が割高の目安。',
    pegNoData:      'データなし',
    pegCheap:       '割安',
    pegFair:        '適正',
    pegExpensive:   '割高',
    crashToggle:    '🌪️ 暴落テスト ON（レイ・ダリオ流）',
    crashBadge:     '−25%',
    crashLabel:     '⚠️ もし今 −25% の暴落が起きたら...',
    crashSub:       (diff) => `通常比: ${diff}`,
    labelDivPanel:  'ポートフォリオ分散分析',
    labelHhi:       'HHI集中度',
    labelTop1:      '最大銘柄比率',
    labelAvgCorr:   '平均相関係数',
    labelCorrMatrix:'📐 銘柄間 相関マトリクス（10秒足リターン）',
  },
  en: {
    appTitle:    'Stock Trade Simulator <small>(Live Market)</small>',
    reset:       'Reset',
    cash:        'Cash',
    syncFetching:'Fetching market data...',
    syncUpdated: (t) => `Last sync: ${t} (10s interval)`,
    qty:         'Shares Held',
    avg:         'Avg. Cost',
    pnl:         'Unrealized P&L',
    buyQty:      'Buy Qty',
    buyBtn:      'Buy Order',
    sellQty:     'Sell Qty',
    sellBtn:     'Sell Order',
    total:       'Total Assets',
    noHolding:   'No positions',
    sharpe:      'Sharpe Ratio',
    drawdown:    'Max Drawdown',
    sharpeDesc:  'Risk-adjusted return efficiency. Time-weighted & annualized. Above 1 is good, above 2 is excellent.',
    drawdownDesc:'The largest percentage decline in assets. Useful for practicing risk discipline.',
    searchPlaceholder: 'Company name or ticker symbol',
    searchBtn:    'Search',
    searchLoading:'Searching...',
    searchEmpty:  'No results',
    searchError:  'Search error',
    apiKeyTitle:  'Finnhub API Key',
    apiKeyPlaceholder: 'Enter your Finnhub API key',
    apiKeySave:   'Save',
    apiKeyDelete: 'Delete',
    apiKeyManage: 'Settings',
    apiKeySaved:  'Saved',
    apiKeyMissing:'Not saved',
    apiKeyExplain: [
      'Purpose: Used to retrieve real-time stock price data.',
      'Reason: Keeps the app free without making the developer pay for every user\'s API usage.',
      'Safety: Your key works only inside your browser.'
    ],
    apiKeyHelp:   'If you do not have a key, get one for free at the {link}.',
    apiKeyLink:   'official Finnhub website',
    apiKeyNotice: 'API keys are stored only in your browser LocalStorage and are never sent to the developer server.',
    apiKeyRequired:'Enter and save your Finnhub API key first',
    apiKeySavedMessage:'API key saved',
    apiKeyDeletedMessage:'API key deleted',
    sharesUnit:  (n) => `${n} sh`,
    confirmReset:'Reset all data?',
    alertCash:   'Insufficient cash',
    alertShares: 'Insufficient shares',
    buffettTheory:  '📐 Intrinsic Value (Graham)',
    buffettMargin:  '🛡️ Margin of Safety (Buffett)',
    buffettTheoryDesc: 'Calculated as √(22.5 × EPS × BPS). Buffett-style intrinsic value.',
    buffettMarginDesc: 'Positive = undervalued. Negative = overvalued vs. Graham Number.',
    buffettNoData:  'No data',
    pegRatio:       '📈 PEG Ratio',
    pegRatioDesc:   'P/E ÷ EPS growth (%). Under 1 = undervalued, over 2 = expensive.',
    pegNoData:      'No data',
    pegCheap:       'Cheap',
    pegFair:        'Fair',
    pegExpensive:   'Expensive',
    crashToggle:    '🌪️ Crash Test ON (Ray Dalio)',
    crashBadge:     '−25%',
    crashLabel:     '⚠️ If a −25% crash happened right now...',
    crashSub:       (diff) => `vs. normal: ${diff}`,
    labelDivPanel:  'Portfolio Diversification Analysis',
    labelHhi:       'HHI Concentration',
    labelTop1:      'Top Stock Weight',
    labelAvgCorr:   'Avg Correlation',
    labelCorrMatrix:'📐 Inter-stock Correlation Matrix (10s returns)',
  }
};

// ============================================================
// ポジションサイジング手法説明文
// ============================================================
const PSZ_METHOD_DESC = {
  ja: {
    fixed: '【固定比率法】プロが最も多用する基本手法。「1トレードで総資産の最大N%しか失わない」というルールに基づき、損切り幅から株数を逆算します。リスクを一定に保つことでドローダウンを抑制します。',
    kelly: '【ケリー基準】過去の勝率とRR比から数学的に最適なベット比率を算出します。フルケリーは破産リスクが高いため、通常は50%（ハーフケリー）以下で運用します。安定した統計が蓄積されてから使うのがプロの流儀です。',
    atr:   '【ATRベース（ボラティリティ調整）】ATR（真の値幅の平均）を使い、銘柄の実際の値動きに合わせて損切り幅を決め、そこからサイズを逆算します。高ボラ銘柄を小さく、低ボラ銘柄を大きく持つことでリスクを均一化します。',
    rr:    '【RR比チェック付き固定比率法】エントリー前にRR比（リスクリワード比）を検証し、基準を下回るトレードを排除します。「良いトレードだけを適切なサイズで実行する」という選別と sizing を同時に行います。'
  },
  en: {
    fixed: '[Fixed Fraction] The most widely used method among pros. Determines position size by back-calculating from the stop-loss distance so that the max loss equals a fixed % of total equity. Keeps risk consistent and limits drawdowns.',
    kelly: '[Kelly Criterion] Calculates the mathematically optimal bet size from historical win rate and R/R ratio. Full Kelly is too aggressive — most pros use Half Kelly (50%) or less. Best used once you have stable statistics from many trades.',
    atr:   '[ATR-based / Volatility-sizing] Uses ATR (Average True Range) to set stop distance dynamically based on a stock\'s actual volatility. Normalizes risk across high- and low-vol names by holding fewer shares in choppy stocks.',
    rr:    '[Fixed Fraction with R/R Filter] Validates the risk/reward ratio before sizing. Trades that don\'t meet your minimum R/R are flagged and rejected. Combines trade selection and sizing into one step — a core pro workflow.'
  }
};

// ============================================================
// LocalStorage 永続化
// ============================================================

/** メインデータ（銘柄・現金・保有・資産履歴）を保存する */
function saveData() {
  localStorage.setItem(LS.STOCKS,        JSON.stringify(STOCKS));
  localStorage.setItem(LS.CASH,          cash);
  localStorage.setItem(LS.HOLDINGS,      JSON.stringify(holdings));
  localStorage.setItem(LS.ASSET_HISTORY, JSON.stringify(assetHistory));
}

/** 実現損益ログを保存する（最大500件） */
function saveRealizedTrades() {
  localStorage.setItem(LS.REALIZED_TRADES, JSON.stringify(realizedTrades.slice(-500)));
}

/** 待機注文リストを保存する */
function savePendingOrders() {
  localStorage.setItem(LS.PENDING_ORDERS, JSON.stringify(pendingOrders));
}

/** 信用取引ポジションを保存する */
function saveMarginData() {
  localStorage.setItem(LS.SHORT_POSITIONS, JSON.stringify(shortPositions));
  localStorage.setItem(LS.LEVERAGE_LONGS,  JSON.stringify(leverageLongs));
}

// ============================================================
// リセット
// ============================================================

/**
 * 全データを LocalStorage から削除してページをリロードする
 * ユーザー確認ダイアログを表示してから実行する
 */
function resetGame() {
  if (!confirm(I18N[lang].confirmReset)) return;
  Object.values(LS).forEach(key => localStorage.removeItem(key));
  location.reload();
}

// ============================================================
// フォーマットユーティリティ
// ============================================================

/**
 * 円建て金額を表示用文字列にフォーマットする
 * lang==='ja' の場合：主表示=円、副表示=ドル（secondary=true で逆転）
 * lang==='en' の場合：主表示=ドル、副表示=円
 * @param {number}  valueJpy
 * @param {Object}  [opts]
 * @param {boolean} [opts.secondary=false] - 副通貨で表示する
 * @param {boolean} [opts.signed=false]    - 正数に + を付ける
 * @returns {string}
 */
function formatCurrency(valueJpy, { secondary = false, signed = false } = {}) {
  const useUsd  = lang === 'en' ? !secondary : secondary;
  const value   = useUsd ? valueJpy / fxRate : valueJpy;
  const absVal  = Math.abs(value);
  const sign    = signed && value > 0 ? '+' : value < 0 ? '-' : '';

  if (useUsd) {
    return `${sign}$${absVal.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return `${sign}¥${Math.round(absVal).toLocaleString('ja-JP')}`;
}

/**
 * Date を HH:MM:SS 形式の時刻文字列にフォーマットする
 * ja → JST、en → EST タイムゾーン
 * @param {Date} date
 * @returns {string}
 */
function formatClock(date) {
  return date.toLocaleTimeString(lang === 'en' ? 'en-US' : 'ja-JP', {
    timeZone : lang === 'en' ? 'America/New_York' : 'Asia/Tokyo',
    hour     : '2-digit',
    minute   : '2-digit',
    second   : '2-digit',
  });
}

/**
 * Date を HH:MM 形式の時刻文字列にフォーマットする（チャート X 軸ラベル用）
 * @param {Date} date
 * @returns {string}
 */
function formatChartClock(date) {
  return date.toLocaleTimeString(lang === 'en' ? 'en-US' : 'ja-JP', {
    timeZone: lang === 'en' ? 'America/New_York' : 'Asia/Tokyo',
    hour    : '2-digit',
    minute  : '2-digit',
    hour12  : false,
  });
}

// ============================================================
// 言語切り替え
// ============================================================

/**
 * 現在の lang に合わせて全ラベルを更新する
 * api-client.js の renderApiKeyHelp / renderApiKeyExplanation / updateApiKeyStatus を呼ぶ
 */
function applyLang() {
  const t = I18N[lang];
  const ids = {
    'app-title'             : 'innerHTML',
    'btn-reset-label'       : 'textContent',
    'label-cash'            : 'textContent',
    'label-qty'             : 'textContent',
    'label-avg'             : 'textContent',
    'label-pnl'             : 'textContent',
    'label-buy-qty'         : 'textContent',
    'btn-buy-label'         : 'textContent',
    'label-sell-qty'        : 'textContent',
    'btn-sell-label'        : 'textContent',
    'label-total'           : 'textContent',
    'label-sharpe'          : 'textContent',
    'label-drawdown'        : 'textContent',
    'desc-sharpe'           : 'textContent',
    'desc-drawdown'         : 'textContent',
    'label-buffett-theory'  : 'textContent',
    'label-buffett-margin'  : 'textContent',
    'desc-buffett-theory'   : 'textContent',
    'desc-buffett-margin'   : 'textContent',
    'label-peg-ratio'       : 'textContent',
    'desc-peg-ratio'        : 'textContent',
    'label-crash-toggle'    : 'textContent',
    'crash-badge-pct'       : 'textContent',
    'crash-result-label'    : 'textContent',
    'label-div-panel'       : 'textContent',
    'label-hhi'             : 'textContent',
    'label-top1w'           : 'textContent',
    'label-avg-corr'        : 'textContent',
    'label-corr-matrix'     : 'textContent',
  };

  const labelMap = {
    'app-title'            : t.appTitle,
    'btn-reset-label'      : t.reset,
    'label-cash'           : t.cash,
    'label-qty'            : t.qty,
    'label-avg'            : t.avg,
    'label-pnl'            : t.pnl,
    'label-buy-qty'        : t.buyQty,
    'btn-buy-label'        : t.buyBtn,
    'label-sell-qty'       : t.sellQty,
    'btn-sell-label'       : t.sellBtn,
    'label-total'          : t.total,
    'label-sharpe'         : t.sharpe,
    'label-drawdown'       : t.drawdown,
    'desc-sharpe'          : t.sharpeDesc,
    'desc-drawdown'        : t.drawdownDesc,
    'label-buffett-theory' : t.buffettTheory,
    'label-buffett-margin' : t.buffettMargin,
    'desc-buffett-theory'  : t.buffettTheoryDesc,
    'desc-buffett-margin'  : t.buffettMarginDesc,
    'label-peg-ratio'      : t.pegRatio,
    'desc-peg-ratio'       : t.pegRatioDesc,
    'label-crash-toggle'   : t.crashToggle,
    'crash-badge-pct'      : t.crashBadge,
    'crash-result-label'   : t.crashLabel,
    'label-div-panel'      : t.labelDivPanel,
    'label-hhi'            : t.labelHhi,
    'label-top1w'          : t.labelTop1,
    'label-avg-corr'       : t.labelAvgCorr,
    'label-corr-matrix'    : t.labelCorrMatrix,
  };

  Object.entries(labelMap).forEach(([id, value]) => {
    const el = document.getElementById(id);
    if (!el) return;
    ids[id] === 'innerHTML' ? (el.innerHTML = value) : (el.textContent = value);
  });

  // 検索・APIキー UI
  const searchEl = document.getElementById('stock-search');
  if (searchEl) searchEl.placeholder = t.searchPlaceholder;

  const btnAddEl = document.getElementById('btn-add');
  if (btnAddEl) btnAddEl.textContent = t.searchBtn;

  [
    ['api-key-title',       t.apiKeyTitle],
    ['api-key-save',        t.apiKeySave],
    ['api-key-delete',      t.apiKeyDelete],
    ['api-key-manage',      t.apiKeyManage],
    ['api-key-note',        t.apiKeyNotice],
  ].forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  });

  const inputEl = document.getElementById('api-key-input');
  if (inputEl) inputEl.placeholder = t.apiKeyPlaceholder;

  const langBtn = document.getElementById('lang-btn');
  if (langBtn) langBtn.textContent = lang === 'ja' ? 'EN' : 'JP';

  // OCO パネルラベル
  const isJa = lang === 'ja';
  const ocoMap = {
    'oco-panel-title' : isJa ? 'OCO注文（利確・損切り同時設定）' : 'OCO Order (Take-profit + Stop-loss)',
    'label-oco-qty'   : isJa ? '数量'              : 'Quantity',
    'label-oco-side'  : isJa ? '売買方向'           : 'Direction',
    'oco-side-sell'   : isJa ? '売（保有株の決済）'  : 'Sell (close position)',
    'oco-side-buy'    : isJa ? '買（新規購入）'      : 'Buy (new entry)',
    'label-oco-profit': isJa ? '🟢 利確価格（指値）' : '🟢 Profit target (limit)',
    'label-oco-stop'  : isJa ? '🔴 損切り価格（逆指値）' : '🔴 Stop-loss price (stop)',
    'btn-oco-label'   : isJa ? 'OCO注文を出す'       : 'Place OCO Order',
    'label-pending-orders': isJa ? '待機中の注文'     : 'Pending Orders',
  };
  Object.entries(ocoMap).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  });

  // api-client.js 側の関数を呼び出す（依存）
  renderApiKeyExplanation();
  renderApiKeyHelp();
  updateApiKeyStatus();

  // 決算パネルラベル
  const earningsLabelEl = document.getElementById('label-earnings-panel');
  if (earningsLabelEl) {
    earningsLabelEl.textContent = lang === 'ja' ? '決算カレンダー＋EPSサプライズ' : 'Earnings Calendar & EPS Surprise';
  }

  // 外部リンクラベル（言語切替時に再描画）
  updateTipRanksLink(currentStock);
  updateMacrotrendsLink(currentStock);
}

/**
 * 言語を ja/en 切り替えて保存し、ラベルと UI を更新する
 */
function toggleLang() {
  lang = lang === 'ja' ? 'en' : 'ja';
  localStorage.setItem(LS.LANG, lang);
  applyLang();
  updateUI();
}

// ============================================================
// トースト通知
// ============================================================

let _toastTimer = null;

/**
 * 画面下部にトースト通知を表示する（4秒後に自動消去）
 * @param {string} msg - 表示するメッセージ
 */
function showToast(msg) {
  const el = document.getElementById('order-triggered-toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(_toastTimer);
  _toastTimer = setTimeout(() => el.classList.remove('show'), 4000);
}

// ============================================================
// 初期化（DOMContentLoaded）
// ============================================================

/**
 * ページ読み込み時の初期処理
 * - 言語ラベル適用
 * - 全銘柄の価格・財務データ取得
 * - タブ・UI 構築
 */
document.addEventListener('DOMContentLoaded', async () => {
  applyLang();
  await refreshFxRate();

  for (const k of Object.keys(STOCKS)) {
    await fetchLatestPrice(k);
    fetchBuffettMetrics(k);
    fetchEarningsHistory(k);
    fetchNextEarningsDate(k);
  }

  buildTabs();
  renderPendingOrders();
  switchPszMethod(pszMethod);
  updateUI();
});
