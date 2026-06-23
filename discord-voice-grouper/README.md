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
- 振り分け完了後、途中参加用の待機VCを自動作成して10分間監視できます。
- 待機中の参加者を、3人以下の子VCへ補充できます。
- 補充先がない場合、待機中に3人集まった時点で新規子VCへ転送できます。
- 待機VCは10分経過、または終了通知キャンセル時に自動削除されます。
- `/b` で募集メッセージを送信できます。
- `/b` 実行者がVCに入っていて名目を指定した場合、そのVC名を名目で更新します。
- VC集合フォームで、2人以上集まったVCに参加者ロールを付与し、開始時に話題フォーム付きメッセージを送れます。
- VC集合フォームと同じPB子VCカテゴリ内で、1つのVCに6人以上いる場合だけ自動振り分け提案を送れます。
- 話題フォームの内容を、送信者が参加中のVCチャンネルステータスへ `今の話題：...` として設定できます。
- 毎日朝6:00に、おすすめ話題を指定チャンネルへ3択で投稿できます。
- `/splitvc` の転送完了後、当日投稿済みのおすすめ話題を参加者ロールへメンションして再掲できます。
- `/splitvc` 後のおすすめ話題再掲先を、実行チャンネルとは別に指定できます。
- `/splitvc` 後にスタート・途中参加案内を指定チャンネルへ送り、待機VC削除時に締切済みの文面へ編集できます。
- `/addwadai`、`/showwadai`、`/delwadai` でおすすめ話題の追加・確認・削除ができます。
- `/sendwadai` で、管理者が定時外におすすめ話題を投稿できます。
- 運用ログを指定チャンネルにまとめられます。
- 話題提供、提案・要望、相談・苦情フォームを設置し、入力内容を指定チャンネルへ転送できます。
- 通話待機システムで、毎時ちょうどに次の1時間後の雑談希望者をリアクションで募集できます。
- 希望者が2人以上集まった場合、参加希望者ロールを30分だけ付与して集合通知できます。

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

基本操作はスラッシュコマンドで動きます。
ただし、VCリマインダー中に「話題を出して」という通常メッセージへ反応する機能があります。
その機能まで使う場合は、Discord Developer Portal側のMessage Content Intentも確認してください。

## ファイル構成

