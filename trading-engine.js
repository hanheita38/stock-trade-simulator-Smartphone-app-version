// ============================================================
// trading-engine.js — 計算・ロジック層
// ビジネスロジック・売買処理・各種指標計算を一元管理する
//   - 売買処理（成行・指値・逆指値・OCO注文）
//   - 待機注文の管理・約定チェック
//   - リスク指標計算（シャープレシオ・最大ドローダウン）
//   - バフェット指標（グレアム数・安全域・PEGレシオ）
//   - 暴落テスト（ダリオ流）
//   - ポートフォリオ分散分析（HHI・相関マトリクス）
//   - ポジションサイジング計算（固定比率・ケリー・ATR・RR）
//   - 信用取引（空売り・レバレッジロング）
//   - 資産スナップショット記録
// ============================================================

// ===== 定数 =====
const CRASH_RATE = 0.25; // ダリオ流暴落テスト: 25%暴落想定

// ============================================================
// 総資産計算
// ============================================================

/**
 * 現金 + 保有株評価額 + 信用取引含み損益 の合計を返す
 * @returns {number} 総資産額（円建て）
 */
function getTotalAssets() {
  let total = cash;
  Object.keys(holdings).forEach(k => {
    if (holdings[k].qty > 0 && prices[k] && prices[k].length > 0) {
      total += prices[k][prices[k].length - 1] * holdings[k].qty;
    }
  });
  // 信用取引の含み損益も含む
  Object.values(shortPositions).forEach(pos => {
    const p = prices[pos.symbol];
    if (p && p.length > 0) total += (pos.entryPrice - p[p.length - 1]) * pos.qty;
  });
  Object.values(leverageLongs).forEach(pos => {
    const p = prices[pos.symbol];
    if (p && p.length > 0) total += (p[p.length - 1] - pos.entryPrice) * pos.qty * pos.leverage;
  });
  return total;
}

// ============================================================
// 資産スナップショット記録
// ============================================================

/**
 * 現在の総資産を assetHistory に記録する
 * 5秒以内に直前のスナップショットがある場合は上書きする
 * @param {number} totalVal - 総資産額
 */
function recordAssetSnapshot(totalVal) {
  if (!Number.isFinite(totalVal) || totalVal <= 0) return;

  const now  = Date.now();
  const last = assetHistory[assetHistory.length - 1];
  if (last && now - last.t < 5000) {
    last.v = Math.round(totalVal);
    last.t = now;
  } else {
    assetHistory.push({ t: now, v: Math.round(totalVal) });
  }

  if (assetHistory.length > 500) assetHistory = assetHistory.slice(-500);
  localStorage.setItem('sim_asset_history', JSON.stringify(assetHistory));
}

// ============================================================
// リスク指標計算
// ============================================================

/**
 * 資産履歴からシャープレシオを計算する（時間加重・年率換算版）
 *
 * 修正点（旧実装の3つのバグを修正）:
 *  1. 時間軸無視バグ → スナップショット間の実経過時間(ms)でリターンを重み付け
 *     スナップショット間隔は5秒〜数分とバラバラなため、単純リターンを並べると
 *     短間隔のノイズが過大評価され、長間隔の変動が過小評価される。
 *     解決: リターンを「1秒あたりの対数リターン」に正規化してから集計する。
 *
 *  2. 年率換算バグ → √(returns.length) は「観測数の√」であり年率換算ではない
 *     正しくは √(年間観測数) を掛ける必要がある。
 *     解決: 全期間の実経過時間から平均間隔を算出し、1年分の観測数を逆算して換算。
 *
 *  3. prev !== cur フィルタバグ → 資産変動がない期間を除外するとボラが過小評価
 *     変動ゼロの期間は「リスクを取っていない安全な期間」なので除外すべきでない。
 *     解決: フィルタを撤廃し、ゼロリターン期間も含めて計算する。
 *
 * @returns {number|null} 年率換算シャープレシオ（データ不足の場合 null）
 */
function calcSharpeRatio() {
  if (assetHistory.length < 10) return null; // 最低10点必要

  // ── Step1: 時間加重対数リターン（1秒あたり）の配列を構築 ──
  const logReturnsPerSec = [];
  for (let i = 1; i < assetHistory.length; i++) {
    const prev   = assetHistory[i - 1].v;
    const cur    = assetHistory[i].v;
    const dtMs   = assetHistory[i].t - assetHistory[i - 1].t;
    if (prev <= 0 || cur <= 0 || dtMs <= 0) continue;

    const dtSec     = dtMs / 1000;
    const logReturn = Math.log(cur / prev);           // 対数リターン（時間加法性あり）
    logReturnsPerSec.push(logReturn / dtSec);          // 1秒あたりに正規化
  }

  if (logReturnsPerSec.length < 9) return null;

  // ── Step2: 平均・標準偏差（1秒あたり）を計算 ──
  const n    = logReturnsPerSec.length;
  const mean = logReturnsPerSec.reduce((s, r) => s + r, 0) / n;
  const variance = logReturnsPerSec.reduce((s, r) => s + Math.pow(r - mean, 2), 0) / (n - 1);
  const stdev = Math.sqrt(variance);
  if (!Number.isFinite(stdev) || stdev === 0) return null;

  // ── Step3: 年率換算 ──
  // 全スパンの実経過秒数から平均間隔を逆算し、1年(31,536,000秒)あたりの観測数を算出
  const totalSec      = (assetHistory[assetHistory.length - 1].t - assetHistory[0].t) / 1000;
  const avgIntervalSec = totalSec / n;
  const secsPerYear    = 365 * 24 * 3600; // 31,536,000
  const annFactor      = Math.sqrt(secsPerYear / Math.max(avgIntervalSec, 1));

  // 無リスク金利 = 0（シミュレーター用途として妥当）
  return (mean / stdev) * annFactor;
}

/**
 * 資産履歴から最大ドローダウンを計算する
 * @returns {number|null} 最大ドローダウン（0〜1の小数）（データ不足の場合 null）
 */
function calcMaxDrawdown() {
  if (assetHistory.length < 2) return null;

  let peak = assetHistory[0].v;
  let maxDrawdown = 0;
  assetHistory.forEach(point => {
    if (point.v > peak) peak = point.v;
    if (peak > 0) {
      const drawdown = (peak - point.v) / peak;
      if (drawdown > maxDrawdown) maxDrawdown = drawdown;
    }
  });

  return maxDrawdown;
}

// ============================================================
// バフェット指標（グレアム数・安全域）
// ============================================================

/**
 * グレアム数と安全域を計算してUIに反映する
 * データ未取得の場合は fetchBuffettMetrics() を呼び出す
 * @param {string} k - 銘柄コード
 */
function updateBuffettMetrics(k) {
  const fin        = stockFinancials[k];
  const theoryBox  = document.getElementById('buffett-theory-box');
  const marginBox  = document.getElementById('buffett-margin-box');
  const theoryValEl= document.getElementById('buffett-theory-val');
  const marginValEl= document.getElementById('buffett-margin-val');

  // まだデータ取得していない（初回）→ 非同期取得を開始
  if (!fin) {
    fetchBuffettMetrics(k);
    theoryValEl.textContent = '取得中...';
    marginValEl.textContent = '取得中...';
    marginBox.className = 'metric-box';
    return;
  }

  // 取得中
  if (fin.loading) {
    theoryValEl.textContent = '取得中...';
    marginValEl.textContent = '取得中...';
    marginBox.className = 'metric-box';
    return;
  }

  // エラー or EPS/BPS が取得できなかった or 負数（グレアム数算出不可）
  if (fin.error || fin.eps === undefined || fin.eps <= 0 || fin.bps === undefined || fin.bps <= 0) {
    theoryValEl.textContent = I18N[lang].buffettNoData;
    marginValEl.textContent = I18N[lang].buffettNoData;
    marginBox.className = 'metric-box';
    return;
  }

  // グレアム数を円で算出
  // 日本株（jpy:true）はEPS/BPSがJPY建て → そのまま計算
  // 米国株（jpy:false）はEPS/BPSがUSD建て → fxRate で円換算
  const grahamBase = Math.sqrt(22.5 * fin.eps * fin.bps);
  const grahamJpy  = fin.jpy ? Math.round(grahamBase) : Math.round(grahamBase * fxRate);
  theoryValEl.textContent = formatCurrency(grahamJpy);

  // EPS/BPS の出所を補足表示
  const epsLabel   = fin.jpy ? `¥${fin.eps.toFixed(2)}` : `$${fin.eps.toFixed(2)}`;
  const bpsLabel   = fin.jpy ? `¥${fin.bps.toFixed(2)}` : `$${fin.bps.toFixed(2)}`;
  const sourceNote = lang === 'ja'
    ? `EPS: ${epsLabel} / BPS: ${bpsLabel} (Finnhub最新値)`
    : `EPS: ${epsLabel} / BPS: ${bpsLabel} (live via Finnhub)`;
  const theoryHelpEl = document.getElementById('desc-buffett-theory');
  if (theoryHelpEl) theoryHelpEl.textContent = lang === 'ja'
    ? `√(22.5 × EPS × BPS) で算出。${sourceNote}`
    : `Calculated as √(22.5 × EPS × BPS). ${sourceNote}`;

  // 現在価格（prices は常に円建てで格納されている）
  const data = prices[k];
  if (!data || data.length === 0) { marginValEl.textContent = '--'; return; }
  const curJpy = data[data.length - 1];

  // 安全域 = (理論値 - 現在値) / 現在値 × 100
  const margin = ((grahamJpy - curJpy) / curJpy) * 100;
  const sign   = margin >= 0 ? '+' : '';
  marginValEl.textContent = `${sign}${margin.toFixed(1)}%`;
  marginBox.className = `metric-box ${margin >= 0 ? 'buffett-margin-pos' : 'buffett-margin-neg'}`;
}

