const { launch, newPage, sleep } = require('./cdp');
const path = require('path');
let fails = 0;
function check(c, m) { console.log((c ? '  OK  ' : '  NG  ') + m); if (!c) fails++; }
(async () => {
  const proc = await launch(path.join(require('os').tmpdir(), 'dexq-prof6'));
  try {
    const p = await newPage('local', 'http://localhost:8000/');
    await p.waitFor("document.getElementById('bootOverlay').classList.contains('is-done') && State.screen==='s1'", 40000);
    // すぐに始める
    await p.eval("startGame(true)");
    await p.waitFor("State.screen==='s2'", 8000);
    check(await p.eval("!$id('s2').classList.contains('is-remote-draw') && flavorText.textContent.length>0"), 'すぐに始める：解説文とキャンバスが出る');
    await p.scribble('#drawCanvas'); await p.eval("finishDrawing()");
    await p.waitFor("State.screen==='s3'", 5000);
    check(await p.eval("answererLabel.textContent==='みんなのこたえ' && interstitial.hidden"), 'すぐに始める：みんなのこたえ・合図なし');
    const nm = await p.eval("State.quiz[0].nameJa");
    await p.eval(`answerInput.value=${JSON.stringify(nm)}; submitAnswer()`);
    await p.waitFor("State.screen==='s4'", 5000);
    check(await p.eval("State.answers.length===1 && State.answers[0].correct && State.coop.correct===1"), 'すぐに始める：正解して協力の記録が 1');
    check(await p.eval("getComputedStyle(btnRevealNext).display!=='none' && revealResults.querySelectorAll('.btn-flip').length===1"), '親の画面には ○× 直しと次へが出る');
    await p.eval("btnRevealNext.click()");
    await p.waitFor("State.screen==='s1'", 5000);
    // 対戦（2人・この端末だけ）
    await p.eval("State.players=[makePlayer('あ'),makePlayer('い')]; renderPlayers(); State.settings.mode='vs'; renderMode(); State.order=[]; startGame(false)");
    for (let r = 0; r < 2; r++) {
      await p.waitFor("State.screen==='s2'", 8000);
      await p.eval("if(!interstitial.hidden) hideInterstitial()"); await sleep(300);
      await p.scribble('#drawCanvas'); await p.eval("finishDrawing()");
      await p.waitFor("State.screen==='s3'", 5000);
      const info = await p.eval("({n: State.answerers.length, label: answererLabel.textContent, inter: !interstitial.hidden})");
      check(info.n === 1 && /さんのこたえ/.test(info.label), `対戦 ${r + 1}問目：出題者以外の1人が答える（${info.label}）`);
      await p.eval("if(!interstitial.hidden) hideInterstitial(); answerInput.value=State.quiz[State.round].nameJa; submitAnswer()");
      await p.waitFor("State.screen==='s4'", 5000);
      await p.eval("nextRound()");
    }
    await p.waitFor("State.screen==='s5'", 5000);
    check(await p.eval("rankTotal.children.length===2 && /2点|1点/.test(rankTotal.innerText)"), '対戦：結果発表が出る');
    check(await p.eval("Object.keys(loadStats().players).length===2"), '対戦：累積記録に加算された');
    check(await p.eval("JSON.parse(localStorage.getItem('pq:roster')).length===2"), '名簿が保存されている');
    check(await p.eval("!JSON.parse(localStorage.getItem('pq:netlog')||'null')"), 'オンラインを使わなければ通信の記録も PeerJS の読み込みもない' );
    check(await p.eval("typeof window.Peer==='undefined' && !document.querySelector('script[src*=peerjs]')"), 'PeerJS は読み込まれていない');
    const errs = p.logs.filter((l) => /EXC|error/i.test(l)); if (errs.length) console.log(errs.join('\n'));
  } catch (e) { console.error('FAILED', e.message); fails++; } finally { proc.kill(); }
  console.log(fails ? fails + ' 件 NG' : 'すべて OK'); process.exit(fails ? 1 : 0);
})();