```text
discord-voice-grouper/
├─ .env.example
├─ data/
│  ├─ bump-reminders.json
│  └─ settings.json
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

- `src/bot.js`: Bot本体です。Discordに接続し、`/splitvc`、`/b`、`/setting`、話題コマンド、VCリマインダー、通話待機システム、DISBOARD bumpリマインドを処理します。
- `src/bump-reminder-store.js`: DISBOARD bumpリマインドの予約を保存します。
- `src/commands.js`: スラッシュコマンドの定義です。
- `src/grouping.js`: 3人組・4人組に分ける計算ロジックです。
- `src/settings-store.js`: `/setting` で保存したPB連携、募集、VCリマインダー、話題、ログ、フォーム設定を読み書きします。
- `src/register-commands.js`: Discordへスラッシュコマンドを登録します。
- `data/settings.json`: `/setting` や話題コマンドで保存したサーバー別設定です。
- `data/bump-reminders.json`: 予約中のDISBOARD bumpリマインドです。
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
- `Add Reactions`
- `Read Message History`
- `Connect`
- `Move Members`
- `Manage Roles`
- `Manage Channels`
- `Set Voice Channel Status`

生成されたURLをブラウザで開き、Botを使いたいサーバーへ招待します。

補足:

- `/splitvc` の結果を投稿するため、テキスト送信権限が必要です。
- ボイスチャンネル内のメンバーを見るため、対象チャンネルを閲覧できる必要があります。
- チャンネルごとの権限でBotが見えないVCは対象にできません。
- メンバーをPB親VCや子VCへ移動するため、Move Members権限が必要です。
- 参加者ロールを付与・解除するため、Manage Roles権限が必要です。
- 参加者ロールはBotの最上位ロールより下に置いてください。
- 途中参加用の待機VCを作成・削除するため、Manage Channels権限が必要です。
- 話題フォームの内容をVCチャンネルステータスへ設定するため、Set Voice Channel Status権限が必要です。Botが対象VCに入っていない場合はManage Channels権限も必要です。
- おすすめ話題、運用ログ、フォーム設置、フォーム転送先の各チャンネルへメッセージを送信できる必要があります。
- 通話待機システムでは、募集メッセージにリアクションを付けるため `Add Reactions`、リアクションしたユーザーを確認するため `Read Message History` が必要です。
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
# PB_WAITING_VC_CATEGORY_ID=123456789012345678
# PB_WAITING_VC_NAME=途中参加部屋
# PB_VOICE_REMINDER_ENABLED=true
# PB_VOICE_REMINDER_CHANNEL_ID=123456789012345678
# PB_VOICE_REMINDER_PARENT_CHANNEL_ID=123456789012345678
# PB_VOICE_REMINDER_CHILD_CATEGORY_ID=123456789012345678
# PB_WADAI_CHANNEL_ID=123456789012345678
# PB_POST_SPLIT_WADAI_CHANNEL_ID=123456789012345678
# PB_SPLIT_START_CHANNEL_ID=123456789012345678
# PB_LOG_CHANNEL_ID=123456789012345678
# PB_FORM_CHANNEL_ID=123456789012345678
# PB_FORM_SEND_CHANNEL_ID=123456789012345678
# PB_FORM_MODERATOR_ROLE_ID=123456789012345678
# PB_TRANSFER_WAIT_SECONDS=30
# PB_NOTICE_WAIT_MINUTES=25
# PB_ROLE_REMOVE_WAIT_MINUTES=3
# PB_CALL_WAIT_ENABLED=true
# PB_CALL_WAIT_ROLE_ID=123456789012345678
# PB_CALL_WAIT_PROMPT_CHANNEL_ID=123456789012345678
# PB_CALL_WAIT_NOTICE_CHANNEL_ID=123456789012345678
# PB_CALL_WAIT_VOICE_CATEGORY_ID=123456789012345678
# PB_CALL_WAIT_MODE=button
# PB_CALL_WAIT_BOSYU_NOTICE_ENABLED=false
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
| `PB_WAITING_VC_CATEGORY_ID` | 任意 | Botが途中参加用の待機VCを作成するカテゴリIDです。 |
| `PB_WAITING_VC_NAME` | 任意 | 自動作成する待機VCの名前です。未設定時は `途中参加部屋` です。 |
| `PB_WAITING_CHANNEL_ID` | 任意 | 古い設定との互換用です。新しく設定する場合は `PB_WAITING_VC_CATEGORY_ID` を使ってください。 |
| `PB_VOICE_REMINDER_ENABLED` | 任意 | VCリマインダー機能の有効・無効です。`false` で無効化します。 |
| `PB_VOICE_REMINDER_CHANNEL_ID` | 任意 | VCリマインダーを送るテキストチャンネルIDです。 |
| `PB_VOICE_TOPIC_CHANNEL_ID` | 任意 | 旧設定との互換用です。現在のリマインダー話題フォームでは使いません。 |
| `PB_VOICE_REMINDER_PARENT_CHANNEL_ID` | 任意 | リマインダー対象にするPB親VCのIDです。 |
| `PB_VOICE_REMINDER_CHILD_CATEGORY_ID` | 任意 | リマインダー対象にするPB子VCカテゴリIDです。未設定時はPB親VCのカテゴリから判定します。 |
| `PB_WADAI_CHANNEL_ID` | 任意 | 毎朝6時のおすすめ話題を送るテキストチャンネルIDです。 |
| `PB_POST_SPLIT_WADAI_CHANNEL_ID` | 任意 | `/splitvc` 後におすすめ話題を再掲するテキストチャンネルIDです。未設定時は実行チャンネルへ送ります。 |
| `PB_SPLIT_START_CHANNEL_ID` | 任意 | `/splitvc` 後にスタート・途中参加案内を送るテキストチャンネルIDです。未設定時は送信しません。 |
| `PB_LOG_CHANNEL_ID` | 任意 | 運用ログをまとめるテキストチャンネルIDです。 |
| `PB_FORM_CHANNEL_ID` | 任意 | フォームボタンを設置するテキストチャンネルIDです。 |
| `PB_FORM_SEND_CHANNEL_ID` | 任意 | フォーム入力内容を転送するテキストチャンネルIDです。 |
| `PB_FORM_MODERATOR_ROLE_ID` | 任意 | 相談・苦情フォームでメンションするモデレーターロールIDです。 |
| `PB_TRANSFER_WAIT_SECONDS` | 任意 | 転送開始までの待機秒数です。未設定時は30秒です。 |
| `PB_NOTICE_WAIT_MINUTES` | 任意 | 終了通知までの待機分数です。未設定時は25分です。 |
| `PB_ROLE_REMOVE_WAIT_MINUTES` | 任意 | 終了通知後のロール解除待機分数です。未設定時は3分です。 |
| `PB_CALL_WAIT_ENABLED` | 任意 | 通話待機システムの有効・無効です。`true` で有効化します。 |
| `PB_CALL_WAIT_ROLE_ID` | 任意 | 通話希望者に30分だけ付与するロールIDです。 |
| `PB_CALL_WAIT_PROMPT_CHANNEL_ID` | 任意 | 通話待機システムの募集メッセージを送るチャンネルIDです。 |
| `PB_CALL_WAIT_NOTICE_CHANNEL_ID` | 任意 | 通話待機システムの集合通知を送るチャンネルIDです。 |
| `PB_CALL_WAIT_VOICE_CATEGORY_ID` | 任意 | 毎時ちょうどに、すでに2人以上いるか確認するVCカテゴリIDです。 |
| `PB_CALL_WAIT_MODE` | 任意 | `reaction` または `button` です。未設定時は `button` です。 |
| `PB_CALL_WAIT_BOSYU_NOTICE_ENABLED` | 任意 | 集合通知後に `/b` の募集ロールへ途中参加案内を送るかどうかです。 |

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

成功すると、Discord側にBotのスラッシュコマンドが登録されます。

`.env` に `DISCORD_GUILD_ID` がある場合は、そのサーバーだけに登録されます。
ない場合はグローバルコマンドとして登録されます。

## 6. Botを起動する

```powershell
npm start
```

起動に成功すると、ターミナルにログインしたBot名が表示されます。
この状態でDiscordからBotのスラッシュコマンドを実行できます。

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
確実に残したい設定は、RenderのEnvironment Variablesに `PB_PARTICIPANT_ROLE_ID`、`PB_PARENT_CHANNEL_ID`、`PB_CHILD_CATEGORY_ID`、`PB_WAITING_VC_CATEGORY_ID`、`PB_WAITING_VC_NAME`、`PB_VOICE_REMINDER_ENABLED`、`PB_VOICE_REMINDER_CHANNEL_ID`、`PB_VOICE_REMINDER_PARENT_CHANNEL_ID`、`PB_VOICE_REMINDER_CHILD_CATEGORY_ID`、`PB_WADAI_CHANNEL_ID`、`PB_POST_SPLIT_WADAI_CHANNEL_ID`、`PB_SPLIT_START_CHANNEL_ID`、`PB_LOG_CHANNEL_ID`、`PB_FORM_CHANNEL_ID`、`PB_FORM_SEND_CHANNEL_ID`、`PB_FORM_MODERATOR_ROLE_ID`、`PB_TRANSFER_WAIT_SECONDS`、`PB_NOTICE_WAIT_MINUTES`、`PB_ROLE_REMOVE_WAIT_MINUTES`、`PB_CALL_WAIT_ENABLED`、`PB_CALL_WAIT_ROLE_ID`、`PB_CALL_WAIT_PROMPT_CHANNEL_ID`、`PB_CALL_WAIT_NOTICE_CHANNEL_ID`、`PB_CALL_WAIT_VOICE_CATEGORY_ID`、`PB_CALL_WAIT_MODE`、`PB_CALL_WAIT_BOSYU_NOTICE_ENABLED` として入れてください。
募集チャンネルや募集メンションロール、登録した話題など、Environment Variablesに対応していない `/setting` 項目は `data/settings.json` に保存されます。
Renderで永続ディスクを使っていない場合、再デプロイ後に `/setting splitvc`、`/setting reminder` などで再設定が必要になることがあります。

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

登録に成功したら、DiscordでBotのスラッシュコマンドが使えるようになります。

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

PB連携、募集、VCリマインダー、話題、ログ、フォーム、通話待機システムに使うロール・チャンネル・通知文を機能ごとに設定します。

現在の設定を見る場合:

```text
/setting show
```

`/setting set` は使わず、次のように機能別サブコマンドで設定します。

```text
/setting splitvc participant_role:@参加者ロール parent_channel:PB親VC child_category:PB子VCカテゴリ waiting_vc_category:待機VC作成先カテゴリ waiting_vc_name:途中参加部屋 post_split_wadai_channel:話題再掲先 split_start_channel:スタート案内先 transfer_wait_seconds:30 notice_wait_minutes:25 role_remove_wait_minutes:3
/setting bosyu bosyu_channel:募集チャンネル bosyu_mention_role:@募集通知
/setting reminder voice_participant_role:@VC参加者 voice_reminder_enabled:true voice_reminder_channel:リマインダー送信先 voice_reminder_parent_channel:PB親VC voice_reminder_child_category:PB子VCカテゴリ
/setting wadai wadaich:毎朝話題送信先
/setting logs log_channel:運用ログ
/setting forms form_channel:フォーム設置先 form_send_channel:フォーム転送先 moderator_role:@モデレーター
/setting callwait call_wait_enabled:true call_wait_role:@通話希望者 call_wait_prompt_channel:募集チャンネル call_wait_notice_channel:集合通知チャンネル call_wait_voice_category:VCカテゴリ call_wait_mode:button call_wait_bosyu_notice_enabled:true
```

`child_category` は任意です。
設定すると、PBが作った子VCをそのカテゴリ内だけから探します。
未設定の場合は、代表者がPB親VCから別のVCへ移動したことを見て自動検出します。

`waiting_vc_category` は任意です。
設定すると、振り分け完了後にそのカテゴリへ途中参加用の待機VCを自動作成し、10分間監視します。

`waiting_vc_name` は任意です。
自動作成する待機VCの名前を変更できます。
未設定の場合は `途中参加部屋` という名前で作成します。

募集・VCリマインダー・話題・ログ・フォーム・通話待機関連の主なオプション:

| オプション | 説明 |
| --- | --- |
| `bosyu_channel` | `/b` を使えるテキストチャンネルを制限します。未設定なら制限なしです。 |
| `bosyu_mention_role` | `/b` の募集メッセージでメンションするロールです。 |
| `voice_participant_role` | VCリマインダーの対象VCに2人以上集まったとき付与するロールです。 |
| `voice_reminder_enabled` | VCリマインダーを有効・無効にします。`false` で監視しません。 |
| `voice_reminder_channel` | リマインダー送信先テキストチャンネルです。未設定時はVC名などから関連テキストチャンネルを探します。 |
| `voice_topic_channel` | 旧設定との互換用です。現在のリマインダー話題フォームでは使いません。 |
| `voice_reminder_parent_channel` | リマインダー対象にするPB親VCです。 |
| `voice_reminder_child_category` | リマインダー対象にするPB子VCカテゴリです。未設定時はPB親VCのカテゴリから判定します。 |
| `wadaich` | 毎朝6時のおすすめ話題を送るテキストチャンネルです。 |
| `post_split_wadai_channel` | `/splitvc` 後のおすすめ話題再掲先です。未設定時は実行チャンネルへ送ります。 |
| `split_start_channel` | `/splitvc` 後のスタート・途中参加案内送信先です。未設定時は送信しません。 |
| `log_channel` | 転送結果、待機VC作成、途中参加転送、PB子VC削除による終了通知自動キャンセル、ロール解除結果などの運用ログをまとめるチャンネルです。未設定時は従来どおり実行チャンネルへ送ります。 |
| `form_channel` | フォームボタンを設置するチャンネルです。 |
| `form_send_channel` | フォーム入力内容を転送するチャンネルです。 |
| `moderator_role` | 相談・苦情フォームの転送時にメンションするモデレーターロールです。 |
| `call_wait_enabled` | 通話待機システムを有効・無効にします。 |
| `call_wait_role` | 希望者が2人以上集まったとき、一時的に付与するロールです。 |
| `call_wait_prompt_channel` | リアクション式・ボタン式の募集メッセージを送るチャンネルです。 |
| `call_wait_notice_channel` | 集合通知を送るチャンネルです。 |
| `call_wait_voice_category` | 毎時ちょうどに、すでに2人以上いるか確認するVCカテゴリです。 |
| `call_wait_mode` | `reaction` でリアクション式、`button` でボタン式にします。 |
| `call_wait_bosyu_notice_enabled` | 集合通知後に `/b` の募集ロールへ途中参加案内を送るかどうかです。 |

`/setting` を使うにはサーバー管理権限が必要です。

待機時間オプション:

| オプション | 単位 | 省略時 | 説明 |
| --- | --- | --- | --- |
| `transfer_wait_seconds` | 秒 | 30 | 振り分け後、VC転送を始めるまでの待機時間です。 |
| `notice_wait_minutes` | 分 | 25 | 終了通知を送るまでの待機時間です。 |
| `role_remove_wait_minutes` | 分 | 3 | 終了通知を送った後、参加者ロールを解除するまでの待機時間です。 |

いずれも `0` を指定できます。
`0` の場合、その待機は行わずすぐ次の処理へ進みます。

### おすすめ話題

毎日朝6:00に、`wadaich` で設定したチャンネルへおすすめ話題を3択で投稿します。
定時投稿では参加者ロールへのメンションは行いません。

定時投稿の形式:

```text
本日のお薦め話題
①好きな食べ物は？
②最近うれしかったことは？
③無人島に一つだけ持っていくなら何？

