# Discord Voice Grouper

ボイスチャンネル内にいるメンバーを読み取り、3人組を基本にして自動でグループ分けするDiscord Botです。

余りが出た場合は、余った人だけを別グループにするのではなく、既存のグループへ寄せて4人グループを作ります。
たとえば7人なら `4人 + 3人`、8人なら `4人 + 4人`、11人なら `4人 + 4人 + 3人` になります。

## できること

- `/splitvc` でボイスチャンネル内のメンバーを取得します。
- コマンド実行者が入っているボイスチャンネルを自動で対象にできます。
- オプションで任意のボイスチャンネルを指定できます。
- ランダム分けと、表示名順での固定分けを切り替えられます。
- Botを対象に含めるかどうかを選べます。
- 結果をチャンネル全体に出すか、自分だけに表示するかを選べます。
- 参加者ロールを対象メンバーへ付与できます。
- PBの親VCへ代表者を移動し、PBが作成した子VCへ同じグループの残りメンバーを移動できます。
- 25分後に参加者ロールへメンションして終了通知を送信できます。
- 終了通知の3分後に参加者ロールを解除できます。
- 転送前待機、終了通知前待機、通知後ロール解除待機をコマンドで変更できます。
- PBが作成した子VCがすべて削除されたら、終了通知を自動キャンセルして参加者ロールを解除できます。
- DISBOARDの `/bump` 成功メッセージを検知し、2時間後に実行者へリマインドできます。

## グループ分けのルール

基本は3人ずつです。

| 人数 | 分け方 |
| ---: | --- |
| 3 | 3 |
| 4 | 4 |
| 5 | 3 + 2 |
| 6 | 3 + 3 |
| 7 | 4 + 3 |
| 8 | 4 + 4 |
| 9 | 3 + 3 + 3 |
| 10 | 4 + 3 + 3 |
| 11 | 4 + 4 + 3 |
| 12 | 3 + 3 + 3 + 3 |

計算の考え方:

- 3で割り切れる人数は、すべて3人グループにします。
- 余りが1人なら、1つの3人グループに1人足して4人グループにします。
- 余りが2人なら、2つの3人グループに1人ずつ足して4人グループにします。
- 5人だけは3人・4人のみでは作れないため、`3人 + 2人` として表示します。
- 1人または2人の場合は、そのまま小さなグループとして表示します。

想定人数は30人前後ですが、30人を超えていても処理自体は行います。

## 必要なもの

- Node.js `22.12.0` 以上
- DiscordのBot Token
- Discord Application Client ID
- Botを招待できるDiscordサーバーの管理権限

このBotはスラッシュコマンドで動くため、通常のメッセージ本文を読む必要はありません。
そのため、Message Content Intentは不要です。

## ファイル構成

```text
discord-voice-grouper/
├─ .env.example
├─ package.json
├─ README.md
└─ src/
   ├─ bot.js
   ├─ bump-reminder-store.js
   ├─ commands.js
   ├─ grouping.js
   ├─ settings-store.js
   └─ register-commands.js
```

主な役割:

- `src/bot.js`: Bot本体です。Discordに接続し、`/splitvc` を処理します。
- `src/bump-reminder-store.js`: DISBOARD bumpリマインドの予約を保存します。
- `src/commands.js`: スラッシュコマンドの定義です。
- `src/grouping.js`: 3人組・4人組に分ける計算ロジックです。
- `src/settings-store.js`: `/setting` で保存したPB連携設定を読み書きします。
- `src/register-commands.js`: Discordへスラッシュコマンドを登録します。
- `.env.example`: `.env` を作るための見本です。

## 1. Discord側でアプリを作る

1. Discord Developer Portalを開きます。
2. `New Application` で新しいアプリを作ります。
3. 左メニューの `Bot` からBotを追加します。
4. `Token` を作成またはリセットして、Bot Tokenを控えます。
5. 左メニューの `OAuth2` で `Client ID` を控えます。

Bot Tokenはパスワードのようなものです。
`.env` 以外の場所に書いたり、GitHubなどへ公開したりしないでください。

## 2. Botをサーバーへ招待する

Discord Developer Portalの `OAuth2` からURLを作ります。

Scopes:

- `bot`
- `applications.commands`

Bot Permissions:

- `View Channels`
- `Send Messages`
- `Connect`
- `Move Members`
- `Manage Roles`

生成されたURLをブラウザで開き、Botを使いたいサーバーへ招待します。

補足:

- `/splitvc` の結果を投稿するため、テキスト送信権限が必要です。
- ボイスチャンネル内のメンバーを見るため、対象チャンネルを閲覧できる必要があります。
- チャンネルごとの権限でBotが見えないVCは対象にできません。
- メンバーをPB親VCや子VCへ移動するため、Move Members権限が必要です。
- 参加者ロールを付与・解除するため、Manage Roles権限が必要です。
- 参加者ロールはBotの最上位ロールより下に置いてください。
- DISBOARD bumpリマインドのため、DISBOARDがbump成功メッセージを投稿するチャンネルをBotが閲覧できる必要があります。

## 3. `.env` を作る

このフォルダで `.env.example` を `.env` にコピーします。

```powershell
copy .env.example .env
```

`.env` の中身を編集します。

```env
DISCORD_TOKEN=your_bot_token_here
DISCORD_CLIENT_ID=your_application_client_id_here
# DISBOARD_BOT_ID=302050872383242240
# DISCORD_GUILD_ID=123456789012345678
# PB_PARTICIPANT_ROLE_ID=123456789012345678
# PB_PARENT_CHANNEL_ID=123456789012345678
# PB_CHILD_CATEGORY_ID=123456789012345678
# PB_FINISH_MESSAGE=終了時間です。
# PB_TRANSFER_WAIT_SECONDS=30
# PB_NOTICE_WAIT_MINUTES=25
# PB_ROLE_REMOVE_WAIT_MINUTES=3
```

環境変数:

| 名前 | 必須 | 説明 |
| --- | --- | --- |
| `DISCORD_TOKEN` | 必須 | Discord Developer Portalで取得したBot Tokenです。 |
| `DISCORD_CLIENT_ID` | 必須 | アプリのClient IDです。 |
| `DISBOARD_BOT_ID` | 任意 | DISBOARD BotのIDです。未設定時は公開DISBOARD Bot IDを使います。 |
| `DISCORD_GUILD_ID` | 任意 | テスト用サーバーのIDです。指定すると、そのサーバーだけにコマンドを登録します。 |
| `PB_PARTICIPANT_ROLE_ID` | 任意 | Renderなどで固定設定したい場合の参加者ロールIDです。 |
| `PB_PARENT_CHANNEL_ID` | 任意 | Renderなどで固定設定したい場合のPB親VCのIDです。 |
| `PB_CHILD_CATEGORY_ID` | 任意 | PBが子VCを作るカテゴリIDです。未設定でも自動検出します。 |
| `PB_FINISH_MESSAGE` | 任意 | 終了通知の文面です。 |
| `PB_TRANSFER_WAIT_SECONDS` | 任意 | 転送開始までの待機秒数です。未設定時は30秒です。 |
| `PB_NOTICE_WAIT_MINUTES` | 任意 | 終了通知までの待機分数です。未設定時は25分です。 |
| `PB_ROLE_REMOVE_WAIT_MINUTES` | 任意 | 終了通知後のロール解除待機分数です。未設定時は3分です。 |

テスト中は `DISCORD_GUILD_ID` を入れるのがおすすめです。
サーバー単位のコマンド登録は反映が速く、動作確認がしやすいです。

サーバーIDの取り方:

1. Discordのユーザー設定を開きます。
2. `詳細設定` で `開発者モード` をオンにします。
3. 対象サーバーを右クリックします。
4. `サーバーIDをコピー` を選びます。
5. `.env` の `DISCORD_GUILD_ID` に、コピーした数字だけを入れます。

グローバルコマンドとして全サーバーに登録したい場合は、`DISCORD_GUILD_ID` の行を空にするか削除します。
グローバル登録は反映まで時間がかかることがあります。

## 4. 依存関係を入れる

```powershell
npm install
```

## 5. スラッシュコマンドを登録する

```powershell
npm run register
```

成功すると、Discord側に `/splitvc` が登録されます。

`.env` に `DISCORD_GUILD_ID` がある場合は、そのサーバーだけに登録されます。
ない場合はグローバルコマンドとして登録されます。

## 6. Botを起動する

```powershell
npm start
```

