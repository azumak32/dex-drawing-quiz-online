const { launch, newPage, sleep } = require('./cdp');
const path = require('path');
let fails = 0;
function check(c, m) { console.log((c ? '  OK  ' : '  NG  ') + m); if (!c) fails++; }
const booted = "document.getElementById('bootOverlay').classList.contains('is-done') && typeof Online !== 'undefined' && State.screen==='s1'";
(async () => {
  const proc = await launch(path.join(require('os').tmpdir(), 'dexq-prof7'));
  try {
    const host = await newPage('host', 'http://localhost:8000/');
    const guest = await newPage('guest', 'http://127.0.0.1:8000/');
    await host.waitFor(booted, 40000); await guest.waitFor(booted, 40000);
    await host.eval("State.players=[makePlayer('あ'),makePlayer('い')]; renderPlayers(); State.settings.mode='vs'; renderMode(); State.settings.timer=false; renderTimer(); Online._host();");
    const room = await host.waitFor("Online.isHost() && Online._debug().room", 20000);
    await guest.eval(`Online._join(${JSON.stringify(room)}, 'こども')`);
    await host.waitFor("State.players.filter(p=>p.online).length===1 && gamePlayers().length===3", 20000);
    check(await host.eval("State.players.length===3"), '子は空欄の行ではなく末尾に入った（名前のある2人はそのまま）');
    await host.eval("State.order=[]; startGame(false)");
    for (let r = 0; r < 3; r++) {
      await host.waitFor("State.screen==='s2'", 10000);
      await host.eval("if(!interstitial.hidden) hideInterstitial()"); await sleep(300);
      const d = await host.eval("({drawer: playerName(State.order[State.round]), online: isOnlinePlayer(State.order[State.round]), name: State.quiz[State.round].nameJa})");
      if (d.online) {
        await guest.waitFor("State.screen==='s2' && flavorText.textContent.length>0", 15000);
        await guest.scribble('#drawCanvas'); await guest.eval("btnDrawDone.click()");
        await host.waitFor("State.screen==='s3'", 15000);
        // 親の端末の2人は順番に（あいだに合図が入る）
        check(await host.eval("!interstitial.hidden"), `${r + 1}問目（${d.drawer}）：親の端末の1人目の前に合図が出る`);
        await host.eval("hideInterstitial(); answerInput.value='まちがい'; submitAnswer()");
        await host.waitFor("State.screen==='s3' && !interstitial.hidden", 5000);
        check(true, '2人目の前にも合図が出る');
        await host.eval(`hideInterstitial(); answerInput.value=${JSON.stringify(d.name)}; submitAnswer()`);
      } else {
        await host.scribble('#drawCanvas'); await host.eval("finishDrawing()");
        await host.waitFor("State.screen==='s3'", 5000);
        await guest.waitFor("State.screen==='s3'", 10000);
        // 子が先に答え、親の端末の1人があとから
        await guest.eval(`answerInput.value=${JSON.stringify(d.name)}; btnAnswerNext.click()`);
        await sleep(800);
        check(await host.eval("State.screen==='s3' && !$id('s3').classList.contains('is-waiting')"), `${r + 1}問目（${d.drawer}）：子が先に答えても、親の端末の解答は続けられる`);
        await host.eval("if(!interstitial.hidden) hideInterstitial(); answerInput.value='しらない'; submitAnswer()");
      }
      await host.waitFor("State.screen==='s4'", 10000);
      const rows = await host.eval("State.answers.map(a=>playerName(a.playerId)+':'+a.correct)");
      const order = await host.eval("State.answerers.map(playerName)");
      check(JSON.stringify(rows.map(x => x.split(':')[0])) === JSON.stringify(order), `正解発表の並びが解答者の順（${rows.join(', ')}）`);
      await guest.waitFor("State.screen==='s4' && revealResults.children.length===2", 8000);
      await host.eval("nextRound()");
    }
    await host.waitFor("State.screen==='s5'", 5000);
    await guest.waitFor("State.screen==='s5' && rankTotal.children.length===3", 8000);
    check(true, '3人の結果発表が子にも出た');
    console.log('     ' + (await host.eval("rankTotal.innerText")).replace(/\n/g, ' '));
    const errs = host.logs.concat(guest.logs).filter((l) => /EXC|error/i.test(l)); if (errs.length) console.log(errs.join('\n'));
  } catch (e) { console.error('FAILED', e.message); fails++; } finally { proc.kill(); }
  console.log(fails ? fails + ' 件 NG' : 'すべて OK'); process.exit(fails ? 1 : 0);
})();