ぜひ使ってみてください！
```

新しい話題を投稿すると、前回投稿した話題メッセージは自動削除します。
デプロイ直後や確認用に定時外で投稿したい場合は、管理者が次を実行します。

```text
/sendwadai
```

`/splitvc` の転送が完了し、参加者ロール付与が終わった後は、当日投稿済みの話題をコピーして送信します。

`/splitvc` 後の送信形式:

```text
@参加者ロール
おすすめの話題
①好きな食べ物は？
②最近うれしかったことは？
③無人島に一つだけ持っていくなら何？
話題に詰まったらここから選んでみてください！
```

`/splitvc` 後のコピー送信は、`/splitvc` を実行したチャンネルへ送ります。
まだ本日分の話題が投稿されていない場合、`/splitvc` 後のコピー送信は行われません。

話題は3つの分野ごとに管理します。

| 分野 | 内容 |
| --- | --- |
| `1` | 大まかな話題です。趣味や好きな食べ物などを入れます。 |
| `2` | 最近ベースの話題です。最近の出来事や近況を入れます。 |
| `3` | 思考実験やディベート的な話題です。 |

各分野から1つずつランダムに選びます。
一度選ばれた話題は、同じ分野で最低3回は選ばれないようにします。
登録数が少なくて条件を満たせない場合だけ、再選択されることがあります。

初期状態では、各分野に5個ずつ話題が登録されています。

#### `/addwadai`

話題を追加します。

```text
/addwadai category:1 content:好きな季節は？
```

`category` は `1`、`2`、`3` から選びます。
追加と削除にはサーバー管理権限が必要です。

#### `/showwadai`

登録されている話題を添え字付きで表示します。

```text
/showwadai
```

表示例:

```text
①大まかな話題
1. 好きな食べ物は？
2. 趣味は何？

