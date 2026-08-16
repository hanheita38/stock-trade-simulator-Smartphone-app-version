// ============================================================
// ui-renderer.js — 表示層
// DOM への描画・パネル開閉・タブ切替など全ての UI 更新を担う
//   - updateUI()              メイン表示更新（価格・保有・総資産）
//   - drawChart()             株価チャート（Canvas）
//   - drawAssetHistoryChart() 総資産推移チャート（Canvas）
//   - buildTabs()             銘柄タブ構築
//   - switchStock()           銘柄切替
//   - deleteStock()           銘柄削除
//   - renderPendingOrders()   待機注文一覧表示
//   - updatePlPanel()         P/L パネル
//   - updateMarginPanel()     信用取引パネル
//   - updateAssetHistoryStats() 資産推移統計表示
//   - switchOrderTab()        注文タイプ切替
//   - switchMarginTab()       信用取引タブ切替
//   - toggleXxxPanel()        各パネル開閉
//   - updateFxDisplay()       為替レート表示
//   - updateApiKeyStatus()    APIキー状態表示
//   - renderApiKeyHelp/Explanation()
//   - switchPszMethod()       ポジションサイジング手法切替
//   - applyPszToOrder()       PSZ 結果を注文欄に反映
//   - pszAutoFillEntry()      銘柄切替時エントリー価格自動入力
//   - updateMarginRequiredDisplay() 信用取引必要証拠金プレビュー
//   - updateCoverSelect() / updateLcloseSelect()
//   - updateCoverPnlPreview() / updateLclosePnlPreview()
//   - setAhRange()            資産推移グラフ期間切替
//   - toggleAssetHistoryPanel() / toggleDivPanel() / togglePlPanel() / togglePszPanel()
// ============================================================

// ============================================================
// 為替レート表示
// ============================================================

/** ヘッダーの為替レート表示を更新する */
function updateFxDisplay() {
  const el = document.getElementById('fx-rate-display');
  if (el) el.textContent = `¥${fxRate.toFixed(2)}/USD`;
}

// ============================================================
// APIキー UI
// ============================================================

/** APIキーの保存状態バッジとパネル折りたたみを更新する */
function updateApiKeyStatus() {
  const panelEl  = document.querySelector('.api-key-panel');
  const statusEl = document.getElementById('api-key-status');
  const hasKey   = Boolean(getFinnhubApiKey());
  if (statusEl) {
    statusEl.textContent = hasKey ? I18N[lang].apiKeySaved : I18N[lang].apiKeyMissing;
    statusEl.classList.toggle('saved', hasKey);
  }
  if (panelEl) panelEl.classList.toggle('collapsed', hasKey);
}

/** APIキーパネルを展開してフォーカスを当てる */
function expandApiKeyPanel() {
  document.querySelector('.api-key-panel')?.classList.remove('collapsed');
  document.getElementById('api-key-input')?.focus();
}

/** APIキー取得先リンクを含むヘルプ文を描画する */
function renderApiKeyHelp() {
  const helpEl = document.getElementById('api-key-help');
  if (!helpEl) return;
  const [before, after] = I18N[lang].apiKeyHelp.split('{link}');
  helpEl.textContent = before || '';
  const link = document.createElement('a');
  link.href      = FINNHUB_REGISTER_URL;
  link.target    = '_blank';
  link.rel       = 'noopener noreferrer';
  link.textContent = I18N[lang].apiKeyLink;
  helpEl.appendChild(link);
  helpEl.append(after || '');
}

/** APIキー利用目的の説明文（箇条書き）を描画する */
function renderApiKeyExplanation() {
  const explainEl = document.getElementById('api-key-explain');
  if (!explainEl) return;
  explainEl.innerHTML = '';
  I18N[lang].apiKeyExplain.forEach(line => {
    const item = document.createElement('div');
    item.textContent = line;
    explainEl.appendChild(item);
  });
}

// ============================================================
// 銘柄タブ
// ============================================================

/** ウォッチリストの銘柄タブを全再描画する */
function buildTabs() {
  document.getElementById('tabs').innerHTML = Object.keys(STOCKS).map(k => `
    <div class="tab-container">
      <button class="tab ${k === currentStock ? 'active' : ''}" onclick="switchStock('${k}')">${k}</button>
      <button class="btn-del" onclick="deleteStock('${k}', event)">×</button>
    </div>
  `).join('');
}

/**
 * 表示銘柄を切り替える
 * @param {string} k - 銘柄コード
 */
function switchStock(k) {
  currentStock = k;
  buildTabs();
  updateBuffettMetrics(k);
  updatePegRatio(k);
  updateCrashTest();
  renderPendingOrders();
  updateEarningsPanel(k);
  updateMacrotrendsLink(k);
  if (!earningsData[k]) { fetchEarningsHistory(k); fetchNextEarningsDate(k); }
  updateUI();
}

/**
 * 銘柄をウォッチリストから削除する（保有中は不可）
 * @param {string} k     - 銘柄コード
 * @param {Event}  event - クリックイベント（バブリング防止用）
 */
function deleteStock(k, event) {
  event.stopPropagation();
  const holdingQty = holdings[k]?.qty || 0;
  if (holdingQty > 0) {
    alert(lang === 'ja'
      ? `${k} を ${I18N[lang].sharesUnit(holdingQty)} 保有中です。\n全株売却してから削除してください。`
      : `You hold ${I18N[lang].sharesUnit(holdingQty)} of ${k}.\nPlease sell all shares before removing.`);
    return;
  }
  if (!confirm(lang === 'ja' ? `${k} をウォッチリストから削除しますか？` : `Remove ${k} from watchlist?`)) return;
  delete STOCKS[k];
  delete prices[k];
  delete stockFinancials[k];
  if (currentStock === k) currentStock = Object.keys(STOCKS)[0] || '';
  saveData(); buildTabs(); updateUI();
}

// ============================================================
// メイン UI 更新
// ============================================================

/**
 * 現在銘柄の株価・保有状況・総資産・各パネルを一括更新する
 * prices が未取得の場合はエラーメッセージのみ表示して返る
 */
