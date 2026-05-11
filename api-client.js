// ============================================================
// api-client.js — データ取得層
// 外部APIとの通信を一元管理する
//   - Finnhub API: 株価・財務データ・銘柄検索
//   - Frankfurter API: USD/JPY 為替レート
//   - Google Translate API: 日本語クエリの翻訳
// ============================================================

// ===== 為替レート状態 =====
// fxRate / fxRateUpdatedAt / FX_REFRESH_MS は state-manager.js で宣言済み

// ============================================================
// Finnhub APIキー ユーティリティ
// ============================================================

function getFinnhubApiKey() {
  return localStorage.getItem(LS.FINNHUB_KEY) || '';
}

/**
 * Finnhub APIエンドポイントURLを生成する
 * @param {string} path  - 例: 'quote', 'stock/metric', 'search'
 * @param {Object} params - クエリパラメータ（token は自動付与）
 * @returns {string} 完成したURL文字列
 * @throws {Error} APIキー未設定の場合 'FINNHUB_API_KEY_MISSING'
 */
function buildFinnhubUrl(path, params = {}) {
  const apiKey = getFinnhubApiKey();
  if (!apiKey) throw new Error('FINNHUB_API_KEY_MISSING');

  const url = new URL(`https://finnhub.io/api/v1/${path}`);
  Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
  url.searchParams.set('token', apiKey);
  return url.toString();
}

// ============================================================
// 為替レート取得（Frankfurter API）
// ============================================================

/**
 * USD/JPY レートを取得してキャッシュに保存する
 * 5分以内に取得済みの場合は何もしない（クールダウン）
 */
async function refreshFxRate() {
  if (Date.now() - fxRateUpdatedAt < FX_REFRESH_MS) return;
  try {
    const res  = await fetch('https://api.frankfurter.app/latest?from=USD&to=JPY');
    const data = await res.json();
    const rate = data?.rates?.JPY;
    if (rate && isFinite(rate) && rate > 50 && rate < 500) { // 異常値ガード
      fxRate           = rate;
      fxRateUpdatedAt  = Date.now();
      localStorage.setItem('sim_fx_rate', fxRate.toString());
      updateFxDisplay();
    }
  } catch (e) {
    // 取得失敗時はキャッシュ値 or フォールバック 150 を継続使用
  }
}

// ============================================================
// 株価取得（Finnhub /quote）
// ============================================================

/**
 * 指定銘柄が日本株かどうか判定する
 * @param {string} k - 銘柄コード（例: '7203.T'）
 * @returns {boolean}
 */
function isJpStock(k) { return k.endsWith('.T'); }

/**
 * 指定銘柄の最新株価を1点取得し prices[] に追記する
 * 日本株は円建てのまま、米国株は fxRate で円換算する
 * 取得成功後に checkPendingOrders() を呼び出す
 * @param {string} k - 銘柄コード
 * @returns {Promise<boolean>} 取得成功なら true
 */
async function fetchLatestPrice(k) {
  try {
    const res  = await fetch(buildFinnhubUrl('quote', { symbol: k }));
    const data = await res.json();

    if (data.c && data.c !== 0) {
      // 価格取得成功
      const newPrice = isJpStock(k) ? Math.round(data.c) : Math.round(data.c * fxRate);
      if (!prices[k]) prices[k] = [];
      if (prices[k].length === 0) {
        for (let i = 0; i < 60; i++) prices[k].push(newPrice);
      } else {
        prices[k].push(newPrice);
        if (prices[k].length > 60) prices[k].shift();
      }
      delete STOCKS[k]._fetchError;
      checkPendingOrders(k);
      return true;
    } else {
      // data.c が 0 / null → Finnhub 無料プランで非対応銘柄（日本株など）
      if (!prices[k]) prices[k] = [];
      STOCKS[k]._fetchError = isJpStock(k) ? 'JP_NOT_SUPPORTED' : 'NO_DATA';
      return false;
    }
  } catch (e) {
    if (e.message === 'FINNHUB_API_KEY_MISSING') {
      document.getElementById('sync-time').textContent = I18N[lang].apiKeyRequired;
    } else {
      console.error('fetchLatestPrice error:', k, e);
    }
    if (!prices[k]) prices[k] = [];
    return false;
  }
}

// ============================================================
// バフェット指標取得（Finnhub /stock/metric）
// ============================================================

/**
 * グレアム数・PEG計算に必要な財務データを取得する
 * EPS・BPS・PER・EPS成長率を stockFinancials[k] に格納する
 * すでにデータ取得中 or 取得済みの場合はスキップ
 * @param {string} k - 銘柄コード
 */
