# Discord Voice Grouper

ボイスチャンネル内にいるメンバーを読み取り、3人組を基本にして自動でグループ分けするDiscord Botです。

読みやすく整理したHTML版は `README.html` にあります。

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
- 終了通知の150分後に参加者ロールを解除できます（設定で変更可能）。
- 転送前待機、終了通知前待機、通知後ロール解除待機をコマンドで変更できます。
- PBが作成した子VCがすべて削除されたら、終了通知を自動キャンセルして参加者ロールを解除できます。
- DISBOARDの `/bump` 成功メッセージを検知し、2時間後に実行者へリマインドできます。
- 振り分け完了後、途中参加用の待機VCを自動作成して10分間監視できます。
- 待機中の参加者を、3人以下の子VCへ補充できます。
- 補充先がない場合、待機中に3人集まった時点で新規子VCへ転送できます。
- 待機VCは10分経過、または終了通知キャンセル時に自動削除されます。
- VC集合フォームで、2人以上集まったVCに参加者ロールを付与し、開始時に話題フォーム付きメッセージを送れます。
- VC集合フォームと同じPB子VCカテゴリ内で、1つのVCに6人以上いる場合だけ自動振り分け提案を送れます。
- 話題フォームの内容を、送信者が参加中のVCチャンネルステータスへ `今の話題：...` として設定できます。
- `/kokuchi` で会話練習会の告知を投稿し、`send_topic:true` のときだけ最初の話題を話題リストからランダムに選べます。
- `/setting kokuchi` の開催予定時刻を基準に、30分前案内・20分前の集合VC開放・5分前の集合開始メッセージを送れます。
- 集合VCの権限は、`/splitvc` 転送完了時に変更前の状態へ戻せます。
- `/kokuchi send_topic:false` を選ぶと、その回は告知にも次回 `/splitvc` 後にも最初の話題を送信しません。
- `/splitvc` の転送完了後、最後に `/kokuchi` で選ばれた話題と、グループごとの発話順を参加者ロールへメンションして送信できます。
- `/splitvc` 後の話題・発話順の送信先を、実行チャンネルとは別に指定できます。
- `/splitvc` の参加者ロール解除時に、途中参加者を含む参加人数入りのお礼と次回案内を送信できます。
- `/splitvc` 後にスタート・途中参加案内を指定チャンネルへ送り、待機VC削除時に締切済みの文面へ編集できます。
- `/addwadai`、`/showwadai`、`/delwadai` でおすすめ話題の追加・確認・削除ができます。
- 運用ログを指定チャンネルにまとめられます。
- 話題提供、提案・要望、相談・苦情フォームを設置し、入力内容を指定チャンネルへ転送できます。
- 通話待機システムで、JST 0:00基準の30分・45分・60分間隔ごとに、ボタン式の雑談希望者募集を送れます（`/kokuchi` 実行日のJST 20:00〜21:59を除く）。
- 希望者が2人以上集まった場合、参加希望者ロールを付与し、VCに2人入った確認後に集合通知できます。
- `call_wait_notice_channel` に常設の「募集を作成」ボタンを置き、ユーザーがその場で「人が集まったらすぐ」の匿名募集を作成できます。
- ボタン募集は作成者を初期参加者として扱い、別の参加者が参加希望して確認時間を過ぎると、2人以上で集合通知を送ります。
- ボタン募集の掲載終了時刻、予定通話時間、`@通話` へのメンション、ひとことを作成画面で指定できます。
- VC未参加者・長期不参加者へ、JST 17:00の日次判定で案内DMを送り、DMからイベント30分前のリマインダーを登録できます。

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
   ├─ mongodb.js
   └─ register-commands.js