// ============================================================
// PEGレシオ
// ============================================================

/**
 * PEGレシオを計算してUIに反映する
 * @param {string} k - 銘柄コード
 */
function updatePegRatio(k) {
  const pegBox  = document.getElementById('peg-ratio-box');
  const pegVal  = document.getElementById('peg-ratio-val');
  const pegDesc = document.getElementById('desc-peg-ratio');
  const fin     = stockFinancials[k];
  const t       = I18N[lang];

  if (!fin || fin.loading) {
    pegVal.innerHTML = lang === 'ja' ? '取得中...' : 'Loading...';
    pegBox.className = 'metric-box';
    return;
  }

  const pe = fin.pe;
  let growthPct = fin.epsGrowth;

  if (pe === null || pe === undefined || !isFinite(pe) || pe <= 0) {
    pegVal.textContent = t.pegNoData;
    pegBox.className   = 'metric-box';
    pegDesc.textContent= t.pegRatioDesc;
    return;
  }

  if (growthPct === null || growthPct === undefined || !isFinite(growthPct) || growthPct <= 0) {
    pegVal.textContent = `PER: ${pe.toFixed(1)}`;
    pegBox.className   = 'metric-box';
    pegDesc.textContent= lang === 'ja'
      ? `PER: ${pe.toFixed(1)}（EPS成長率データなし、PEG算出不可）`
      : `P/E: ${pe.toFixed(1)} (EPS growth data unavailable)`;
    return;
  }

  // growthPct が小数（例: 0.25 = 25%）の場合は100倍して%変換
  if (Math.abs(growthPct) < 3) growthPct = growthPct * 100;

  const peg = pe / growthPct;

  let badgeClass, badgeText;
  if (peg < 1) {
    badgeClass = 'cheap'; badgeText = t.pegCheap;
    pegBox.className = 'metric-box peg-cheap';
  } else if (peg < 2) {
    badgeClass = 'fair'; badgeText = t.pegFair;
    pegBox.className = 'metric-box peg-fair';
  } else {
    badgeClass = 'expensive'; badgeText = t.pegExpensive;
    pegBox.className = 'metric-box peg-expensive';
  }

  pegVal.innerHTML    = `${peg.toFixed(2)}<span class="peg-badge ${badgeClass}">${badgeText}</span>`;
  pegDesc.textContent = lang === 'ja'
    ? `PER ${pe.toFixed(1)} ÷ EPS成長率 ${growthPct.toFixed(1)}% = ${peg.toFixed(2)}。1未満が割安の目安。`
    : `P/E ${pe.toFixed(1)} ÷ EPS growth ${growthPct.toFixed(1)}% = ${peg.toFixed(2)}. Under 1 is undervalued.`;
}

// ============================================================
// 暴落テスト（ダリオ流）
// ============================================================

/**
 * 全保有銘柄が25%下落したと仮定した場合の総資産を計算してUIに反映する
 */
function updateCrashTest() {
  const toggle    = document.getElementById('crash-toggle').checked;
  const resultBox = document.getElementById('crash-result-box');

  if (!toggle) { resultBox.classList.remove('active'); return; }

  let stockVal = 0;
  Object.keys(holdings).forEach(k => {
    if (holdings[k].qty > 0 && prices[k] && prices[k].length > 0) {
      stockVal += prices[k][prices[k].length - 1] * holdings[k].qty;
    }
  });

  if (stockVal === 0) { resultBox.classList.remove('active'); return; }

  const crashedStockVal = stockVal * (1 - CRASH_RATE);
  const totalNormal     = cash + stockVal;
  const totalCrashed    = cash + crashedStockVal;
  const diff            = totalCrashed - totalNormal;

  document.getElementById('crash-result-value').textContent = formatCurrency(totalCrashed);
  document.getElementById('crash-result-sub').textContent   =
    I18N[lang].crashSub(formatCurrency(diff, { signed: true }));
  resultBox.classList.add('active');
}

/**
 * シャープレシオ・最大ドローダウン・バフェット指標・PEG・暴落テスト を一括更新する
 */
function updateRiskMetrics() {
  const sharpe   = calcSharpeRatio();
  const drawdown = calcMaxDrawdown();
  document.getElementById('sharpe-ratio').textContent  = sharpe   === null ? '--' : sharpe.toFixed(2);
  document.getElementById('max-drawdown').textContent  = drawdown === null ? '--' : `${(drawdown * 100).toFixed(2)}%`;
  updateBuffettMetrics(currentStock);
  updatePegRatio(currentStock);
  updateCrashTest();
}

// ============================================================
// 売買処理（成行・指値・逆指値）
// ============================================================

/**
 * 買い・売り注文を処理する
 * 成行注文は即時約定。指値・逆指値は pendingOrders に追加する
 * @param {'buy'|'sell'} type
 */
function trade(type) {
  const qty = parseInt(document.getElementById(`${type}-qty`).value);
  if (!qty || qty <= 0) return;
  const p = prices[currentStock][prices[currentStock].length - 1];

  // 指値・逆指値は待機注文として登録
  if (currentOrderType === 'limit' || currentOrderType === 'stop') {
    const priceInput = document.getElementById(`${type}-limit-price`);
    const limitPrice = parseFloat(priceInput.value);
    if (!limitPrice || limitPrice <= 0) return alert(lang === 'ja' ? '価格を入力してください' : 'Enter a price');
    placePendingOrder(currentOrderType, type, qty, limitPrice);
    priceInput.value = '';
    const lbl = currentOrderType === 'limit'
      ? (lang === 'ja' ? '指値注文' : 'Limit order')
      : (lang === 'ja' ? '逆指値注文' : 'Stop order');
    showToast(lang === 'ja'
      ? `✅ ${lbl}を受付ました (${formatCurrency(limitPrice)})`
      : `✅ ${lbl} placed (${formatCurrency(limitPrice)})`
    );
    return;
  }

  // 成行注文（即時約定）
  if (!holdings[currentStock]) holdings[currentStock] = { qty: 0, avgCost: 0 };
  const h = holdings[currentStock];

  if (type === 'buy') {
    if (cash < p * qty) return alert(I18N[lang].alertCash);
    h.avgCost = (h.avgCost * h.qty + p * qty) / (h.qty + qty);
    h.qty    += qty;
    cash     -= p * qty;
  } else {
    if (h.qty < qty) return alert(I18N[lang].alertShares);
    const realizedPnl = (p - h.avgCost) * qty;
    realizedTrades.push({ symbol: currentStock, qty, buyAvg: h.avgCost, sellPrice: p, pnl: realizedPnl, ts: Date.now() });
    saveRealizedTrades();
    cash   += p * qty;
    h.qty  -= qty;
  }
  saveData(); updateUI();
}

