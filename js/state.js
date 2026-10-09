/* =========================================================
   state.js — 状態オブジェクト / 小さな共通ユーティリティ /
              sessionStorage への自動保存と復帰
   （ES modules は使わない。すべて window 直下のグローバル）
   ========================================================= */

/* ---------- 共通ユーティリティ ---------- */
var $ = function (sel, root) { return (root || document).querySelector(sel); };
var $$ = function (sel, root) {
  return Array.prototype.slice.call((root || document).querySelectorAll(sel));
};
var $id = function (id) { return document.getElementById(id); };

/* URL クエリ（?debug=1 など） */
var QUERY = (function () {
  var q = {};
  var s = location.search.replace(/^\?/, '');
  if (!s) return q;
  s.split('&').forEach(function (pair) {
    var kv = pair.split('=');
    q[decodeURIComponent(kv[0])] = decodeURIComponent(kv[1] || '');
  });
  return q;
})();
var DEBUG = QUERY.debug === '1';

/* トースト表示 */
var toastTimer = null;
function toast(msg, ms) {
  var el = $id('toast');
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () { el.hidden = true; }, ms || 2600);
}

/* 配列シャッフル（Fisher-Yates） */
function shuffle(arr) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

/* ---------- 既定値 ---------- */
var DEFAULT_SETTINGS = {
  gens: [1, 2, 3, 4, 5, 6, 7, 8, 9],  // 出題する世代（その世代で新登場した種のみ・複数選択）
  sources: [],       // 図鑑説明の出典ソフト（空配列＝おまかせ＝すべて）
  mode: 'coop',      // 'coop' 協力（既定） | 'vs' 対戦
                     //   対戦はプレイヤー登録が要るので、既定は登録なしで始められる協力にする
  timer: false,      // 時間制限あり/なし
  drawSec: 90,
  answerSec: 30
};

function makePlayer(name, remote) {
  return {
    id: 'p' + Math.random().toString(36).slice(2, 9),
    name: name || '',
    remote: !!remote
  };
}

function newState() {
  return {
    version: 4,        // 設定の形を変えたら上げる（旧セッションは復帰させない）
    screen: 's1',
    settings: JSON.parse(JSON.stringify(DEFAULT_SETTINGS)),
    players: [makePlayer(''), makePlayer('')],
    order: [],          // 出題者の順番（player id の配列）
    round: 0,           // 何問目（0 始まり）
    quiz: [],           // プリフェッチ済みのポケモン（1問1件）
    usedIds: [],        // 抽選済み ID（重複防止）
    drawing: null,      // 現在ラウンドの絵（dataURL）
    answerers: [],      // 現ラウンドの解答者 id 一覧（協力モードは [null]）
    answerIndex: 0,     // 対戦モードで今なんばんめの解答者か
    answers: [],        // 現ラウンドの解答 [{playerId,text,correct,manual}]
    scores: {},         // { playerId: {answer:n, draw:n} }
    coop: { total: 0, correct: 0 },
    lastRoundScore: null,   // 現ラウンドで加算した分（○×の手動修正・リロード復帰用）
    statsCommitted: false,  // 累積記録へ加算ずみか（対戦モードのみ・二重加算の防止）
    finished: false
  };
}

var State = newState();

/* ---------- sessionStorage 保存・復帰 ---------- */
var SS_KEY = 'pq:session';

function saveState() {
  try {
    // キャンバス画像は容量が大きいので「直近1件（現在ラウンド分）」だけ保持する
    sessionStorage.setItem(SS_KEY, JSON.stringify(State));
  } catch (e) {
    // 容量オーバー時は絵を捨ててリトライ
    try {
      var copy = JSON.parse(JSON.stringify(State));
      copy.drawing = null;
      if (copy.quiz) copy.quiz.forEach(function (q) { if (q) q.drawing = null; });
      sessionStorage.setItem(SS_KEY, JSON.stringify(copy));
    } catch (e2) { /* あきらめる（ゲームは続行できる） */ }
  }
}

function loadSavedState() {
  try {
    var raw = sessionStorage.getItem(SS_KEY);
    if (!raw) return null;
    var obj = JSON.parse(raw);
    if (!obj || obj.version !== 4) return null;
    return obj;
  } catch (e) { return null; }
}

function clearSavedState() {
  try { sessionStorage.removeItem(SS_KEY); } catch (e) {}
}

/* ---------- 便利アクセサ ---------- */
function playerById(id) {
  for (var i = 0; i < State.players.length; i++) {
    if (State.players[i].id === id) return State.players[i];
  }
  return null;
}
function playerName(id) {
  var p = playerById(id);
  return p ? (p.name || '名無し') : '—';
}
function activePlayers() {
  return State.players.filter(function (p) { return (p.name || '').trim() !== ''; });
}
function ensureScore(id) {
  if (!State.scores[id]) State.scores[id] = { answer: 0, draw: 0 };
  return State.scores[id];
}

/* ---------- 出題履歴（localStorage・端末に残る） ----------
   同じポケモンが続けて出ないようにするための記録。
   古い順に並んだ図鑑 No. の配列で、新しく出題したものを末尾に足していく。
   ゲームの勝敗やプレイヤー名は入れない（何が出たかだけ）。 */
var ASKED_KEY = 'pq:asked';
var ASKED_MAX = 2000;   // これを超えたら古いものから捨てる

function loadAskedIds() {
  try {
    var raw = localStorage.getItem(ASKED_KEY);
    if (!raw) return [];
    var a = JSON.parse(raw);
    return Array.isArray(a) ? a.filter(function (x) { return typeof x === 'number'; }) : [];
  } catch (e) { return []; }
}