async function fetchBuffettMetrics(k) {
  if (!getFinnhubApiKey()) return;
  if (stockFinancials[k] && (stockFinancials[k].loading || stockFinancials[k].eps !== undefined)) return;

  stockFinancials[k] = { loading: true };
  // バフェット指標取得中を即時表示
  document.getElementById('buffett-theory-val').textContent = '取得中...';
  document.getElementById('buffett-margin-val').textContent = '取得中...';

  try {
    const res  = await fetch(buildFinnhubUrl('stock/metric', { symbol: k, metric: 'all' }));
    const data = await res.json();
    const m    = data.metric || {};

    // EPS: epsBasicExclExtraTTM (TTM基本EPS) → なければ epsNormalizedAnnual
    const eps = m.epsBasicExclExtraTTM ?? m.epsNormalizedAnnual ?? null;
    // BPS: bookValuePerShareQuarterly → なければ bookValuePerShareAnnual
    const bps = m.bookValuePerShareQuarterly ?? m.bookValuePerShareAnnual ?? null;
    // PEG計算用: PER(pe) と EPS成長率
    // PER: peTTM (TTMベース) → なければ peNormalizedAnnual
    const pe  = m.peTTM ?? m.peNormalizedAnnual ?? null;
    // EPS成長率: eps5YearGrowth → eps3YearGrowth → epsGrowth3Y → epsGrowth5Y (Finnhubフィールド名の揺れ対応)
    const epsGrowth = m['5YearEPSGrowth'] ?? m['3YearEPSGrowth'] ?? m.epsTTMToTTMGrowth ?? null;
    const isJp = isJpStock(k);

    if (eps !== null && bps !== null) {
      stockFinancials[k] = { eps, bps, pe, epsGrowth, jpy: isJp, loading: false };
    } else {
      stockFinancials[k] = { pe, epsGrowth, loading: false, error: 'NO_DATA' };
    }
  } catch (e) {
    stockFinancials[k] = { loading: false, error: 'FETCH_ERROR' };
  }

  // 取得完了後に現在の銘柄なら即描画
  if (k === currentStock) updateBuffettMetrics(k);
}

// ============================================================
// 銘柄検索（Finnhub /search + Google Translate）
// ============================================================

/**
 * 日本語クエリを英語に翻訳する（Google Translate 非公式API使用）
 * 日本語文字が含まれない場合はそのまま返す
 * @param {string} query - 検索クエリ
 * @returns {Promise<string>} 英語クエリ（翻訳失敗時は原文）
 */
