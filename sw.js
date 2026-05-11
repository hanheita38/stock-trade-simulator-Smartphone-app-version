// ============================================================
// sw.js — Service Worker (PWA対応)
// キャッシュ戦略: Cache First（静的アセット）
//                Network First（API通信はキャッシュしない）
// ============================================================

const CACHE_NAME = 'kabu-sim-v1';

// キャッシュ対象の静的ファイル
const STATIC_ASSETS = [
  './',
  './index.html',
  './style.css',
  './state-manager.js',
  './api-client.js',
  './trading-engine.js',
  './ui-renderer.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png',
];

// ============================================================
// install: 静的アセットをプリキャッシュ
// ============================================================
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => {
      // アイコンなど存在しないファイルはスキップして続行
      return Promise.allSettled(
        STATIC_ASSETS.map((url) =>
          cache.add(url).catch(() => {
            console.warn('[SW] キャッシュできませんでした:', url);
          })
        )
      );
    }).then(() => self.skipWaiting())
  );
});

// ============================================================
// activate: 古いキャッシュを削除
// ============================================================
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

// ============================================================
// fetch: リクエスト横取り戦略
// ============================================================
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);

  // 外部API（Finnhub / Frankfurter / Google Translate）はネットワーク優先
  const isExternalApi =
    url.hostname.includes('finnhub.io') ||
    url.hostname.includes('frankfurter.app') ||
    url.hostname.includes('translate.googleapis.com');

  if (isExternalApi) {
    // Network Only — API通信はキャッシュしない
    event.respondWith(fetch(event.request));
    return;
  }

  // 静的アセット: Cache First → なければネットワーク取得してキャッシュ
  event.respondWith(
    caches.match(event.request).then((cached) => {
      if (cached) return cached;

      return fetch(event.request).then((response) => {
        // 有効なレスポンスだけキャッシュ
        if (
          !response ||
          response.status !== 200 ||
          response.type === 'opaque'
        ) {
          return response;
        }
        const cloned = response.clone();
        caches.open(CACHE_NAME).then((cache) =>
          cache.put(event.request, cloned)
        );
        return response;
      }).catch(() => {
        // オフライン時にHTMLを返すフォールバック
        if (event.request.mode === 'navigate') {
          return caches.match('./index.html');
        }
      });
    })
  );
});