function updateUI() {
  const data = prices[currentStock];

  // prices 未取得 or 空配列（非対応銘柄）
  if (!data || data.length === 0) {
    const err = STOCKS[currentStock]?._fetchError;
    const syncEl = document.getElementById('sync-time');
    if (err === 'JP_NOT_SUPPORTED') {
      const msg      = lang === 'ja' ? '⚠️ 日本株はFinnhub無料プランの対象外です。' : '⚠️ Japanese stocks require a paid Finnhub plan.';
      const linkText = lang === 'ja' ? '有料プランを確認' : 'See Finnhub pricing';
      syncEl.innerHTML = msg + `<a href="https://finnhub.io/pricing" target="_blank" style="color:#2563eb;font-size:10px;margin-left:4px">${linkText}</a>`;
    } else if (err === 'NO_DATA') {
      syncEl.textContent = lang === 'ja'
        ? '⚠️ 価格データを取得できませんでした。銘柄コードを確認してください。'
        : '⚠️ No price data. Please check the ticker symbol.';
    }
    return;
  }

  const cur  = data[data.length - 1];
  const prev = data[data.length - 2] || cur;
  const diff = cur - prev;
  const pct  = ((diff / prev) * 100).toFixed(2);

  // 価格表示
  document.getElementById('price-jpy').textContent = formatCurrency(cur);
  document.getElementById('price-usd').textContent = formatCurrency(cur, { secondary: true });

  const changeEl = document.getElementById('change-display');
  changeEl.textContent = `${formatCurrency(diff, { signed: true })} (${pct}%)`;
  changeEl.className   = `price-change ${diff >= 0 ? 'up' : 'down'}`;

  document.getElementById('cash-display').textContent = formatCurrency(cash);
  document.getElementById('sync-time').innerHTML = I18N[lang].syncUpdated(formatClock(new Date()));

  // 保有情報
  const h = holdings[currentStock] || { qty: 0, avgCost: 0 };
  document.getElementById('current-qty').textContent     = I18N[lang].sharesUnit(h.qty);
  document.getElementById('current-avg-jpy').textContent = formatCurrency(h.avgCost);
  document.getElementById('current-avg-usd').textContent = formatCurrency(h.avgCost, { secondary: true });

  const pnlJpyEl = document.getElementById('current-pnl-jpy');
  const pnlUsdEl = document.getElementById('current-pnl-usd');
  if (h.qty > 0) {
    const pnlJpy = (cur - h.avgCost) * h.qty;
    pnlJpyEl.textContent = formatCurrency(pnlJpy, { signed: true });
    pnlUsdEl.textContent = formatCurrency(pnlJpy, { secondary: true, signed: true });
    pnlJpyEl.className   = `info-value ${pnlJpy >= 0 ? 'up' : 'down'}`;
  } else {
    pnlJpyEl.textContent = formatCurrency(0);
    pnlUsdEl.textContent = formatCurrency(0, { secondary: true });
    pnlJpyEl.className   = 'info-value';
  }

  // 保有資産一覧テーブル & 総資産計算
  let totalVal = cash;
  const heldEntries = [];
  Object.keys(holdings).forEach(k => {
    if (holdings[k].qty > 0 && prices[k] && prices[k].length > 0) {
      const curPrice = prices[k][prices[k].length - 1];
      const val      = curPrice * holdings[k].qty;
      const pnl      = (curPrice - holdings[k].avgCost) * holdings[k].qty;
      const pnlPct   = holdings[k].avgCost > 0 ? ((curPrice - holdings[k].avgCost) / holdings[k].avgCost) * 100 : 0;
      totalVal += val;
      heldEntries.push({ k, qty: holdings[k].qty, avgCost: holdings[k].avgCost, curPrice, val, pnl, pnlPct });
    }
  });

  // 信用取引含み損益を総資産に反映
  Object.values(shortPositions).forEach(pos => {
    const p = prices[pos.symbol];
    if (p && p.length > 0) totalVal += (pos.entryPrice - p[p.length - 1]) * pos.qty;
  });
  Object.values(leverageLongs).forEach(pos => {
    const p = prices[pos.symbol];
    if (p && p.length > 0) totalVal += (p[p.length - 1] - pos.entryPrice) * pos.qty * pos.leverage;
  });

  // 保有テーブル HTML
  let hHtml = '';
  if (heldEntries.length > 0) {
    const isJa = lang === 'ja';
    hHtml = `<div class="holdings-table-wrap">
      <div class="holdings-table-title">📋 ${isJa ? '保有資産一覧' : 'Holdings'}</div>
      <table class="holdings-table">
        <thead><tr>
          <th>${isJa ? '銘柄'   : 'Symbol'}</th>
          <th>${isJa ? '株数'   : 'Shares'}</th>
          <th>${isJa ? '取得単価': 'Avg Cost'}</th>
          <th>${isJa ? '現在値' : 'Price'}</th>
          <th>${isJa ? '評価額' : 'Value'}</th>
          <th>${isJa ? '損益'   : 'P&L'}</th>
        </tr></thead><tbody>`;
    heldEntries.forEach(({ k, qty, avgCost, curPrice, val, pnl, pnlPct }) => {
      const pnlClass  = pnl > 0 ? 'holding-pnl-pos' : pnl < 0 ? 'holding-pnl-neg' : 'holding-pnl-zero';
      const pnlSign   = pnl >= 0 ? '+' : '';
      const stockName = STOCKS[k]?.name || '';
      hHtml += `<tr>
        <td><span class="holding-symbol">${k}</span><span class="holding-name">${stockName}</span></td>
        <td>${I18N[lang].sharesUnit(qty)}</td>
        <td>${formatCurrency(avgCost)}</td>
        <td>${formatCurrency(curPrice)}</td>
        <td>${formatCurrency(val)}</td>
        <td class="${pnlClass}">${pnlSign}${formatCurrency(pnl)}<br>
          <span style="font-size:10px;font-weight:normal">${pnlSign}${pnlPct.toFixed(2)}%</span>
        </td>
      </tr>`;
    });
    hHtml += `</tbody></table></div>`;
  } else {
    hHtml = `<span style='color:#bbb;font-size:13px'>${I18N[lang].noHolding}</span>`;
  }
  document.getElementById('holdings-list').innerHTML = hHtml;
  document.getElementById('total-assets').innerHTML  =
    `<span id='label-total'>${I18N[lang].total}</span>: ${formatCurrency(totalVal)}`;

  // 各パネル更新（依存順）
  recordAssetSnapshot(totalVal);
  updateRiskMetrics();
  updateDiversification();
  drawChart();
  updatePlPanel();
  updateMarginPanel();
  pszAutoFillEntry();
  drawAssetHistoryChart();
  updateEarningsPanel(currentStock);
  updateTipRanksLink(currentStock);
  updateMacrotrendsLink(currentStock);
}

// ============================================================
// 株価チャート（Canvas）
// ============================================================

/** 現在銘柄の株価折れ線グラフを Canvas に描画する */
function drawChart() {
  const canvas = document.getElementById('chart');
  const dpr    = window.devicePixelRatio || 1;
  const W      = canvas.clientWidth;
  const H      = canvas.clientHeight;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const data = prices[currentStock];
  if (!data || data.length < 2) return;

  const pad    = { l: 68, r: 12, t: 10, b: 32 };
  const gW     = W - pad.l - pad.r;
  const gH     = H - pad.t - pad.b;
  const rawMin = Math.min(...data);
  const rawMax = Math.max(...data);
  const spread = rawMax - rawMin || rawMax * 0.01;
  const minP   = rawMin - spread * 0.08;
  const maxP   = rawMax + spread * 0.08;
  const isUp   = data[data.length - 1] >= data[0];
  const lineColor = isUp ? '#22c55e' : '#ef4444';

  const toX = i => pad.l + gW * i / (data.length - 1);
  const toY = v => pad.t + gH * (1 - (v - minP) / (maxP - minP));

  ctx.clearRect(0, 0, W, H);

  // Y軸グリッド & 金額ラベル
  const ySteps = 5;
  ctx.font      = '10px sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= ySteps; i++) {
    const val = minP + (maxP - minP) * (1 - i / ySteps);
    const y   = pad.t + gH * i / ySteps;
    ctx.strokeStyle = 'rgba(0,0,0,0.06)';
    ctx.lineWidth   = 0.5;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + gW, y); ctx.stroke();
    ctx.fillStyle = '#999';
    ctx.fillText(formatCurrency(val), pad.l - 4, y + 3.5);
  }

  // X軸 時刻ラベル（60点 = 10秒ごと ≈ 10分分）
  const xCount    = Math.min(6, data.length);
  const msPerPoint = 10000;
  const now        = Date.now();
  ctx.textAlign = 'center';
  ctx.fillStyle = '#999';
  ctx.font      = '10px sans-serif';
  for (let i = 0; i < xCount; i++) {
    const di     = Math.round(i * (data.length - 1) / (xCount - 1));
    const x      = toX(di);
    const secAgo = (data.length - 1 - di) * (msPerPoint / 1000);
    ctx.fillText(formatChartClock(new Date(now - secAgo * 1000)), x, H - 8);
    ctx.strokeStyle = 'rgba(0,0,0,0.04)';
    ctx.lineWidth   = 0.5;
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + gH); ctx.stroke();
  }

  // グラデーション塗りつぶし
  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + gH);
  grad.addColorStop(0, lineColor + '44');
  grad.addColorStop(1, lineColor + '00');
  ctx.beginPath();
  data.forEach((v, i) => i === 0 ? ctx.moveTo(toX(i), toY(v)) : ctx.lineTo(toX(i), toY(v)));
  ctx.lineTo(toX(data.length - 1), pad.t + gH);
  ctx.lineTo(pad.l, pad.t + gH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // 折れ線
  ctx.strokeStyle = lineColor;
  ctx.lineWidth   = 2;
  ctx.lineJoin    = 'round';
  ctx.beginPath();
  data.forEach((v, i) => i === 0 ? ctx.moveTo(toX(i), toY(v)) : ctx.lineTo(toX(i), toY(v)));
  ctx.stroke();

  // 現在価格の横線（破線）
  const curY = toY(data[data.length - 1]);
  ctx.strokeStyle = lineColor + '88';
  ctx.lineWidth   = 0.8;
  ctx.setLineDash([4, 3]);
  ctx.beginPath(); ctx.moveTo(pad.l, curY); ctx.lineTo(pad.l + gW, curY); ctx.stroke();
  ctx.setLineDash([]);
}