async function getSearchQuery(query) {
  const hasJapanese = /[\u3040-\u30ff\u3400-\u9fff]/.test(query);
  if (!hasJapanese) return query;

  const transUrl  = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=ja&tl=en&dt=t&q=${encodeURIComponent(query)}`;
  const transRes  = await fetch(transUrl);
  const transData = await transRes.json();
  return transData?.[0]?.[0]?.[0] || query;
}

/**
 * 銘柄を検索して結果を UI に表示する
 * 日本株の4桁コードは .T を付与して直接検索
 * 検索結果クリックで銘柄を追加・価格取得・画面更新を行う
 */
async function searchAndAddStock() {
  const query = document.getElementById('stock-search').value.trim();
  if (!query) return;
  if (!getFinnhubApiKey()) return alert(I18N[lang].apiKeyRequired);

  const t       = I18N[lang];
  const resList = document.getElementById('searchResultList');
  resList.innerHTML     = `<li>${t.searchLoading}</li>`;
  resList.style.display = 'block';

  try {
    // 日本株 4桁数字の場合は翻訳せず .T を付与して直接検索
    const isJpCode = /^\d{4}$/.test(query);
    let searchQuery;
    if (isJpCode) {
      searchQuery = query + '.T';
    } else {
      searchQuery = await getSearchQuery(query);
    }

    const response = await fetch(buildFinnhubUrl('search', { q: searchQuery }));
    const data     = await response.json();
    resList.innerHTML = '';

    if (data.result && data.result.length > 0) {
      // 日本語検索の場合は .T 銘柄を優先的に上に出す
      const hasJapanese = /[\u3040-\u30ff\u3400-\u9fff]/.test(query);
      let results = data.result.filter(item => item.symbol && item.description);
      if (hasJapanese || isJpCode) {
        const jpResults = results.filter(item =>  item.symbol.endsWith('.T'));
        const usResults = results.filter(item => !item.symbol.endsWith('.T'));
        results = [...jpResults, ...usResults];
      }
      results = results.slice(0, 6);

      results.forEach(item => {
        const li   = document.createElement('li');
        const flag = item.symbol.endsWith('.T') ? '🇯🇵 ' : '🇺🇸 ';
        li.textContent = `${flag}${item.symbol} | ${item.description}`;
        li.onclick = async () => {
          STOCKS[item.symbol] = { name: item.description, color: `hsl(${Math.random() * 360}, 70%, 50%)` };
          await fetchLatestPrice(item.symbol);
          fetchBuffettMetrics(item.symbol);
          fetchEarningsHistory(item.symbol);
          fetchNextEarningsDate(item.symbol);
          currentStock = item.symbol;
          saveData(); buildTabs(); updateUI();
          resList.style.display = 'none';
          document.getElementById('stock-search').value = '';
        };
        resList.appendChild(li);
      });

      if (!resList.children.length) resList.innerHTML = `<li>${t.searchEmpty}</li>`;
    } else {
      resList.innerHTML = `<li>${t.searchEmpty}</li>`;
    }
  } catch (e) {
    console.error(e);
    resList.innerHTML = `<li>${t.searchError}</li>`;
  }
}

// ============================================================
// APIキー管理（保存・削除・状態表示）
// ============================================================

/** APIキーを LocalStorage に保存し、全銘柄の価格・財務を再取得する */
async function saveFinnhubApiKey() {
  const input = document.getElementById('api-key-input');
  const key   = input.value.trim();
  if (!key) return alert(I18N[lang].apiKeyRequired);

  localStorage.setItem(LS.FINNHUB_KEY, key);
  input.value = '';
  updateApiKeyStatus();
  alert(I18N[lang].apiKeySavedMessage);

  for (const k of Object.keys(STOCKS)) {
    await fetchLatestPrice(k);
    fetchBuffettMetrics(k);
    fetchEarningsHistory(k);
    fetchNextEarningsDate(k);
  }
  buildTabs();
  updateUI();
}

/** APIキーを LocalStorage から削除する */
function deleteFinnhubApiKey() {
  localStorage.removeItem(LS.FINNHUB_KEY);
  document.getElementById('api-key-input').value = '';
  updateApiKeyStatus();
  alert(I18N[lang].apiKeyDeletedMessage);
}

// ============================================================
// 定期ポーリング（10秒ごとに全銘柄の価格を同期）
// ============================================================

/**
 * 10秒ごとに全登録銘柄の最新価格と為替レートを取得する
 * 財務データ未取得の銘柄があれば合わせて取得する
 * APIキー未設定時はスキップ
 */
setInterval(async () => {
  if (!getFinnhubApiKey()) return;
  await refreshFxRate(); // 為替レートを最新化（5分クールダウン付き）
  for (const k of Object.keys(STOCKS)) {
    await fetchLatestPrice(k);
    // 財務データ未取得の銘柄があれば取得（ページ再読み込み後の対応）
    if (!stockFinancials[k] || stockFinancials[k].error) {
      fetchBuffettMetrics(k);
    }
  }
  checkMarginCall(); // ロスカット自動執行（updateUI の直前）
  updateUI();
}, 10000); // API負荷を考慮し10秒間隔

// ============================================================
// 決算データ取得（Finnhub /stock/earnings + /calendar/earnings）
// ============================================================

/**
 * 指定銘柄の過去EPSサプライズ履歴を取得して earningsData[k] に格納する
 * すでに取得済み or 取得中の場合はスキップ
 * @param {string} k - 銘柄コード
 */
async function fetchEarningsHistory(k) {
  if (!getFinnhubApiKey()) return;
  if (earningsData[k] && (earningsData[k].loading || earningsData[k].history)) return;
  if (isJpStock(k)) {
    earningsData[k] = { loading: false, error: 'JP_NOT_SUPPORTED' };
    return;
  }

  earningsData[k] = { loading: true };
  try {
    const res  = await fetch(buildFinnhubUrl('stock/earnings', { symbol: k, limit: 8 }));
    const data = await res.json();

    if (Array.isArray(data) && data.length > 0) {
      earningsData[k] = {
        loading : false,
        history : data.map(e => ({
          period   : e.period,
          actual   : e.actual,
          estimate : e.estimate,
          surprise : e.surprise,        // 絶対値差 (actual - estimate)
          surprisePct: e.surprisePercent, // サプライズ率(%)
        })),
      };
    } else {
      earningsData[k] = { loading: false, error: 'NO_DATA' };
    }
  } catch (e) {
    earningsData[k] = { loading: false, error: 'FETCH_ERROR' };
  }

  if (k === currentStock) updateEarningsPanel(k);
}

/**
 * 今後の決算予定日を取得して nextEarnings[k] に格納する
 * Finnhub /calendar/earnings で from/to を2ヶ月先まで指定
 * @param {string} k - 銘柄コード
 */
async function fetchNextEarningsDate(k) {
  if (!getFinnhubApiKey()) return;
  if (isJpStock(k)) return;

  const today  = new Date();
  const from   = today.toISOString().slice(0, 10);
  const toDate = new Date(today);
  toDate.setDate(toDate.getDate() + 90); // 90日先まで
  const to = toDate.toISOString().slice(0, 10);

  try {
    const res  = await fetch(buildFinnhubUrl('calendar/earnings', { symbol: k, from, to }));
    const data = await res.json();
    const items = data?.earningsCalendar;
    if (Array.isArray(items) && items.length > 0) {
      // 最も近い未来の決算を取得
      const upcoming = items
        .filter(e => e.date >= from)
        .sort((a, b) => a.date.localeCompare(b.date))[0];
      if (upcoming) {
        nextEarnings[k] = {
          date      : upcoming.date,
          epsEstimate: upcoming.epsEstimate,
          revenueEstimate: upcoming.revenueEstimate,
        };
      } else {
        nextEarnings[k] = null;
      }
    } else {
      nextEarnings[k] = null;
    }
  } catch (e) {
    nextEarnings[k] = null;
  }

  if (k === currentStock) updateEarningsPanel(k);
}
