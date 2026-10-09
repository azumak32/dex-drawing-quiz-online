// 時間制限あり（子が時間切れ）・親の再読み込み・画面の見た目
const { launch, newPage, sleep } = require('./cdp');
const path = require('path');
const fs = require('fs');

const OUT = path.join(require('os').tmpdir(), 'dexq-shots');
fs.mkdirSync(OUT, { recursive: true });
let fails = 0;
function check(cond, msg) { console.log((cond ? '  OK  ' : '  NG  ') + msg); if (!cond) fails++; }
const booted = "document.getElementById('bootOverlay').classList.contains('is-done') && typeof Online !== 'undefined'";

async function shot(page, name) {
  const r = await page.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true });
  fs.writeFileSync(path.join(OUT, name + '.png'), Buffer.from(r.result.data, 'base64'));
}

(async () => {
  const proc = await launch(path.join(require('os').tmpdir(), 'dexq-prof2'));
  try {
    const host = await newPage('host', 'http://localhost:8000/');
    const guest = await newPage('guest', 'http://127.0.0.1:8000/');
    global.H = host; global.G = guest;
    for (const p of [host, guest]) await p.send('Emulation.setDeviceMetricsOverride', { width: 820, height: 1180, deviceScaleFactor: 1, mobile: false });
    await host.waitFor(booted, 40000); await guest.waitFor(booted, 40000);

    await host.eval("State.players=[makePlayer('おや'),makePlayer('')]; renderPlayers(); State.settings.mode='vs'; renderMode(); $id('onlinePanel').open=true; Online._host();");
    const room = await host.waitFor("Online.isHost() && Online._debug().room", 20000);
    await guest.eval(`$id('onlinePanel').open=true; $id('onlineName').value='こども'; $id('onlineCode').value=${JSON.stringify(room.toLowerCase())}; $id('btnOnlineJoin').click();`);
    await guest.waitFor("Online.isGuest() && State.screen==='s9'", 20000);
    check(true, '小文字で打った部屋コードでも参加できた（ボタン操作）');
    await sleep(500);
    await host.eval("document.getElementById('onlinePanel').scrollIntoView()");
    await shot(host, '1_host_s1'); await shot(guest, '2_guest_lobby');

    // --- 親の再読み込み：同じ部屋コードで開き直し、子が自動でつなぎ直す ---
    await host.send('Page.reload');
    await host.waitFor(booted, 40000);
    const room2 = await host.waitFor("Online.isHost() && Online._debug().room", 40000, 'host re-open room');
    check(room2 === room, `親が再読み込みしても同じ部屋コードで開き直した（${room2}）`);
    await host.waitFor("State.players.some(p => p.online && Online.isConnected(p.id))", 40000, 'guest auto reconnect');
    check(true, '子が自動でつなぎ直した');

    // --- 時間制限あり：子が出題者で、描いたまま時間切れ → 絵が自動で届く ---
    await host.eval("State.settings.timer=true; State.settings.drawSec=6; State.settings.answerSec=6; renderTimer(); State.order=[]; startGame(false)");
    await host.waitFor("State.screen==='s2'", 10000);
    if (!(await host.eval("isOnlinePlayer(State.order[State.round])"))) {
      // 親が先なら、親の回は描いて親以外（子）が時間切れで無回答になるのを見る
      await host.eval("if (!$id('interstitial').hidden) hideInterstitial()");
      await sleep(300);
      await host.scribble('#drawCanvas'); await host.eval("finishDrawing()");
      await guest.waitFor("State.screen==='s3'", 10000);
      await sleep(800);
      await shot(guest, '3_guest_answer'); await shot(host, '4_host_waiting');
      await host.waitFor("State.screen==='s4'", 20000, 'answer timeout → reveal');
      check(await host.eval("State.answers.length===1 && State.answers[0].text===''"), '子が時間切れ → 無回答で正解発表へ');
      await host.eval("nextRound()");
      await host.waitFor("State.screen==='s2'", 10000);
    }
    await guest.waitFor("State.screen==='s2' && flavorText.textContent.length>0", 10000);
    await guest.scribble('#drawCanvas');
    await sleep(500);
    await shot(guest, '5_guest_draw'); await shot(host, '6_host_remote_draw');
    // 押さずに時間切れを待つ
    await host.waitFor("State.screen==='s3' || State.screen==='s4'", 20000, 'drawing arrives on timeout');
    check(await host.eval("!!State.drawing"), '子の絵が時間切れで自動的に届いた');
    await host.eval("if (!$id('interstitial').hidden) hideInterstitial(); answerInput.value='ぴかちゅう'; submitAnswer();");
    await host.waitFor("State.screen==='s4'", 10000);
    await guest.waitFor("State.screen==='s4'", 10000);
    await sleep(800);
    await shot(guest, '7_guest_reveal');
    await host.eval("nextRound()");
    // 親の番が残っていれば描いて進める（子は時間切れで無回答）
    for (let i = 0; i < 2; i++) {
      await host.waitFor("State.screen==='s2' || State.screen==='s5'", 10000);
      if (await host.eval("State.screen==='s5'")) break;
      await host.eval("if (!$id('interstitial').hidden) hideInterstitial()");
      await sleep(300);
      await host.scribble('#drawCanvas'); await host.eval("finishDrawing()");
      await guest.waitFor("State.screen==='s3'", 10000);
      await sleep(800);
      await shot(guest, '3_guest_answer'); await shot(host, '4_host_waiting');
      await host.waitFor("State.screen==='s4'", 20000, 'answer timeout → reveal');
      check(await host.eval("State.answers.length===1 && State.answers[0].text===''"), '子が時間切れ → 無回答で正解発表へ');
      await host.eval("nextRound()");
    }
    await guest.waitFor("State.screen==='s5'", 10000);
    await sleep(500);
    await shot(guest, '8_guest_result');

    console.log('\n[guest netlog]\n' + await guest.eval("Online._summary()"));
    console.log(await guest.eval("JSON.parse(localStorage.getItem('pq:netlog')).events.map(e=>e.kind+' '+(e.route||'')+' '+(e.stage||e.why||'')).join(' | ')"));
    const errs = host.logs.concat(guest.logs).filter((l) => /EXC|error/i.test(l));
    if (errs.length) console.log('\nconsole errors:\n' + errs.join('\n'));
  } catch (e) {
    console.error('FAILED:', e.message);
    try {
      for (const p of [global.H, global.G]) {
        console.log(p.name, JSON.stringify(await p.eval("({screen: State.screen, round: State.round, order: State.order.length, players: State.players.map(p=>p.name+(p.online?'*':'')), dbg: (function(){var d=Online._debug(); return {role:d.role, conns:d.conns, last: d.lastPhase && d.lastPhase.s}})()})")));
        console.log(p.logs.slice(-15).join('\n'));
      }
    } catch (e2) { console.log('dump failed', e2.message); }
    fails++;
  } finally {
    proc.kill();
  }
  console.log(fails ? `\n${fails} 件 NG` : '\nすべて OK');
  process.exit(fails ? 1 : 0);
})();
