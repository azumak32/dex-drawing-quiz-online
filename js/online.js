/* =========================================================
   online.js — オンラインプレイ（別々の端末どうし・PeerJS / WebRTC P2P）

   ・公開版だけに入れる。コンプリート版（通信ゼロが存在意義）には入れない。
     app.js 側は Online が無ければ何もしない書き方にしてある。
   ・親（部屋を作った端末）が進行を全部にぎる。State の正は親だけが持つ。
     子は「画面の合図と絵を受け取り、自分の絵か解答を返す」だけ。
   ・送るのは 名前・図鑑No.と出典（ref）・絵・解答・得点・画面の合図 だけ。
     **図鑑の文章は送らない。** 子は ref から手元の図鑑データで同じ文面を組み立てる。
     送受信はすべて SCHEMA に書いた項目だけに絞ってから行う（それ以外は送れない作り）。
   ・接続の試行・成功・失敗はこの端末の localStorage（pq:netlog）にだけ残す。
     外部には送らない。PeerJS を続けるか Firebase に移るかは、この数字で決める。
   ========================================================= */

var Online = (function () {
  var PEERJS_URL = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.5/dist/peerjs.min.js';
  var ID_PREFIX = 'dexdrawquiz-';   // 公開ブローカーは全世界で共用なので、ほかのアプリと混ざらない名前にする
  var PROTO = 1;                    // 親と子でちがうと参加させない（片方だけ古い版のとき）
  var JOIN_TIMEOUT = 15000;         // ここまでに繋がらなければ失敗とみなす
  var PING_MS = 2000;               // 生存確認の間隔
  var DEAD_MS = 6500;               // 生存確認 3 回ぶん便りがなければ切れたとみなす
  var RETRY_MAX = 5;                // 子が自動でつなぎ直す回数
  var RETRY_MS = 3000;
  var CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';   // まぎらわしい I O 0 1 を除く
  var CODE_LEN = 6;

  var role = null;      // null | 'host' | 'guest'
  var busy = false;     // 部屋づくり・参加の途中
  var peer = null;
  var pingTimer = null;

  /* 親 */
  var room = null;
  var conns = {};       // pid -> { conn, seen, phase, imgKey }

  /* 子 */
  var hostConn = null;
  var hostSeen = 0;
  var guestRoom = '';
  var guestName = '';
  var lastPhase = null;
  var guestKey = '';
  var guestImg = null;
  var guestTimer = null;
  var sentDrawRound = -1;
  var sentAnswerRound = -1;
  var retryCount = 0;
  var retryTimer = null;
  var closedByHost = false;

  /* =========================================================
     送る内容の型（ここに無い項目は送れない・受け取らない）
     文字列は上限で切る。絵は data:image/… の形だけ通す。
     ========================================================= */
  function str(max) {
    return function (v) { return typeof v === 'string' ? v.slice(0, max) : undefined; };
  }
  function int(v) { return (typeof v === 'number' && isFinite(v)) ? Math.round(v) : undefined; }
  function bool(v) { return typeof v === 'boolean' ? v : undefined; }
  function oneOf(list) { return function (v) { return list.indexOf(v) >= 0 ? v : undefined; }; }
  function pidv(v) { return (typeof v === 'string' && /^[A-Za-z0-9_-]{1,24}$/.test(v)) ? v : undefined; }
  function image(v) {
    if (v === null) return null;
    if (typeof v !== 'string' || v.length > 3000000) return undefined;
    return /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+$/.test(v) ? v : undefined;
  }

  var NAME = str(12);
  var TEXT = str(40);
  var REF = { id: int, v: str(32), h: int };   // 図鑑No.・出典 slug・文面のハッシュ（文面そのものではない）

  var SCHEMA = {
    hello:   { pid: pidv, name: NAME, proto: int },
    welcome: { pid: pidv, room: str(CODE_LEN) },
    reject:  { reason: oneOf(['full', 'proto']) },
    bye:     { reason: oneOf(['closed', 'kicked', 'left']) },
    ping:    { t: int },
    pong:    { t: int },
    answer:  { round: int, text: TEXT },
    drawing: { round: int, img: image },
    phase: {
      s: oneOf(['lobby', 'loading', 'draw', 'quiz', 'reveal', 'result']),
      room: str(CODE_LEN),
      mode: oneOf(['vs', 'coop']),
      game: int,                                  // ゲームの識別（出題の並びのハッシュ）
      round: int,
      total: int,
      sec: int,                                   // 時間制限（0 ならなし）
      members: [{ name: NAME, on: bool }],
      drawer: NAME,
      mine: bool,                                 // この子が出題者か
      ref: REF,                                   // 出題者と正解発表にだけ付ける
      img: image,
      answering: bool,                            // この子がまだ答えていないか
      wait: [NAME],
      answers: [{ who: NAME, text: TEXT, ok: bool }],
      coop: { correct: int, total: int, last: bool },
      ranking: [{ name: NAME, answer: int, draw: int, total: int, title: str(20), online: bool }]
    }
  };

  function clean(spec, v) {
    if (typeof spec === 'function') return spec(v);
    if (Array.isArray(spec)) {
      if (!Array.isArray(v)) return undefined;
      return v.slice(0, 20).map(function (x) { return clean(spec[0], x); })
        .filter(function (x) { return x !== undefined; });
    }
    if (v === null) return null;
    if (!v || typeof v !== 'object') return undefined;
    var out = {};
    Object.keys(spec).forEach(function (k) {
      if (!(k in v)) return;
      var c = clean(spec[k], v[k]);
      if (c !== undefined) out[k] = c;
    });
    return out;
  }

  function pack(type, body) {
    if (!SCHEMA[type]) return null;
    var out = clean(SCHEMA[type], body || {}) || {};
    out.type = type;
    return out;
  }

  function unpack(data) {
    if (!data || typeof data !== 'object' || !SCHEMA.hasOwnProperty(data.type)) return null;
    var out = clean(SCHEMA[data.type], data) || {};
    out.type = data.type;
    return out;
  }

  var tap = null;   // テスト用：送った中身を控える（絵は長さだけ）

  function send(conn, type, body) {
    if (!conn || !conn.open) return false;
    var m = pack(type, body);
    if (!m) return false;
    if (tap) tap.push(JSON.stringify(m, function (k, v) {
      return (k === 'img' && typeof v === 'string') ? '[img ' + v.length + ']' : v;
    }));
    try { conn.send(m); return true; } catch (e) { return false; }
  }

  /* 文面の同定に使う 32bit ハッシュ（FNV-1a）。文面は送らず、これだけ送る。 */
  function hashText(s) {
    var h = 0x811c9dc5;
    s = String(s || '');
    for (var i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    return h >>> 0;
  }

  function refOf(q) {
    return q ? { id: q.id, v: q.version, h: hashText(q.flavorRaw) } : null;
  }

  /* ref から、親が選んだのと同じ出題を手元の図鑑データで組み立てる */
  function questionFromRef(ref) {
    if (!ref || !ref.id) return null;
    var sp = speciesOf(ref.id);
    if (!sp || !sp.flavors.length) return null;
    var same = sp.flavors.filter(function (f) { return f.version === ref.v; });
    var hit = null;
    same.concat(sp.flavors).some(function (f) {
      if (hashText(normalizeFlavor(f.text)) === ref.h) { hit = f; return true; }
      return false;
    });
    if (!hit) hit = same[0] || sp.flavors[0];
    var raw = normalizeFlavor(hit.text);
    var masked = raw;
    [sp.nameJa, sp.evolvesFromJa].filter(Boolean).forEach(function (n) { masked = maskName(masked, n); });
    var v = hit.version;
    return {
      id: sp.id,
      nameJa: sp.nameJa,
      genusJa: sp.genusJa,
      flavorMasked: masked,
      flavorRaw: raw,
      version: v,
      versionJa: VERSION_JA[v] || v
    };
  }

  /* =========================================================
     接続の記録（この端末の localStorage だけ・外部には送らない）
     名前は残さない（記録をコピーして渡しても、誰が遊んだかは出ない）。
     ========================================================= */
  var LOG_KEY = 'pq:netlog';
  var LOG_MAX = 400;

  function loadLog() {
    try {
      var o = JSON.parse(localStorage.getItem(LOG_KEY) || 'null');
      if (o && o.version === 1 && Array.isArray(o.events)) return o;
    } catch (e) {}
    return { version: 1, events: [] };
  }

  function logEvent(kind, extra) {
    var o = loadLog();
    var e = { t: Date.now(), kind: kind, dev: deviceLabel() };
    if (extra) Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
    o.events.push(e);
    if (o.events.length > LOG_MAX) o.events = o.events.slice(o.events.length - LOG_MAX);
    try { localStorage.setItem(LOG_KEY, JSON.stringify(o)); } catch (err) {}
    renderLog();
    return e.t;
  }

  /* あとから分かったこと（経路）を、記録ずみの1件に書き足す */
  function patchEvent(t, kind, extra) {
    var o = loadLog();
    for (var i = o.events.length - 1; i >= 0; i--) {
      var e = o.events[i];
      if (e.t === t && e.kind === kind) {
        Object.keys(extra).forEach(function (k) { e[k] = extra[k]; });
        try { localStorage.setItem(LOG_KEY, JSON.stringify(o)); } catch (err) {}
        renderLog();
        return;
      }
    }
  }

  /* 成功はその場で記録し、経路（直接か中継か）は分かりしだい書き足す */
  function logWithRoute(kind, conn, extra) {
    var t = logEvent(kind, extra);
    detectRoute(conn, function (route) { patchEvent(t, kind, { route: route }); });
  }

  function deviceLabel() {
    var ua = navigator.userAgent || '';
    var os = /iPad/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1) ? 'iPad'
      : /iPhone/.test(ua) ? 'iPhone'
      : /Android/.test(ua) ? 'Android'
      : /Mac OS X/.test(ua) ? 'Mac'
      : /Windows/.test(ua) ? 'Windows' : 'other';
    var br = / Line\//.test(ua) ? 'LINE'
      : /EdgA?\/|EdgiOS/.test(ua) ? 'Edge'
      : /CriOS|Chrome\//.test(ua) ? 'Chrome'
      : /FxiOS|Firefox\//.test(ua) ? 'Firefox'
      : /Safari\//.test(ua) ? 'Safari' : 'other';
    return os + '/' + br;
  }

  var STAGE_JA = {
    load: 'PeerJS を読み込めない',
    broker: '仲介サーバーにつながらない',
    'no-room': '部屋が見つからない',
    p2p: '端末どうしがつながらない',
    proto: 'アプリの版がちがう',
    full: '満員',
    unknown: 'その他'
  };

  function summarize() {
    var ev = loadLog().events;
    var s = {
      join: { tr: 0, ok: 0, fail: {}, ms: [], direct: 0, relay: 0 },
      rejoin: { tr: 0, ok: 0, fail: 0 },
      drop: 0,
      host: { tr: 0, ok: 0, fail: {}, guests: 0, guestDrops: 0 }
    };
    ev.forEach(function (e) {
      switch (e.kind) {
        case 'join-try': s.join.tr++; break;
        case 'join-ok':
          s.join.ok++;
          if (e.ms) s.join.ms.push(e.ms);
          if (e.route === 'relay') s.join.relay++;
          else if (e.route === 'direct') s.join.direct++;
          break;
        case 'join-fail': s.join.fail[e.stage] = (s.join.fail[e.stage] || 0) + 1; break;
        case 'rejoin-try': s.rejoin.tr++; break;
        case 'rejoin-ok': s.rejoin.ok++; break;
        case 'rejoin-fail': s.rejoin.fail++; break;
        case 'drop': s.drop++; break;
        case 'host-try': s.host.tr++; break;
        case 'host-ok': s.host.ok++; break;
        case 'host-fail': s.host.fail[e.stage] = (s.host.fail[e.stage] || 0) + 1; break;
        case 'guest-in': s.host.guests++; break;
        case 'guest-drop': s.host.guestDrops++; break;
      }
    });
    return s;
  }

  function failText(f) {
    var keys = Object.keys(f);
    if (!keys.length) return '';
    return '（' + keys.map(function (k) { return (STAGE_JA[k] || k) + ' ' + f[k]; }).join('・') + '）';
  }

  function summaryText() {
    var s = summarize();
    var failN = 0;
    Object.keys(s.join.fail).forEach(function (k) { failN += s.join.fail[k]; });
    var avg = s.join.ms.length
      ? (s.join.ms.reduce(function (a, b) { return a + b; }, 0) / s.join.ms.length / 1000).toFixed(1) : '—';
    var hostFailN = 0;
    Object.keys(s.host.fail).forEach(function (k) { hostFailN += s.host.fail[k]; });
    var rate = s.join.tr ? Math.round(failN / s.join.tr * 100) + '%' : '—';
    return [
      '【参加（子として）】試行 ' + s.join.tr + ' / 成功 ' + s.join.ok + ' / 失敗 ' + failN + failText(s.join.fail),
      '　失敗率 ' + rate + '　つながるまで平均 ' + avg + ' 秒　経路：直接 ' + s.join.direct + '・中継 ' + s.join.relay,
      '【つなぎ直し】試行 ' + s.rejoin.tr + ' / 成功 ' + s.rejoin.ok + ' / 失敗 ' + s.rejoin.fail +
        '　途中で切れた ' + s.drop + ' 回',
      '【部屋を作る（親として）】試行 ' + s.host.tr + ' / 成功 ' + s.host.ok + ' / 失敗 ' + hostFailN +
        failText(s.host.fail),
      '　子が入った ' + s.host.guests + ' 回 / 子が切れた ' + s.host.guestDrops + ' 回'
    ].join('\n');
  }

  function pad2(n) { return ('0' + n).slice(-2); }
  function fmtTime(t) {
    var d = new Date(t);
    return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
      pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }

  function logText() {
    var lines = loadLog().events.map(function (e) {
      return [fmtTime(e.t), e.kind, e.stage || '', e.why || '',
              e.ms ? (e.ms / 1000).toFixed(1) + 's' : '', e.route || '', e.dev].join(' ').replace(/ +/g, ' ');
    });
    return 'ポケモン図鑑クイズ 接続の記録（' + deviceLabel() + '）\n' + summaryText() + '\n---\n' + lines.join('\n');
  }

  function renderLog() {
    var el = $id('netlogSummary');
    if (el) el.textContent = summaryText();
  }

  function copyText(text, okMsg) {
    function fallback() {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); toast(okMsg); } catch (e) { toast('コピーできませんでした'); }
      document.body.removeChild(ta);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast(okMsg); }, fallback);
    } else {
      fallback();
    }
  }

  /* 実際に使われた経路（直接か中継か）を WebRTC の統計から読む。
     つながった直後は統計がまだ出ていないことがあるので、何度か読み直す。 */
  function detectRoute(conn, cb, tries) {
    tries = tries || 0;
    setTimeout(function () {
      readRoute(conn).then(function (route) {
        if (route === '?' && tries < 4) detectRoute(conn, cb, tries + 1);
        else cb(route);
      });
    }, tries ? 1500 : 1000);
  }

  function readRoute(conn) {
    var pc = conn && conn.peerConnection;
    if (!pc || !pc.getStats) return Promise.resolve('?');
    return pc.getStats().then(function (stats) {
      var pairs = {}, locals = {}, selected = null;
      stats.forEach(function (r) {
        if (r.type === 'transport' && r.selectedCandidatePairId) selected = r.selectedCandidatePairId;
        if (r.type === 'candidate-pair') pairs[r.id] = r;
        if (r.type === 'local-candidate') locals[r.id] = r;
      });
      var pair = selected ? pairs[selected] : null;
      if (!pair) {
        Object.keys(pairs).forEach(function (k) {
          var p = pairs[k];
          if (p.selected || (p.nominated && p.state === 'succeeded')) pair = p;
        });
      }
      var lc = pair && locals[pair.localCandidateId];
      return lc ? (lc.candidateType === 'relay' ? 'relay' : 'direct') : '?';
    }).catch(function () { return '?'; });
  }

  /* =========================================================
     PeerJS の読み込み（「部屋を作る／参加する」を押したときに初めて読む）
     ========================================================= */
  var peerLoad = null;

  function loadPeerJs() {
    var P = window.Peer || (window.peerjs && window.peerjs.Peer);
    if (P) return Promise.resolve(P);
    if (peerLoad) return peerLoad;
    peerLoad = new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = PEERJS_URL;
      s.async = true;
      s.crossOrigin = 'anonymous';   // Service Worker がキャッシュできるよう CORS で読む
      var timer = setTimeout(function () { reject({ type: 'load' }); }, 12000);
      s.onload = function () {
        clearTimeout(timer);
        var Peer = window.Peer || (window.peerjs && window.peerjs.Peer);
        if (Peer) resolve(Peer); else reject({ type: 'load' });
      };
      s.onerror = function () { clearTimeout(timer); reject({ type: 'load' }); };
      document.head.appendChild(s);
    });
    peerLoad.catch(function () { peerLoad = null; });
    return peerLoad;
  }

  /* 仲介サーバーに登録する。id を省くとサーバーが決める（子） */
  function openPeer(Peer, id) {
    return new Promise(function (resolve, reject) {
      var p;
      try { p = id ? new Peer(id, { debug: 0 }) : new Peer({ debug: 0 }); }
      catch (e) { reject({ type: 'browser-incompatible' }); return; }
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        try { p.destroy(); } catch (e) {}
        reject({ type: 'broker-timeout' });
      }, JOIN_TIMEOUT);
      p.on('open', function () {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(p);
      });
      p.on('error', function (err) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        try { p.destroy(); } catch (e) {}
        reject(err || { type: 'unknown' });
      });
    });
  }

  /* PeerJS のエラーを、記録用の段階名にまとめる */
  function stageOf(err, fallback) {
    var t = (err && err.type) || '';
    if (t === 'load') return 'load';
    if (t === 'peer-unavailable') return 'no-room';
    if (t === 'reject-proto') return 'proto';
    if (t === 'reject-full') return 'full';
    if (/^p2p|no-welcome/.test(t)) return 'p2p';
    if (/broker|network|server-error|socket|unavailable-id|disconnected/.test(t)) return 'broker';
    return fallback || 'unknown';
  }

  function randomCode() {
    var s = '';
    for (var i = 0; i < CODE_LEN; i++) s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return s;
  }

  function normCode(s) {
    return String(s || '')
      .replace(/[Ａ-Ｚａ-ｚ０-９]/g, function (c) { return String.fromCharCode(c.charCodeAt(0) - 0xFEE0); })   // 全角 → 半角
      .toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, CODE_LEN);
  }

  function myPid() {
    var id = null;
    try { id = localStorage.getItem('pq:onlineId'); } catch (e) {}
    if (!pidv(id)) {
      id = 'g' + Math.random().toString(36).slice(2, 10);
      try { localStorage.setItem('pq:onlineId', id); } catch (e) {}
    }
    return id;
  }

  function ssGet(k) { try { return JSON.parse(sessionStorage.getItem(k) || 'null'); } catch (e) { return null; } }
  function ssSet(k, v) { try { sessionStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
  function ssDel(k) { try { sessionStorage.removeItem(k); } catch (e) {} }

  /* =========================================================
     親：部屋を作る
     ========================================================= */
  function host(preferredCode) {
    if (role || busy) return;
    busy = true;
    var t0 = Date.now();
    setStatus('部屋を作っています…');
    logEvent('host-try');
    renderPanel();

    var stage = 'load';
    loadPeerJs().then(function (Peer) {
      stage = 'broker';
      return tryOpenRoom(Peer, preferredCode, 0);
    }).then(function (res) {
      busy = false;
      peer = res.peer;
      room = res.code;
      role = 'host';
      ssSet('pq:hostRoom', room);
      peer.on('connection', onGuestConnection);
      peer.on('disconnected', function () {
        // 仲介サーバーとの接続だけが切れた（つながっている子はそのまま）。新しい子が入れるよう登録し直す
        setTimeout(function () {
          try { if (role === 'host' && peer && !peer.destroyed && peer.disconnected) peer.reconnect(); } catch (e) {}
        }, 2000);
      });
      peer.on('error', function (err) { console.warn('[online] peer error', err && err.type); });
      startPing();
      logEvent('host-ok', { ms: Date.now() - t0 });
      setStatus('部屋ができました。子の端末で部屋コードを入れてもらってください。');
      renderPanel();
      hostBroadcast();
    }).catch(function (err) {
      busy = false;
      var st = stageOf(err, stage);
      logEvent('host-fail', { stage: st, ms: Date.now() - t0 });
      setStatus('部屋を作れませんでした（' + (STAGE_JA[st] || st) + '）。少し待ってもう一度ためしてください。', true);
      ssDel('pq:hostRoom');
      renderPanel();
    });
  }

  /* 同じコードがほかで使われていたら作り直す。
     ページを再読み込みした直後は、古い登録が仲介サーバーに少し残るので同じコードを何度か待つ。 */
  function tryOpenRoom(Peer, preferred, attempt) {
    var code = preferred || randomCode();
    return openPeer(Peer, ID_PREFIX + code).then(function (p) {
      return { peer: p, code: code };
    }, function (err) {
      if (err && err.type === 'unavailable-id' && attempt < 6) {
        if (preferred && attempt < 5) {
          return new Promise(function (r) { setTimeout(r, 3000); })
            .then(function () { return tryOpenRoom(Peer, preferred, attempt + 1); });
        }
        return tryOpenRoom(Peer, null, attempt + 1);
      }
      throw err;
    });
  }

  function onGuestConnection(conn) {
    var pid = null;
    conn.on('data', function (raw) {
      var m = unpack(raw);
      if (!m) return;
      if (!pid) {
        if (m.type !== 'hello' || !m.pid) return;
        if (m.proto !== PROTO) {
          send(conn, 'reject', { reason: 'proto' });
          setTimeout(function () { try { conn.close(); } catch (e) {} }, 600);
          return;
        }
        var old = conns[m.pid];
        var res = onlineGuestHello(m.pid, m.name || '');
        if (res !== 'ok') {
          send(conn, 'reject', { reason: 'full' });
          setTimeout(function () { try { conn.close(); } catch (e) {} }, 600);
          return;
        }
        pid = m.pid;
        if (old && old.conn !== conn) { try { old.conn.close(); } catch (e) {} }
        conns[pid] = { conn: conn, seen: Date.now(), phase: '', imgKey: '' };
        send(conn, 'welcome', { pid: pid, room: room });
        logWithRoute('guest-in', conn);
        onlinePlayerBack(pid);
        hostBroadcast();
        return;
      }
      var c = conns[pid];
      if (!c || c.conn !== conn) return;
      c.seen = Date.now();
      switch (m.type) {
        case 'answer': receiveOnlineAnswer(pid, m.round, m.text || ''); break;
        case 'drawing': receiveDrawing(pid, m.round, m.img === undefined ? null : m.img); break;
        case 'bye': dropGuest(pid, 'left'); break;
      }
    });
    function closed() {
      if (pid && conns[pid] && conns[pid].conn === conn) dropGuest(pid, 'close');
    }
    conn.on('close', closed);
    conn.on('error', closed);
  }

  function dropGuest(pid, why) {
    var c = conns[pid];
    if (!c) return;
    delete conns[pid];
    try { c.conn.close(); } catch (e) {}
    if (why !== 'left' && why !== 'kicked') logEvent('guest-drop', { why: why });
    if (why !== 'kicked') onlinePlayerDropped(pid, why === 'left');
    hostBroadcast();
  }

  function startPing() {
    clearInterval(pingTimer);
    pingTimer = setInterval(function () {
      var now = Date.now();
      if (role === 'host') {
        Object.keys(conns).forEach(function (pid) {
          var c = conns[pid];
          if (now - c.seen > DEAD_MS) { dropGuest(pid, 'timeout'); return; }
          send(c.conn, 'ping', { t: now });
        });
      } else if (role === 'guest' && hostConn) {
        if (now - hostSeen > DEAD_MS) guestLost('timeout');
      }
    }, PING_MS);
  }

  /* 画面に合わせた合図を、子ごとに組み立てる（State から作るので、親の進行と必ず一致する） */
  function labelOf(id) {
    if (id === '__quick__') return '親';
    return id ? playerName(id) : 'みんな';
  }

  function imgKey() {
    var d = State.drawing || '';
    return State.round + ':' + d.length + ':' + hashText(d.slice(-256));
  }

  function hostPhase(pid) {
    var ph = {
      room: room,
      mode: State.settings.mode === 'vs' ? 'vs' : 'coop',
      game: hashText(State.quiz.map(function (x) { return x && x.id; }).join(',')),
      round: State.round,
      total: State.order.length
    };
    var q = State.quiz[State.round];
    var drawer = State.order[State.round];
    switch (State.screen) {
      case 's15':
        ph.s = 'loading';
        return ph;
      case 's2':
        if (!q) break;
        ph.s = 'draw';
        ph.drawer = labelOf(drawer);
        ph.mine = drawer === pid;
        ph.sec = State.settings.timer ? timerSec('draw') : 0;
        if (ph.mine) ph.ref = refOf(q);
        return ph;
      case 's3':
        if (!q) break;
        var wait = State.onlineWait || {};
        ph.s = 'quiz';
        ph.drawer = labelOf(drawer);
        ph.mine = drawer === pid;
        ph.answering = !!wait[pid];
        ph.wait = Object.keys(wait).map(playerName);
        ph.sec = State.settings.timer ? timerSec('answer') : 0;
        ph.img = State.drawing || null;
        return ph;
      case 's4':
        if (!q) break;
        var isCoop = State.settings.mode !== 'vs' || drawer === '__quick__';
        ph.s = 'reveal';
        ph.drawer = labelOf(drawer);
        ph.ref = refOf(q);
        ph.img = State.drawing || null;
        ph.answers = State.answers.map(function (a) {
          return { who: labelOf(a.playerId), text: a.text || '', ok: !!a.correct };
        });
        ph.coop = isCoop ? {
          correct: State.coop.correct,
          total: State.order.length,
          last: State.round >= State.order.length - 1
        } : null;
        return ph;
      case 's5':
        ph.s = 'result';
        ph.ranking = buildRanking().map(function (e) {
          return { name: e.name, answer: e.answer, draw: e.draw, total: e.total, title: e.title, online: e.online };
        });
        return ph;
    }
    // 設定画面・図鑑ビューア・累積ランキングは、子にとっては「待合室」
    ph.s = 'lobby';
    ph.members = State.players.filter(function (p) { return (p.name || '').trim(); })
      .map(function (p) { return { name: p.name, on: !p.online || !!conns[p.id] }; });
    return ph;
  }

  function sendPhase(pid) {
    var c = conns[pid];
    if (!c) return;
    var ph = hostPhase(pid);
    var img = ph.img;
    delete ph.img;
    var key = JSON.stringify(ph);
    var needImg = img !== undefined && c.imgKey !== imgKey();
    if (key === c.phase && !needImg) return;   // 同じ合図は送り直さない（絵は1ラウンド1回だけ）
    c.phase = key;
    if (needImg) { ph.img = img; c.imgKey = imgKey(); }
    send(c.conn, 'phase', ph);
  }

  function hostBroadcast() {
    if (role !== 'host') return;
    Object.keys(conns).forEach(sendPhase);
    renderPanel();
  }

  function kick(pid) {
    if (role !== 'host' || !conns[pid]) return;
    send(conns[pid].conn, 'bye', { reason: 'kicked' });
    setTimeout(function () { dropGuest(pid, 'kicked'); }, 300);
  }

  function closeRoom() {
    if (role !== 'host') return;
    Object.keys(conns).forEach(function (pid) { send(conns[pid].conn, 'bye', { reason: 'closed' }); });
    var p = peer;
    setTimeout(function () { try { p.destroy(); } catch (e) {} }, 400);
    peer = null;
    conns = {};
    room = null;
    role = null;
    clearInterval(pingTimer);
    ssDel('pq:hostRoom');
    onlineRoomClosed();
    setStatus('部屋を閉じました。');
    renderPanel();
  }

  /* =========================================================
     子：部屋に参加する
     ========================================================= */
  function join(code, name) {
    if (role || busy) return;
    code = normCode(code);
    name = String(name || '').trim().slice(0, 12);
    if (code.length !== CODE_LEN) { setStatus('部屋コードは ' + CODE_LEN + ' 文字です。', true); return; }
    if (!name) { setStatus('あなたの名前を入れてください。', true); return; }
    guestRoom = code;
    guestName = name;
    try { localStorage.setItem('pq:onlineName', name); } catch (e) {}
    closedByHost = false;
    retryCount = 0;
    attemptJoin(false);
  }

  function attemptJoin(isRetry) {
    busy = true;
    var t0 = Date.now();
    var stage = 'load';
    logEvent(isRetry ? 'rejoin-try' : 'join-try');
    if (isRetry) {
      guestWait('つなぎ直しています…', '（' + retryCount + ' / ' + RETRY_MAX + ' 回目）', { retrying: true });
    } else {
      setStatus('つないでいます…');
      renderPanel();
    }

    loadPeerJs().then(function (Peer) {
      stage = 'broker';
      if (peer && !peer.destroyed && peer.open) return peer;
      if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
      return openPeer(Peer, null);
    }).then(function (p) {
      peer = p;
      stage = 'p2p';
      return connectHost(p);
    }).then(function (conn) {
      busy = false;
      var ms = Date.now() - t0;
      role = 'guest';
      hostConn = conn;
      hostSeen = Date.now();
      retryCount = 0;
      ssSet('pq:guestRoom', { code: guestRoom, name: guestName });
      document.body.classList.add('is-guest');
      startPing();
      logWithRoute(isRetry ? 'rejoin-ok' : 'join-ok', conn, { ms: ms });
      setStatus('');
      if (!lastPhase) guestWait('部屋に入りました', '親がゲームを始めるのを待っています。');
      beep('ok');
    }).catch(function (err) {
      busy = false;
      var st = stageOf(err, stage);
      logEvent(isRetry ? 'rejoin-fail' : 'join-fail', { stage: st, ms: Date.now() - t0 });
      if (isRetry && role === 'guest') {
        scheduleRetry(st);
        return;
      }
      var msg = {
        'no-room': '部屋が見つかりません。部屋コードをたしかめてください（親が部屋を閉じたか、親の画面が止まっているかもしれません）。',
        proto: '親とアプリの版がちがいます。両方の端末でページを再読み込みしてください。',
        full: '部屋が満員です（最大10人）。'
      }[st] || ('つながりませんでした（' + (STAGE_JA[st] || st) + '）。もう一度ためしてください。');
      setStatus(msg, true);
      if (peer) { try { peer.destroy(); } catch (e) {} peer = null; }
      ssDel('pq:guestRoom');
      renderPanel();
    });
  }

  function connectHost(p) {
    return new Promise(function (resolve, reject) {
      var conn = p.connect(ID_PREFIX + guestRoom, { reliable: true });
      var welcomed = false, done = false;
      var timer = setTimeout(function () {
        fin(false, { type: conn.open ? 'no-welcome' : 'p2p-timeout' });
      }, JOIN_TIMEOUT);
      function fin(ok, v) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        p.off('error', onPeerErr);
        if (ok) { resolve(v); return; }
        try { conn.close(); } catch (e) {}
        reject(v);
      }
      function onPeerErr(err) {
        if (err && err.type === 'peer-unavailable') fin(false, { type: 'peer-unavailable' });
        else if (err && /network|server-error|socket|disconnected/.test(err.type || '')) fin(false, { type: 'broker' });
      }
      p.on('error', onPeerErr);
      conn.on('open', function () {
        send(conn, 'hello', { pid: myPid(), name: guestName, proto: PROTO });
      });
      conn.on('data', function (raw) {
        var m = unpack(raw);
        if (!m) return;
        if (!welcomed) {
          if (m.type === 'welcome') { welcomed = true; fin(true, conn); }
          else if (m.type === 'reject') fin(false, { type: 'reject-' + m.reason });
          return;
        }
        if (hostConn === conn) guestOnMessage(m);
      });
      function closed() {
        if (!done) { fin(false, { type: 'p2p-closed' }); return; }
        if (hostConn === conn) guestLost('close');
      }
      conn.on('close', closed);
      conn.on('error', closed);
    });
  }

  function guestOnMessage(m) {
    hostSeen = Date.now();
    switch (m.type) {
      case 'ping': send(hostConn, 'pong', { t: m.t }); break;
      case 'phase': guestRender(m); break;
      case 'bye':
        closedByHost = true;
        stopGuestTimer();
        var c = hostConn;
        hostConn = null;
        try { c.close(); } catch (e) {}
        ssDel('pq:guestRoom');
        guestWait(m.reason === 'kicked' ? '部屋から外されました' : '親が部屋を閉じました',
          '「部屋を出る」で最初の画面にもどれます。', { ended: true });
        break;
    }
  }

  function guestLost(why) {
    if (role !== 'guest' || !hostConn) return;
    var c = hostConn;
    hostConn = null;
    try { c.close(); } catch (e) {}
    if (closedByHost) return;
    logEvent('drop', { why: why });
    stopGuestTimer();
    guestKey = '';
    retryCount = 0;
    scheduleRetry();
  }

  function scheduleRetry() {
    clearTimeout(retryTimer);
    if (retryCount >= RETRY_MAX) {
      guestWait('接続が切れました', '親の端末の画面がついているか確認して「つなぎ直す」を押してください。', { failed: true });
      return;
    }
    retryCount++;
    guestWait('接続が切れました', 'つなぎ直しています…', { retrying: true });
    retryTimer = setTimeout(function () {
      if (role === 'guest' && !hostConn && !busy) attemptJoin(true);
    }, retryCount === 1 ? 500 : RETRY_MS);
  }

  function retryNow() {
    if (role !== 'guest' || hostConn || busy) return;
    clearTimeout(retryTimer);
    retryCount = 0;
    retryCount++;
    attemptJoin(true);
  }

  function leave() {
    clearTimeout(retryTimer);
    stopGuestTimer();
    if (hostConn) send(hostConn, 'bye', { reason: 'left' });
    var c = hostConn, p = peer;
    hostConn = null;
    peer = null;
    setTimeout(function () {
      try { if (c) c.close(); } catch (e) {}
      try { if (p) p.destroy(); } catch (e) {}
    }, 300);
    role = null;
    lastPhase = null;
    guestKey = '';
    guestImg = null;
    ssDel('pq:guestRoom');
    document.body.classList.remove('is-guest');
    clearInterval(pingTimer);
    setStatus('');
    showScreen('s1');
    renderPanel();
  }

  /* =========================================================
     子の画面
     ========================================================= */
  function stopGuestTimer() {
    if (guestTimer) { guestTimer.stop(); guestTimer = null; }
  }

  function topStatus(ph) {
    var s = '🌐 ' + guestRoom;
    if (ph && ph.total && ph.s !== 'lobby' && ph.s !== 'result') s += '　' + (ph.round + 1) + ' / ' + ph.total + ' 問目';
    setTopStatus(s);
  }

  function enter(id) {
    if (State.screen !== id) showScreen(id);
  }

  /* 待合室の画面（S9）。opts: {img, members, retrying, failed, ended} */
  function guestWait(title, note, opts) {
    opts = opts || {};
    $id('guestTitle').textContent = title;
    $id('guestNote').textContent = note || '';
    $id('guestRoom').textContent = '部屋 ' + (guestRoom || '—') + (guestName ? '　/　' + guestName + ' さん' : '');
    var wrap = $id('guestImageWrap');
    if (opts.img && guestImg) { $id('guestImage').src = guestImg; wrap.hidden = false; }
    else { wrap.hidden = true; }
    var mem = $id('guestMembers');
    mem.innerHTML = '';
    (opts.members || []).forEach(function (m) {
      var chip = document.createElement('span');
      chip.className = 'guest-member' + (m.on ? '' : ' is-off');
      chip.textContent = m.name + (m.on ? '' : '（切断中）');
      mem.appendChild(chip);
    });
    $id('btnGuestRetry').hidden = !opts.failed;
    enter('s9');
    topStatus(lastPhase);
  }

  function guestRender(ph) {
    lastPhase = ph;
    if ('img' in ph) guestImg = ph.img;
    var key = [ph.s, ph.game, ph.round, ph.mine ? 1 : 0, ph.answering ? 1 : 0].join(':');
    var same = key === guestKey;
    guestKey = key;
    if (!same) stopGuestTimer();

    switch (ph.s) {
      case 'lobby':
        guestWait('部屋に入りました', '親がゲームを始めるのを待っています。', { members: ph.members });
        break;
      case 'loading':
        guestWait('出題を用意しています…', '');
        break;
      case 'draw':
        if (ph.mine && sentDrawRound !== roundKey(ph)) {
          if (!same) guestStartDraw(ph);
        } else if (ph.mine) {
          guestWait('絵を送りました', 'みんなが答えるのを待っています。');
        } else {
          guestWait(ph.drawer + ' さんが絵を描いています', 'できあがるまで待ってね。');
        }
        break;
      case 'quiz':
        if (ph.answering && sentAnswerRound !== roundKey(ph)) {
          if (!same) guestStartAnswer(ph);
        } else {
          var w = (ph.wait || []).length ? 'まだ答えていない人：' + ph.wait.join('、') : '';
          var t = ph.mine ? 'みんながあなたの絵を見て答えています'
            : sentAnswerRound === roundKey(ph) ? 'こたえを送りました' : 'ほかの人が答えています';
          guestWait(t, w, { img: true });
        }
        break;
      case 'reveal':
        guestReveal(ph);
        break;
      case 'result':
        guestResult(ph);
        break;
    }
    if (ph.s !== 'lobby') topStatus(ph);
  }

  /* 同じ round 番号が次のゲームでも出るので、ゲームの識別と組み合わせて区別する */
  function roundKey(ph) { return ph.game + ':' + ph.round; }

  function guestStartDraw(ph) {
    var q = questionFromRef(ph.ref);
    if (!q) {
      guestWait('出題を読み込めませんでした', '図鑑データが親とちがうようです。ページを再読み込みしてください。');
      return;
    }
    enter('s2');
    $id('s2').classList.remove('is-remote-draw');
    $id('drawerName').textContent = 'あなた';
    $id('turnCount').textContent = (ph.round + 1) + ' / ' + ph.total + ' 問目';
    $id('flavorMeta').textContent = 'ポケットモンスター ' + q.versionJa + ' より';
    $id('flavorText').textContent = q.flavorMasked;
    DrawPad.reset();
    beep('ok');
    if (ph.sec) {
      guestTimer = makeTimer('drawTimerWrap', 'drawTimerFill', 'drawTimerNum', ph.sec, function () {
        guestTimer = null;
        guestFinishDrawing(true);
      });
    } else {
      $id('drawTimerWrap').hidden = true;
    }
  }

  function guestFinishDrawing(timeUp) {
    if (role !== 'guest' || !lastPhase || lastPhase.s !== 'draw' || !lastPhase.mine) return;
    if (!timeUp && DrawPad.isBlank()) { toast('まだ何も描かれていません'); return; }
    if (!hostConn) { toast('親とつながっていません。つなぎ直すのを待ってください'); return; }
    stopGuestTimer();
    $id('drawTimerWrap').hidden = true;
    sentDrawRound = roundKey(lastPhase);
    guestImg = DrawPad.toDataURL();
    send(hostConn, 'drawing', { round: lastPhase.round, img: guestImg });
    beep('ok');
    guestWait('絵を送りました', 'みんなが答えるのを待っています。');
  }

  function guestStartAnswer(ph) {
    enter('s3');
    $id('s3').classList.remove('is-waiting');
    $id('quizImage').src = guestImg || '';
    $id('quizTurnCount').textContent = (ph.round + 1) + ' / ' + ph.total + ' 問目';
    $id('answererLabel').textContent = 'あなたのこたえ';
    $id('answerInput').value = '';
    $id('btnAnswerNext').textContent = 'こたえる';
    beep('ok');
    setTimeout(function () {
      var el = $id('answerInput');
      if (el && $id('s3').classList.contains('is-active')) el.focus();
    }, 120);
    if (ph.sec) {
      guestTimer = makeTimer('answerTimerWrap', 'answerTimerFill', 'answerTimerNum', ph.sec, function () {
        guestTimer = null;
        guestAnswer($id('answerInput').value || '');
      });
    } else {
      $id('answerTimerWrap').hidden = true;
    }
  }

  function guestAnswer(text) {
    if (role !== 'guest' || !lastPhase || lastPhase.s !== 'quiz') return;
    if (!hostConn) { toast('親とつながっていません。つなぎ直すのを待ってください'); return; }
    stopGuestTimer();
    $id('answerTimerWrap').hidden = true;
    sentAnswerRound = roundKey(lastPhase);
    send(hostConn, 'answer', { round: lastPhase.round, text: String(text || '').trim() });
    beep('tap');
    guestWait('こたえを送りました', 'ほかの人を待っています。', { img: true });
  }

  function guestReveal(ph) {
    var q = questionFromRef(ph.ref);
    if (!q) {
      guestWait('正解を読み込めませんでした', '図鑑データが親とちがうようです。ページを再読み込みしてください。');
      return;
    }
    fillRevealCard(q, ph.drawer, guestImg);
    var rows = (ph.answers || []).map(function (a) { return { who: a.who, text: a.text, correct: a.ok }; });
    renderAnswerRows(rows, null);
    var rec = $id('coopRecord');
    if (ph.coop) {
      rec.hidden = false;
      rec.textContent = (ph.coop.last ? 'これで最後の問題！ ' : '') +
        '全 ' + ph.coop.total + ' 問中 ' + ph.coop.correct + ' 問正解！';
    } else {
      rec.hidden = true;
    }
    if (State.screen !== 's4') {
      showScreen('s4');
      beep(rows.some(function (r) { return r.correct; }) ? 'correct' : 'wrong');
    }
  }

  function guestResult(ph) {
    var list = (ph.ranking || []).map(function (e) {
      return { name: e.name, answer: e.answer, draw: e.draw, total: e.total, title: e.title, online: e.online };
    });
    renderPodium(list);
    renderRankList('rankTotal', list, 'total', '点');
    renderRankList('rankAnswer', list, 'answer', '問');
    renderRankList('rankDraw', list, 'draw', '人');
    if (State.screen !== 's5') {
      showScreen('s5');
      beep('fanfare');
    }
  }

  /* =========================================================
     設定画面のパネル（S1）
     ========================================================= */
  var statusText = '', statusErr = false;
  function setStatus(text, isErr) {
    statusText = text || '';
    statusErr = !!isErr;
    var el = $id('onlineStatus');
    if (!el) return;
    el.textContent = statusText;
    el.classList.toggle('is-err', statusErr);
  }

  function roomUrl() {
    return location.origin + location.pathname + '?room=' + room;
  }

  function renderPanel() {
    var panel = $id('onlinePanel');
    if (!panel) return;
    var hosting = role === 'host';
    $id('onlineIdle').hidden = hosting || role === 'guest';
    $id('onlineHosting').hidden = !hosting;
    $id('btnOnlineHost').disabled = busy;
    $id('btnOnlineJoin').disabled = busy;
    if (hosting) {
      $id('onlineRoomCode').textContent = room;
      $id('onlineRoomUrl').value = roomUrl();
      var list = State.players.filter(function (p) { return p.online; });
      $id('onlineGuestList').textContent = list.length
        ? '参加中：' + list.map(function (p) {
            return (p.name || '名無し') + (conns[p.id] ? '' : '（切断中）');
          }).join('、')
        : 'まだ誰も参加していません。';
    }
    var tag = $id('onlineTag');
    // 閉じていても部屋をひらいていることが分かるよう、見出しに出す
    if (tag) tag.textContent = hosting ? '（部屋 ' + room + ' をひらいています）' : '（ためし版・別々の端末どうし）';
  }

  function updateVisibility() {
    var panel = $id('onlinePanel');
    if (!panel) return;
    // オフラインのときは出さない（親として部屋をひらいている間は、表示を消すと閉じられなくなるので残す）
    panel.hidden = !navigator.onLine && role !== 'host';
  }

  function init() {
    var panel = $id('onlinePanel');
    if (!panel) return;

    var nameInput = $id('onlineName');
    var codeInput = $id('onlineCode');
    try { nameInput.value = localStorage.getItem('pq:onlineName') || ''; } catch (e) {}

    $id('btnOnlineHost').addEventListener('click', function () { beep('tap'); host(); });
    $id('btnOnlineJoin').addEventListener('click', function () {
      beep('tap');
      join(codeInput.value, nameInput.value);
    });
    [nameInput, codeInput].forEach(function (el) {
      el.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        if (e.isComposing || e.keyCode === 229) return;   // 変換確定の Enter は無視（二重入力になる）
        e.preventDefault();
        join(codeInput.value, nameInput.value);
      });
    });
    /* 大文字にそろえ、英数字以外を消す。
       ただし日本語入力の変換中に書き換えると、確定のときに同じ文字がもう一度入る
       （iPad で「abc」が「AABABC」になった）。変換中は触らず、確定してからそろえる。 */
    var composing = false;
    function tidyCode() {
      var raw = codeInput.value;
      var v = normCode(raw);
      if (v !== raw) codeInput.value = v;
      // ローマ字入力のまま打つと「か」などになって消えてしまうので、黙って消さずに知らせる
      if (/[ぁ-ゖァ-ヶ]/.test(raw)) setStatus('部屋コードは英数字です。キーボードを英字（ABC）に切り替えて入れてください。', true);
    }
    codeInput.addEventListener('compositionstart', function () { composing = true; });
    codeInput.addEventListener('compositionend', function () { composing = false; tidyCode(); });
    codeInput.addEventListener('input', function (e) {
      if (composing || e.isComposing) return;
      tidyCode();
    });
    codeInput.addEventListener('blur', tidyCode);
    $id('btnOnlineCopyUrl').addEventListener('click', function () {
      copyText(roomUrl(), '参加用 URL をコピーしました');
    });
    var share = $id('btnOnlineShare');
    if (navigator.share) {
      share.hidden = false;
      share.addEventListener('click', function () {
        navigator.share({ title: 'ポケモン図鑑クイズ', text: '部屋コード ' + room, url: roomUrl() }).catch(function () {});
      });
    }
    armConfirm('btnOnlineClose', '部屋を閉じる', 'ほんとうに閉じる？（もう一度おす）', closeRoom);

    $id('btnNetlogCopy').addEventListener('click', function () {
      copyText(logText(), '接続の記録をコピーしました');
    });
    armConfirm('btnNetlogClear', '記録を消す', 'ほんとうに消す？（もう一度おす）', function () {
      try { localStorage.removeItem(LOG_KEY); } catch (e) {}
      renderLog();
      toast('接続の記録を消しました');
    });

    $id('btnGuestRetry').addEventListener('click', function () { beep('tap'); retryNow(); });
    $id('btnGuestLeave').addEventListener('click', function () { beep('tap'); leave(); });
    $id('btnStopWaiting').addEventListener('click', function () { beep('tap'); giveUpOnlineAnswers(); });
    armConfirm('btnSkipRound', 'この問題をとばす', 'ほんとうにとばす？（もう一度おす）', skipRound);

    window.addEventListener('online', updateVisibility);
    window.addEventListener('offline', updateVisibility);
    // 子：画面がもどってきたら、止まっている間に切れていないか確かめる
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState !== 'visible') return;
      if (role === 'guest' && hostConn && Date.now() - hostSeen > DEAD_MS) guestLost('timeout');
    });

    updateVisibility();
    renderLog();
    renderPanel();

    // 再読み込みからの復帰：親は同じ部屋コードで開き直し、子は同じ部屋に入り直す
    var hostRoom = ssGet('pq:hostRoom');
    var guestSaved = ssGet('pq:guestRoom');
    if (hostRoom && navigator.onLine) {
      panel.open = true;
      host(normCode(hostRoom));
    } else if (guestSaved && guestSaved.code && navigator.onLine) {
      codeInput.value = guestSaved.code;
      nameInput.value = guestSaved.name || nameInput.value;
      join(guestSaved.code, guestSaved.name);
    } else if (QUERY.room) {
      // 参加用 URL から開いた：コードを入れておき、名前だけ打てば参加できるようにする
      panel.open = true;
      codeInput.value = normCode(QUERY.room);
      setStatus('部屋コードが入っています。名前を入れて「参加する」を押してください。');
      setTimeout(function () {
        if (panel.scrollIntoView) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
        if (!nameInput.value) nameInput.focus();
      }, 300);
    }
  }

  return {
    init: init,
    isHost: function () { return role === 'host'; },
    isGuest: function () { return role === 'guest'; },
    isConnected: function (pid) { return role === 'host' && !!conns[pid]; },
    hostBroadcast: hostBroadcast,
    kick: kick,
    guestFinishDrawing: function () { guestFinishDrawing(false); },
    guestAnswer: guestAnswer,
    // テスト用（ブラウザを2つ並べた自動テストから使う）
    _debug: function () {
      return { role: role, room: room, conns: Object.keys(conns), lastPhase: lastPhase, busy: busy };
    },
    _summary: summaryText,
    _tap: function () { tap = tap || []; return tap; },
    _host: host,
    _join: join,
    _close: closeRoom,
    _leave: leave
  };
})();