/* 出題した ID を記録する。すでにある ID は「最近出た」扱いにするため末尾へ移す。 */
function recordAskedIds(ids) {
  if (!ids || !ids.length) return;
  var list = loadAskedIds();
  var add = {};
  ids.forEach(function (id) { add[id] = true; });
  list = list.filter(function (id) { return !add[id]; });
  ids.forEach(function (id) { list.push(id); });
  if (list.length > ASKED_MAX) list = list.slice(list.length - ASKED_MAX);
  try { localStorage.setItem(ASKED_KEY, JSON.stringify(list)); } catch (e) {}
}

function clearAskedIds() {
  var n = loadAskedIds().length;
  try { localStorage.removeItem(ASKED_KEY); } catch (e) {}
  return n;
}

/* ---------- プレイヤー登録の永続化（localStorage・端末に残る） ----------
   対戦モードで毎回名前を打ち直さずに済むようにする。
   sessionStorage の State.players はゲーム進行中の作業用で、こちらが「元の名簿」。
   保存するのは id / 名前 / リモート印だけ（得点は pq:stats 側）。 */
var ROSTER_KEY = 'pq:roster';

function loadRoster() {
  try {
    var raw = localStorage.getItem(ROSTER_KEY);
    if (!raw) return null;
    var a = JSON.parse(raw);
    if (!Array.isArray(a) || !a.length) return null;
    var out = [];
    a.forEach(function (p) {
      if (!p || typeof p.id !== 'string') return;
      out.push({ id: p.id, name: String(p.name || ''), remote: !!p.remote });
    });
    return out.length ? out : null;
  } catch (e) { return null; }
}

function saveRoster(players) {
  var all = (players || State.players || []).map(function (p) {
    return { id: p.id, name: p.name || '', remote: !!p.remote, online: !!p.online };
  });
  // オンラインで入ってきた人は、その回だけの参加者なので名簿には残さない（累積記録には残る）
  var list = all.filter(function (p) { return !p.online; }).map(function (p) {
    return { id: p.id, name: p.name, remote: p.remote };
  });
  try { localStorage.setItem(ROSTER_KEY, JSON.stringify(list)); } catch (e) {}
  // 名前を変えたら累積記録の表示名も追従させる（紐付けは id なので記録は消えない）
  syncStatsNames(all);
}

function clearRoster() {
  try { localStorage.removeItem(ROSTER_KEY); } catch (e) {}
}

/* ---------- 対戦モードの累積記録（localStorage・端末に残る） ----------
   ユーザーの明言により **対戦モードだけ** 加算する。協力モードでは一切さわらない。
   紐付けは player.id。名簿から消した人の記録も残るよう、名前も一緒に持つ。 */
var STATS_KEY = 'pq:stats';

function emptyStats() { return { version: 1, players: {} }; }

function loadStats() {
  try {
    var raw = localStorage.getItem(STATS_KEY);
    if (!raw) return emptyStats();
    var obj = JSON.parse(raw);
    if (!obj || obj.version !== 1 || !obj.players) return emptyStats();
    return obj;
  } catch (e) { return emptyStats(); }
}

function writeStats(stats) {
  try { localStorage.setItem(STATS_KEY, JSON.stringify(stats)); } catch (e) {}
}

function clearStats() {
  var n = Object.keys(loadStats().players).length;
  try { localStorage.removeItem(STATS_KEY); } catch (e) {}
  return n;
}

/* 名簿の改名を記録側にも反映する（記録そのものは動かさない） */
function syncStatsNames(list) {
  var stats = loadStats();
  var changed = false;
  (list || []).forEach(function (p) {
    var rec = stats.players[p.id];
    var name = (p.name || '').trim();
    if (rec && name && rec.name !== name) { rec.name = name; changed = true; }
  });
  if (changed) writeStats(stats);
}

/* 1ゲーム分を加算する。
   list は app.js の buildRanking() が返す [{id,name,answer,draw,total}]。
   呼び出しは showResult() の1回だけ（State.statsCommitted で二重加算を止める）。 */
function commitVsStats(list) {
  if (!list || !list.length) return;
  var stats = loadStats();
  var now = Date.now();

  var maxTotal = 0;
  list.forEach(function (e) { if (e.total > maxTotal) maxTotal = e.total; });

  list.forEach(function (e) {
    // 「すぐに始める」の仮 ID（__quick__）は名簿に無いので記録しない
    if (!e.id || e.id === '__quick__') return;
    var rec = stats.players[e.id];
    if (!rec) rec = stats.players[e.id] = { name: '', answer: 0, draw: 0, games: 0, wins: 0, lastAt: 0 };
    rec.name = e.name || rec.name || '名無し';
    rec.answer += e.answer;
    rec.draw += e.draw;
    rec.games += 1;
    // 0 点どうしの並びで全員を勝者にしないよう、1 点以上の1位だけ勝利とする
    if (maxTotal > 0 && e.total === maxTotal) rec.wins += 1;
    rec.lastAt = now;
  });

  writeStats(stats);
}

/* 累積ランキング画面が使う形に展開する（S5 の renderRankList と同じキー名にそろえる） */
function statsRanking() {
  var stats = loadStats();
  return Object.keys(stats.players).map(function (id) {
    var r = stats.players[id];
    return {
      id: id,
      name: r.name || '名無し',
      remote: false,
      answer: r.answer || 0,
      draw: r.draw || 0,
      total: (r.answer || 0) + (r.draw || 0),
      games: r.games || 0,
      wins: r.wins || 0,
      lastAt: r.lastAt || 0
    };
  });
}
