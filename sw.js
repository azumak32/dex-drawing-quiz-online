/* =========================================================
   sw.js — Service Worker
   一度オンラインで開けば、以後ネットが無くても Safari で起動できるようにする。
   （HTTPS または localhost でのみ動作。GitHub Pages は HTTPS なので有効）
   ========================================================= */

var CACHE = 'pq-shell-v12';
var API_CACHE = 'pq-api-v1';

var SHELL = [
  './',
  './index.html',
  './css/dex.css',
  './css/screens.css',
  './js/state.js',
  './js/dexdata.js',
  './js/dexsource.js',
  './js/dexviewer.js',
  './js/online.js',
  './js/judge.js',
  './js/canvas.js',
  './js/sfx.js',
  './js/app.js'
];

self.addEventListener('install', function (e) {
  e.waitUntil(
    caches.open(CACHE).then(function (c) {
      return c.addAll(SHELL);
    }).then(function () { return self.skipWaiting(); })
  );
});

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      return Promise.all(keys.map(function (k) {
        if (k !== CACHE && k !== API_CACHE) return caches.delete(k);
        return null;
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);

  /* 自分自身のファイル：ネット優先・つながらなければキャッシュ。
     キャッシュ優先にすると、更新してもホーム画面に追加した端末に
     古い版が残り続けてしまう（更新が1回遅れて届く）。
     会場でネットが無い場合に備え、2.5秒で見切ってキャッシュに切り替える。 */
  if (url.origin === location.origin) {
    e.respondWith(
      networkFirst(req).catch(function () {
        return caches.match(req).then(function (hit) {
          return hit || caches.match('./index.html');
        });
      })
    );
    return;
  }

  /* 図鑑データ（jsDelivr）：コミットを固定した URL なので中身が変わらない。
     キャッシュ優先にしておけば、2回目以降は通信ゼロで起動できる。 */
  if (/cdn\.jsdelivr\.net/.test(url.hostname)) {
    e.respondWith(
      caches.match(req).then(function (hit) {
        if (hit) return hit;
        return fetch(req).then(function (res) {
          if (res && res.status === 200) {
            var copy = res.clone();
            caches.open(API_CACHE).then(function (c) { c.put(req, copy); });
          }
          return res;
        });
      })
    );
    return;
  }

  /* PokeAPI と公式イラスト：ネット優先、失敗したらキャッシュ（保険の二重化） */
  if (/pokeapi\.co|raw\.githubusercontent\.com/.test(url.hostname)) {
    e.respondWith(
      fetch(req).then(function (res) {
        if (res && res.status === 200) {
          var copy = res.clone();
          caches.open(API_CACHE).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () {
        return caches.match(req);
      })
    );
  }
});

/* ネットを先に試し、2.5秒で応答が無ければあきらめる。
   取れた分は必ずキャッシュに書き戻すので、次はオフラインでも開ける。 */
function networkFirst(req) {
  return new Promise(function (resolve, reject) {
    var settled = false;
    var timer = setTimeout(function () {
      if (!settled) { settled = true; reject(new Error('timeout')); }
    }, 2500);

    fetch(req).then(function (res) {
      if (res && res.status === 200) {
        var copy = res.clone();
        caches.open(CACHE).then(function (c) { c.put(req, copy); });
      }
      if (settled) return;           // 時間切れ後に届いた分もキャッシュだけ更新する
      settled = true; clearTimeout(timer);
      resolve(res);
    }).catch(function (err) {
      if (settled) return;
      settled = true; clearTimeout(timer);
      reject(err);
    });
  });
}