```

主な役割:

- `src/bot.js`: Bot本体です。Discordに接続し、`/splitvc`、`/setting`、話題コマンド、VCリマインダー、通話待機システム、ボタン募集、DISBOARD bumpリマインドを処理します。
- `src/bump-reminder-store.js`: DISBOARD bumpリマインドの予約を保存します。
- `src/commands.js`: スラッシュコマンドの定義です。
- `src/grouping.js`: 3人組・4人組に分ける計算ロジックです。
- `src/settings-store.js`: `/setting` で保存したPB連携、募集、VCリマインダー、話題、ログ、フォーム設定を読み書きします。
- `src/mongodb.js`: MongoDB Atlasへの接続・切断を管理します。
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
- 集合VCの閲覧・接続権限を、告知時刻から算出した時刻に一時開放し、`/splitvc` 転送完了時に元の状態へ戻すため、対象VCのManage Channels権限が必要です。
- 話題フォームの内容をVCチャンネルステータスへ設定するため、Set Voice Channel Status権限が必要です。Botが対象VCに入っていない場合はManage Channels権限も必要です。
- おすすめ話題、運用ログ、フォーム設置、フォーム転送先の各チャンネルへメッセージを送信できる必要があります。
- 通話待機システムは募集メッセージのボタンで参加を受け付けます。
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
# PB_VOICE_REMINDER_PARENT_CHANNEL_IDS=123456789012345678,234567890123456789
# PB_VOICE_REMINDER_CHILD_CATEGORY_ID=123456789012345678
# PB_WADAI_CHANNEL_ID=123456789012345678
# PB_POST_SPLIT_WADAI_CHANNEL_ID=123456789012345678
# PB_SPLIT_START_CHANNEL_ID=123456789012345678
# PB_GATHERING_VOICE_CHANNEL_ID=123456789012345678
# PB_KOKUCHI_MENTION_ROLE_IDS=123456789012345678,234567890123456789
# PB_SPLIT_FEEDBACK_CHANNEL_ID=1513457664041160765
# PB_LOG_CHANNEL_ID=123456789012345678
# PB_FORM_CHANNEL_ID=123456789012345678
# PB_FORM_SEND_CHANNEL_ID=123456789012345678
# PB_FORM_MODERATOR_ROLE_ID=123456789012345678
# PB_TRANSFER_WAIT_SECONDS=30
# PB_NOTICE_WAIT_MINUTES=25
# PB_ROLE_REMOVE_WAIT_MINUTES=150
# PB_CALL_WAIT_ENABLED=true
# PB_CALL_WAIT_ROLE_ID=123456789012345678
# PB_CALL_WAIT_PROMPT_CHANNEL_ID=123456789012345678
# PB_CALL_WAIT_NOTICE_CHANNEL_ID=123456789012345678
# PB_CALL_WAIT_VOICE_CATEGORY_ID=123456789012345678
# PB_CALL_WAIT_INTERVAL_MINUTES=30
# PB_OTEBO_QUICK_CONFIRM_SECONDS=30
```

環境変数:

| 名前 | 必須 | 説明 |
| --- | --- | --- |
| `DISCORD_TOKEN` | 必須 | Discord Developer Portalで取得したBot Tokenです。 |
| `DISCORD_CLIENT_ID` | 必須 | アプリのClient IDです。 |
| `MONGODB_URI` | 必須 | MongoDB Atlasの接続文字列です。 |
| `DISBOARD_BOT_ID` | 任意 | DISBOARD BotのIDです。未設定時は公開DISBOARD Bot IDを使います。 |
| `DISCORD_GUILD_ID` | 任意 | テスト用サーバーのIDです。指定すると、そのサーバーだけにコマンドを登録します。 |
| `PB_PARTICIPANT_ROLE_ID` | 任意 | Renderなどで固定設定したい場合の参加者ロールIDです。 |
| `PB_SPLIT_MODE` | 任意 | `/splitvc` のVC作成方式です。`direct`（Botが直接作成、既定）または `partybeast`（旧PB互換）を指定します。 |
| `PB_PARENT_CHANNEL_ID` | 任意 | Renderなどで固定設定したい場合のPB親VCのIDです。 |
| `PB_CHILD_CATEGORY_ID` | 任意 | direct modeでVCを作成するカテゴリ、またはPBが子VCを作るカテゴリのIDです。PB互換モードでは未設定でも自動検出します。 |
| `PB_WAITING_VC_CATEGORY_ID` | 任意 | Botが途中参加用の待機VCを作成するカテゴリIDです。 |
| `PB_WAITING_VC_NAME` | 任意 | 自動作成する待機VCの名前です。未設定時は `途中参加部屋` です。 |
| `PB_WAITING_CHANNEL_ID` | 任意 | 古い設定との互換用です。新しく設定する場合は `PB_WAITING_VC_CATEGORY_ID` を使ってください。 |
| `PB_VOICE_REMINDER_ENABLED` | 任意 | VCリマインダー機能の有効・無効です。`false` で無効化します。 |
| `PB_VOICE_REMINDER_CHANNEL_ID` | 任意 | VCリマインダーを送るテキストチャンネルIDです。 |
| `PB_VOICE_TOPIC_CHANNEL_ID` | 任意 | 旧設定との互換用です。現在のリマインダー話題フォームでは使いません。 |
| `PB_VOICE_REMINDER_PARENT_CHANNEL_ID` | 任意 | リマインダー対象にするPB親VCのIDです。 |
| `PB_VOICE_REMINDER_PARENT_CHANNEL_IDS` | 任意 | リマインダー対象にするPB親VCのIDをカンマ区切りで指定します。単一IDの旧設定より優先されます。 |
| `PB_VOICE_REMINDER_CHILD_CATEGORY_ID` | 任意 | リマインダー対象にするPB子VCカテゴリIDです。未設定時はPB親VCのカテゴリから判定します。 |
| `PB_WADAI_CHANNEL_ID` | 任意 | `/kokuchi` の告知送信先、告知時刻から算出する事前案内送信先、`/splitvc` 後のスタート案内・参加お礼送信先として使うテキストチャンネルIDです。 |
| `PB_POST_SPLIT_WADAI_CHANNEL_ID` | 任意 | `/splitvc` 後に最初の話題と発話順を送るテキストチャンネルIDです。未設定時は実行チャンネルへ送ります。 |
| `PB_SPLIT_START_CHANNEL_ID` | 任意 | 旧互換用です。現在は `PB_WADAI_CHANNEL_ID` と同じ送信先として扱います。 |
| `PB_GATHERING_VOICE_CHANNEL_ID` | 任意 | `/kokuchi` の告知時刻から算出した集合時刻に、閲覧・接続権限を一時開放する集合VCのIDです。`/splitvc` 転送完了時には開放前の状態へ戻します。環境変数で設定した場合も、スケジュール保存後と再起動後に引き続き使用されます。 |
| `PB_KOKUCHI_MENTION_ROLE_IDS` | 任意 | `/kokuchi` の告知と集合リマインダーでメンションするロールIDをカンマ区切りで指定します。 |
| `PB_SPLIT_FEEDBACK_CHANNEL_ID` | 任意 | `/splitvc` 終了後のお礼メッセージで、意見・苦情案内として表示するチャンネルIDです。未設定時は `1513457664041160765` です。 |
| `PB_LOG_CHANNEL_ID` | 任意 | 運用ログをまとめるテキストチャンネルIDです。 |
| `PB_FORM_CHANNEL_ID` | 任意 | フォームボタンを設置するテキストチャンネルIDです。 |
| `PB_FORM_SEND_CHANNEL_ID` | 任意 | フォーム入力内容を転送するテキストチャンネルIDです。 |
| `PB_FORM_MODERATOR_ROLE_ID` | 任意 | 相談・苦情フォームでメンションするモデレーターロールIDです。 |
| `PB_TRANSFER_WAIT_SECONDS` | 任意 | 転送開始までの待機秒数です。未設定時は30秒です。 |
| `PB_NOTICE_WAIT_MINUTES` | 任意 | 終了通知までの待機分数です。未設定時は25分です。 |
| `PB_ROLE_REMOVE_WAIT_MINUTES` | 任意 | 終了通知後のロール解除待機分数です。未設定時は150分です。 |
| `PB_CALL_WAIT_ENABLED` | 任意 | 通話待機システムの有効・無効です。`true` で有効化します。 |
| `PB_CALL_WAIT_ROLE_ID` | 任意 | 通話待機・ボタン募集で参加希望者に付与するロールIDです。 |
| `PB_CALL_WAIT_PROMPT_CHANNEL_ID` | 任意 | 通話待機システムの募集メッセージを送るチャンネルIDです。 |
| `PB_CALL_WAIT_NOTICE_CHANNEL_ID` | 任意 | 通話待機システムの集合通知を送るチャンネルIDです。 |
| `PB_CALL_WAIT_VOICE_CATEGORY_ID` | 任意 | 定時募集時に、すでに2人以上いるか確認するVCカテゴリIDです。 |
| `PB_CALL_WAIT_INTERVAL_MINUTES` | 任意 | 定時募集の間隔です。`30`、`45`、`60`から選べ、未設定時は`30`です。 |
| `PB_OTEBO_QUICK_CONFIRM_SECONDS` | 任意 | ボタン募集の「人が集まったらすぐ」で、参加希望後にキャンセルできる秒数です。未設定時は30秒です。 |

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
GET /ready
GET /live
```

- `/health` はDiscord、MongoDB、起動時復元、終了状態をまとめた厳格なヘルス判定です。起動時復元が一部失敗した場合もHTTP 503になります。
- `/ready` はリクエストを処理できる準備が整っているかを返します。MongoDBは接続状態だけでなく実際のping結果を確認します。復元の一部失敗は`degraded:true`で示し、Discord・MongoDB・起動完了が利用可能ならHTTP 200です。
- `/live` はプロセスが応答可能で終了処理中でないかを返します。ホスティングの再起動判定にはこのURLを推奨します。

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
確実に残したい設定は、RenderのEnvironment Variablesに `PB_PARTICIPANT_ROLE_ID`、`PB_SPLIT_MODE`、`PB_PARENT_CHANNEL_ID`、`PB_CHILD_CATEGORY_ID`、`PB_WAITING_VC_CATEGORY_ID`、`PB_WAITING_VC_NAME`、`PB_VOICE_REMINDER_ENABLED`、`PB_VOICE_REMINDER_CHANNEL_ID`、`PB_VOICE_REMINDER_PARENT_CHANNEL_ID` または `PB_VOICE_REMINDER_PARENT_CHANNEL_IDS`、`PB_VOICE_REMINDER_CHILD_CATEGORY_ID`、`PB_WADAI_CHANNEL_ID`、`PB_POST_SPLIT_WADAI_CHANNEL_ID`、`PB_SPLIT_START_CHANNEL_ID`、`PB_GATHERING_VOICE_CHANNEL_ID`、`PB_KOKUCHI_MENTION_ROLE_IDS`、`PB_SPLIT_FEEDBACK_CHANNEL_ID`、`PB_LOG_CHANNEL_ID`、`PB_FORM_CHANNEL_ID`、`PB_FORM_SEND_CHANNEL_ID`、`PB_FORM_MODERATOR_ROLE_ID`、`PB_TRANSFER_WAIT_SECONDS`、`PB_NOTICE_WAIT_MINUTES`、`PB_ROLE_REMOVE_WAIT_MINUTES`、`PB_CALL_WAIT_ENABLED`、`PB_CALL_WAIT_ROLE_ID`、`PB_CALL_WAIT_PROMPT_CHANNEL_ID`、`PB_CALL_WAIT_NOTICE_CHANNEL_ID`、`PB_CALL_WAIT_VOICE_CATEGORY_ID`、`PB_CALL_WAIT_INTERVAL_MINUTES`、`PB_OTEBO_QUICK_CONFIRM_SECONDS` として入れてください。
募集チャンネルや募集メンションロール、登録した話題など、Environment Variablesに対応していない `/setting` 項目は `data/settings.json` に保存されます。
Renderで永続ディスクを使っていない場合、再デプロイ後に `/setting splitvc`、`/setting zatudan`、`/setting kokuchi` などで再設定が必要になることがあります。

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
/setting splitvc mode:direct participant_role:@参加者ロール child_category:直接作成先カテゴリ parent_channel:PB親VC kokuchi_overview_channel:告知概要チャンネル waiting_vc_category:待機VC作成先カテゴリ waiting_vc_name:途中参加部屋 post_split_wadai_channel:話題・発話順送信先 gathering_voice_channel:集合VC split_feedback_channel:意見・苦情チャンネル transfer_wait_seconds:30 notice_wait_minutes:25 role_remove_wait_minutes:150
/setting zatudan voice_participant_role:@VC参加者 voice_reminder_enabled:true voice_reminder_parent_channel:PB親VC voice_reminder_parent_channel_2:PB親VC2 voice_reminder_child_category:PB子VCカテゴリ
/setting kokuchi announcement_channel:告知・スタート案内送信先 event_time:21:00 gathering_voice_channel:集合VC mention_role:@告知ロール
/setting logs log_channel:運用ログ
/setting forms form_channel:フォーム設置先 form_send_channel:フォーム転送先 moderator_role:@モデレーター
/setting callwait call_wait_enabled:true call_wait_interval_minutes:45 call_wait_role:@通話希望者 call_wait_prompt_channel:募集作成用チャンネル call_wait_notice_channel:常設パネル・集合通知チャンネル call_wait_voice_category:VCカテゴリ otebo_quick_confirm_seconds:30 bosyu_mention_role:@募集通知
/setting vc_dm enabled:true panel_channel:対象確認パネル target_category:対象VCカテゴリ target_channels:VCのIDをカンマ区切り excluded_channels:対象外VCのIDをカンマ区切り
/setting status_board channel:運用ステータス
```