// ============================================================
// 待機注文（指値・逆指値・OCO）
// ============================================================

/**
 * 待機注文を追加する
 * @param {'limit'|'stop'} type
 * @param {'buy'|'sell'} side
 * @param {number} qty
 * @param {number} price
 */
function placePendingOrder(type, side, qty, price) {
  const id = Date.now() + '_' + Math.random().toString(36).slice(2);
  pendingOrders.push({ id, type, side, symbol: currentStock, qty, price });
  savePendingOrders();
  renderPendingOrders();
}

/**
 * OCO注文（利確指値 + 損切逆指値のペア）を追加する
 */
function placeOcoOrder() {
  const qty         = parseInt(document.getElementById('oco-qty').value);
  const side        = document.getElementById('oco-side').value;
  const profitPrice = parseFloat(document.getElementById('oco-profit-price').value);
  const stopPrice   = parseFloat(document.getElementById('oco-stop-price').value);

  if (!qty || qty <= 0)               return alert(lang === 'ja' ? '数量を入力してください'             : 'Enter quantity');
  if (!profitPrice || profitPrice<=0) return alert(lang === 'ja' ? '利確価格を入力してください'         : 'Enter profit target price');
  if (!stopPrice   || stopPrice  <=0) return alert(lang === 'ja' ? '損切り価格を入力してください'       : 'Enter stop-loss price');
  if (profitPrice <= stopPrice)       return alert(lang === 'ja' ? '利確価格は損切り価格より高くしてください' : 'Profit price must be above stop price');

  const groupId = 'oco_' + Date.now();
  const id1     = groupId + '_profit';
  const id2     = groupId + '_stop';
  // OCOは利確（指値）+ 損切り（逆指値）の2注文セット
  pendingOrders.push({ id: id1, type: 'oco', side, symbol: currentStock, qty, price: profitPrice, ocoRole: 'profit', groupId });
  pendingOrders.push({ id: id2, type: 'oco', side, symbol: currentStock, qty, price: stopPrice,   ocoRole: 'stop',   groupId });
  savePendingOrders();
  renderPendingOrders();

  document.getElementById('oco-profit-price').value = '';
  document.getElementById('oco-stop-price').value   = '';
  showToast(lang === 'ja' ? '✅ OCO注文を受付ました' : '✅ OCO order placed');
}

/**
 * 指定IDの待機注文を取り消す（OCOはグループ単位で削除）
 * @param {string} id - 注文ID
 */
function cancelOrder(id) {
  const order = pendingOrders.find(o => o.id === id);
  if (!order) return;
  if (order.groupId) {
    pendingOrders = pendingOrders.filter(o => o.groupId !== order.groupId);
  } else {
    pendingOrders = pendingOrders.filter(o => o.id !== id);
  }
  savePendingOrders();
  renderPendingOrders();
}

/**
 * 最新価格に対して待機注文の約定判定を行い、約定処理を実行する
 * 約定した注文とそのOCO相方は pendingOrders から除去する
 * @param {string} symbol - 対象銘柄コード
 */
function checkPendingOrders(symbol) {
  const data = prices[symbol];
  if (!data || data.length === 0) return;
  const cur = data[data.length - 1];

  const toExecute    = [];
  const cancelGroups = new Set();

  pendingOrders.forEach(o => {
    if (o.symbol !== symbol) return;

    let triggered = false;
    if (o.type === 'limit') {
      // 指値買い: 現在値 ≤ 指値 → 約定 / 指値売り: 現在値 ≥ 指値 → 約定
      triggered = o.side === 'buy' ? cur <= o.price : cur >= o.price;
    } else if (o.type === 'stop') {
      // 逆指値買い: 現在値 ≥ トリガー価格 / 逆指値売り: 現在値 ≤ トリガー価格
      triggered = o.side === 'buy' ? cur >= o.price : cur <= o.price;
    } else if (o.type === 'oco') {
      // すでに同グループの別注文が約定済みならスキップ
      if (cancelGroups.has(o.groupId)) return;
      const isProfit = o.ocoRole === 'profit';
      const isStop   = o.ocoRole === 'stop';
      if (isProfit) triggered = o.side === 'buy' ? cur <= o.price : cur >= o.price;
      if (isStop)   triggered = o.side === 'buy' ? cur >= o.price : cur <= o.price;
    }

    if (triggered) {
      toExecute.push(o);
      if (o.groupId) cancelGroups.add(o.groupId);
    }
  });

  if (toExecute.length === 0) return;

  toExecute.forEach(o => {
    if (!holdings[o.symbol]) holdings[o.symbol] = { qty: 0, avgCost: 0 };
    const h = holdings[o.symbol];
    let msg = '';

    if (o.side === 'buy') {
      if (cash >= o.price * o.qty) {
        h.avgCost = (h.avgCost * h.qty + o.price * o.qty) / (h.qty + o.qty);
        h.qty    += o.qty;
        cash     -= o.price * o.qty;
        const typeTag = o.type === 'oco'
          ? (o.ocoRole === 'profit' ? 'OCO利確' : 'OCO損切')
          : (o.type === 'limit' ? '指値' : '逆指値');
        msg = lang === 'ja'
          ? `✅ [${typeTag}]買い約定 ${o.symbol} ${o.qty}株 @ ${formatCurrency(o.price)}`
          : `✅ [${typeTag}] Buy filled: ${o.symbol} ${o.qty}sh @ ${formatCurrency(o.price)}`;
      } else {
        msg = lang === 'ja' ? '⚠️ 指値買い注文：現金不足で約定できませんでした' : '⚠️ Limit buy: insufficient cash';
      }
    } else {
      if (h.qty >= o.qty) {
        const realizedPnl = (o.price - h.avgCost) * o.qty;
        realizedTrades.push({ symbol: o.symbol, qty: o.qty, buyAvg: h.avgCost, sellPrice: o.price, pnl: realizedPnl, ts: Date.now() });
        saveRealizedTrades();
        cash   += o.price * o.qty;
        h.qty  -= o.qty;
        const typeTag = o.type === 'oco'
          ? (o.ocoRole === 'profit' ? 'OCO利確' : 'OCO損切')
          : (o.type === 'limit' ? '指値' : '逆指値');
        msg = lang === 'ja'
          ? `✅ [${typeTag}]売り約定 ${o.symbol} ${o.qty}株 @ ${formatCurrency(o.price)}`
          : `✅ [${typeTag}] Sell filled: ${o.symbol} ${o.qty}sh @ ${formatCurrency(o.price)}`;
      } else {
        msg = lang === 'ja' ? '⚠️ 指値売り注文：株数不足で約定できませんでした' : '⚠️ Limit sell: insufficient shares';
      }
    }
    if (msg) showToast(msg);
  });

  // 約定した注文 & OCO相方を削除
  const executedIds = new Set(toExecute.map(o => o.id));
  pendingOrders = pendingOrders.filter(o => {
    if (executedIds.has(o.id)) return false;
    if (o.groupId && cancelGroups.has(o.groupId)) return false;
    return true;
  });

  savePendingOrders();
  saveData();
  renderPendingOrders();
  updateUI();
}

// ============================================================
// 信用取引（空売り・レバレッジロング）
// ============================================================

/**
 * 信用取引（空売り新規・空売り返済・信用買い新規・信用買い返済）を処理する
 * @param {'short'|'cover'|'llong'|'lclose'} action
 */