起動に成功すると、ターミナルにログインしたBot名が表示されます。
この状態でDiscordから `/splitvc` を実行できます。

開発中にファイル変更を見ながら起動したい場合は、次のコマンドも使えます。

```powershell
npm run dev
```

## Google Apps Scriptで定期アクセスする

Google Apps Scriptだけで、このDiscord Bot本体を常時起動することはできません。
Discord BotはDiscord Gatewayへ常時接続し、Heartbeatを送り続ける必要があります。
Apps Scriptは定期実行には向いていますが、常時接続のNode.jsプロセスを動かし続ける場所ではありません。

そのため、GASを使う場合は次の構成にします。

```text
Discord
  ↑ 常時接続
Bot本体: Render / Railway / VPS / 自宅サーバーなど
  ↑ 定期アクセス
Google Apps Script
```

GASの役割は、外部で動いているBotの公開URLに定期アクセスすることです。
Bot本体は別のホスティング先で起動しておく必要があります。

### 1. Bot側の確認URL

このBotには、ホスティングや定期アクセス用に簡単な確認URLがあります。

```text
GET /
GET /health
```

ホスティング先が `PORT` 環境変数を渡す場合は、そのポートで自動的に待ち受けます。
ローカルで確認したい場合は `.env` に次を追加します。

```env
KEEP_ALIVE_PORT=3000
```

その状態でBotを起動します。

```powershell
npm start
```

ブラウザで次を開いて、JSONが返れば確認URLは動いています。

```text
http://localhost:3000/health
```

実際にGASから叩くには、`localhost` ではなくホスティング先の公開URLが必要です。

```text
https://example-your-bot-host.example.com/health
```

### 2. Apps Scriptを作る

1. Google Apps Scriptを開きます。
2. 新しいプロジェクトを作ります。
3. `コード.gs` に次のコードを貼ります。
4. `BOT_HEALTH_URL` を自分のBotの公開URLに変えます。

```javascript
const BOT_HEALTH_URL = "https://example-your-bot-host.example.com/health";

function pingDiscordBot() {
  const response = UrlFetchApp.fetch(BOT_HEALTH_URL, {
    method: "get",
    muteHttpExceptions: true,
  });

  console.log(
    `${new Date().toISOString()} ${response.getResponseCode()} ${response.getContentText()}`,
  );
}

function createKeepAliveTrigger() {
  ScriptApp.newTrigger("pingDiscordBot")
    .timeBased()
    .everyMinutes(5)
    .create();
}

function deleteKeepAliveTriggers() {
  for (const trigger of ScriptApp.getProjectTriggers()) {
    if (trigger.getHandlerFunction() === "pingDiscordBot") {
      ScriptApp.deleteTrigger(trigger);
    }
  }
}
```

### 3. 初回実行と権限許可

1. Apps Script上部の関数選択で `pingDiscordBot` を選びます。
2. 実行します。
3. 権限確認が出たら許可します。
4. 実行ログに `200` が出れば、Botの確認URLにアクセスできています。

次に、関数選択で `createKeepAliveTrigger` を選び、1回だけ実行します。
これで5分ごとに `pingDiscordBot` が実行されます。

止めたい場合は `deleteKeepAliveTriggers` を1回実行します。

### 注意点

- GASはBot本体を起動する場所ではありません。Bot本体は別途ホスティングしてください。
- GASから `localhost` や自分のPC内のURLにはアクセスできません。公開URLが必要です。
- ホスティングサービスによっては、定期アクセスでスリープ回避する使い方が規約上制限される場合があります。
- Apps Scriptには実行時間やURL Fetchの利用回数などの上限があります。
- もしBotを確実に常時起動したいなら、VPS、Cloud Run、Railway、Fly.ioなど、常時起動に対応した環境を使う方が安定します。

## GitHub経由でRenderにデプロイする

Renderへ置く場合は、`Web Service` として作成します。
`Background Worker` でもBot自体は起動できますが、公開URLが出ないためGASから `/health` を叩く用途には向きません。

### 1. GitHubにリポジトリを作る

GitHubで新しいリポジトリを作成します。

公開リポジトリでも非公開リポジトリでも構いません。
ただし、`.env` は絶対にGitHubへ入れないでください。
このプロジェクトでは `.gitignore` で `.env` を除外しています。