運用ステータスボードを解除する場合は`/setting status_board remove:true`を実行します。`/botstatus show`、`/botstatus refresh`、`/botstatus manage`はManageGuild権限が必要です。問題詳細と管理操作は最初にEphemeral応答を確定してから状態を取得し、操作結果の応答はボード再描画を待ちません。Snapshotには処理期限があり、Discordパネル確認は短時間キャッシュされます。

`/setting vc_dm` の対象VCは、カテゴリ指定または個別VC指定で設定します。対象VCへ3分以上連続して参加すると有効参加として記録され、対象確認パネルから外れます。AFK、集合VC、待機VCカテゴリ、VCコントロールカテゴリ、PB親VC、明示した対象外VCは自動的に対象外です。管理者はパネルのユーザー選択メニューから、既参加者としての除外・除外取消を行えます。パネルを置くチャンネルには、Botの閲覧・メッセージ送信・メッセージ履歴閲覧権限が必要です。

新規参加者DMは加入後7日目以降の最初の日次判定、長期不参加者DMは最後の有効VC参加または移行時基準日から30日目以降の日次判定で、対象イベント（火曜・土曜、`kokuchi` の開催時刻）を案内します。VC DMを有効にする前に`/setting kokuchi event_time`を設定してください。DM送信記録、リマインダー、日次実行、移行状態はMongoDBへ保存され、再起動後も復元されます。VC DMを無効化した場合、未送信リマインダーは保留され、再有効化時に復元されます。DMを受け取れない場合は再送せず、送信障害だけを再試行します。

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
| `bosyu_mention_role` | ボタン募集で `@通話へのメンション` を有効にしたときにメンションするロールです。 |
| `voice_participant_role` | VCリマインダーの対象VCに2人以上集まったとき付与するロールです。 |
| `voice_reminder_enabled` | VC集合フォームの開始通知の有効・無効を保存します。`false` でも参加者ロールの付与・解除は行います。 |
| `voice_reminder_parent_channel` / `_2`〜`_5` | リマインダー対象から除外するPB親VCを複数指定できます。 |
| `voice_reminder_child_category` | リマインダー対象にするPB子VCカテゴリです。設定時は、そのカテゴリ内の子VCだけを対象にします。未設定時は指定した親VCのカテゴリから判定します。 |
| `announcement_channel` | `/kokuchi` の告知送信先と、`/splitvc` 後のスタート案内・参加お礼送信先を兼ねます。`/kokuchi` の `channel` を省略した場合にも使います。 |
| `post_split_wadai_channel` | `/splitvc` 後の最初の話題と発話順の送信先です。未設定時は実行チャンネルへ送ります。 |
| `split_start_channel` | 旧設定との互換用です。現在は `announcement_channel` と同じ送信先として扱います。 |
| `split_feedback_channel` | `/splitvc` 終了後のお礼メッセージで、意見・苦情案内として表示するチャンネルです。未設定時は `1513457664041160765` です。 |
| `log_channel` | 転送結果、待機VC作成、途中参加転送、PB子VC削除による終了通知自動キャンセル、ロール解除結果などの運用ログをまとめるチャンネルです。未設定時は従来どおり実行チャンネルへ送ります。 |
| `form_channel` | フォームボタンを設置するチャンネルです。 |
| `form_send_channel` | フォーム入力内容を転送するチャンネルです。 |
| `moderator_role` | 相談・苦情フォームの転送時にメンションするモデレーターロールです。 |
| `call_wait_enabled` | 通話待機システムを有効・無効にします。 |
| `call_wait_role` | 希望者が2人以上集まったとき、一時的に付与するロールです。 |
| `call_wait_prompt_channel` | 定時募集メッセージを送るチャンネルです。ボタン募集の作成パネル自体は `call_wait_notice_channel` に常設されます。 |
| `call_wait_notice_channel` | ボタン募集パネル、匿名のボタン募集、集合通知、VC開始時の自動取消通知を送るチャンネルです。 |
| `call_wait_voice_category` | 毎時ちょうどに、すでに2人以上いるか確認するVCカテゴリです。 |
| `call_wait_interval_minutes` | `30`、`45`、`60` 分から選べます。毎日JST 0:00基準の固定スロットで実行します。 |

