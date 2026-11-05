# Webページの公開手順（GitHub Pages）

所要15分。**無料・サーバー不要**。公開するとスマホからも募集状況と振り分けが見られます。

```
① GitHubにリポジトリを作る     （3分）
② ファイルをアップロード        （5分）
③ Pagesを有効化                （2分）
④ 動作確認                     （3分）
⑤ 合言葉を合わせる              （2分）
```

---

# ① GitHubにリポジトリを作る

1. https://github.com/new を開く（アカウントが無ければ先に作成）
2. 入力する

| 項目 | 値 |
|---|---|
| Repository name | `mix`（何でもOK） |
| 公開範囲 | **Public** ← 必須。PrivateだとPagesが有料 |
| Initialize this repository | チェックしない（READMEも作らない） |

3. **Create repository**

作成後に「Quick setup」画面が出ます。ここに後でファイルを上げます。

---

# ② ファイルをアップロード

`mix-git` フォルダの中身を**全部**上げます。

1. リポジトリの画面で **`uploading an existing file`** をクリック
2. `mix-git` フォルダを開き、**中身を全選択**してドラッグ＆ドロップ

入れるファイル（6個）：

| ファイル | 役割 |
|---|---|
| `index.html` | アプリ本体。これがトップページ |
| `checklist.html` | セットアップ手順書 |
| `.nojekyll` | 空ファイル。GitHubの余計な変換を止める |
| `README.md` | 説明 |
| `SETUP.md` | 詳細手順 |
| `worker.js` / `pipeline-worker.js` / `Code.gs` | 予備（表示されなくても害はない） |

⚠️ **`.nojekyll` は隠しファイル**です。エクスプローラーで「隠しファイルを表示」をONにしないと見えません。無いままアップしても動きますが、入れておくと安全です。

3. 下の **Commit changes** を押す

---

# ③ Pagesを有効化

1. リポジトリ上部の **Settings**
2. 左メニューの **Pages**
3. **Source** を `Deploy from a branch`
4. **Branch** を `main` / フォルダは `/ (root)`
5. **Save**

**✅ 成功の見え方：** 上部に「Your site is live at https://ユーザー名.github.io/mix/」が出る。初回は**1〜2分**かかります。

---

# ④ 動作確認

```
https://ユーザー名.github.io/mix/
```

開くと3つのタブが出ます。

| タブ | できること |
|---|---|
| 募集 | Discordの✅🟡を集計して表示 |
| バランス | 振り直したいかを3票で匿名確認 |
| 振り分け | シートを読んで6v6を計算 |

### 最初にやること：プロキシURLを入れる

「振り分け」タブ → 設定 → **取得プロキシURL** に、WorkerのURLを入れて保存。

```
https://wild-bread-33c3.gantz8811.workers.dev
```

これでExperienceがWebからも取れます。**Workerを増やす必要はありません**（`/exp` を追加済み）。

---

# ⑤ 合言葉を合わせる

DiscordとWebで**同じ合言葉**を使うと、✅の人数がWebの募集タブに反映されます。

1. ⑥の `TOPIC` を確認（例: `mgo2pc-mix`）
2. ページを開くときにURLへ付ける

```
https://ユーザー名.github.io/mix/?c=mgo2pc-mix
```

`?c=` の値が `TOPIC` と同じなら繋がります。Discordに貼るURLはこれにしてください。

---

# 完成後の姿

```
Discord   ：✅🟡を押すだけ（自動で集計・通知・振り分け）
Web       ：状況確認・バランス投票・手動で振り分け
Worker    ：集計役（1分ごと）＋Experience取得プロキシ
シート    ：プレイヤー名とURLの台帳
```

---

# つまずいたとき

| 症状 | 原因 | 対処 |
|---|---|---|
| 404 | Pagesの反映待ち | 1〜2分待つ／Branchが `main` か確認 |
| 真っ白 | `.nojekyll` が無くJekyllが変換した | 空ファイル `.nojekyll` を追加 |
| シートが読めない | 共有設定 | 「リンクを知っている全員が閲覧可」 |
| Experienceが取れない | プロキシURL未設定 | ④の設定を入れる |
| 募集タブが空 | 合言葉が違う | `?c=` を `TOPIC` と一致させる |