function tradeMargin(action) {
  const p = prices[currentStock];
  if (!p || p.length === 0) return alert(lang === 'ja' ? '価格データがありません' : 'No price data');
  const cur = p[p.length - 1];

  if (action === 'short') {
    const qty = parseInt(document.getElementById('short-qty').value);
    const lev = parseInt(document.getElementById('short-leverage').value);
    if (!qty || qty <= 0) return alert(lang === 'ja' ? '数量を入力してください' : 'Enter quantity');
    const collateral = Math.round((cur * qty) / lev);
    if (cash < collateral) return alert(lang === 'ja'
      ? `証拠金不足です（必要: ${formatCurrency(collateral)}）`
      : `Insufficient margin (need ${formatCurrency(collateral)})`);
    cash -= collateral;
    const id = 'short_' + Date.now();
    shortPositions[id] = { id, symbol: currentStock, qty, entryPrice: cur, leverage: lev, collateral, ts: Date.now() };
    saveMarginData(); saveData();
    showToast(lang === 'ja'
      ? `📉 空売り新規：${currentStock} ${qty}株 @ ${formatCurrency(cur)}（${lev}倍レバレッジ）`
      : `📉 Short opened: ${currentStock} ${qty}sh @ ${formatCurrency(cur)} (${lev}x leverage)`
    );
    updateUI();

  } else if (action === 'cover') {
    const posId = document.getElementById('cover-stock-select').value;
    const pos   = shortPositions[posId];
    if (!pos) return alert(lang === 'ja' ? 'ポジションを選択してください' : 'Select a position');
    const qty = parseInt(document.getElementById('cover-qty').value);
    if (!qty || qty <= 0 || qty > pos.qty) return alert(lang === 'ja'
      ? `数量が無効です（最大 ${pos.qty}株）`
      : `Invalid quantity (max ${pos.qty})`);
    const pnl               = (pos.entryPrice - cur) * qty;
    const returnedCollateral = Math.round(pos.collateral * qty / pos.qty);
    cash += returnedCollateral + pnl;
    realizedTrades.push({ symbol: pos.symbol, qty, buyAvg: cur, sellPrice: pos.entryPrice, pnl, ts: Date.now(), type: 'short' });
    saveRealizedTrades();
    if (qty >= pos.qty) {
      delete shortPositions[posId];
    } else {
      pos.qty        -= qty;
      pos.collateral -= returnedCollateral;
    }
    saveMarginData(); saveData();
    const sign = pnl >= 0 ? '+' : '';
    showToast(lang === 'ja'
      ? `🔄 空売り返済：${pos.symbol} ${qty}株 @ ${formatCurrency(cur)}　損益: ${sign}${formatCurrency(pnl)}`
      : `🔄 Short closed: ${pos.symbol} ${qty}sh @ ${formatCurrency(cur)}  P&L: ${sign}${formatCurrency(pnl)}`
    );
    updateUI();

  } else if (action === 'llong') {
    const qty = parseInt(document.getElementById('llong-qty').value);
    const lev = parseInt(document.getElementById('llong-leverage').value);
    if (!qty || qty <= 0) return alert(lang === 'ja' ? '数量を入力してください' : 'Enter quantity');
    const collateral = Math.round((cur * qty) / lev);
    if (cash < collateral) return alert(lang === 'ja'
      ? `証拠金不足です（必要: ${formatCurrency(collateral)}）`
      : `Insufficient margin (need ${formatCurrency(collateral)})`);
    cash -= collateral;
    const id = 'llong_' + Date.now();
    leverageLongs[id] = { id, symbol: currentStock, qty, entryPrice: cur, leverage: lev, collateral, ts: Date.now() };
    saveMarginData(); saveData();
    showToast(lang === 'ja'
      ? `📈 信用買い新規：${currentStock} ${qty}株 @ ${formatCurrency(cur)}（${lev}倍レバレッジ）`
      : `📈 Leveraged long opened: ${currentStock} ${qty}sh @ ${formatCurrency(cur)} (${lev}x leverage)`
    );
    updateUI();

  } else if (action === 'lclose') {
    const posId = document.getElementById('lclose-stock-select').value;
    const pos   = leverageLongs[posId];
    if (!pos) return alert(lang === 'ja' ? 'ポジションを選択してください' : 'Select a position');
    const qty = parseInt(document.getElementById('lclose-qty').value);
    if (!qty || qty <= 0 || qty > pos.qty) return alert(lang === 'ja'
      ? `数量が無効です（最大 ${pos.qty}株）`
      : `Invalid quantity (max ${pos.qty})`);
    const pnl               = (cur - pos.entryPrice) * qty * pos.leverage;
    const returnedCollateral = Math.round(pos.collateral * qty / pos.qty);
    cash += returnedCollateral + pnl;
    realizedTrades.push({ symbol: pos.symbol, qty, buyAvg: pos.entryPrice, sellPrice: cur, pnl, ts: Date.now(), type: 'leverageLong' });
    saveRealizedTrades();
    if (qty >= pos.qty) {
      delete leverageLongs[posId];
    } else {
      pos.qty        -= qty;
      pos.collateral -= returnedCollateral;
    }
    saveMarginData(); saveData();
    const sign = pnl >= 0 ? '+' : '';
    showToast(lang === 'ja'
      ? `💰 信用買い返済：${pos.symbol} ${qty}株 @ ${formatCurrency(cur)}　損益: ${sign}${formatCurrency(pnl)}`
      : `💰 Leveraged long closed: ${pos.symbol} ${qty}sh @ ${formatCurrency(cur)}  P&L: ${sign}${formatCurrency(pnl)}`
    );
    updateUI();
  }
}

// ============================================================
// 信用取引ロスカット自動執行
// ============================================================

/**
 * 全信用ポジションの維持率を計算し、100%未満のものを強制決済する
 * 決済処理は tradeMargin() の内部ロジックと同等の計算で直接行う
 * （UI 操作なしで動作させるため DOM に依存しない実装にする）
 */
function checkMarginCall() {
  const isJa = lang === 'ja';

  // 空売りポジションのロスカット判定
  for (const posId of Object.keys(shortPositions)) {
    const pos = shortPositions[posId];
    const p   = prices[pos.symbol];
    if (!p || p.length === 0) continue;

    const cur         = p[p.length - 1];
    const pnl         = (pos.entryPrice - cur) * pos.qty;
    const netAsset    = pos.collateral + pnl;
    const exposure    = cur * pos.qty;
    if (exposure === 0) continue;

    const ratio = (netAsset / exposure) * 100;
    if (ratio >= 100) continue;

    // ロスカット執行
    const returnedCollateral = pos.collateral;
    cash += returnedCollateral + pnl;
    realizedTrades.push({
      symbol    : pos.symbol,
      qty       : pos.qty,
      buyAvg    : cur,
      sellPrice : pos.entryPrice,
      pnl,
      ts        : Date.now(),
      type      : 'short',
    });
    saveRealizedTrades();
    delete shortPositions[posId];
    saveMarginData();
    saveData();
    showToast(isJa
      ? `⚠️ ロスカット執行：${pos.symbol} 空売り ${pos.qty}株（維持率 ${ratio.toFixed(1)}%）`
      : `⚠️ Force-closed: ${pos.symbol} short ${pos.qty}sh (ratio ${ratio.toFixed(1)}%)`
    );
  }

  // 信用買いポジションのロスカット判定
  for (const posId of Object.keys(leverageLongs)) {
    const pos = leverageLongs[posId];
    const p   = prices[pos.symbol];
    if (!p || p.length === 0) continue;

    const cur         = p[p.length - 1];
    const pnl         = (cur - pos.entryPrice) * pos.qty * pos.leverage;
    const netAsset    = pos.collateral + pnl;
    const exposure    = cur * pos.qty;
    if (exposure === 0) continue;

    const ratio = (netAsset / exposure) * 100;
    if (ratio >= 100) continue;

    // ロスカット執行
    const returnedCollateral = pos.collateral;
    cash += returnedCollateral + pnl;
    realizedTrades.push({
      symbol    : pos.symbol,
      qty       : pos.qty,
      buyAvg    : pos.entryPrice,
      sellPrice : cur,
      pnl,
      ts        : Date.now(),
      type      : 'leverageLong',
    });
    saveRealizedTrades();
    delete leverageLongs[posId];
    saveMarginData();
    saveData();
    showToast(isJa
      ? `⚠️ ロスカット執行：${pos.symbol} 信用買い ${pos.qty}株（維持率 ${ratio.toFixed(1)}%）`
      : `⚠️ Force-closed: ${pos.symbol} leveraged long ${pos.qty}sh (ratio ${ratio.toFixed(1)}%)`
    );
  }
}

// ============================================================
// ポートフォリオ分散分析
// ============================================================

/**
 * ピアソン相関係数を計算する
 * @param {number[]} a
 * @param {number[]} b
 * @returns {number|null} 相関係数（データ不足の場合 null）
 */