`/setting` を使うにはサーバー管理権限が必要です。

待機時間オプション:

| オプション | 単位 | 省略時 | 説明 |
| --- | --- | --- | --- |
| `transfer_wait_seconds` | 秒 | 30 | 振り分け後、VC転送を始めるまでの待機時間です。 |
| `notice_wait_minutes` | 分 | 25 | 終了通知を送るまでの待機時間です。 |
| `role_remove_wait_minutes` | 分 | 150 | 終了通知を送った後、参加者ロールを解除するまでの待機時間です。 |

いずれも `0` を指定できます。
`0` の場合、その待機は行わずすぐ次の処理へ進みます。

### おすすめ話題

話題は1つのリストで管理し、`/splitvc` 後に子VCへ表示する話題パネルで利用します。

初期状態では、次の話題が登録されています。

```text
最近の趣味
最近やろうと思っていること
休みの日にやりがちなこと
最近あったちょっとよかったこと
最近食べておいしかったもの
買ってよかったもの
今ほしいと思ってるもの
今ハマってるもの
```

#### `/kokuchi`

会話練習会の告知を投稿します。
`channel` を省略した場合は、`/setting kokuchi announcement_channel:...` で設定したチャンネルに投稿します。
`overview_channel` を省略した場合は、`/setting kokuchi overview_channel:...` で設定したチャンネルを使います。
告知時刻は `/setting kokuchi event_time:HH:mm`（未設定時は21:00）で設定できます。告知本文には話題を含めません。

```text
/kokuchi weekday:火曜日 channel:#告知
```

投稿形式:

```text
本日は火曜日！
21:00から会話練習会です！
（概要は #概要 から）

ただ雑談したい方はもちろん、少しずつ会話に慣れていきたいという方にも参加していただきたいです！
時間の都合が合う方はぜひご参加ください！！
```

告知の30分前の事前案内、20分前の集合VC開放、5分前の集合リマインダーは、設定した告知時刻から自動計算します。
開催予定時刻の30分前には、`/kokuchi` の告知送信先へ次の案内を送ります。

```text
30分前です！ぜひご参加ください！
```

