// 親（localhost）と子（127.0.0.1）を別オリジンで開き、PeerJS 公開ブローカー経由で通しで遊ぶ
const { launch, newPage, closePage, sleep } = require('./cdp');
const path = require('path');

const HOST_URL = 'http://localhost:8000/';
const GUEST_URL = 'http://127.0.0.1:8000/';
let fails = 0;
function check(cond, msg) { console.log((cond ? '  OK  ' : '  NG  ') + msg); if (!cond) fails++; }

const booted = "document.getElementById('bootOverlay').classList.contains('is-done') && typeof Online !== 'undefined' && State.screen === 's1'";

async function drawOnHost(host) {
  // 親の端末で描いたことにする（キャンバスに実際に線を引く）
  await host.eval("if (!document.getElementById('interstitial').hidden) hideInterstitial()");
  await sleep(300);
  await host.scribble('#drawCanvas');
  await host.eval("finishDrawing()");
}

async function playRound(host, guest, mode) {
  const info = await host.eval(`({round: State.round, drawer: State.order[State.round], name: State.quiz[State.round].nameJa,
      masked: State.quiz[State.round].flavorMasked, raw: State.quiz[State.round].flavorRaw,
      drawerOnline: isOnlinePlayer(State.order[State.round])})`);
  console.log(`-- round ${info.round + 1} drawer=${info.drawerOnline ? 'guest' : 'host'} answer=${info.name}`);
  if (info.drawerOnline) {
    await host.waitFor("State.screen==='s2'", 10000);
    check(await host.eval("document.getElementById('s2').classList.contains('is-remote-draw') && document.getElementById('flavorText').textContent===''"),
      '親の画面：オンラインの出題者のとき解説文を出さない');
    await guest.waitFor("State.screen==='s2' && document.getElementById('flavorText').textContent.length>0", 15000, 'guest draw screen');
    const gText = await guest.eval("document.getElementById('flavorText').textContent");
    check(gText === info.masked, '子の端末で、親と同じ伏字の解説文を組み立てられた');
    await guest.scribble('#drawCanvas');
    await guest.eval("document.getElementById('btnDrawDone').click()");
    await guest.waitFor("State.screen==='s9'", 5000);
    // 親の端末には、ほかに答える人（親）がいる
    await host.waitFor("State.screen==='s3' && !!State.drawing", 15000, 'host s3 after guest drawing');
    check(await host.eval("State.drawing && State.drawing.indexOf('data:image/png')===0"), '子の絵が親に届いた');
    // 親の端末の解答（わざと1文字ちがい → 不正解のはず）
    await host.eval(`(function(){ if (!document.getElementById('interstitial').hidden) hideInterstitial();
      document.getElementById('answerInput').value=${JSON.stringify(info.name)}.slice(0,-1); submitAnswer(); })()`);
  } else {
    await host.waitFor("State.screen==='s2'", 10000);
    await guest.waitFor("State.screen==='s9' && /描いています/.test(document.getElementById('guestTitle').textContent)", 10000, 'guest waiting for drawer');
    await drawOnHost(host);
    // 子が解答する
    await guest.waitFor("State.screen==='s3' && document.getElementById('quizImage').src.indexOf('data:image')===0", 15000, 'guest answer screen');
    check(true, '子の端末に親の絵が届き、解答画面になった');
    if (mode === 'vs') {
      // 親の端末にはこの端末で答える人がいない → 待ち画面
      await host.waitFor("document.getElementById('s3').classList.contains('is-waiting')", 5000, 'host waiting');
      check(true, '親：オンラインの人の解答を待つ表示になった');
    } else {
      // 協力モード：親の端末の「みんな」も答える
      await host.eval("document.getElementById('answerInput').value='わからん'; submitAnswer();");
    }
    // ひらがなで正解を答える
    const hira = info.name.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
    await guest.eval(`document.getElementById('answerInput').value=${JSON.stringify(hira)}; document.getElementById('btnAnswerNext').click();`);
  }
  await host.waitFor("State.screen==='s4'", 15000, 'host reveal');
  await guest.waitFor("State.screen==='s4'", 10000, 'guest reveal');
  const hostReveal = await host.eval("({name: revealName.textContent, flavor: revealFlavor.textContent, rows: revealResults.innerText})");
  const guestReveal = await guest.eval("({name: revealName.textContent, flavor: revealFlavor.textContent, rows: revealResults.innerText, flip: revealResults.querySelectorAll('.btn-flip').length, next: getComputedStyle(btnRevealNext).display})");
  check(guestReveal.name === hostReveal.name && guestReveal.flavor === hostReveal.flavor && guestReveal.flavor === info.raw,
    '子の正解発表：名前と解説文（完全版）が親と一致');
  check(guestReveal.flip === 0 && guestReveal.next === 'none', '子の端末には ○× 直しと「次へ」を出さない');
  const answers = await host.eval("State.answers.map(a => (a.playerId ? playerName(a.playerId) : 'みんな') + ':' + a.text + ':' + a.correct)");
  console.log('     answers', JSON.stringify(answers));
  if (info.drawerOnline) check(answers.length === 1 && /:false$/.test(answers[0]), '1文字ちがい（末尾を1文字消した答え）は不正解');
  else check(answers.some((a) => /^こども:.*:true$/.test(a)), '子のひらがな解答が正解になった');
  return info;
}