②最近ベースの話題
1. 最近うれしかったことは？

③思考実験やディベート的なもの
1. 無人島に一つだけ持っていくなら何？
```

#### `/delwadai`

`/showwadai` に表示された添え字で話題を削除します。

```text
/delwadai target:1-2
```

上の例では、①大まかな話題の2番目を削除します。
削除後の添え字は自動で詰められます。

### フォーム

話題提供、提案・要望、相談・苦情の3種類のフォームボタンを設置できます。

事前に設置先と転送先を設定します。相談・苦情フォームで通知したい場合はモデレーターロールも設定します。

```text
/setting forms form_channel:フォーム設置先 form_send_channel:フォーム転送先 moderator_role:@モデレーター
```

フォームボタンを設置するには、管理者が次を実行します。

```text
/setupforms
```

設置されるメッセージは3つに分かれます。

1つ目:

```text
日替わり話題にちょうどいい話題があればぜひ！
```

この下に `話題提供フォーム` ボタンが付きます。

2つ目:

```text
提案および要望があればぜひお聞かせください！
```

この下に `提案・要望フォーム` ボタンが付きます。

3つ目:

```text
対人トラブルや、サーバーについての苦情があればこちらへ
```

この下に `相談・苦情フォーム` ボタンが付きます。

フォーム入力内容は、`form_send_channel` へ次の形式で転送されます。

```text
送信者:フォーム入力者名
分類:提案・要望
内容:入力されたメッセージ
```

分類は `話題提供`、`提案・要望`、`相談・苦情` のいずれかです。
`相談・苦情` の場合だけ、転送内容の先頭に設定したモデレーターロールをメンションします。

### `/b`

募集メッセージを送信します。

```text
/b note:遠慮せずご参加ください！ time:30分 purpose:雑談
```

オプション:

| オプション | 必須 | 説明 |
| --- | --- | --- |
| `note` | 必須 | 募集のひとことです。 |
| `time` | 任意 | 募集時間です。 |
| `purpose` | 任意 | 名目です。 |

`/b` は同じユーザーが15分以内に連続使用できないようになっています。
送信後15分間は、募集メッセージの「募集内容を編集」ボタンから内容を編集できます。

実行者がVCに入っていて `purpose` を指定した場合、BotはそのVCのチャンネル名を `purpose` に更新しようとします。
編集ボタンから名目を変更した場合も、元のVC、または編集者が参加中のVCのチャンネル名を更新しようとします。

現在のコードでは、`note` をVCのチャンネルステータスとして設定する処理は行っていません。
Discord APIのチャンネルステータス項目は使わず、募集メッセージ本文に `ひとこと` として表示します。

### VC集合フォーム

VC集合フォームは、PB子VCまたは設定された監視VCに2人以上集まったときに開始します。

- 開始時に送信先へ参加者ロールをメンションし、話題フォームボタン付きの集合メッセージを1回送ります。
- `voice_participant_role` が設定されている場合、対象VC内の参加者へロールを付与します。
- 30分ごとの確認メッセージは送信しません。
- 対象VCが2人未満になった場合、5分待ってからセッションを終了します。5分以内に2人以上へ戻った場合はセッションを継続します。
- 対象VCが2人未満になってから10分後に、集合メッセージと話題フォームを削除します。10分以内に2人以上へ戻った場合は削除を取り消し、同じフォームを継続します。
- セッション終了時、他の有効なVCセッションにいないメンバーから参加者ロールを解除します。
- `voice_reminder_child_category` で指定したカテゴリ内のVC単体で6人以上になると、自動振り分け提案を送ります。
- `voice_reminder_child_category` が未設定の場合は、VC集合フォームと同じく `child_category`、またはPB親VCのカテゴリから判定します。
- 自動振り分け提案では、`voice_participant_role` で指定したVC集合フォームの参加者ロールをメンションします。

話題フォーム:

- フォームを送信できるのは、送信時点でVCに参加しているメンバーだけです。
- 通話終了まで何度でも送信できます。
- 送信内容はテキストチャンネルへ転送せず、送信者が参加中のVCチャンネルステータスへ設定します。
- ステータス形式は `今の話題：入力内容` です。
- Botには `Set Voice Channel Status` 権限が必要です。Botが対象VCに入っていない場合は `Manage Channels` 権限も必要です。

「話題を出して」とリマインダー送信先チャンネルに投稿すると、Botがランダムな話題を返します。
この機能は通常メッセージ本文を読むため、Discord側のMessage Content Intent設定に注意してください。

### 通話待機システム

毎時ちょうどに、1時間後の雑談希望者を募集します。
募集方式は `call_wait_mode` で、リアクション式またはボタン式から選べます。
`call_wait_mode` を指定せずに有効・無効などを変更しても、直前の募集方式は維持されます。募集方式が一度も設定されていない場合はボタン式になります。

リアクション式の場合、例として10:00に動くと、11:00から雑談したい人向けに次のようなメッセージを送ります。

```text
11:00から雑談したい方はリアクション 🤚 を押してください。
複数人希望者が集まったら11:00にメンションします。メンションが来たらご参加ください。
もちろん普通の募集もしてOKです
```

Bot自身が先に `🤚` を付けます。

ボタン式の場合は、次のメッセージと `11時から雑談希望` のような時刻入りボタンを送ります。

```text
【お手軽募集ボタン】
11時から雑談してみたい方は、下のボタンを押してください。
11:00時点で複数人が集まっていたら、メンションでお知らせします。
メンションを受け取ったらVCへの参加をお願いします！
```

時刻が5:00の場合、本文とボタンでは `5時` と表示し、先頭に `0` は付けません。
ボタンを押した人には、自分だけに見える `希望をキャンセル` ボタンを表示します。
希望ボタン、キャンセルボタン、人数不足によるリセットが発生した場合は、`log_channel` に操作ユーザーと現在の希望者リストを送ります。

11:00時点で、Bot以外に2人以上が `🤚` を押していた場合、またはボタン式で2人以上が希望していた場合、その人たちへ `call_wait_role` で設定したロールを付与し、`call_wait_notice_channel` に次の集合通知を送ります。

```text
@通話希望者 雑談希望者が複数人集まりました！VCへの参加お願いします！
```

付与したロールは、集合通知から30分後に自動解除します。
`call_wait_bosyu_notice_enabled:true` かつ `bosyu_mention_role` が設定されている場合、集合通知後に次の途中参加案内も送ります。

```text
@募集ロール VCが始まりました！お暇ならぜひ途中参加してみてください！
```

集合通知を送った直後の同じ時刻には、次回分の募集メッセージは送りません。
集合通知から30分後に `call_wait_voice_category` 内のVC参加人数を確認し、Bot以外の参加者が2人未満なら、次の `yy:00` 向けの募集メッセージを送ります。
11:00時点で希望者が2人未満の場合、古い募集メッセージを削除し、希望者カウントをリセットして、12:00向けの募集メッセージを新しく送ります。

`call_wait_voice_category` に設定したVCカテゴリ内に、毎時ちょうどの時点でBot以外の参加者が2人以上いる場合は、募集メッセージは送らず、残っている募集メッセージがあれば削除します。
この場合、募集メッセージ送信先へ `複数人が雑談中なので12時の募集は出ません` のように、募集を出さなかった理由を送ります。集合通知30分後の再確認で2人以上いた場合も同様です。
このカテゴリ内VC人数の確認だけでロール付与や集合通知は行いません。集合通知の対象は、あくまで募集メッセージに反応またはボタンで希望した人だけです。

再デプロイ直後やイベント前など、定時を待たずに募集メッセージを出したい場合は、管理者が次を実行します。

```text
/sendcallwait
```

このコマンドで送った募集メッセージも、次の `yy:00` に通常どおりリアクション確認、削除、次回分への更新が行われます。

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
2. 参加者ロールは、各メンバーをVCへ転送したタイミングで付与します。
3. 30秒待機し、待機中だけ転送キャンセルボタンを表示します。
4. 各グループから1人をPB親VCへ移動します。
5. PBが作成した子VCを検出し、同じグループの残りメンバーを移動します。
6. 転送と参加者ロール付与が終わった後、当日投稿済みのおすすめ話題をコピーして送信します。
7. 25分後に参加者ロールへメンションして終了通知を送信します。
8. 終了通知の3分後に参加者ロールを解除します。

おすすめ話題の再掲先は `/setting splitvc post_split_wadai_channel:...` で指定できます。
未設定の場合は、従来どおり `/splitvc` を実行したチャンネルへ送ります。

`waiting_vc_category` が設定されている場合、振り分け完了後に待機VCを自動作成し、10分間だけ途中参加者を監視します。

- 待機VCは `/setting splitvc waiting_vc_category:...` で設定したカテゴリ内に作成されます。
- 待機VC名は `/setting splitvc waiting_vc_name:...` で変更できます。
- `split_start_channel` が設定されている場合、待機VC作成後に次の案内を送ります。

```text
集合開始から5分経ったのでスタートします
スタート後も10分までなら途中参加を受け付けているのでぜひ#途中参加部屋からご参加ください！
```

- 参加者が待機中VCにいて、3人以下の子VCがある場合は、その子VCへ1人転送します。
- 3人以下の子VCがない場合は、待機中VCに3人集まるまで待ちます。
- 待機中VCに3人集まったら、その3人を新規グループとしてPB親VC経由で新規子VCへ転送します。
- 参加者ロールは、実際にVC転送が発生したタイミングで付与します。
- 参加者ロール解除は、最初の参加者と途中参加者をまとめて一括で行います。
- 待機VCは作成から10分が経過したら自動削除されます。
- 終了通知キャンセル、またはPB子VC削除による自動キャンセルが発生した場合も、待機VCは削除されます。
- 待機VCが削除されたら、スタート・途中参加案内は次の文面へ編集されます。

```text
集合開始から５分経ったのでスタートします
スタートから10分経過したので途中参加は締め切られました
```

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
- 途中参加用の待機VCを作成・削除できること
- `/b` の名目に合わせてVC名を変更できること
- 話題フォームの内容をVCチャンネルステータスへ設定できること

Role Hierarchyの注意:

- Botのロールは、参加者ロールより上に置いてください。
- Botのロールが参加者ロール以下だと、Discordの仕様でロール付与・解除が失敗します。

基本操作はスラッシュコマンドの入力で動きます。
DISBOARD bumpリマインドも、DISBOARDのメッセージ本文ではなく、Discordのコマンド実行メタ情報を見て判定します。

一方で、VCリマインダー中の「話題を出して」機能は通常メッセージ本文を見ます。
反応しない場合は、Discord Developer Portal側のMessage Content Intent設定と、Botコード側のIntent設定を確認してください。

## DISBOARD bumpリマインド

DISBOARDの `/bump` が成功し、DISBOARD Botがメッセージを投稿したら、2時間後に同じチャンネルへリマインドを送ります。

送信内容:

```text
前回のbumpから２時間が経過しました
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
- `/setting splitvc child_category:...` でPBが子VCを作るカテゴリを設定すると安定しやすくなります。
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