`gathering_voice_channel` が設定されている場合、`/kokuchi` を送信した日の開催予定時刻20分前（JST）に、その集合VCの@everyone表示・接続権限を許可します。対象VCは告知時に保存されるため、再起動後も開放予定を復帰できます。
開催予定時刻の5分前には、`/kokuchi` を送信したチャンネルへ次の集合開始メッセージを送ります。

```text
@ロール @ロール 会話練習会の集合が開始しました！ #集合VC からぜひご参加ください！5分後に締め切られます
```

`/splitvc` の転送が完了し、参加者ロール付与が終わった後は、最初の話題とグループごとの発話順を送信します。

終了時には、途中参加者を含むユニークな参加人数を入れて、告知送信先へ次のようにお礼を送信します。

```text
ご参加いただきありがとうございました！！
今回の参加人数はx人でした！

やってみての意見や苦情等があれば
 <#1513457664041160765> からお願いします！

次回(x曜日)もぜひご参加ください！
```

```text
@参加者ロール
今日の最初の話題：
「最近の趣味」

話す量は一言くらいで大丈夫です！
まずは以下の順番で、一人ずつ軽く話してみてください。
言葉がまとまらなかったら、順番を後ろに回しても大丈夫です。

【練習部屋.1】
1. ユーザーA
2. ユーザーB
3. ユーザーC

【練習部屋.2】
1. ユーザーD
2. ユーザーE
3. ユーザーF

ひとことずつ話した後は自由に会話してください！
```

発話順は、グループごとにランダムで決まります。
ユーザー名はメンションではなく表示名で出します。
送信先は `/setting splitvc post_split_wadai_channel:...` で指定できます。未設定時は `/splitvc` を実行したチャンネルへ送ります。

#### `/addwadai`

話題を追加します。

```text
/addwadai content:好きな季節は？
```

追加と削除にはサーバー管理権限が必要です。

#### `/showwadai`

登録されている話題を添え字付きで表示します。

```text
/showwadai
```

表示例:

```text
話題リスト
1. 最近の趣味
2. 最近やろうと思っていること
3. 休みの日にやりがちなこと
```

#### `/delwadai`

`/showwadai` に表示された添え字で話題を削除します。

```text
/delwadai target:2
```

上の例では、2番目の話題を削除します。
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
会話練習会の最初の話題にちょうどいい話題があればぜひ！
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

### ボタン募集

ボタン募集パネルは、設定した `call_wait_notice_channel` の最下部に常設されます。ユーザーが `募集を作成` を押すと、自分だけに見える作成画面が開きます。

作成画面では次を指定できます。

- `掲載終了時刻`: JSTの次の15分区切りから2時間後まで
- `予定通話時間`: なし / 30分間 / 1時間
- `@通話へのメンション`: しない / する
- `ひとこと`: 任意、300文字まで

作成される募集は「人が集まったらすぐ」方式だけです。募集者は初期参加者になり、別のユーザーが `参加希望` を押すと設定した確認時間のカウントダウンが始まります。確認時間中は参加者本人だけが `参加をキャンセル` できます。

確認時間が過ぎてBot以外の参加者が2人以上なら、`call_wait_role` を対象者へ付与し、同じ `call_wait_notice_channel` に集合通知を送ります。成功後の公開メッセージには作成者名・参加者一覧を表示しません。成立しなかった募集は自動で削除されます。

公開ボタンは `参加希望` と `募集を取り消す` です。募集者が取り消す場合は確認を求め、他のユーザーが取り消しを押した場合は募集者だけに操作可能な案内を返します。

### VC集合フォーム

VC集合フォームは、`voice_reminder_child_category`で指定したカテゴリ内のPB子VC、または設定された監視VCに2人以上集まったときに開始します。

- 開始時に送信先へ参加者ロールをメンションし、話題フォームボタン付きの集合メッセージを1回送ります。
- 開始時に設定した送信先へ参加者ロールをメンションした開始通知を送ります。`voice_reminder_enabled:false` の場合はこの公開通知を送りませんが、参加者ロールの付与・解除は継続します。
- `voice_participant_role` が設定されている場合、対象VC内の参加者へロールを付与します。
- 30分ごとの確認メッセージは送信しません。
- 対象VCが2人未満になった場合、5分待ってからセッションを終了します。5分以内に2人以上へ戻った場合はセッションを継続します。
- 対象VCが2人未満になってから10分後に、対象セッションを終了します。10分以内に2人以上へ戻った場合は終了を取り消し、ロール付与を継続します。
- セッション終了時、他の有効なVCセッションにいないメンバーから参加者ロールを解除します。
- Botが付与した参加者ロールは記録され、再起動時に現在のVC参加状況を照合します。再起動中に離脱して条件を満たさなくなったメンバーのロールも解除します。
- `voice_reminder_child_category` で指定したカテゴリ内のVC単体で6人以上になると、自動振り分け提案を送ります。
- `voice_reminder_child_category` が未設定の場合は、`child_category`、または指定したPB親VCのカテゴリから判定します。
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

