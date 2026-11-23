# デモ動画（`demos/`）

SNS 発信と後からの編集に使う、**バージョンごとのプレイ映像素材**です。PR を `main` にマージするたびに、そのマージコミットのコードで全シーンを撮り直し、リポジトリに残します。

- `demos/<date>-<short-sha>/720p/` … 1バージョンぶんの素材（クリップ・スチル・コンタクトシート・リール）
- `demos/index.json` … 全バージョンの一覧（撮影日・コミット・PR・尺・ファイルサイズ）
- `demos/.raw/` … 録画直後の一時ファイル（git 管理外）

ディレクトリ名はマージコミットから決まります（例: `2026-11-24-2ffeaec` = 2026-11-24 にマージされた `2ffeaec`）。PR 番号は `clips.json` と `index.json` に記録します。

## PR をマージしたらやること

マージ直後に、**マージコミットをチェックアウトした状態で**次を実行します。

```bash
git switch main && git pull                       # マージコミットを取り込む
npm install                                       # 初回のみ
npm run dev &                                     # :5173 で起動しておく（撮影は dev サーバー必須）

node scripts/demo/version.mjs --pr 8 --sha $(git rev-parse --short=7 HEAD) --label "変更点をひとことで"
```

`version.mjs` は次をまとめて行います。

1. `HEAD` が指定 `--sha` と一致するか確認（別バージョンの映像が混ざるのを防ぐ）
2. そのマージがゲーム本体を変えたか確認。`demos/` と `scripts/demo/` しか触っていなければ**撮影せずに終了**する
3. 全シーンを録画 → 720p / 30fps / H.264 に正規化（`scripts/demo/capture.mjs`）
4. コンタクトシートと通しリールを生成（`scripts/demo/render.mjs`）
5. `demos/index.json` にバージョン情報を追記

### 撮影をスキップする条件

**ゲームの絵に効くファイルが変わっていないマージは撮りません。** 映像はコードの写像なので、`demos/`・`scripts/demo/`・README しか変わっていないマージを撮っても、前のバージョンと同一の絵ができるだけです。これを機械的に繰り返すと「撮影PRをマージ → その動画を撮るPRをマージ → …」が終わりません。

判定は許可リスト方式で、次のいずれかが変わったときだけ撮影します。

```
src/  public/  index.html  vite.config.ts  package.json  package-lock.json
```

それ以外（ドキュメント、テスト、撮影スクリプト、`demos/`）だけのマージはスキップします。撮り直したい場合は `--force` を付けます。

最後に素材をコミットします。

```bash
git add demos/index.json demos/<date>-<short-sha>
git commit -m "Capture demo footage for <date>-<short-sha>"
git push origin main
```

> マージコミットで撮る理由: 映像はリリース済みのコードと 1 対 1 で対応させます。後から「この動画はどのバージョンか」を `index.json` の `sha` で必ず辿れるようにしています。
>
> 撮影は `main` への直接コミットで構いません（ゲーム本体のコードには触れず、`demos/` と `index.json` だけを追加するため）。

## シーン一覧

`scripts/demo/scenes.mjs` が唯一の定義です。カメラ・尺・密度・スクリプトをシーンごとに変えてあるので、1本のプロモではなく**編集前提の素材**として使えます。

| ID | 内容 | アングル |
| --- | --- | --- |
| `01-menu` | タイトル → モード選択 → 初期ボーナス | 全景 |
| `02-combat` | 基本戦闘（残響・手動照準・ダッシュ） | 全景 |
| `03-rail` | 貫通レール（中心撃破 / 周辺大ダメージ） | 全景・固定レーン |
| `04-boss` | ボス戦 KAIROS | プッシュイン |
| `05-draft` | レベルアップ抽選 → 選択 | 全景 |
| `06-punch-echo` | 残響召喚 | 寄り |
| `07-overdrive` | ZERO FIELD | プッシュイン |
| `08-bastion` | BASTION 全方位射撃 | プッシュイン |
| `09-letterbox` | シネマティック比率（HUDなし） | 2.39:1 クロップ |
| `10-vertical` | 縦型（Reels / Shorts） | 9:16 |
| `11-boss-chorus` | NEXUS 弾幕 | 寄り |
| `12-final` | 最終ボス AION（WARDEN） | シネマティック |
| `13-tank` | 装甲タンクの破壊 | 寄り |
| `14-cards` | カード選択アップ | 全景 |

同じシーンを別アングルで撮りたい場合は `scenes.mjs` に 1 行足すだけで、次のマージからは自動的に含まれます。1 シーンだけ撮り直すときは:

```bash
node scripts/demo/capture.mjs --version <tag> --resolution 720p --only 03-rail
node scripts/demo/render.mjs  --version <tag> --resolution 720p
```

## 出力

`demos/<tag>/720p/` の中身:

| ファイル | 用途 |
| --- | --- |
| `NN-name.mp4` | シーンごとのクリップ（720p / 30fps / H.264 / 無音） |
| `NN-name.jpg` | 同シーンのスチル（SNS のサムネ・記事のアイキャッチ） |
| `reel.mp4` | 全クリップを通しで並べたリール（2分弱） |
| `contact-sheet.jpg` | 全シーンの一覧（4列。編集時の絵コンテ代わり） |
| `clips.json` | シーン・尺・カメラ・コミットのマニフェスト |

音声は入れていません。撮影時はゲーム音を切り、編集で BGM と効果音を載せる前提です（`scripts/make-promo-audio.py` の素材が使えます）。

## 仕組み

- **撮影** (`scripts/demo/lib.mjs`) … Playwright で実ブラウザを起動し、`window.__ECHO__` の rAF を止めて **1/60 秒固定ステップ**で進めます。シード固定なので同じシーンは何度撮っても同じ展開になります。
- **ペーシング** … シミュレーションは実時間に合わせて進めます。録画は実時間で走るため、速く回すと早送り映像になり尺も足りなくなります。
- **オートパイロット** … 「忙しく動くが死なない」パイロットが、敵・弾を避けながら照準を合わせ、残響・スキル・ダッシュ・ZERO を実戦と同じ条件で使います。`draft` は最後まで画面を出してから選び、`rail` は 1.6 秒周期で発射します。
- **カメラ** … `full` / `push`（1.35x）/ `punch`（2x）/ `letter`（HUD なし + 2.39:1）/ `vertical`（9:16）。ズームは実解像度のまま CSS で寄せ、追従は自機基準です。
- **正規化** … 録画の生 WebM は尺も fps もばらつくため、必ず 720p / 30fps / CRF 26 / `yuv420p` / `setsar=1` に揃えます。編集ソフトで並べてもコーデック差でつまずきません。

ffmpeg は `scripts/demo/node_modules/ffmpeg` を使います。無い場合は `scripts/demo/fetch-ffmpeg.mjs` で取得してください（`imageio-ffmpeg` の静的バイナリを配置するだけです）。

## 容量の方針

1 バージョンあたり約 **18 MB**（14 クリップ + スチル + リール）。リポジトリを軽く保つため、次の方針にしています。

- 配信は **720p**（1080p 原版は必要なときだけ `--resolution 1080p` で別途）
- クリップは CRF 26（1080p CRF 23 と見比べて遜色ないことを確認済み）
- リールは派生ファイル。容量が厳しくなったら `reel.mp4` から間引く（クリップは残す）

## 過去のバージョン

`demos/index.json` が正です。`promo/echo-abyss-short.mp4`（初期の完成プロモ）はこの仕組み以前の成果物として残しています。