// ============================================================
// 待機注文一覧
// ============================================================

/** 現在銘柄の待機注文リストをパネルに描画する */
function renderPendingOrders() {
  const panel    = document.getElementById('pending-orders-panel');
  const list     = document.getElementById('pending-orders-list');
  const filtered = pendingOrders.filter(o => o.symbol === currentStock);
  panel.style.display = filtered.length > 0 ? '' : 'none';
  if (filtered.length === 0) return;

  list.innerHTML = filtered.map(o => {
    const sideLabel = o.side === 'buy'
      ? (lang === 'ja' ? '買' : 'Buy')
      : (lang === 'ja' ? '売' : 'Sell');
    let typeLabel, badgeClass;
    if (o.type === 'limit') {
      typeLabel = lang === 'ja' ? '指値' : 'Limit'; badgeClass = 'badge-limit';
    } else if (o.type === 'stop') {
      typeLabel = lang === 'ja' ? '逆指値' : 'Stop'; badgeClass = 'badge-stop';
    } else if (o.type === 'oco') {
      typeLabel  = o.ocoRole === 'profit'
        ? (lang === 'ja' ? 'OCO利確' : 'OCO TP')
        : (lang === 'ja' ? 'OCO損切' : 'OCO SL');
      badgeClass = 'badge-oco';
    }
    return `<div class="order-item order-${o.type}">
      <div class="order-detail">
        <span class="order-badge ${badgeClass}">${typeLabel}</span>
        <strong>${o.symbol}</strong> ${sideLabel} ${I18N[lang].sharesUnit(o.qty)} @ ${formatCurrency(o.price)}
      </div>
      <button class="order-cancel" onclick="cancelOrder('${o.id}')" title="${lang === 'ja' ? '取消' : 'Cancel'}">✕</button>
    </div>`;
  }).join('');
}

// ============================================================
// 注文タイプ切替
// ============================================================

/**
 * 注文タイプ（成行・指値・逆指値・OCO）を切り替えてパネルを更新する
 * @param {'market'|'limit'|'stop'|'oco'} type
 */
function switchOrderTab(type) {
  currentOrderType = type;
  ['market','limit','stop','oco'].forEach(t => {
    document.getElementById('tab-' + t).classList.toggle('active', t === type);
  });
  const mainPanel = document.getElementById('panel-market-limit-stop');
  const ocoPanel  = document.getElementById('panel-oco');
  mainPanel.style.display = type === 'oco' ? 'none' : '';
  ocoPanel.style.display  = type === 'oco' ? ''     : 'none';

  const showPrice = type === 'limit' || type === 'stop';
  document.getElementById('buy-price-row').style.display  = showPrice ? '' : 'none';
  document.getElementById('sell-price-row').style.display = showPrice ? '' : 'none';

  const t          = I18N[lang];
  const typeLabel  = {
    market : '',
    limit  : lang === 'ja' ? '（指値）'   : ' (Limit)',
    stop   : lang === 'ja' ? '（逆指値）' : ' (Stop)',
  };
  const tl         = typeLabel[type] || '';
  document.getElementById('btn-buy-label').textContent  = (t.buyBtn  || '買い注文') + tl;
  document.getElementById('btn-sell-label').textContent = (t.sellBtn || '売り注文') + tl;

  prefillLimitPrice();
}

/** 指値・逆指値・OCO の価格入力欄に現在価格をプリフィルする（未入力時のみ） */
function prefillLimitPrice() {
  if (!currentStock || !prices[currentStock] || prices[currentStock].length === 0) return;
  const cur = prices[currentStock][prices[currentStock].length - 1];
  ['buy-limit-price','sell-limit-price','oco-profit-price','oco-stop-price'].forEach(id => {
    const el = document.getElementById(id);
    if (el && !el.value) el.value = cur;
  });
}

// ============================================================
// P/L パネル
// ============================================================

function togglePlPanel() {
  plPanelOpen = !plPanelOpen;
  document.getElementById('pl-panel-body').style.display    = plPanelOpen ? '' : 'none';
  document.getElementById('pl-panel-chevron').textContent   = plPanelOpen ? '▼' : '▶';
}