### 2. コードをGitHubへpushする

`discord-voice-grouper` フォルダだけをリポジトリにする場合は、このフォルダで次を実行します。

```powershell
git init
git add .
git commit -m "Add Discord voice grouper bot"
git branch -M main
git remote add origin https://github.com/あなたのユーザー名/あなたのリポジトリ名.git
git push -u origin main
```

親フォルダごとリポジトリにする場合は、Render側でRoot Directoryに次を指定してください。

```text
discord-voice-grouper
```

### 3. RenderでWeb Serviceを作る

1. Render Dashboardを開きます。
2. `New` から `Web Service` を選びます。
3. GitHubアカウントを連携します。
4. このBotをpushしたリポジトリを選びます。
5. Branchは通常 `main` を選びます。

設定値:

| 項目 | 値 |
| --- | --- |
| Service Type | `Web Service` |
| Runtime / Language | `Node` |
| Root Directory | リポジトリ直下がBotなら空欄。親フォルダごとpushしたなら `discord-voice-grouper` |
| Build Command | `npm install` |
| Start Command | `npm start` |
| Health Check Path | `/health` |

### 4. Renderに環境変数を入れる

RenderのEnvironment Variablesに次を登録します。

| 名前 | 値 |
| --- | --- |
| `DISCORD_TOKEN` | Discord Developer Portalで取得したBot Token |
| `DISCORD_CLIENT_ID` | Discord ApplicationのClient ID |
| `DISBOARD_BOT_ID` | 任意。通常は未設定でOK |
| `DISCORD_GUILD_ID` | テスト用サーバーだけに登録したい場合のみ設定 |

Renderでは `.env` ファイルを使わず、画面上のEnvironment Variablesへ入れます。
`DISCORD_TOKEN` はGitHubへ書かないでください。

`PORT` はRenderが自動で渡すため、自分で設定しなくて大丈夫です。
このBotは `PORT` がある場合、そのポートで `/health` を公開します。

Renderのログに `DISCORD_TOKEN is required.` と出る場合は、Environment Variablesに `DISCORD_TOKEN` が入っていません。
ログに `No package.json found` や `ENOENT` が出る場合は、Root Directoryの指定がずれている可能性が高いです。
ログに `Cannot find module` が出る場合は、Build Commandが `npm install` になっているか確認してください。

Renderでは `/setting` で保存したファイルが再デプロイや再起動で消える場合があります。
確実に残したい設定は、RenderのEnvironment Variablesに `PB_PARTICIPANT_ROLE_ID`、`PB_PARENT_CHANNEL_ID`、`PB_CHILD_CATEGORY_ID`、`PB_FINISH_MESSAGE`、`PB_TRANSFER_WAIT_SECONDS`、`PB_NOTICE_WAIT_MINUTES`、`PB_ROLE_REMOVE_WAIT_MINUTES` として入れてください。

### 5. デプロイする

設定が終わったら `Create Web Service` を押します。
ビルドと起動が成功すると、Render上に公開URLが表示されます。

例:

```text
https://discord-voice-grouper.onrender.com
```

確認URLは、公開URLの末尾に `/health` を付けたものです。

```text
https://discord-voice-grouper.onrender.com/health
```

ブラウザで開いて次のようなJSONが出れば成功です。

```json
{
  "ok": true,
  "ready": true,
  "bot": "Bot名#0000",
  "uptimeSeconds": 123,
  "startedAt": "2026-05-21T00:00:00.000Z"
}
```

### 6. スラッシュコマンドを登録する

スラッシュコマンド登録は、手元のPCから実行しても大丈夫です。

```powershell
npm run register
```

登録に成功したら、Discordで `/splitvc` が使えるようになります。

もしRender上で登録したい場合は、RenderのShellや一時的なコマンド実行機能が使える環境で次を実行します。

```bash
npm run register
```

ただし、通常は手元PCで1回登録する方が簡単です。

### 7. GitHubへpushした後の更新

Renderは、指定したブランチにpushされた変更を自動で再デプロイできます。

```powershell
git add .
git commit -m "Update bot"
git push
```

push後、RenderのEventsやLogsでデプロイ状況を確認してください。

## コマンド仕様

### `/setting`

PB連携に使う参加者ロール、PB親VC、子VCカテゴリ、終了通知文を設定します。