function pearsonCorr(a, b) {
  const n = Math.min(a.length, b.length);
  if (n < 5) return null;
  const xa = a.slice(-n), xb = b.slice(-n);
  const meanA = xa.reduce((s, v) => s + v, 0) / n;
  const meanB = xb.reduce((s, v) => s + v, 0) / n;
  let num = 0, varA = 0, varB = 0;
  for (let i = 0; i < n; i++) {
    const da = xa[i] - meanA, db = xb[i] - meanB;
    num  += da * db;
    varA += da * da;
    varB += db * db;
  }
  if (varA === 0 || varB === 0) return null;
  return num / Math.sqrt(varA * varB);
}

/**
 * 価格配列をリターン（騰落率）の配列に変換する
 * @param {number[]} priceArr
 * @returns {number[]}
 */
function toReturns(priceArr) {
  const r = [];
  for (let i = 1; i < priceArr.length; i++) {
    if (priceArr[i - 1] > 0) r.push((priceArr[i] - priceArr[i - 1]) / priceArr[i - 1]);
  }
  return r;
}

/**
 * 相関係数を色クラスに変換する
 * @param {number|null} r
 * @returns {string} CSSクラス名
 */
function corrClass(r) {
  if (r === null) return 'corr-na';
  const abs = Math.abs(r);
  if (abs >= 0.7) return 'corr-high';
  if (abs >= 0.4) return 'corr-mid';
  return 'corr-low';
}

/**
 * HHI・相関マトリクス・分散分析コメントを計算してUIに反映する
 */
function updateDiversification() {
  const heldSymbols = Object.keys(holdings).filter(k => holdings[k].qty > 0 && prices[k] && prices[k].length > 0);
  const allSymbols  = Object.keys(STOCKS).filter(k => prices[k] && prices[k].length > 0);

  // 配分バー（ウォッチ全銘柄）
  let totalStockVal = 0;
  const vals = {};
  allSymbols.forEach(k => {
    const qty   = holdings[k]?.qty || 0;
    const price = prices[k][prices[k].length - 1];
    vals[k]     = qty * price;
    totalStockVal += vals[k];
  });

  const barsEl = document.getElementById('allocation-bars');
  const COLORS  = ['#6366f1','#f59e0b','#22c55e','#ef4444','#3b82f6','#a855f7','#14b8a6','#f97316'];
  if (totalStockVal === 0) {
    barsEl.innerHTML = `<div style="color:#bbb;font-size:12px;text-align:center;padding:8px 0">${lang === 'ja' ? '保有銘柄なし' : 'No positions held'}</div>`;
  } else {
    barsEl.innerHTML = allSymbols.map((k, i) => {
      const pct   = vals[k] / totalStockVal * 100;
      const color = STOCKS[k]?.color || COLORS[i % COLORS.length];
      return `<div class="allocation-row">
        <div class="allocation-label">
          <span style="font-weight:bold;color:${color}">${k}</span>
          <span>${pct.toFixed(1)}% &nbsp; ${formatCurrency(vals[k])}</span>
        </div>
        <div class="allocation-bar-bg">
          <div class="allocation-bar-fill" style="width:${pct}%;background:${color}"></div>
        </div>
      </div>`;
    }).join('');
  }

  // HHI 集中度
  const hhiEl  = document.getElementById('div-hhi');
  const top1El = document.getElementById('div-top1');

  if (heldSymbols.length === 0 || totalStockVal === 0) {
    hhiEl.textContent  = '--'; hhiEl.className  = 'div-score-value';
    top1El.textContent = '--'; top1El.className = 'div-score-value';
    document.getElementById('div-avg-corr').textContent = '--';
    document.getElementById('corr-matrix-wrap').innerHTML = '';
    document.getElementById('div-analysis-note').textContent = '';
    return;
  }

  let hhi = 0, maxPct = 0;
  heldSymbols.forEach(k => {
    const p = vals[k] / totalStockVal;
    hhi += p * p;
    if (p > maxPct) maxPct = p;
  });
  const hhiPct = hhi * 100;

  let hhiClass;
  if (hhiPct < 18)      hhiClass = 'div-score-good';
  else if (hhiPct < 35) hhiClass = 'div-score-warn';
  else                  hhiClass = 'div-score-bad';
  hhiEl.textContent = hhiPct.toFixed(1);
  hhiEl.className   = `div-score-value ${hhiClass}`;

  const top1Class    = maxPct < 0.4 ? 'div-score-good' : maxPct < 0.6 ? 'div-score-warn' : 'div-score-bad';
  top1El.textContent = (maxPct * 100).toFixed(1) + '%';
  top1El.className   = `div-score-value ${top1Class}`;

  // 相関マトリクス（保有2銘柄以上）
  const corrWrap  = document.getElementById('corr-matrix-wrap');
  const avgCorrEl = document.getElementById('div-avg-corr');

  if (heldSymbols.length < 2) {
    corrWrap.innerHTML = `<div style="color:#bbb;font-size:12px;padding:6px 0">${lang === 'ja' ? '相関計算には2銘柄以上の保有が必要です' : 'Hold 2+ stocks to compute correlation'}</div>`;
    avgCorrEl.textContent = '--';
    avgCorrEl.className   = 'div-score-value';
    generateDivNote([]);
    return;
  }

  const returns = {};
  heldSymbols.forEach(k => { returns[k] = toReturns(prices[k]); });

  const corrPairs = [];
  let corrSum = 0, corrCount = 0;

  let tableHtml = `<table class="corr-table"><thead><tr><th></th>`;
  heldSymbols.forEach(k => { tableHtml += `<th>${k}</th>`; });
  tableHtml += '</tr></thead><tbody>';

  heldSymbols.forEach(k1 => {
    tableHtml += `<tr><th>${k1}</th>`;
    heldSymbols.forEach(k2 => {
      if (k1 === k2) {
        tableHtml += `<td class="corr-self">1.00</td>`;
      } else {
        const r    = pearsonCorr(returns[k1], returns[k2]);
        const cls  = corrClass(r);
        const disp = r === null ? '--' : r.toFixed(2);
        tableHtml += `<td class="${cls}">${disp}</td>`;
        if (r !== null) { corrSum += r; corrCount++; corrPairs.push({ k1, k2, r }); }
      }
    });
    tableHtml += '</tr>';
  });
  tableHtml += '</tbody></table>';
  corrWrap.innerHTML = tableHtml;

  if (corrCount > 0) {
    const avg      = corrSum / corrCount;
    const avgClass = avg < 0.4 ? 'div-score-good' : avg < 0.7 ? 'div-score-warn' : 'div-score-bad';
    avgCorrEl.textContent = avg.toFixed(2);
    avgCorrEl.className   = `div-score-value ${avgClass}`;
    generateDivNote(corrPairs, avg, hhiPct, maxPct);
  } else {
    avgCorrEl.textContent = '--';
    avgCorrEl.className   = 'div-score-value';
    generateDivNote([]);
  }
}

/**
 * HHI・相関ペアをもとに分散分析コメントを生成してUIに反映する
 * @param {Array}  corrPairs
 * @param {number} [avgCorr]
 * @param {number} [hhiPct]
 * @param {number} [maxPct]
 */