/** ポートフォリオ全体の含み損益・実現損益・勝率を計算して P/L パネルに描画する */
function updatePlPanel() {
  const isJa = lang === 'ja';

  // ラベル
  const labelMap = {
    'label-pl-panel'       : isJa ? 'リアルタイム損益（P/L）'      : 'Real-time P&L',
    'pl-label-cost'        : isJa ? '投資元本'                      : 'Cost Basis',
    'pl-label-mkt'         : isJa ? '時価評価額'                    : 'Market Value',
    'pl-label-ret'         : isJa ? '損益率'                        : 'Return',
    'pl-hero-label'        : isJa ? '含み損益（ポートフォリオ合計）': 'Unrealized P&L (Total Portfolio)',
    'pl-breakdown-title'   : isJa ? '銘柄別 含み損益'               : 'P&L by Stock',
    'pl-realized-title'    : isJa ? '実現損益（確定済み）'          : 'Realized P&L',
    'pl-label-realized'    : isJa ? '累計実現損益'                  : 'Total Realized',
    'pl-label-trades'      : isJa ? '売買回数'                      : 'Trades',
    'pl-label-winrate'     : isJa ? '勝率'                          : 'Win Rate',
  };
  Object.entries(labelMap).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  });

  // 含み損益計算
  let totalCost = 0, totalMkt = 0;
  const rows = [];
  Object.keys(holdings).forEach(k => {
    const h = holdings[k];
    if (h.qty <= 0 || !prices[k] || prices[k].length === 0) return;
    const curPrice = prices[k][prices[k].length - 1];
    const cost     = h.avgCost * h.qty;
    const mkt      = curPrice  * h.qty;
    const pnl      = mkt - cost;
    const pnlPct   = cost > 0 ? (pnl / cost) * 100 : 0;
    totalCost += cost;
    totalMkt  += mkt;
    rows.push({ k, pnl, pnlPct, cost, mkt });
  });

  const totalPnl    = totalMkt - totalCost;
  const totalPnlPct = totalCost > 0 ? (totalPnl / totalCost) * 100 : 0;

  // サマリーバー
  document.getElementById('pl-cost-val').textContent = totalCost > 0 ? formatCurrency(totalCost) : '--';
  document.getElementById('pl-mkt-val').textContent  = totalMkt  > 0 ? formatCurrency(totalMkt)  : '--';
  const retEl = document.getElementById('pl-ret-val');
  if (totalCost > 0) {
    const sign = totalPnlPct >= 0 ? '+' : '';
    retEl.textContent = `${sign}${totalPnlPct.toFixed(2)}%`;
    retEl.className   = `pl-summary-value ${totalPnl > 0 ? 'up' : totalPnl < 0 ? 'down' : ''}`;
  } else {
    retEl.textContent = '--'; retEl.className = 'pl-summary-value';
  }

  // ヒーロー表示
  const heroEl    = document.getElementById('pl-hero');
  const heroValEl = document.getElementById('pl-hero-value');
  const heroSubEl = document.getElementById('pl-hero-sub');
  const heroUsdEl = document.getElementById('pl-hero-usd');
  if (totalCost === 0) {
    heroEl.className    = 'pl-hero zero';
    heroValEl.className = 'pl-hero-value zero';
    heroValEl.textContent = isJa ? '¥0（ポジションなし）' : '¥0 (No positions)';
    heroSubEl.textContent = '--';
    heroUsdEl.textContent = '';
  } else {
    const sign = totalPnl >= 0 ? '+' : '';
    const cls  = totalPnl > 0 ? 'profit' : totalPnl < 0 ? 'loss' : 'zero';
    heroEl.className    = `pl-hero ${cls}`;
    heroValEl.className = `pl-hero-value ${cls}`;
    heroValEl.textContent = `${sign}${formatCurrency(totalPnl)}`;
    heroSubEl.textContent = `${sign}${totalPnlPct.toFixed(2)}%　${isJa ? '（元本比）' : '(vs cost basis)'}`;
    heroUsdEl.textContent = `${sign}${formatCurrency(totalPnl, { secondary: true, signed: true })}`;
  }

  // 銘柄別バー
  const rowsEl = document.getElementById('pl-rows');
  if (rows.length === 0) {
    rowsEl.innerHTML = `<div style="color:#bbb;font-size:12px;padding:8px 0">${isJa ? '保有銘柄なし' : 'No positions held'}</div>`;
  } else {
    const maxAbs = Math.max(...rows.map(r => Math.abs(r.pnl)), 1);
    rowsEl.innerHTML = rows
      .sort((a, b) => b.pnl - a.pnl)
      .map(({ k, pnl, pnlPct }) => {
        const cls      = pnl > 0 ? 'profit' : pnl < 0 ? 'loss' : 'zero';
        const barWidth = Math.max(2, Math.abs(pnl) / maxAbs * 100);
        const sign     = pnl >= 0 ? '+' : '';
        const pctSign  = pnlPct >= 0 ? '+' : '';
        return `<div class="pl-row" onclick="switchStock('${k}')">
          <span class="pl-row-symbol">${k}</span>
          <div class="pl-row-bar-wrap">
            <div class="pl-row-bar ${cls}" style="width:${barWidth}%"></div>
          </div>
          <div class="pl-row-right">
            <span class="pl-row-amount ${cls}">${sign}${formatCurrency(pnl)}</span>
            <span class="pl-row-pct">${pctSign}${pnlPct.toFixed(2)}%</span>
          </div>
        </div>`;
      }).join('');
  }

  // 実現損益
  const totalRealized = realizedTrades.reduce((s, t) => s + t.pnl, 0);
  const tradeCount    = realizedTrades.length;
  const winCount      = realizedTrades.filter(t => t.pnl > 0).length;
  const winRate       = tradeCount > 0 ? (winCount / tradeCount * 100) : null;

  const realizedEl = document.getElementById('pl-realized-val');
  if (tradeCount === 0) {
    realizedEl.textContent = isJa ? '取引なし' : 'No trades yet';
    realizedEl.className   = 'pl-realized-value zero';
  } else {
    const sign = totalRealized >= 0 ? '+' : '';
    realizedEl.textContent = `${sign}${formatCurrency(totalRealized)}`;
    realizedEl.className   = `pl-realized-value ${totalRealized > 0 ? 'profit' : totalRealized < 0 ? 'loss' : 'zero'}`;
  }

  document.getElementById('pl-trades-val').textContent = tradeCount > 0 ? `${tradeCount}${isJa ? '回' : ' trades'}` : '--';
  const winRateEl = document.getElementById('pl-winrate-val');
  if (winRate === null) {
    winRateEl.textContent = '--'; winRateEl.className = 'pl-realized-value';
  } else {
    winRateEl.textContent = `${winRate.toFixed(1)}%　(${winCount}/${tradeCount})`;
    winRateEl.className   = `pl-realized-value ${winRate >= 50 ? 'profit' : 'loss'}`;
  }
}

// ============================================================
// 資産推移グラフ
// ============================================================

function toggleAssetHistoryPanel() {
  ahPanelOpen = !ahPanelOpen;
  document.getElementById('asset-history-body').style.display    = ahPanelOpen ? '' : 'none';
  document.getElementById('asset-history-chevron').textContent   = ahPanelOpen ? '▼' : '▶';
}

/**
 * 資産推移グラフの表示期間を切り替える
 * @param {'all'|'1h'|'3h'|'1d'} range
 * @param {HTMLElement} btn
 */