```text
/setting set participant_role:@参加者ロール parent_channel:PB親VC child_category:PB子VCカテゴリ finish_message:終了時間です。 transfer_wait_seconds:30 notice_wait_minutes:25 role_remove_wait_minutes:3
```

現在の設定を見る場合:

```text
/setting show
```

`child_category` は任意です。
設定すると、PBが作った子VCをそのカテゴリ内だけから探します。
未設定の場合は、代表者がPB親VCから別のVCへ移動したことを見て自動検出します。

`/setting set` を使うにはサーバー管理権限が必要です。

待機時間オプション:

| オプション | 単位 | 省略時 | 説明 |
| --- | --- | --- | --- |
| `transfer_wait_seconds` | 秒 | 30 | 振り分け後、VC転送を始めるまでの待機時間です。 |
| `notice_wait_minutes` | 分 | 25 | 終了通知を送るまでの待機時間です。 |
| `role_remove_wait_minutes` | 分 | 3 | 終了通知を送った後、参加者ロールを解除するまでの待機時間です。 |

いずれも `0` を指定できます。
`0` の場合、その待機は行わずすぐ次の処理へ進みます。

### `/splitvc`

```text
/splitvc
```

オプション:

| オプション | 型 | 省略時 | 説明 |
| --- | --- | --- | --- |
| `channel` | ボイスチャンネル | 実行者が入っているVC | 対象のボイスチャンネルを指定します。 |
| `shuffle` | 真偽値 | `true` | ランダムに並べ替えてから分けます。 |
| `include_bots` | 真偽値 | `false` | Botユーザーもグループ分けに含めます。 |
| `private` | 真偽値 | `false` | 結果を自分だけに表示します。 |

使い方の例:

- 自分が入っているVCをランダムに分ける: `/splitvc`
- 指定したVCを分ける: `/splitvc channel:一般`
- 表示名順で固定分けする: `/splitvc shuffle:false`
- 結果を自分だけに表示する: `/splitvc private:true`
- Botも含めて分ける: `/splitvc include_bots:true`

PB連携設定が済んでいる場合、`/splitvc` 実行後に次の処理も行います。

1. 振り分け結果を送信します。
2. 対象メンバーへ参加者ロールを付与します。
3. 30秒待機し、待機中だけ転送キャンセルボタンを表示します。
4. 各グループから1人をPB親VCへ移動します。
5. PBが作成した子VCを検出し、同じグループの残りメンバーを移動します。
6. 25分後に参加者ロールへメンションして終了通知を送信します。
7. 終了通知の3分後に参加者ロールを解除します。

転送キャンセルボタンを押した場合、VC移動だけをキャンセルします。
終了通知の待機と参加者ロール解除は続行します。

終了通知キャンセルボタンを押した場合、終了通知をキャンセルし、その場ですぐ参加者ロールを解除します。

PBが作成した子VCをBotが検出できている場合、その子VCがすべて削除された時点でも終了通知を自動キャンセルします。
この場合も、その場ですぐ参加者ロールを解除します。

待機中の残り時間表示は `xx分xx秒` 形式で、1秒ごとに更新します。

## 結果表示

結果は次のような形で表示されます。

```text
一般 のグループ分け
8人を2グループに分けました。3人グループ: 0、4人グループ: 2。

グループ 1 (4人)
- 田中
- 佐藤
- 鈴木
- 高橋

グループ 2 (4人)
- 伊藤
- 渡辺
- 山本
- 中村
```

メンション通知が大量に飛ばないように、結果ではメンバーIDへのメンションではなく表示名を使います。

## 権限とIntent

コードでは次のGateway Intentを使っています。

- `Guilds`
- `GuildMessages`
- `GuildVoiceStates`

Botに必要な主な権限:

- 対象サーバーでスラッシュコマンドを使えること
- 結果を投稿するチャンネルにメッセージを送れること
- 対象ボイスチャンネルを閲覧できること
- PB親VCへ接続できること
- メンバーをVC間で移動できること
- 参加者ロールを付与・解除できること

Role Hierarchyの注意:

- Botのロールは、参加者ロールより上に置いてください。
- Botのロールが参加者ロール以下だと、Discordの仕様でロール付与・解除が失敗します。