`call_wait_interval_minutes` で設定した30分・45分・60分間隔ごとに、次回のJST固定スロット向けの雑談希望者を募集します。45分間隔では `00:00`、`00:45`、`01:30` のように毎日JST 0:00を基準にします。
ただし `/kokuchi` 実行日は、JST 20:00〜21:59の定時募集と希望者確認30分後の再確認による新規募集を停止します。そのため21時・22時開始向けの定時募集は送信しません。
募集はボタン式に統一されています。次のメッセージと時刻入りの参加ボタン、常設のキャンセルボタンを送ります。

```text
【定時募集】
11時から雑談したい方は、下のボタンを押してください。
11:00時点で複数人が集まっていたらメンションでお知らせします！

現在の参加予定者数：x人
```

時刻が5:00の場合、本文とボタンでは `5時` と表示し、先頭に `0` は付けません。
`x` には現在の参加予定人数を表示し、参加・キャンセル操作のたびに更新します。
メッセージ下の `参加をキャンセル` ボタンは常に表示します。参加予定でない人が押した場合は、参加予定を変更せず、その旨を本人だけに通知します。
希望ボタン、キャンセルボタン、興味ありボタン、人数不足によるリセットが発生した場合は、`log_channel` に操作ユーザー、現在の希望者リスト、現在の興味ありメンバーを送ります。

募集の対象時刻に、Bot以外で2人以上がボタンから希望していた場合、その人たちへ `call_wait_role` で設定したロールを付与します。
その後、`call_wait_voice_category` 内のVCにBot以外の参加者が2人以上入ったことを確認してから、`call_wait_notice_channel` に次の集合通知を送ります。

```text
@通話希望者 雑談希望者が複数人集まりました！VCへの参加お願いします！
```

付与したロールは、希望者確認から30分後に自動解除します。
希望者が2人以上いた直後の同じ時刻には、次回分の募集メッセージは送りません。
希望者確認から30分後に `call_wait_voice_category` 内のVC参加人数を確認し、Bot以外の参加者が2人未満なら、次のJST固定スロット向けの募集メッセージを送ります。
対象時刻に希望者が2人未満の場合、古い募集メッセージを削除し、希望者カウントをリセットして、次の固定スロット向けの募集メッセージを新しく送ります。

`call_wait_voice_category` に設定したVCカテゴリ内に、定時処理の時点でBot以外の参加者が2人以上いる場合は、募集メッセージは送らず、残っている募集メッセージがあれば削除します。
この場合、募集メッセージ送信先へ次の固定スロットの募集を出さなかった理由を送ります。希望者確認30分後の再確認で2人以上いた場合も同様です。
理由メッセージは募集メッセージと同じ扱いで、次に募集メッセージまたは新しい理由メッセージを送るときに古いものを削除します。
このカテゴリ内VC人数の確認だけでロール付与や集合通知は行いません。集合通知の対象は、あくまで募集メッセージのボタンで希望した人だけです。

再デプロイ直後やイベント前など、定時を待たずに募集メッセージを出したい場合は、管理者が次を実行します。

```text
/sendcallwait
```

このコマンドで送った募集メッセージも、次のJST固定スロットに通常どおりボタン参加者の確認、削除、次回分への更新が行われます。

### ボタン募集システム

`call_wait_notice_channel` の最下部に、次の常設パネルを表示します。

```text
下のボタンから募集を作成すると、募集内容と参加ボタンを含む匿名の募集メッセージが送信されます。
参加ボタンが押されると、参加者と募集作成者へ招集メンションが送られます。
成立しなかった募集は自動で削除されます。
```

パネルの `募集を作成` ボタンから開く入力画面では、掲載終了時刻、予定通話時間（なし / 30分間 / 1時間）、`@通話へのメンション` の有無、300文字以内のひとことを指定できます。掲載終了時刻はJSTの次の15分区切りから2時間後までです。募集タイプの選択はありません。

募集本文には作成者名・参加者一覧・ユーザーIDを表示しません。ひとこと内のメンションも通知されない形に変換されます。公開ボタンは `参加希望` と `募集を取り消す`、参加者本人だけに表示する操作は `参加をキャンセル` です。

募集作成者は初期参加者です。別のユーザーが `参加希望` を押すと、`otebo_quick_confirm_seconds` 秒の確認時間が始まり、その間は参加者本人が取り消せます。確認時間を過ぎてBot以外の参加者が2人以上なら、`call_wait_role` を対象者へ付与し、次の集合通知を `call_wait_notice_channel` へ送ります。

```text
@通話希望者 雑談募集が成立しました！VCへの参加お願いします！
```

成立時は募集メッセージを削除し、`call_wait_role` は20分後に世代番号を確認してから解除します。予定通話時間を指定していた場合は、成立後に同じVCへ2人以上集まった時点で既存のVCステータス処理を開始します。募集の掲載終了、VC開始、別の定時募集との統合、作成者による取消しでは、募集メッセージと一時状態を安全に回収します。