function setAhRange(range, btn) {
  ahRange = range;
  document.querySelectorAll('.range-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  drawAssetHistoryChart();
}

/**
 * 現在の ahRange に合わせてフィルタされた assetHistory を返す
 * @returns {{ t: number, v: number }[]}
 */
function getAhFilteredData() {
  if (!assetHistory || assetHistory.length === 0) return [];
  if (ahRange === 'all') return assetHistory;
  const msMap    = { '1h': 3_600_000, '3h': 10_800_000, '1d': 86_400_000 };
  const cutoff   = Date.now() - (msMap[ahRange] || 0);
  const filtered = assetHistory.filter(p => p.t >= cutoff);
  return filtered.length > 0 ? filtered : assetHistory.slice(-1);
}

/** タイムスタンプを HH:MM 形式に変換する（資産推移グラフ X 軸用） */
function formatAhTime(ts) {
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

/** タイムスタンプを M/D HH:MM 形式に変換する（長期間表示用） */
function formatAhDate(ts) {
  const d = new Date(ts);
  return `${d.getMonth()+1}/${d.getDate()} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}

/** 資産推移グラフ上部の統計値（開始・現在・損益・損益率）を更新する */
function updateAssetHistoryStats(data) {
  const isJa = lang === 'ja';
  const labelMap = {
    'ah-label-start'    : isJa ? '開始時資産'  : 'Start',
    'ah-label-current'  : isJa ? '現在の総資産' : 'Current',
    'ah-label-change'   : isJa ? '累計損益'    : 'Total P&L',
    'ah-label-changepct': isJa ? '損益率'       : 'Return',
    'label-asset-history': isJa ? '総資産推移'  : 'Asset History',
  };
  Object.entries(labelMap).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  });
  const rangeAllEl = document.getElementById('ah-range-all');
  if (rangeAllEl) rangeAllEl.textContent = isJa ? '全期間' : 'All';

  const els = ['ah-start-val','ah-current-val','ah-change-val','ah-changepct-val'].map(id => document.getElementById(id));
  if (!data || data.length === 0) {
    els.forEach(el => { if (el) { el.textContent = '--'; el.className = 'ah-stat-value'; } });
    return;
  }

  const startVal   = assetHistory[0].v;
  const currentVal = data[data.length - 1].v;
  const change     = currentVal - startVal;
  const changePct  = startVal > 0 ? (change / startVal) * 100 : 0;
  const sign       = change >= 0 ? '+' : '';
  const cls        = change > 0 ? 'up' : change < 0 ? 'down' : '';

  const [startEl, currentEl, changeEl, changePctEl] = els;
  if (startEl)    { startEl.textContent    = formatCurrency(startVal);   startEl.className    = 'ah-stat-value'; }
  if (currentEl)  { currentEl.textContent  = formatCurrency(currentVal); currentEl.className  = 'ah-stat-value'; }
  if (changeEl)   { changeEl.textContent   = `${sign}${formatCurrency(change)}`; changeEl.className = `ah-stat-value ${cls}`; }
  if (changePctEl){ changePctEl.textContent= `${sign}${changePct.toFixed(2)}%`;  changePctEl.className = `ah-stat-value ${cls}`; }
}

/** 総資産推移を Canvas に描画する（折れ線 + グラデーション + 最高値・最低値マーカー） */
function drawAssetHistoryChart() {
  const data   = getAhFilteredData();
  const canvas = document.getElementById('asset-history-canvas');
  const noData = document.getElementById('ah-no-data');

  updateAssetHistoryStats(data);

  if (!data || data.length < 2) {
    canvas.style.display = 'none';
    noData.style.display = '';
    noData.textContent   = lang === 'ja' ? '取引を始めると推移が表示されます' : 'Make trades to see your asset history';
    return;
  }
  canvas.style.display = '';
  noData.style.display = 'none';

  const dpr = window.devicePixelRatio || 1;
  const W   = canvas.clientWidth;
  const H   = canvas.clientHeight;
  canvas.width  = W * dpr;
  canvas.height = H * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);

  const pad    = { l: 72, r: 14, t: 16, b: 32 };
  const gW     = W - pad.l - pad.r;
  const gH     = H - pad.t - pad.b;
  const vals   = data.map(p => p.v);
  const rawMin = Math.min(...vals);
  const rawMax = Math.max(...vals);
  const spread = rawMax - rawMin || rawMax * 0.01 || 1;
  const minV   = rawMin - spread * 0.1;
  const maxV   = rawMax + spread * 0.1;
  const startVal  = assetHistory[0].v;
  const lineColor = data[data.length - 1].v >= startVal ? '#22c55e' : '#ef4444';

  const toX = i => pad.l + gW * i / (data.length - 1);
  const toY = v => pad.t + gH * (1 - (v - minV) / (maxV - minV));

  ctx.clearRect(0, 0, W, H);

  // Y軸グリッド & ラベル
  ctx.font = '10px sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i <= 4; i++) {
    const val = minV + (maxV - minV) * (1 - i / 4);
    const y   = pad.t + gH * i / 4;
    ctx.strokeStyle = 'rgba(0,0,0,0.05)'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(pad.l, y); ctx.lineTo(pad.l + gW, y); ctx.stroke();
    ctx.fillStyle = '#aaa';
    ctx.fillText(formatCurrency(val), pad.l - 4, y + 3.5);
  }

  // 基準線（開始時資産）
  if (startVal >= minV && startVal <= maxV) {
    const baseY = toY(startVal);
    ctx.strokeStyle = 'rgba(100,100,100,0.25)'; ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath(); ctx.moveTo(pad.l, baseY); ctx.lineTo(pad.l + gW, baseY); ctx.stroke();
    ctx.setLineDash([]);
    ctx.fillStyle = '#aaa'; ctx.font = '9px sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(lang === 'ja' ? '開始' : 'Start', pad.l + 2, baseY - 3);
    ctx.textAlign = 'right';
  }

  // X軸ラベル
  const xCount = Math.min(5, data.length);
  ctx.textAlign = 'center'; ctx.fillStyle = '#aaa'; ctx.font = '10px sans-serif';
  for (let i = 0; i < xCount; i++) {
    const di    = Math.round(i * (data.length - 1) / (xCount - 1));
    const x     = toX(di);
    const label = ahRange === 'all' && data.length > 50 ? formatAhDate(data[di].t) : formatAhTime(data[di].t);
    ctx.fillText(label, x, H - 8);
    ctx.strokeStyle = 'rgba(0,0,0,0.04)'; ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.moveTo(x, pad.t); ctx.lineTo(x, pad.t + gH); ctx.stroke();
  }

  // グラデーション塗りつぶし
  const grad = ctx.createLinearGradient(0, pad.t, 0, pad.t + gH);
  grad.addColorStop(0, lineColor + '50');
  grad.addColorStop(1, lineColor + '00');
  ctx.beginPath();
  data.forEach((p, i) => { const x = toX(i), y = toY(p.v); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
  ctx.lineTo(toX(data.length - 1), pad.t + gH);
  ctx.lineTo(pad.l, pad.t + gH);
  ctx.closePath();
  ctx.fillStyle = grad; ctx.fill();

  // 折れ線
  ctx.strokeStyle = lineColor; ctx.lineWidth = 2; ctx.lineJoin = 'round';
  ctx.beginPath();
  data.forEach((p, i) => { const x = toX(i), y = toY(p.v); i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y); });
  ctx.stroke();

  // 最新値ドット（光るエフェクト）
  const lx = toX(data.length - 1), ly = toY(data[data.length - 1].v);
  ctx.beginPath(); ctx.arc(lx, ly, 5, 0, Math.PI * 2); ctx.fillStyle = lineColor + '33'; ctx.fill();
  ctx.beginPath(); ctx.arc(lx, ly, 3, 0, Math.PI * 2); ctx.fillStyle = lineColor; ctx.fill();

  // 最高値・最低値マーカー
  const maxIdx = vals.indexOf(Math.max(...vals));
  const minIdx = vals.indexOf(Math.min(...vals));
  [[maxIdx, Math.max(...vals), '#22c55e', -10], [minIdx, Math.min(...vals), '#ef4444', 14]].forEach(([idx, val, color, yOff]) => {
    if (idx < 0) return;
    const mx = toX(idx), my = toY(val);
    ctx.beginPath(); ctx.arc(mx, my, 3, 0, Math.PI * 2); ctx.fillStyle = color; ctx.fill();
    ctx.fillStyle = color; ctx.font = 'bold 9px sans-serif';
    ctx.textAlign = idx > data.length * 0.7 ? 'right' : 'left';
    ctx.fillText(formatCurrency(val), mx + (idx > data.length * 0.7 ? -6 : 6), my + yOff);
    ctx.textAlign = 'right';
  });
}

// ============================================================
// 分散分析パネル
// ============================================================

function toggleDivPanel() {
  divPanelOpen = !divPanelOpen;
  document.getElementById('div-panel-body').style.display  = divPanelOpen ? '' : 'none';
  document.getElementById('div-panel-chevron').textContent = divPanelOpen ? '▼' : '▶';
}

function toggleEarningsPanel() {
  earningsPanelOpen = !earningsPanelOpen;
  document.getElementById('earnings-panel-body').style.display  = earningsPanelOpen ? '' : 'none';
  document.getElementById('earnings-panel-chevron').textContent = earningsPanelOpen ? '▼' : '▶';
}

// ============================================================
// 信用取引パネル
// ============================================================

function toggleMarginPanel() {
  marginPanelOpen = !marginPanelOpen;
  document.getElementById('margin-panel-body').style.display    = marginPanelOpen ? '' : 'none';
  document.getElementById('margin-panel-chevron').textContent   = marginPanelOpen ? '▼' : '▶';
}

/**
 * 信用取引タブ（新規空売り・空売り返済・信用買い・信用買い返済）を切り替える
 * @param {'short'|'cover'|'llong'|'lclose'} tab
 */
function switchMarginTab(tab) {
  currentMarginTab = tab;
  const activeClassMap = { short: 'active-short', cover: 'active-cover', llong: 'active-long', lclose: 'active-close' };
  ['short','cover','llong','lclose'].forEach(t => {
    document.getElementById('mtab-' + t).className  = 'margin-trade-tab' + (t === tab ? ' ' + activeClassMap[t] : '');
    document.getElementById('mform-' + t).style.display = t === tab ? '' : 'none';
  });
  if (tab === 'cover')  updateCoverSelect();
  if (tab === 'lclose') updateLcloseSelect();
  updateMarginRequiredDisplay();
}

/** 空売り・信用買いの必要証拠金プレビューを更新する */
function updateMarginRequiredDisplay() {
  const p = prices[currentStock];
  if (!p || p.length === 0) return;
  const cur = p[p.length - 1];

  const shortQty = parseInt(document.getElementById('short-qty').value)  || 0;
  const shortLev = parseInt(document.getElementById('short-leverage').value) || 2;
  document.getElementById('short-required-val').textContent = formatCurrency(Math.round(cur * shortQty / shortLev));

  const llongQty = parseInt(document.getElementById('llong-qty').value)  || 0;
  const llongLev = parseInt(document.getElementById('llong-leverage').value) || 2;
  document.getElementById('llong-required-val').textContent = formatCurrency(Math.round(cur * llongQty / llongLev));

  updateCoverPnlPreview();
  updateLclosePnlPreview();
}

/** 空売り返済セレクトボックスを最新のポジション情報で更新する */
function updateCoverSelect() {
  const sel     = document.getElementById('cover-stock-select');
  const entries = Object.values(shortPositions);
  sel.innerHTML = entries.length === 0
    ? `<option value="">${lang === 'ja' ? '空売りポジションなし' : 'No short positions'}</option>`
    : entries.map(pos => {
        const p   = prices[pos.symbol];
        const cur = p && p.length > 0 ? p[p.length - 1] : pos.entryPrice;
        const pnl = (pos.entryPrice - cur) * pos.qty;
        const sign = pnl >= 0 ? '+' : '';
        return `<option value="${pos.id}">${pos.symbol} ${pos.qty}株 @ ${formatCurrency(pos.entryPrice)} (${sign}${formatCurrency(pnl)})</option>`;
      }).join('');
  updateCoverPnlPreview();
}

/** 信用買い返済セレクトボックスを最新のポジション情報で更新する */
function updateLcloseSelect() {
  const sel     = document.getElementById('lclose-stock-select');
  const entries = Object.values(leverageLongs);
  sel.innerHTML = entries.length === 0
    ? `<option value="">${lang === 'ja' ? '信用買いポジションなし' : 'No leveraged long positions'}</option>`
    : entries.map(pos => {
        const p   = prices[pos.symbol];
        const cur = p && p.length > 0 ? p[p.length - 1] : pos.entryPrice;
        const pnl = (cur - pos.entryPrice) * pos.qty;
        const sign = pnl >= 0 ? '+' : '';
        return `<option value="${pos.id}">${pos.symbol} ${pos.qty}株 @ ${formatCurrency(pos.entryPrice)} (${sign}${formatCurrency(pnl)})</option>`;
      }).join('');
  updateLclosePnlPreview();
}

/** 空売り返済フォームの概算損益プレビューを更新する */
function updateCoverPnlPreview() {
  const posId = document.getElementById('cover-stock-select').value;
  const qty   = parseInt(document.getElementById('cover-qty').value) || 0;
  const pos   = shortPositions[posId];
  const el    = document.getElementById('cover-pnl-val');
  if (!pos || !el) { if (el) el.textContent = '--'; return; }
  const p   = prices[pos.symbol];
  if (!p || p.length === 0) return;
  const pnl  = (pos.entryPrice - p[p.length - 1]) * Math.min(qty, pos.qty);
  const sign = pnl >= 0 ? '+' : '';
  el.textContent = `${sign}${formatCurrency(pnl)}`;
  el.style.color = pnl >= 0 ? '#4ade80' : '#f87171';
}

/** 信用買い返済フォームの概算損益プレビューを更新する */
function updateLclosePnlPreview() {
  const posId = document.getElementById('lclose-stock-select').value;
  const qty   = parseInt(document.getElementById('lclose-qty').value) || 0;
  const pos   = leverageLongs[posId];
  const el    = document.getElementById('lclose-pnl-val');
  if (!pos || !el) { if (el) el.textContent = '--'; return; }
  const p   = prices[pos.symbol];
  if (!p || p.length === 0) return;
  const pnl  = (p[p.length - 1] - pos.entryPrice) * Math.min(qty, pos.qty);
  const sign = pnl >= 0 ? '+' : '';
  el.textContent = `${sign}${formatCurrency(pnl)}`;
  el.style.color = pnl >= 0 ? '#4ade80' : '#f87171';
}

/** 信用取引の証拠金状況・ポジション一覧・維持率バーを更新する */
function updateMarginPanel() {
  const isJa = lang === 'ja';
  const labelMap = {
    'label-margin-panel'    : isJa ? '信用取引（空売り・レバレッジ）'    : 'Margin Trading (Short & Leverage)',
    'margin-badge-label'    : isJa ? '信用'                               : 'Margin',
    'label-margin-deposit'  : isJa ? '預け証拠金'                         : 'Collateral',
    'label-margin-used'     : isJa ? '使用中証拠金'                       : 'Margin Used',
    'label-margin-ratio'    : isJa ? '維持率'                             : 'Maint. Ratio',
    'label-short-qty'       : isJa ? '空売り数量'                         : 'Short Qty',
    'label-short-leverage'  : isJa ? 'レバレッジ'                         : 'Leverage',
    'label-short-required'  : isJa ? '必要証拠金'                         : 'Required Margin',
    'btn-short-label'       : isJa ? '空売り注文（新規）'                  : 'Open Short',
    'short-desc'            : isJa ? '株価下落で利益。借り株を高値で売り、安値で買い戻して差益を得る信用取引です。' : 'Profit when price falls. Borrow shares to sell high, then buy back at a lower price.',
    'label-cover-stock'     : isJa ? '返済する空売りポジション'            : 'Short position to close',
    'label-cover-qty'       : isJa ? '返済数量'                           : 'Close Qty',
    'label-cover-pnl'       : isJa ? '概算損益'                           : 'Est. P&L',
    'btn-cover-label'       : isJa ? '空売り返済（買い戻し）'              : 'Close Short (Buy to Cover)',
    'label-llong-qty'       : isJa ? '信用買い数量'                       : 'Leveraged Buy Qty',
    'label-llong-leverage'  : isJa ? 'レバレッジ'                         : 'Leverage',
    'label-llong-required'  : isJa ? '必要証拠金'                         : 'Required Margin',
    'btn-llong-label'       : isJa ? '信用買い注文（新規）'                : 'Open Leveraged Long',
    'llong-desc'            : isJa ? 'レバレッジをかけて現金以上の買いポジションを持てます。利益も損失も倍率分拡大します。' : 'Open a buy position larger than your cash with leverage. Both gains and losses are amplified.',
    'label-lclose-stock'    : isJa ? '返済する信用買いポジション'          : 'Long position to close',
    'label-lclose-qty'      : isJa ? '返済数量'                           : 'Close Qty',
    'label-lclose-pnl'      : isJa ? '概算損益'                           : 'Est. P&L',
    'btn-lclose-label'      : isJa ? '信用買い返済（転売）'                : 'Close Leveraged Long',
  };
  Object.entries(labelMap).forEach(([id, val]) => {
    const el = document.getElementById(id);
    if (el) el.textContent = val;
  });

  // 証拠金計算
  let totalCollateral = 0, totalExposure = 0, totalShortPnl = 0, totalLlongPnl = 0;
  Object.values(shortPositions).forEach(pos => {
    totalCollateral += pos.collateral;
    const p   = prices[pos.symbol];
    const cur = p && p.length > 0 ? p[p.length - 1] : pos.entryPrice;
    totalExposure  += cur * pos.qty;
    totalShortPnl  += (pos.entryPrice - cur) * pos.qty;
  });
  Object.values(leverageLongs).forEach(pos => {
    totalCollateral += pos.collateral;
    const p   = prices[pos.symbol];
    const cur = p && p.length > 0 ? p[p.length - 1] : pos.entryPrice;
    totalLlongPnl  += (cur - pos.entryPrice) * pos.qty * pos.leverage;
  });

  document.getElementById('margin-deposit-val').textContent = formatCurrency(totalCollateral);
  document.getElementById('margin-used-val').textContent    = formatCurrency(totalExposure);

  const barWrap = document.getElementById('maintenance-bar-wrap');
  const ratioEl = document.getElementById('margin-ratio-val');
  if (totalExposure === 0) {
    ratioEl.textContent = isJa ? '--（ポジションなし）' : '-- (no positions)';
    ratioEl.className   = 'margin-stat-value safe';
    barWrap.style.display = 'none';
  } else {
    const netAsset = totalCollateral + totalShortPnl + totalLlongPnl;
    const ratio    = (netAsset / totalExposure) * 100;
    ratioEl.textContent = `${ratio.toFixed(1)}%`;
    ratioEl.className   = `margin-stat-value ${ratio < 100 ? 'danger' : ratio < 130 ? 'warning' : 'safe'}`;
    barWrap.style.display = '';
    document.getElementById('maintenance-bar-pct').textContent = `${ratio.toFixed(1)}%`;
    const fillEl = document.getElementById('maintenance-bar-fill');
    fillEl.style.width = Math.min(100, ratio / 2) + '%';
    fillEl.className   = `maintenance-bar-fill ${ratio < 100 ? 'danger' : ratio < 130 ? 'warning' : 'safe'}`;
    document.getElementById('maintenance-note').textContent = isJa
      ? '維持率 130%未満で追証警告 / 100%未満でロスカット'
      : 'Margin call warning below 130% / Force-close below 100%';
  }

  // ポジション一覧
  const listEl      = document.getElementById('short-positions-list');
  const allPositions = [
    ...Object.values(shortPositions).map(p => ({ ...p, posType: 'short' })),
    ...Object.values(leverageLongs).map(p  => ({ ...p, posType: 'llong' })),
  ];
  if (allPositions.length === 0) {
    listEl.innerHTML = `<div style="color:#475569;font-size:12px;text-align:center;padding:10px 0;margin-top:8px">${isJa ? '信用ポジションなし' : 'No margin positions'}</div>`;
  } else {
    listEl.innerHTML =
      `<div style="font-size:11px;font-weight:bold;color:#64748b;margin:10px 0 8px">${isJa ? '📋 保有中の信用ポジション' : '📋 Open Margin Positions'}</div>` +
      allPositions.map(pos => {
        const p       = prices[pos.symbol];
        const cur     = p && p.length > 0 ? p[p.length - 1] : pos.entryPrice;
        const isShort = pos.posType === 'short';
        const pnl     = isShort ? (pos.entryPrice - cur) * pos.qty : (cur - pos.entryPrice) * pos.qty * pos.leverage;
        const pnlCls  = pnl >= 0 ? 'profit' : 'loss';
        const sign    = pnl >= 0 ? '+' : '';
        const typeLabel = isShort ? (isJa ? '📉空売り' : '📉Short') : (isJa ? '📈信用買い' : '📈Lev.Long');
        return `<div class="${isShort ? 'short-pos-item' : 'leverage-pos-item'}">
          <div class="short-pos-left">
            <div class="${isShort ? 'short-pos-symbol' : 'leverage-pos-symbol'}">${typeLabel} ${pos.symbol} × ${pos.qty}株</div>
            <div class="short-pos-detail">
              ${isJa ? '建値' : 'Entry'}: ${formatCurrency(pos.entryPrice)} &nbsp;
              ${isJa ? '現在' : 'Now'}: ${formatCurrency(cur)} &nbsp;
              ${pos.leverage}${isJa ? '倍' : 'x'} &nbsp;
              ${isJa ? '証拠金' : 'Margin'}: ${formatCurrency(pos.collateral)}
            </div>
          </div>
          <div class="short-pos-pnl ${pnlCls}">${sign}${formatCurrency(pnl)}</div>
        </div>`;
      }).join('');
  }

  updateMarginRequiredDisplay();
}

// ============================================================
// ポジションサイジング UI
// ============================================================

function togglePszPanel() {
  pszPanelOpen = !pszPanelOpen;
  document.getElementById('psz-body').style.display  = pszPanelOpen ? '' : 'none';
  document.getElementById('psz-chevron').textContent = pszPanelOpen ? '▼' : '▶';
}

/**
 * ポジションサイジング手法を切り替えてフォームと説明文を更新する
 * @param {'fixed'|'kelly'|'atr'|'rr'} method
 */
function switchPszMethod(method) {
  pszMethod = method;
  ['fixed','kelly','atr','rr'].forEach(m => {
    document.getElementById('psztab-' + m).classList.toggle('active', m === method);
    document.getElementById('psz-form-' + m).style.display = m === method ? '' : 'none';
  });
  document.getElementById('psz-method-desc').textContent = PSZ_METHOD_DESC[lang][method];
  if (method === 'atr')   fillAtr();
  if (method === 'kelly') fillKellyFromHistory();
  calcPsz();
}

/**
 * ポジションサイジングスライダーの値を表示ラベルに反映する
 * @param {HTMLElement} el    - スライダー要素
 * @param {string}      valId - 値表示先要素の ID
 */
function onPszSlider(el, valId) {
  const v          = parseFloat(el.value);
  const isKellyFrac= el.id === 'psz-kelly-frac';
  document.getElementById(valId).textContent = isKellyFrac ? v + '%' : v.toFixed(1) + '%';
  const min = parseFloat(el.min), max = parseFloat(el.max);
  el.style.setProperty('--val', ((v - min) / (max - min) * 100).toFixed(1) + '%');
}

/** PSZ 計算結果（推奨株数）を注文欄に反映してスクロールする */
function applyPszToOrder() {
  if (pszLastShares <= 0) return;
  document.getElementById('buy-qty').value  = pszLastShares;
  document.getElementById('sell-qty').value = pszLastShares;
  switchOrderTab('market');
  showToast(lang === 'ja'
    ? `✅ ${pszLastShares.toLocaleString()}株 を注文欄に反映しました`
    : `✅ Applied ${pszLastShares.toLocaleString()} shares to order`);
  document.querySelector('.order-type-tabs')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

/** 銘柄切替・価格更新時に PSZ の全エントリー価格フィールドへ現在値を自動入力する */
function pszAutoFillEntry() {
  const p = prices[currentStock];
  if (!p || p.length === 0) return;
  const cur = p[p.length - 1];
  ['psz-entry','psz-entry-kelly','psz-entry-atr','psz-entry-rr'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = cur;
  });
  if (pszMethod === 'atr') fillAtr();
  calcPsz();
}

// ============================================================
// イベントリスナー登録（初期化）
// ============================================================

document.addEventListener('DOMContentLoaded', () => {
  // 信用取引フォームのリアルタイムプレビュー
  ['short-qty','short-leverage','llong-qty','llong-leverage'].forEach(id => {
    document.getElementById(id)?.addEventListener('input', updateMarginRequiredDisplay);
  });
  document.getElementById('cover-qty')?.addEventListener('input', updateCoverPnlPreview);
  document.getElementById('cover-stock-select')?.addEventListener('change', updateCoverPnlPreview);
  document.getElementById('lclose-qty')?.addEventListener('input', updateLclosePnlPreview);
  document.getElementById('lclose-stock-select')?.addEventListener('change', updateLclosePnlPreview);
});


// ============================================================
// 決算カレンダー＋EPSサプライズ パネル
// ============================================================

/**
 * 決算パネルの表示を更新する
 * - 次回決算日・日数カウントダウン・信用ポジション警告
 * - 過去8四半期のEPSサプライズ棒グラフ
 * @param {string} k - 銘柄コード
 */
function updateEarningsPanel(k) {
  const isJa   = lang === 'ja';
  const panel  = document.getElementById('earnings-panel');
  if (!panel) return;

  if (isJpStock(k)) {
    panel.innerHTML = `<div class="earnings-unsupported">${isJa ? '⚠️ 日本株の決算データはFinnhub無料プランでは取得できません。' : '⚠️ Earnings data for Japanese stocks requires a paid Finnhub plan.'}</div>`;
    return;
  }

  const next = nextEarnings[k];
  const ed   = earningsData[k];

  // ── 次回決算セクション ──
  let nextHtml = '';
  if (next === undefined) {
    nextHtml = `<div class="earnings-next-loading">${isJa ? '決算予定日を取得中...' : 'Fetching next earnings date...'}</div>`;
  } else if (next === null) {
    nextHtml = `<div class="earnings-next-none">${isJa ? '今後90日以内の決算予定なし' : 'No earnings scheduled in the next 90 days'}</div>`;
  } else {
    const today      = new Date();
    today.setHours(0, 0, 0, 0);
    const earningsDate = new Date(next.date + 'T00:00:00');
    const daysLeft   = Math.round((earningsDate - today) / 86400000);
    const daysLabel  = isJa ? `${daysLeft}日後` : `in ${daysLeft} day${daysLeft !== 1 ? 's' : ''}`;
    const urgency    = daysLeft <= 3 ? 'earnings-urgent' : daysLeft <= 14 ? 'earnings-warn' : 'earnings-ok';
    const epsEst     = next.epsEstimate != null ? (isJa ? ` ／ EPS予想: $${next.epsEstimate.toFixed(2)}` : ` / EPS est: $${next.epsEstimate.toFixed(2)}`) : '';

    const hasMarginPos = Object.values(shortPositions).some(p => p.symbol === k)
                      || Object.values(leverageLongs).some(p => p.symbol === k);
    const marginWarn = (hasMarginPos && daysLeft <= 14)
      ? `<div class="earnings-margin-warn">⚠️ ${isJa ? '信用ポジション保有中 — 決算跨ぎのリスクに注意してください' : 'You hold a margin position — watch earnings volatility risk'}</div>`
      : '';

    nextHtml = `
      <div class="earnings-next-row ${urgency}">
        <span class="earnings-date-badge">📅 ${next.date}</span>
        <span class="earnings-days-left">${daysLabel}</span>
        <span class="earnings-est">${epsEst}</span>
      </div>
      ${marginWarn}`;
  }

  // ── 過去EPSサプライズセクション ──
  let histHtml = '';
  if (!ed || ed.loading) {
    histHtml = `<div class="earnings-hist-loading">${isJa ? 'EPS履歴を取得中...' : 'Loading EPS history...'}</div>`;
  } else if (ed.error || !ed.history || ed.history.length === 0) {
    histHtml = `<div class="earnings-hist-none">${isJa ? 'EPS履歴データなし' : 'No EPS history available'}</div>`;
  } else {
    const history = ed.history.slice(0, 8).reverse();
    const maxAbs  = Math.max(...history.map(e => Math.abs(e.surprise ?? 0)), 0.01);

    const bars = history.map(e => {
      const beat   = (e.surprise ?? 0) >= 0;
      const hPct   = Math.max(4, Math.abs(e.surprise ?? 0) / maxAbs * 52);
      const cls    = beat ? 'eps-bar-beat' : 'eps-bar-miss';
      const icon   = beat ? '▲' : '▼';
      const spPct  = e.surprisePct != null ? `${e.surprisePct >= 0 ? '+' : ''}${e.surprisePct.toFixed(1)}%` : '--';
      const period = e.period ? e.period.slice(0, 7) : '?';
      const actualLabel   = e.actual   != null ? `$${e.actual.toFixed(2)}`   : '--';
      const estimateLabel = e.estimate != null ? `$${e.estimate.toFixed(2)}` : '--';
      const tooltip = isJa
        ? `${e.period} 実績:${actualLabel} 予想:${estimateLabel} サプライズ:${spPct}`
        : `${e.period} Actual:${actualLabel} Est:${estimateLabel} Surprise:${spPct}`;
      return `
        <div class="eps-bar-col" title="${tooltip}">
          <div class="eps-bar-top">
            <span class="eps-surprise-pct ${beat ? 'beat' : 'miss'}">${icon}${spPct}</span>
          </div>
          <div class="eps-bar-wrap">
            <div class="eps-bar ${cls}" style="height:${hPct}px"></div>
          </div>
          <div class="eps-bar-period">${period}</div>
          <div class="eps-bar-actual">${actualLabel}</div>
        </div>`;
    }).join('');

    const beatCount = history.filter(e => (e.surprise ?? 0) >= 0).length;
    const beatRate  = Math.round(beatCount / history.length * 100);
    const beatLabel = isJa ? `過去${history.length}四半期 予想超過率: ${beatRate}%` : `Beat rate (last ${history.length}Q): ${beatRate}%`;
    const beatClass = beatRate >= 75 ? 'beat-rate-good' : beatRate >= 50 ? 'beat-rate-mid' : 'beat-rate-bad';

    histHtml = `
      <div class="eps-beat-rate ${beatClass}">${beatLabel}</div>
      <div class="eps-bars-wrap">${bars}</div>
      <div class="eps-legend">
        <span class="eps-legend-beat">▲ ${isJa ? '予想超過(Beat)' : 'Beat'}</span>
        <span class="eps-legend-miss">▼ ${isJa ? '予想未達(Miss)' : 'Miss'}</span>
        <span class="eps-legend-note">${isJa ? '棒の高さ = サプライズ幅' : 'Bar height = surprise magnitude'}</span>
      </div>`;
  }

  panel.innerHTML = `
    <div class="earnings-section-title">📅 ${isJa ? '次回決算予定' : 'Next Earnings'}</div>
    ${nextHtml}
    <div class="earnings-section-title" style="margin-top:12px">📊 ${isJa ? '過去EPS実績 vs 予想' : 'EPS History vs Estimate'}</div>
    ${histHtml}`;
}

/**
 * TipRanksへのディープリンクを更新する（アナリスト分析ページへ）
 * @param {string} symbol - 銘柄コード
 */
function updateTipRanksLink(symbol) {
  const linkEl = document.getElementById('tipranks-link');
  if (!linkEl) return;

  // 米国株のみ対応（日本株 .T はTipRanksに存在しないため）
  if (isJpStock(symbol)) {
    linkEl.style.display = 'none';
  } else {
    linkEl.style.display = 'inline-flex';
    linkEl.href = `https://www.tipranks.com/stocks/${symbol}/forecast`;
    linkEl.querySelector('span').textContent = lang === 'ja' ? 'TipRanksで分析を見る' : 'Analyst ratings on TipRanks';
  }
}

/**
 * 企業名からMacrotrendsのURLスラッグを生成する
 * 例: "NVIDIA Corp" → "nvidia-corp"
 * @param {string} name - 企業名
 * @returns {string}
 */
function toMacrotrendsSlug(name) {
  return (name || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
}

/**
 * MacrotrendsへのディープリンクをEPS履歴ページに更新する
 * 日本株は非対応のため非表示
 * @param {string} symbol - 銘柄コード
 */
function updateMacrotrendsLink(symbol) {
  const linkEl  = document.getElementById('macrotrends-link');
  const labelEl = document.getElementById('macrotrends-label');
  if (!linkEl) return;

  if (isJpStock(symbol)) {
    linkEl.style.display = 'none';
    return;
  }

  const name = STOCKS[symbol]?.name || symbol;
  const slug = toMacrotrendsSlug(name);
  // EPS履歴ページへ直リンク（長期ファンダメンタル分析の核心）
  linkEl.href = `https://www.macrotrends.net/stocks/charts/${symbol}/${slug}/eps-earnings-per-share-diluted`;
  linkEl.style.display = 'inline-flex';
  if (labelEl) {
    labelEl.textContent = lang === 'ja' ? 'Macrotrendsで長期財務を見る' : 'Long-term financials on Macrotrends';
  }
}