Message Content Intentは不要です。
このBotは通常メッセージを読み取らず、スラッシュコマンドの入力だけを使います。
DISBOARD bumpリマインドも、DISBOARDのメッセージ本文ではなく、Discordのコマンド実行メタ情報を見て判定します。

## DISBOARD bumpリマインド

DISBOARDの `/bump` が成功し、DISBOARD Botがメッセージを投稿したら、2時間後に同じチャンネルへリマインドを送ります。

送信内容:

```text
@実行者 前回のbumpから２時間が経過しました
```

この機能は、このBot自身のスラッシュコマンドではありません。
他Botの `/bump` 実行イベントは直接受け取れないため、DISBOARDが投稿するbump成功メッセージを監視します。

必要な条件:

- DISBOARDのbump成功メッセージが公開チャンネルに投稿されること
- このBotがそのチャンネルを見られること
- このBotがそのチャンネルへメッセージを送信できること
- Discord側のメッセージに `/bump` 実行者情報が付いていること

予約は `data/bump-reminders.json` に保存します。
Botが再起動しても、ファイルが残っていれば未送信のリマインドを復元します。
Renderの無料環境などでは再デプロイ時にファイルが消える場合があるため、その場合は再起動前の予約も消える可能性があります。

通常は設定不要ですが、DISBOARD Bot IDを明示したい場合はEnvironment Variablesに入れます。

```env
DISBOARD_BOT_ID=302050872383242240
```

## よくあるトラブル

### `/splitvc` が出てこない

- `npm run register` を実行したか確認してください。
- Bot招待時に `applications.commands` scopeを含めたか確認してください。
- `.env` の `DISCORD_CLIENT_ID` が正しいか確認してください。
- `.env` の `DISCORD_GUILD_ID` が見本のままになっていないか確認してください。使わない場合は行ごと削除するか、先頭に `#` を付けます。
- グローバル登録の場合、反映まで時間がかかることがあります。
- テスト中は `DISCORD_GUILD_ID` を設定して、サーバー単位で登録すると確認しやすいです。

### `/setting` が出てこない

- 新しいコマンドを追加した後は、もう一度 `npm run register` を実行してください。
- Renderへデプロイしただけではスラッシュコマンド定義は更新されません。

### 「対象のボイスチャンネルを指定するか...」と表示される

- `/splitvc` 実行時に `channel` を指定してください。
- または、自分がボイスチャンネルに入った状態で `/splitvc` を実行してください。

### 対象メンバーがいないと表示される

- VCに人がいるか確認してください。
- デフォルトではBotユーザーを除外します。Botだけが入っている場合は `include_bots:true` を使ってください。
- Botが対象VCを閲覧できる権限を持っているか確認してください。

### PBの子VCを検出できない

- PB親VCの設定が正しいか確認してください。
- PBが代表者を子VCへ移動するまでに時間がかかりすぎると検出に失敗します。
- `/setting set child_category:...` でPBが子VCを作るカテゴリを設定すると安定しやすくなります。
- Botに `Move Members` と `Connect` 権限があるか確認してください。
- 子VC削除による終了通知の自動キャンセルは、Botが転送時に検出できた子VCだけを対象にします。

### 参加者ロールを付与できない

- Botに `Manage Roles` 権限があるか確認してください。
- Botのロールを参加者ロールより上に置いてください。
- 管理ロールや連携サービス管理ロールはBotから付与できないことがあります。

### Botが起動しない

- `.env` に `DISCORD_TOKEN` が入っているか確認してください。
- Tokenの前後に余分な空白がないか確認してください。
- `npm install` が完了しているか確認してください。
- Node.jsのバージョンが `22.12.0` 以上か確認してください。

### 結果を全員に見せたくない

`private:true` を指定してください。

```text
/splitvc private:true
```

この場合、結果はコマンドを実行した本人だけに表示されます。

## 運用メモ

- テスト中は `DISCORD_GUILD_ID` を使うと、コマンド反映が速くて扱いやすいです。
- 複数サーバーで使う場合は、動作確認後にグローバルコマンド登録へ切り替えると便利です。
- 30人を超えても処理できますが、結果メッセージが長くなりすぎる場合はDiscord側の文字数制限に注意してください。
- 参加者名はDiscord上の表示名を使います。
- `shuffle:false` の場合は表示名順で分けます。
