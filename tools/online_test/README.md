# オンラインプレイの自動テスト

親（`http://localhost:8000/`）と子（`http://127.0.0.1:8000/`）を、同じ Chrome の別オリジンで開いて
PeerJS の公開ブローカー経由で実際につなぎ、通しで遊ばせる。オリジンが別なので localStorage も別になり、
「別々の端末」と同じ条件になる。Chrome は DevTools Protocol（CDP）で操作する（Node 22 以降の組み込み WebSocket を使用）。

```sh
cd ~/Documents/GitHub/dex-drawing-quiz
python3 -m http.server 8000 &          # 先にサーバーを立てる
node tools/online_test/test_online.js  # 対戦2問・図鑑テキストを送っていないか・切断→無回答・入り直し・部屋を閉じる
node tools/online_test/test_online2.js # 親の再読み込み・時間切れ（絵の自動送信／無回答）・画面のスクリーンショット
node tools/online_test/test_mixed.js   # 親の端末に2人＋子1人の対戦
node tools/online_test/test_local.js   # オンラインを使わない遊び方が壊れていないか
```

- 1本 1〜3 分かかる。スクリーンショットは一時フォルダの `dexq-shots/` に出る。
- 裏側のタブは CSS アニメーションが止まるので、スクショで画面が薄く写ることがある（実機では起きない）。
- 公開ブローカーに実際につなぐので、ネット接続が要る。