function generateDivNote(corrPairs, avgCorr, hhiPct, maxPct) {
  const noteEl = document.getElementById('div-analysis-note');
  const lines  = [];

  if (lang === 'ja') {
    if (hhiPct !== undefined) {
      if (hhiPct < 18)      lines.push('✅ 集中度(HHI)は良好です。18以下は分散投資の目安。');
      else if (hhiPct < 35) lines.push('⚠️ 集中度(HHI)がやや高め。銘柄を追加して分散を改善できます。');
      else                  lines.push('🔴 集中度(HHI)が高すぎます。特定銘柄への偏りがリスクになります。');
    }
    if (maxPct !== undefined) {
      if (maxPct >= 0.6)      lines.push(`🔴 最大銘柄が資産の${(maxPct*100).toFixed(0)}%を占めています。1銘柄依存が高い状態です。`);
      else if (maxPct >= 0.4) lines.push(`⚠️ 最大銘柄が${(maxPct*100).toFixed(0)}%。やや集中気味です。`);
    }
    if (corrPairs.length > 0 && avgCorr !== undefined) {
      if (avgCorr >= 0.7)      lines.push('🔴 銘柄間の相関が高く、同じ方向に動きやすいです。異なるセクターの追加を検討してください。');
      else if (avgCorr >= 0.4) lines.push('⚠️ 相関がやや高め。暴落時は同時下落するリスクがあります。');
      else                     lines.push('✅ 銘柄間の相関が低く、分散効果が働いています。');
      const worst = [...corrPairs].sort((a, b) => Math.abs(b.r) - Math.abs(a.r))[0];
      if (worst && Math.abs(worst.r) >= 0.7)
        lines.push(`　→ ${worst.k1}と${worst.k2}の相関が特に高い（${worst.r.toFixed(2)}）。同じ動きをする可能性大。`);
    }
    lines.push('※ HHI: 各銘柄の比率²の合計×100。18以下が「分散」、35超が「集中」の目安。');
  } else {
    if (hhiPct !== undefined) {
      if (hhiPct < 18)      lines.push('✅ Concentration (HHI) is healthy. Under 18 signals good diversification.');
      else if (hhiPct < 35) lines.push('⚠️ HHI is moderately high. Adding more stocks can improve diversification.');
      else                  lines.push('🔴 HHI is high — portfolio is heavily concentrated in a few positions.');
    }
    if (maxPct !== undefined && maxPct >= 0.4)
      lines.push(`⚠️ Largest position is ${(maxPct*100).toFixed(0)}% of your portfolio.`);
    if (corrPairs.length > 0 && avgCorr !== undefined) {
      if (avgCorr >= 0.7)      lines.push('🔴 High average correlation — stocks tend to move together. Consider adding uncorrelated assets.');
      else if (avgCorr >= 0.4) lines.push('⚠️ Moderate correlation. Stocks may fall together during market stress.');
      else                     lines.push('✅ Low correlation — diversification benefits are working.');
    }
    lines.push("※ HHI: Sum of each stock's weight² × 100. Under 18 = diversified, over 35 = concentrated.");
  }

  noteEl.innerHTML = lines.join('<br>');
}

// ============================================================
// ポジションサイジング計算
// ============================================================

/**
 * ATR（近似値）を prices から計算して入力フィールドに自動入力する
 * 直近14〜15点の価格差の絶対値平均を使用する
 */
function fillAtr() {
  const data = prices[currentStock];
  if (!data || data.length < 14) return;
  const slice = data.slice(-15);
  let trSum   = 0;
  for (let i = 1; i < slice.length; i++) trSum += Math.abs(slice[i] - slice[i - 1]);
  const atr  = Math.round(trSum / (slice.length - 1));
  const el   = document.getElementById('psz-atr-val');
  if (el && atr > 0) el.value = atr;
  const cur    = data[data.length - 1];
  const entryEl = document.getElementById('psz-entry-atr');
  if (entryEl && !entryEl.value) entryEl.value = cur;
}

/**
 * 過去の実現損益履歴からケリー基準の入力値（勝率・RR比）を自動入力する
 */
function fillKellyFromHistory() {
  if (realizedTrades.length < 5) {
    document.getElementById('psz-kelly-detail').className = 'psz-kelly-detail show';
    document.getElementById('psz-kelly-detail').innerHTML =
      lang === 'ja'
        ? '⚠️ 統計的に信頼できる結果を得るには最低20〜30回の取引履歴が必要です。現在 <strong>' + realizedTrades.length + '回</strong> のデータがあります。'
        : '⚠️ At least 20–30 trades are needed for statistically reliable Kelly sizing. You currently have <strong>' + realizedTrades.length + '</strong> trades.';
    return;
  }
  const wins   = realizedTrades.filter(t => t.pnl > 0);
  const losses = realizedTrades.filter(t => t.pnl <= 0);
  const wr     = (wins.length / realizedTrades.length * 100).toFixed(1);
  const avgWin = wins.length   > 0 ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length   : 0;
  const avgLoss= losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 1;
  const rr     = (avgWin / avgLoss).toFixed(2);

  document.getElementById('psz-wr').value       = wr;
  document.getElementById('psz-rr-kelly').value = rr;

  const kellyFrac = parseFloat(document.getElementById('psz-kelly-frac').value);
  const W         = wins.length / realizedTrades.length;
  const R         = avgWin / avgLoss;
  const fullKelly = ((W * R - (1 - W)) / R * 100).toFixed(1);

  document.getElementById('psz-kelly-detail').className = 'psz-kelly-detail show';
  document.getElementById('psz-kelly-detail').innerHTML =
    lang === 'ja'
      ? `📊 直近 <strong>${realizedTrades.length}回</strong> の取引統計から自動入力しました。<br>`
        + `勝率: <strong>${wr}%</strong> &nbsp; 平均RR: <strong>${rr}</strong> &nbsp; フルケリー: <strong>${fullKelly}%</strong><br>`
        + `<span class="psz-kelly-formula">Kelly% = (W × R − (1−W)) ÷ R</span><br>`
        + `※ フルケリーは理論上最大成長ですが破産リスクが高く、実務では${kellyFrac}%（ハーフ以下）で運用します。`
      : `📊 Auto-filled from <strong>${realizedTrades.length}</strong> trades in your history.<br>`
        + `Win rate: <strong>${wr}%</strong> &nbsp; Avg R/R: <strong>${rr}</strong> &nbsp; Full Kelly: <strong>${fullKelly}%</strong><br>`
        + `<span class="psz-kelly-formula">Kelly% = (W × R − (1−W)) ÷ R</span><br>`
        + `※ Full Kelly maximizes log-growth but has high ruin risk. Pros use ${kellyFrac}% (half-Kelly or less).`;
}

/**
 * 選択中のポジションサイジング手法に基づいて推奨株数・リスク額・投資額を計算しUIに反映する
 */
