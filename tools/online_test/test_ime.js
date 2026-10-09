// 部屋コード欄で、日本語入力の「変換中 → 確定」をまねて、二重入力にならないか確かめる
const { launch, newPage, sleep } = require('./cdp');
const path = require('path');
(async () => {
  const proc = await launch(path.join(require('os').tmpdir(), 'dexq-prof8'));
  let ok = true;
  try {
    const p = await newPage('ime', 'http://localhost:8000/');
    await p.waitFor("document.getElementById('bootOverlay').classList.contains('is-done') && typeof Online !== 'undefined'", 40000);
    await p.eval("$id('onlinePanel').open = true; $id('onlineCode').value=''; $id('onlineCode').focus()");
    // iPad の日本語キーボード（英字モード以外）で a → b → c と打ち、確定する流れ
    for (const t of ['a', 'ab', 'abc']) {
      await p.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length });
      await sleep(80);
    }
    await p.send('Input.insertText', { text: 'abc' });
    await sleep(200);
    const v1 = await p.eval("$id('onlineCode').value");
    // 続けて d e f
    for (const t of ['d', 'de', 'def']) {
      await p.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length });
      await sleep(80);
    }
    await p.send('Input.insertText', { text: 'def' });
    await sleep(200);
    const v2 = await p.eval("$id('onlineCode').value");
    console.log('after abc:', JSON.stringify(v1), ' after def:', JSON.stringify(v2));
    ok = v1 === 'ABC' && v2 === 'ABCDEF';
    // 名前欄（日本語）も確かめる
    await p.eval("$id('onlineName').value=''; $id('onlineName').focus()");
    for (const t of ['た', 'たろ', 'たろう']) {
      await p.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length });
      await sleep(80);
    }
    await p.send('Input.insertText', { text: '太郎' });
    await sleep(200);
    const v3 = await p.eval("$id('onlineName').value");
    console.log('name:', JSON.stringify(v3));
    ok = ok && v3 === '太郎';
    // 全角の英数字で確定した場合は半角に直す。かなは消して知らせる
    await p.eval("$id('onlineCode').value=''; $id('onlineCode').focus(); $id('onlineStatus').textContent=''");
    for (const t of ['ａ', 'ａ１']) {
      await p.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length });
      await sleep(80);
    }
    await p.send('Input.insertText', { text: 'ａ１' });
    await sleep(100);
    for (const t of ['k', 'か']) {
      await p.send('Input.imeSetComposition', { text: t, selectionStart: t.length, selectionEnd: t.length });
      await sleep(80);
    }
    await p.send('Input.insertText', { text: 'か' });
    await sleep(200);
    const v4 = await p.eval("$id('onlineCode').value");
    const st = await p.eval("$id('onlineStatus').textContent");
    console.log('fullwidth+kana:', JSON.stringify(v4), '/', st);
    ok = ok && v4 === 'A1' && /英字/.test(st);
  } finally { proc.kill(); }
  console.log(ok ? 'OK' : 'NG');
  process.exit(ok ? 0 : 1);
})();