(async () => {
  const proc = await launch(path.join(require('os').tmpdir(), 'dexq-prof'));
  try {
    const host = await newPage('host', HOST_URL);
    const guest = await newPage('guest', GUEST_URL);
    await host.waitFor(booted, 40000, 'host boot');
    await guest.waitFor(booted, 40000, 'guest boot');
    console.log('booted');
    const tap = await host.eval("Online._tap().length");

    // --- 部屋を作る／参加する ---
    await host.eval("State.players=[makePlayer('おや'),makePlayer('')]; renderPlayers(); State.settings.mode='vs'; renderMode(); State.settings.timer=false; renderTimer(); Online._host();");
    const room = await host.waitFor("Online.isHost() && Online._debug().room", 20000, 'room open');
    console.log('room', room);
    check(await host.eval("document.getElementById('onlineRoomCode').textContent") === room, '親：部屋コードを表示');
    await guest.eval(`Online._tap(); Online._join(${JSON.stringify(room)}, 'こども')`);
    await guest.waitFor("Online.isGuest()", 20000, 'guest joined');
    await host.waitFor("State.players.some(p => p.online && Online.isConnected(p.id))", 10000, 'host sees guest');
    check(true, '子が参加し、親の名簿に 🌐 で入った');
    await guest.waitFor("State.screen==='s9' && /おや/.test(document.getElementById('guestMembers').textContent)", 5000, 'guest lobby');
    check(true, '子の待合室に参加者一覧が出た');

    // --- 対戦モードを2問（親と子が1回ずつ描く） ---
    await host.eval("startGame(false)");
    const infos = [];
    for (let r = 0; r < 2; r++) {
      infos.push(await playRound(host, guest, 'vs'));
      await host.eval("nextRound()");
    }
    await host.waitFor("State.screen==='s5'", 5000);
    await guest.waitFor("State.screen==='s5' && rankTotal.children.length===2", 8000, 'guest result');
    check(true, '子の端末にも結果発表が出た');
    console.log('     guest ranking:', (await guest.eval("rankTotal.innerText")).replace(/\n/g, ' '));

    // --- 図鑑テキストを送っていないことを確認 ---
    const sent = await host.eval("Online._tap()");
    const gsent = await guest.eval("Online._tap()");
    let leak = 0;
    for (const info of infos) {
      for (const text of [info.raw, info.masked]) {
        for (let i = 0; i + 8 <= text.length; i += 3) {
          const w = text.slice(i, i + 8);
          if (/〇/.test(w)) continue;
          if (sent.concat(gsent).some((m) => m.indexOf(w) >= 0)) leak++;
        }
      }
    }
    check(leak === 0, `送受信 ${sent.length + gsent.length} 件に図鑑の文章が含まれていない`);
    console.log('     sample:', sent.filter((m) => /"s":"draw"/.test(m) && /"ref"/.test(m))[0]);

    // --- 協力モード：切断 → 無回答で続行 → 子がつなぎ直す ---
    console.log('-- coop + disconnect');
    await host.eval("showScreen('s1'); State.settings.mode='coop'; renderMode(); startGame(false)");
    // 親が描く番になるまで（2人なので順番は半々）。子が描く番なら描かせて進める
    await host.waitFor("State.screen==='s2'", 10000);
    if (await host.eval("isOnlinePlayer(State.order[State.round])")) {
      await guest.waitFor("State.screen==='s2' && flavorText.textContent.length>0", 15000);
      await guest.scribble('#drawCanvas');
      await guest.eval("btnDrawDone.click()");
      await host.waitFor("State.screen==='s3'", 15000);
      await host.eval("answerInput.value='x'; submitAnswer();");
      await host.waitFor("State.screen==='s4'", 10000);
      await host.eval("nextRound()");
      await host.waitFor("State.screen==='s2'", 10000);
    }
    await drawOnHost(host);
    await guest.waitFor("State.screen==='s3'", 15000, 'guest coop answer');
    // 子のタブを閉じる（いきなり切れる）
    const t0 = Date.now();
    await closePage(guest);
    await host.waitFor("State.screen==='s3' && !!State.onlineWait && Object.keys(State.onlineWait).length===1", 3000).catch(() => {});
    // 親が描いた回は、親の端末で答える人がいない（子だけが答える）→ 切断検知で無回答になって正解発表へ
    check(await host.eval("document.getElementById('s3').classList.contains('is-waiting')"), '親：子の解答待ちの表示');
    await host.waitFor("State.screen==='s4'", 20000, 'host proceeds after drop');
    const dropMs = Date.now() - t0;
    const ans = await host.eval("State.answers.map(a => (a.playerId ? playerName(a.playerId) : 'みんな') + ':' + a.text)");
    check(ans.some((a) => a === 'こども:'), `切れた子は無回答になり、ゲームが進んだ（${(dropMs / 1000).toFixed(1)} 秒）`);

    // 子がもう一度ひらいて入り直す（同じ端末なので同じプレイヤーに戻る）
    const guest2 = await newPage('guest2', GUEST_URL);
    await guest2.waitFor(booted, 40000, 'guest2 boot');
    await guest2.eval(`Online._join(${JSON.stringify(room)}, 'こども')`);
    await guest2.waitFor("Online.isGuest()", 20000, 'guest rejoined');
    await guest2.waitFor("State.screen==='s4'", 8000, 'guest2 sees current reveal');
    const n = await host.eval("State.players.filter(p => p.online).length");
    check(n === 1, '入り直した子は同じプレイヤーのまま（重複しない）');
    check(true, '入り直した子に、いまの画面（正解発表）が届いた');

    // 子のページを再読み込み → 自動で入り直す
    await guest2.send('Page.reload');
    await guest2.waitFor("Online.isGuest() && State.screen==='s4'", 40000, 'auto rejoin after reload');
    check(true, '子が再読み込みしても自動で入り直した');

    // 親が部屋を閉じる
    await host.eval("showScreen('s1'); Online._close()");
    await guest2.waitFor("/閉じました/.test(guestTitle.textContent)", 8000, 'guest sees closed');
    check(true, '親が部屋を閉じると、子に知らせる');
    check(await host.eval("State.players.every(p => !p.online)"), '部屋を閉じると名簿からオンラインの人が消える');

    console.log('\n[host netlog]\n' + await host.eval("Online._summary()"));
    console.log("\n[guest netlog]\n" + await guest2.eval("Online._summary()")); await sleep(1500); console.log(await guest2.eval("JSON.parse(localStorage.getItem('pq:netlog')).events.map(e=>e.kind+' '+(e.route||'')+' '+(e.stage||'')).join(' | ')")); console.log(await host.eval("JSON.parse(localStorage.getItem('pq:netlog')).events.map(e=>e.kind+' '+(e.route||'')+' '+(e.why||'')).join(' | ')"));
    const errs = host.logs.concat(guest2.logs).filter((l) => /EXC|error/i.test(l));
    if (errs.length) console.log('\nconsole errors:\n' + errs.join('\n'));
  } catch (e) {
    console.error('FAILED:', e.message);
    fails++;
  } finally {
    proc.kill();
  }
  console.log(fails ? `\n${fails} 件 NG` : '\nすべて OK');
  process.exit(fails ? 1 : 0);
})();
