// ============================================================
// pwa-install.js — PWA インストール促進バナー
// Android: beforeinstallprompt イベントを使った標準バナー
// iOS:     Safari 判定 + 「共有→ホーム画面に追加」の手順ガイド
// ============================================================

(function () {
  'use strict';

  const DISMISSED_KEY = 'pwa_banner_dismissed_at';
  const DISMISS_DAYS  = 7; // 何日間は再表示しないか

  // ── 表示判定 ────────────────────────────────────────────
  function wasDismissedRecently() {
    const ts = localStorage.getItem(DISMISSED_KEY);
    if (!ts) return false;
    return (Date.now() - parseInt(ts, 10)) < DISMISS_DAYS * 86400 * 1000;
  }

  function isStandalone() {
    return (
      window.matchMedia('(display-mode: standalone)').matches ||
      window.navigator.standalone === true
    );
  }

  function isIos() {
    return /iphone|ipad|ipod/i.test(navigator.userAgent) &&
           !window.MSStream;
  }

  function isIosSafari() {
    return isIos() && /safari/i.test(navigator.userAgent) &&
           !/crios|fxios|opios/i.test(navigator.userAgent);
  }

  // ── バナーHTML を body に挿入 ────────────────────────────
  function injectBannerHTML() {
    // Android / Chrome 用
    const androidBanner = document.createElement('div');
    androidBanner.id = 'pwa-install-banner';
    androidBanner.className = 'hidden';
    androidBanner.innerHTML = `
      <img id="pwa-banner-icon" src="icons/icon-192.png" alt="アイコン">
      <div id="pwa-banner-text">
        <strong>株シミュをホーム画面に追加</strong>
        <span>アプリのようにすぐ起動できます</span>
      </div>
      <button id="pwa-banner-install">追加</button>
      <button id="pwa-banner-close">×</button>
    `;
    document.body.appendChild(androidBanner);

    // iOS Safari 用
    const iosGuide = document.createElement('div');
    iosGuide.id = 'pwa-ios-guide';
    iosGuide.className = 'hidden';
    iosGuide.innerHTML = `
      <div id="pwa-ios-guide-title">
        📲 ホーム画面に追加する方法
        <button id="pwa-ios-guide-close">×</button>
      </div>
      <ol>
        <li>Safari 下部の <strong>「共有」ボタン（↑）</strong>をタップ</li>
        <li><strong>「ホーム画面に追加」</strong>をタップ</li>
        <li>右上の <strong>「追加」</strong>をタップして完了</li>
      </ol>
    `;
    document.body.appendChild(iosGuide);
  }

  // ── Android: beforeinstallprompt ────────────────────────
  let deferredPrompt = null;

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredPrompt = e;

    if (isStandalone() || wasDismissedRecently()) return;

    const banner = document.getElementById('pwa-install-banner');
    if (!banner) return;
    banner.classList.remove('hidden');

    document.getElementById('pwa-banner-install').onclick = async () => {
      banner.classList.add('hidden');
      deferredPrompt.prompt();
      const { outcome } = await deferredPrompt.userChoice;
      if (outcome === 'accepted') {
        console.log('[PWA] インストール承認');
      }
      deferredPrompt = null;
    };

    document.getElementById('pwa-banner-close').onclick = () => {
      banner.classList.add('hidden');
      localStorage.setItem(DISMISSED_KEY, Date.now().toString());
    };
  });

  // ── iOS Safari: 手動ガイド表示 ──────────────────────────
  window.addEventListener('DOMContentLoaded', () => {
    injectBannerHTML();

    if (!isIosSafari() || isStandalone() || wasDismissedRecently()) return;

    // 3秒後に表示（ページ読み込み直後は避ける）
    setTimeout(() => {
      const guide = document.getElementById('pwa-ios-guide');
      if (!guide) return;
      guide.style.display = 'block';

      document.getElementById('pwa-ios-guide-close').onclick = () => {
        guide.classList.add('hidden');
        localStorage.setItem(DISMISSED_KEY, Date.now().toString());
      };
    }, 3000);
  });

  // ── インストール完了 ────────────────────────────────────
  window.addEventListener('appinstalled', () => {
    console.log('[PWA] インストール完了');
    const banner = document.getElementById('pwa-install-banner');
    if (banner) banner.classList.add('hidden');
  });

})();