### `/splitvc`

```text
/splitvc
```

オプション:

| オプション | 型 | 省略時 | 説明 |
| --- | --- | --- | --- |
| `channel` | ボイスチャンネル | 実行者が入っているVC | 対象のボイスチャンネルを指定します。 |
| `shuffle` | 真偽値 | `true` | 旧オプションです。現在は使いません。 |
| `include_bots` | 真偽値 | `false` | Botユーザーもグループ分けに含めます。 |
| `private` | 真偽値 | `false` | 結果を自分だけに表示します。 |

使い方の例:

- 自分が入っているVCをランダムに分ける: `/splitvc`
- 指定したVCを分ける: `/splitvc channel:一般`
- 結果を自分だけに表示する: `/splitvc private:true`
- Botも含めて分ける: `/splitvc include_bots:true`

`/setting splitvc mode:direct`（既定）では、設定した `child_category` 配下に `会話練習会(番号)` というVCを必要数作成します。各VCはカテゴリの権限を継承し、参加人数上限だけ5人（4人＋読み上げ）にします。`mode:partybeast` を選ぶと、従来のPB親VC経由方式を使えます。

`/splitvc` 実行後は次の処理を行います。

1. 振り分け結果を送信します。
2. 参加者ロールは、各メンバーをVCへ転送したタイミングで付与します。
3. 30秒待機し、待機中だけ転送キャンセルボタンを表示します。
4. direct modeでは必要数のVCを先に作成してから各グループのメンバーを移動します。PB互換モードでは各グループから1人をPB親VCへ移動し、PBが作成した子VCへ残りを移動します。
5. 転送と参加者ロール付与が終わった後、集合VCのeveryone接続権限を不可に戻します。
6. 最初の話題とグループごとの発話順を送信します。
7. 25分後に参加者ロールへメンションして終了通知を送信します。
8. 終了通知の150分後に参加者ロールを解除します（設定で変更可能）。
9. `announcement_channel` で指定した告知・スタート案内送信先に、参加のお礼と次回案内を送信します。

direct modeの空VCは、終了通知後に参加者が0人になった時点で削除します。終了通知前に空になった場合は5分間の猶予を置き、終了通知時刻と重なる場合は終了通知を優先します。Bot再起動後も保存済みの空室タイマーと終了通知時刻を復元します。

最初の話題と発話順の送信先は `/setting splitvc post_split_wadai_channel:...` で指定できます。
未設定の場合は、従来どおり `/splitvc` を実行したチャンネルへ送ります。

参加者ロール解除時のお礼メッセージは、`announcement_channel` で指定した告知・スタート案内送信先へ送ります。
意見・苦情案内のチャンネルは `/setting splitvc split_feedback_channel:...` で指定できます。
未設定時は `<#1513457664041160765>` を使います。

`waiting_vc_category` が設定されている場合、振り分け完了後に待機VCを自動作成し、10分間だけ途中参加者を監視します。

- 待機VCは `/setting splitvc waiting_vc_category:...` で設定したカテゴリ内に作成されます。
- 待機VC名は `/setting splitvc waiting_vc_name:...` で変更できます。
- `announcement_channel` が設定されている場合、待機VC作成後に次の案内を送ります。

```text
集合開始から5分経ったのでスタートします
スタート後も10分までなら途中参加を受け付けているのでぜひ#途中参加部屋からご参加ください！
```

- 参加者が待機中VCにいて、3人以下の子VCがある場合は、その子VCへ1人転送します。
- 3人以下の子VCがない場合は、待機中VCに3人集まるまで待ちます。
- 待機中VCに3人集まったら、その3人を新規グループとしてPB親VC経由で新規子VCへ転送します。
- 10分経過時点で2人以下の子VCがある場合に限り、途中参加の受付を延長します。3人の子VCは転送先にはなりますが、延長理由にはなりません。
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
- `GuildMembers`
- `GuildMessages`
- `MessageContent`
- `GuildVoiceStates`

Botに必要な主な権限:

- 対象サーバーでスラッシュコマンドを使えること
- 結果を投稿するチャンネルにメッセージを送れること
- 対象ボイスチャンネルを閲覧できること
- PB親VCへ接続できること
- メンバーをVC間で移動できること
- 参加者ロールを付与・解除できること
- 途中参加用の待機VCを作成・削除できること
- 話題フォームの内容をVCチャンネルステータスへ設定できること
- ボタン募集の `call_wait_notice_channel` で、表示・送信・埋め込み・履歴閲覧・メッセージ管理ができること
- `call_wait_role` より上位のロールを持ち、Manage Roles権限があること

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
- `shuffle` オプションは現在ありません。分け方は常にランダムです。