function calcPsz() {
  const isJa        = lang === 'ja';
  const totalAssets = getTotalAssets();
  let shares = 0, maxLoss = 0, exposure = 0, reward = 0;
  let warning = '', warningClass = '';

  const warnEl   = document.getElementById('psz-warning');
  const applyBtn = document.getElementById('btn-psz-apply');

  if (pszMethod === 'fixed') {
    const riskPct      = parseFloat(document.getElementById('psz-risk-pct').value) / 100;
    const entry        = parseFloat(document.getElementById('psz-entry').value);
    const stop         = parseFloat(document.getElementById('psz-stop').value);
    if (!entry || !stop || entry <= 0 || stop <= 0) { resetPszResult(); return; }
    const riskPerShare = Math.abs(entry - stop);
    if (riskPerShare === 0) { resetPszResult(); return; }
    const riskAmount   = totalAssets * riskPct;
    shares   = Math.floor(riskAmount / riskPerShare);
    maxLoss  = shares * riskPerShare;
    exposure = shares * entry;

    if (stop >= entry)       warning = isJa ? '⚠️ 損切り価格はエントリー価格より低く設定してください（ロングの場合）。' : '⚠️ Stop price should be below entry price for a long trade.';
    if (exposure > cash)   { warning = isJa ? `🔴 必要投資額（${formatCurrency(exposure)}）が現在の現金（${formatCurrency(cash)}）を超えています。株数を減らすか、他ポジションを決済してください。` : `🔴 Required capital (${formatCurrency(exposure)}) exceeds available cash (${formatCurrency(cash)}).`; warningClass = 'danger'; }

  } else if (pszMethod === 'kelly') {
    const wrRaw    = parseFloat(document.getElementById('psz-wr').value);
    const rrRaw    = parseFloat(document.getElementById('psz-rr-kelly').value);
    const fracPct  = parseFloat(document.getElementById('psz-kelly-frac').value) / 100;
    const entry    = parseFloat(document.getElementById('psz-entry-kelly').value);
    const stop     = parseFloat(document.getElementById('psz-stop-kelly').value);
    if (!wrRaw || !rrRaw || !entry || !stop) { resetPszResult(); return; }
    const W        = wrRaw / 100;
    const R        = rrRaw;
    const fullKelly= (W * R - (1 - W)) / R;
    const adjKelly = fullKelly * fracPct;
    if (adjKelly <= 0) {
      warning = isJa
        ? '⚠️ この勝率・RR比ではケリー比率がマイナスです（期待値が負）。この手法には統計的優位性がありません。'
        : '⚠️ Kelly fraction is negative — your strategy has no statistical edge at this win rate and R/R.';
      warningClass = 'danger';
      resetPszResult();
      warnEl.textContent = warning;
      warnEl.className   = 'psz-warning show ' + warningClass;
      return;
    }
    const riskAmount   = totalAssets * adjKelly;
    const riskPerShare = Math.abs(entry - stop);
    if (riskPerShare === 0) { resetPszResult(); return; }
    shares   = Math.floor(riskAmount / riskPerShare);
    maxLoss  = shares * riskPerShare;
    exposure = shares * entry;
    reward   = shares * riskPerShare * R;

    if (fullKelly > 0.25) warning = isJa ? `📌 フルケリー ${(fullKelly*100).toFixed(1)}% は高めです。分率（現在${(fracPct*100).toFixed(0)}%）で安全に調整しています。` : `📌 Full Kelly is ${(fullKelly*100).toFixed(1)}% — high. The fraction (${(fracPct*100).toFixed(0)}%) safely scales it down.`;
    if (exposure > cash)  { warning = isJa ? '🔴 必要投資額が現金を超えます。' : '🔴 Exceeds available cash.'; warningClass = 'danger'; }

  } else if (pszMethod === 'atr') {
    const riskPct  = parseFloat(document.getElementById('psz-risk-pct-atr').value) / 100;
    const entry    = parseFloat(document.getElementById('psz-entry-atr').value);
    const atr      = parseFloat(document.getElementById('psz-atr-val').value);
    const mult     = parseFloat(document.getElementById('psz-atr-mult').value);
    if (!entry || !atr || !mult) { resetPszResult(); return; }
    const stopDist = atr * mult;
    const atrStop  = entry - stopDist;
    document.getElementById('psz-atr-stop-display').value = Math.round(atrStop);
    const riskAmount = totalAssets * riskPct;
    shares   = Math.floor(riskAmount / stopDist);
    maxLoss  = shares * stopDist;
    exposure = shares * entry;

    if (exposure > cash) { warning = isJa ? '🔴 必要投資額が現金を超えます。' : '🔴 Exceeds available cash.'; warningClass = 'danger'; }

  } else if (pszMethod === 'rr') {
    const riskPct  = parseFloat(document.getElementById('psz-risk-pct-rr').value) / 100;
    const entry    = parseFloat(document.getElementById('psz-entry-rr').value);
    const stop     = parseFloat(document.getElementById('psz-stop-rr').value);
    const target   = parseFloat(document.getElementById('psz-target-rr').value);
    const minRR    = parseFloat(document.getElementById('psz-min-rr').value) || 2;
    if (!entry || !stop) { resetPszResult(); return; }
    const riskPerShare = Math.abs(entry - stop);
    if (riskPerShare === 0) { resetPszResult(); return; }

    let actualRR = null;
    if (target && target > 0) {
      const rewardPerShare = Math.abs(target - entry);
      actualRR = rewardPerShare / riskPerShare;
    }

    const riskAmount = totalAssets * riskPct;
    shares   = Math.floor(riskAmount / riskPerShare);
    maxLoss  = shares * riskPerShare;
    exposure = shares * entry;
    reward   = actualRR !== null ? shares * riskPerShare * actualRR : 0;

    if (actualRR !== null && actualRR < minRR) {
      warning      = isJa ? `🔴 RR比 ${actualRR.toFixed(2)} は最低基準 ${minRR} を下回っています。このトレードは推奨できません。` : `🔴 R/R ratio ${actualRR.toFixed(2)} is below your minimum of ${minRR}. This trade is not recommended.`;
      warningClass = 'danger';
    } else if (actualRR !== null) {
      warning      = isJa ? `✅ RR比 ${actualRR.toFixed(2)} — 最低基準 ${minRR} をクリアしています。` : `✅ R/R ratio ${actualRR.toFixed(2)} meets your minimum of ${minRR}.`;
      warningClass = 'warn';
    }
    if (exposure > cash) { warning = isJa ? '🔴 必要投資額が現金を超えます。' : '🔴 Exceeds available cash.'; warningClass = 'danger'; }
  }

  if (shares <= 0) { resetPszResult(); return; }

  pszLastShares = shares;

  // 結果を描画
  document.getElementById('psz-result-shares').textContent = shares.toLocaleString();
  document.getElementById('psz-result-unit').textContent   = isJa ? '株' : 'shares';
  document.getElementById('psz-result-label').textContent  = isJa ? '推奨株数' : 'Recommended Shares';

  const cashPct    = exposure / totalAssets * 100;
  const maxLossPct = maxLoss  / totalAssets * 100;

  const riskEl = document.getElementById('psz-stat-risk');
  riskEl.textContent = formatCurrency(maxLoss) + ` (${maxLossPct.toFixed(2)}%)`;
  riskEl.className   = 'psz-stat-cell-value ' + (maxLossPct > 3 ? 'bad' : maxLossPct > 1.5 ? 'warn' : 'ok');

  const expEl = document.getElementById('psz-stat-exposure');
  expEl.textContent = formatCurrency(exposure);
  expEl.className   = 'psz-stat-cell-value ' + (exposure > cash ? 'bad' : exposure > cash * 0.8 ? 'warn' : 'ok');

  const cpEl = document.getElementById('psz-stat-cashpct');
  cpEl.textContent = cashPct.toFixed(1) + '%';
  cpEl.className   = 'psz-stat-cell-value ' + (cashPct > 80 ? 'bad' : cashPct > 50 ? 'warn' : 'ok');

  const rewEl = document.getElementById('psz-stat-reward');
  if (reward > 0) {
    rewEl.textContent = '+' + formatCurrency(reward);
    rewEl.className   = 'psz-stat-cell-value ok';
  } else {
    rewEl.textContent = '--';
    rewEl.className   = 'psz-stat-cell-value';
  }

  document.getElementById('psz-stat-label-risk').textContent     = isJa ? '最大損失額'   : 'Max Risk';
  document.getElementById('psz-stat-label-exposure').textContent = isJa ? '必要投資額'   : 'Exposure';
  document.getElementById('psz-stat-label-cashpct').textContent  = isJa ? '投資額/総資産' : 'Exposure / Equity';
  document.getElementById('psz-stat-label-reward').textContent   = isJa ? '期待利益額'   : 'Est. Reward';

  if (warning) {
    warnEl.textContent = warning;
    warnEl.className   = 'psz-warning show ' + (warningClass || 'warn');
  } else {
    warnEl.className = 'psz-warning';
  }

  applyBtn.disabled    = (shares <= 0 || warningClass === 'danger');
  applyBtn.textContent = isJa
    ? `↑ ${shares.toLocaleString()}株 を注文欄に反映する`
    : `↑ Apply ${shares.toLocaleString()} shares to order`;

  updateRrVisual();
}

/**
 * ポジションサイジング計算結果をリセットしてUIをクリアする
 */
function resetPszResult() {
  document.getElementById('psz-result-shares').textContent = '--';
  document.getElementById('psz-result-unit').textContent   = '';
  ['psz-stat-risk','psz-stat-exposure','psz-stat-cashpct','psz-stat-reward'].forEach(id => {
    const el = document.getElementById(id);
    el.textContent = '--'; el.className = 'psz-stat-cell-value';
  });
  document.getElementById('psz-warning').className = 'psz-warning';
  document.getElementById('btn-psz-apply').disabled    = true;
  document.getElementById('btn-psz-apply').textContent = lang === 'ja' ? '↑ この株数を注文欄に反映する' : '↑ Apply shares to order';
  pszLastShares = 0;
  updateRrVisual();
}

/**
 * RR比ビジュアル（スコアバッジ・バー・価格レンジ・損益分岐勝率・期待値・実績RR）を更新する
 */
function updateRrVisual() {
  const isJa = lang === 'ja';

  document.getElementById('rr-panel-title').textContent     = isJa ? 'リスクリワード比（自動計算）' : 'Risk/Reward Ratio (Auto)';
  document.getElementById('rr-label-risk').textContent      = isJa ? 'リスク' : 'Risk';
  document.getElementById('rr-label-reward').textContent    = isJa ? 'リワード' : 'Reward';
  document.getElementById('rr-label-breakeven').textContent = isJa ? '損益分岐勝率' : 'Breakeven WR';
  document.getElementById('rr-label-ev').textContent        = isJa ? '1トレード期待値' : 'Expected Value';
  document.getElementById('rr-label-history-rr').textContent= isJa ? '実績平均RR' : 'Hist. Avg RR';
  document.getElementById('rr-price-stop-label').textContent  = isJa ? '🔴 損切り' : '🔴 Stop';
  document.getElementById('rr-price-entry-label').textContent = isJa ? '▼ エントリー' : '▼ Entry';
  document.getElementById('rr-price-target-label').textContent= isJa ? '🟢 目標' : '🟢 Target';
  document.getElementById('rr-history-title').textContent   = isJa ? '直近トレードのP/L比（左が古い）' : 'Recent trade P/L ratios (oldest → newest)';

  // 現在メソッドから entry / stop / target を取得
  let entry = NaN, stop = NaN, target = NaN;
  if (pszMethod === 'fixed') {
    entry = parseFloat(document.getElementById('psz-entry').value);
    stop  = parseFloat(document.getElementById('psz-stop').value);
  } else if (pszMethod === 'kelly') {
    entry = parseFloat(document.getElementById('psz-entry-kelly').value);
    stop  = parseFloat(document.getElementById('psz-stop-kelly').value);
  } else if (pszMethod === 'atr') {
    entry      = parseFloat(document.getElementById('psz-entry-atr').value);
    const atr  = parseFloat(document.getElementById('psz-atr-val').value);
    const mult = parseFloat(document.getElementById('psz-atr-mult').value);
    stop       = (entry && atr && mult) ? entry - atr * mult : NaN;
  } else if (pszMethod === 'rr') {
    entry  = parseFloat(document.getElementById('psz-entry-rr').value);
    stop   = parseFloat(document.getElementById('psz-stop-rr').value);
    target = parseFloat(document.getElementById('psz-target-rr').value);
  }

  const riskPerShare   = (entry > 0 && stop > 0)   ? Math.abs(entry - stop)   : NaN;
  const rewardPerShare = (entry > 0 && target > 0)  ? Math.abs(target - entry) : NaN;
  const rrRatio        = (!isNaN(riskPerShare) && !isNaN(rewardPerShare) && riskPerShare > 0)
    ? rewardPerShare / riskPerShare : NaN;

  const badge   = document.getElementById('rr-score-badge');
  const numEl   = document.getElementById('rr-score-number');
  const verdict = document.getElementById('rr-score-verdict');

  if (isNaN(rrRatio)) {
    badge.className       = 'rr-score-badge none';
    numEl.textContent     = '--';
    verdict.style.display = 'none';
  } else {
    numEl.textContent     = rrRatio.toFixed(2);
    verdict.style.display = '';
    let cls, label;
    if      (rrRatio >= 3) { cls = 'excellent'; label = isJa ? '◎ 優秀' : '◎ Excellent'; }
    else if (rrRatio >= 2) { cls = 'good';      label = isJa ? '○ 良好' : '○ Good'; }
    else if (rrRatio >= 1) { cls = 'fair';      label = isJa ? '△ 普通' : '△ Fair'; }
    else                   { cls = 'poor';      label = isJa ? '✕ 不良' : '✕ Poor'; }
    badge.className   = `rr-score-badge ${cls}`;
    verdict.textContent = label;
  }

  const maxBar    = Math.max(riskPerShare || 0, rewardPerShare || 0, 1);
  const riskPct   = isNaN(riskPerShare)   ? 0 : Math.min(100, riskPerShare   / maxBar * 100);
  const rewardPct = isNaN(rewardPerShare) ? 0 : Math.min(100, rewardPerShare / maxBar * 100);
  document.getElementById('rr-bar-risk').style.width       = riskPct + '%';
  document.getElementById('rr-bar-reward').style.width     = rewardPct + '%';
  document.getElementById('rr-bar-risk-amt').textContent   = isNaN(riskPerShare)   ? '--' : formatCurrency(riskPerShare);
  document.getElementById('rr-bar-reward-amt').textContent = isNaN(rewardPerShare) ? '--' : formatCurrency(rewardPerShare);

  const priceSection = document.getElementById('rr-price-range-section');
  if (!isNaN(entry) && !isNaN(stop) && !isNaN(target) && entry > 0 && stop > 0 && target > 0) {
    priceSection.style.display = '';
    const lo  = Math.min(stop, entry, target);
    const hi  = Math.max(stop, entry, target);
    const rng = hi - lo || 1;
    const toP = v => ((v - lo) / rng * 100).toFixed(1) + '%';

    document.getElementById('rr-price-fill-stop').style.width   = toP(Math.min(entry, stop));
    document.getElementById('rr-price-fill-target').style.width = (100 - parseFloat(toP(Math.max(entry, target)))).toFixed(1) + '%';
    document.getElementById('rr-price-marker-entry').style.left = toP(entry);
    document.getElementById('rr-price-stop-val').textContent    = formatCurrency(stop);
    document.getElementById('rr-price-entry-val').textContent   = formatCurrency(entry);
    document.getElementById('rr-price-target-val').textContent  = formatCurrency(target);
  } else {
    priceSection.style.display = 'none';
  }

  const beEl = document.getElementById('rr-breakeven-val');
  const evEl = document.getElementById('rr-ev-val');

  if (!isNaN(rrRatio) && rrRatio > 0) {
    const breakeven = 1 / (1 + rrRatio) * 100;
    beEl.textContent = breakeven.toFixed(1) + '%';
    beEl.className   = 'rr-mini-value ' + (breakeven < 40 ? 'ok' : breakeven < 50 ? 'mid' : 'bad');

    if (realizedTrades.length >= 3) {
      const wr = realizedTrades.filter(t => t.pnl > 0).length / realizedTrades.length;
      const ev = wr * rrRatio - (1 - wr);
      evEl.textContent = (ev >= 0 ? '+' : '') + ev.toFixed(3);
      evEl.className   = 'rr-mini-value ' + (ev > 0.2 ? 'ok' : ev > 0 ? 'mid' : 'bad');
    } else {
      evEl.textContent = '--'; evEl.className = 'rr-mini-value';
    }
  } else {
    beEl.textContent = '--'; beEl.className = 'rr-mini-value';
    evEl.textContent = '--'; evEl.className = 'rr-mini-value';
  }

  const histEl      = document.getElementById('rr-history-rr-val');
  const histSection = document.getElementById('rr-history-section');

  if (realizedTrades.length >= 3) {
    const wins   = realizedTrades.filter(t => t.pnl > 0);
    const losses = realizedTrades.filter(t => t.pnl <= 0);
    const avgWin  = wins.length   > 0 ? wins.reduce((s, t) => s + t.pnl, 0)   / wins.length   : 0;
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + t.pnl, 0) / losses.length) : 0;
    if (avgLoss > 0) {
      const histRR = avgWin / avgLoss;
      histEl.textContent = histRR.toFixed(2);
      histEl.className   = 'rr-mini-value ' + (histRR >= 2 ? 'ok' : histRR >= 1 ? 'mid' : 'bad');
    } else {
      histEl.textContent = '--'; histEl.className = 'rr-mini-value';
    }

    histSection.style.display = '';
    const recent = realizedTrades.slice(-30);
    const maxAbs = Math.max(...recent.map(t => Math.abs(t.pnl)), 1);
    const barsEl = document.getElementById('rr-history-bars');
    barsEl.innerHTML = recent.map(t => {
      const h   = Math.max(4, Math.abs(t.pnl) / maxAbs * 36);
      const cls = t.pnl >= 0 ? 'win' : 'loss';
      return `<div class="rr-history-bar ${cls}" style="height:${h}px" title="${formatCurrency(t.pnl, {signed:true})}"></div>`;
    }).join('');

    const allPnl = realizedTrades.map(t => t.pnl);
    const worst  = Math.min(...allPnl);
    const best   = Math.max(...allPnl);
    const avg    = allPnl.reduce((s, v) => s + v, 0) / allPnl.length;
    document.getElementById('rr-history-worst').textContent = isJa ? `最悪: ${formatCurrency(worst, {signed:true})}` : `Worst: ${formatCurrency(worst, {signed:true})}`;
    document.getElementById('rr-history-avg').textContent   = isJa ? `平均: ${formatCurrency(avg,   {signed:true})}` : `Avg: ${formatCurrency(avg,   {signed:true})}`;
    document.getElementById('rr-history-best').textContent  = isJa ? `最良: ${formatCurrency(best,  {signed:true})}` : `Best: ${formatCurrency(best,  {signed:true})}`;
  } else {
    histEl.textContent        = '--'; histEl.className = 'rr-mini-value';
    histSection.style.display = 'none';
  }
}
