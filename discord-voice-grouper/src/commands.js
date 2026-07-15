import { ChannelType, SlashCommandBuilder } from "discord.js";

export const splitVoiceCommand = new SlashCommandBuilder()
  .setName("splitvc")
  .setDescription("ボイスチャンネル内のメンバーを3人ずつに分けます")
  .addChannelOption((option) =>
    option
      .setName("channel")
      .setDescription("対象のボイスチャンネル。省略時は自分が入っているチャンネル")
      .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
      .setRequired(false),
  )
  .addBooleanOption((option) =>
    option
      .setName("include_bots")
      .setDescription("Botも対象に含めるか")
      .setRequired(false),
  )
  .addBooleanOption((option) =>
    option
      .setName("private")
      .setDescription("結果を自分だけに表示するか")
      .setRequired(false),
  );

export const settingCommand = new SlashCommandBuilder()
  .setName("setting")
  .setDescription("Botの設定を機能ごとに保存します")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("splitvc")
      .setDescription("/splitvc とPB連携設定を保存します")
      .addRoleOption((option) =>
        option
          .setName("participant_role")
          .setDescription("参加者に付与するロール")
          .setRequired(false),
      )
      .addChannelOption((option) =>
        option
          .setName("parent_channel")
          .setDescription("PBの親ボイスチャンネル")
          .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
          .setRequired(false),
      )
      .addChannelOption((option) =>
        option
          .setName("child_category")
          .setDescription("PBが子VCを作るカテゴリ")
          .addChannelTypes(ChannelType.GuildCategory)
          .setRequired(false),
      )
      .addChannelOption((option) =>
        option
          .setName("kokuchi_overview_channel")
          .setDescription("/kokuchiで使う概要案内チャンネル")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false),
      )
      .addChannelOption((option) =>
        option
          .setName("waiting_vc_category")
          .setDescription("途中参加用の待機VCを作成するカテゴリ")
          .addChannelTypes(ChannelType.GuildCategory)
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName("waiting_vc_name")
          .setDescription("自動作成する待機VCの名前")
          .setMaxLength(100)
          .setRequired(false),
      )
      .addChannelOption((option) =>
        option
          .setName("post_split_wadai_channel")
          .setDescription("/splitvc後の最初の話題・発話順の送信先")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false),
      )
      .addChannelOption((option) =>
        option
          .setName("split_start_channel")
          .setDescription("/kokuchi告知・/splitvc後のスタート案内送信先")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false),
      )
      .addChannelOption((option) =>
        option
          .setName("gathering_voice_channel")
          .setDescription("/kokuchi当日20:40に接続許可する集合VC")
          .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
          .setRequired(false),
      )
      .addChannelOption((option) =>
        option
          .setName("split_feedback_channel")
          .setDescription("終了後の意見・苦情案内に表示するチャンネル")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName("finish_message")
          .setDescription("終了通知で送信する内容")
          .setMaxLength(1000)
          .setRequired(false),
      )
      .addIntegerOption((option) =>
        option
          .setName("transfer_wait_seconds")
          .setDescription("転送開始までの待機秒数。省略時は30秒")
          .setMinValue(0)
          .setRequired(false),
      )
      .addIntegerOption((option) =>
        option
          .setName("notice_wait_minutes")
          .setDescription("終了通知までの待機分数。省略時は25分")
          .setMinValue(0)
          .setRequired(false),
      )
      .addIntegerOption((option) =>
        option
          .setName("role_remove_wait_minutes")
          .setDescription("終了通知後のロール解除待機分数。省略時は3分")
          .setMinValue(0)
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("bosyu")
      .setDescription("/b の募集設定を保存します")
      .addChannelOption((option) =>
        option
          .setName("bosyu_channel")
          .setDescription("/bを使用できるテキストチャンネル")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false),
      )
      .addRoleOption((option) =>
        option
          .setName("bosyu_mention_role")
          .setDescription("/bでメンションするロール")
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("shugo")
      .setDescription("VC集合フォーム設定を保存します")
      .addRoleOption((option) =>
        option
          .setName("voice_participant_role")
          .setDescription("VC参加者に付与するロール")
          .setRequired(false),
      )
      .addBooleanOption((option) =>
        option
          .setName("voice_reminder_enabled")
          .setDescription("VCリマインダーを有効または無効にする")
          .setRequired(false),
      )
      .addChannelOption((option) =>
        option
          .setName("voice_reminder_parent_channel")
          .setDescription("VCリマインダー対象のPB親VC")
          .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
          .setRequired(false),
      )
      .addChannelOption((option) =>
        option
          .setName("voice_reminder_child_category")
          .setDescription("VCリマインダー対象のPB子VCカテゴリ")
          .addChannelTypes(ChannelType.GuildCategory)
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("wadai")
      .setDescription("会話練習会告知の送信先設定を保存します")
      .addChannelOption((option) =>
        option
          .setName("wadaich")
          .setDescription("/kokuchi告知・/splitvc後のスタート案内送信先")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("logs")
      .setDescription("運用ログ設定を保存します")
      .addChannelOption((option) =>
        option
          .setName("log_channel")
          .setDescription("運用ログをまとめるテキストチャンネル")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("forms")
      .setDescription("フォーム設定を保存します")
      .addChannelOption((option) =>
        option
          .setName("form_channel")
          .setDescription("フォームボタンを設置するテキストチャンネル")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false),
      )
      .addChannelOption((option) =>
        option
          .setName("form_send_channel")
          .setDescription("フォーム入力内容の転送先テキストチャンネル")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false),
      )
      .addRoleOption((option) =>
        option
          .setName("moderator_role")
          .setDescription("相談・苦情フォームでメンションするモデレーターロール")
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("callwait")
      .setDescription("通話待機システム設定を保存します")
      .addBooleanOption((option) =>
        option
          .setName("call_wait_enabled")
          .setDescription("通話待機システムを有効または無効にする")
          .setRequired(false),
      )
      .addRoleOption((option) =>
        option
          .setName("call_wait_role")
          .setDescription("通話希望者に一時付与するロール")
          .setRequired(false),
      )
      .addChannelOption((option) =>
        option
          .setName("call_wait_prompt_channel")
          .setDescription("募集メッセージを送るテキストチャンネル")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false),
      )
      .addChannelOption((option) =>
        option
          .setName("call_wait_notice_channel")
          .setDescription("集合通知を送るテキストチャンネル")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false),
      )
      .addChannelOption((option) =>
        option
          .setName("otebo_preview_channel")
          .setDescription("時間指定のお手軽募集を30分前まで掲載するチャンネル")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false),
      )
      .addChannelOption((option) =>
        option
          .setName("call_wait_voice_category")
          .setDescription("参加者確認に使うVCカテゴリ")
          .addChannelTypes(ChannelType.GuildCategory)
          .setRequired(false),
      )
      .addStringOption((option) =>
        option
          .setName("call_wait_mode")
          .setDescription("募集方式")
          .addChoices(
            { name: "リアクション式", value: "reaction" },
            { name: "ボタン式", value: "button" },
          )
          .setRequired(false),
      )
      .addBooleanOption((option) =>
        option
          .setName("call_wait_bosyu_notice_enabled")
          .setDescription("集合通知後に募集ロールへ途中参加案内を送るか")
          .setRequired(false),
      )
      .addIntegerOption((option) =>
        option
          .setName("otebo_quick_confirm_seconds")
          .setDescription("お手軽募集の即時募集でキャンセルを受け付ける秒数。省略時は30秒")
          .setMinValue(0)
          .setRequired(false),
      ),
  )
  .addSubcommand((subcommand) =>
    subcommand.setName("show").setDescription("現在のBot設定を表示します"),
  );

export const bCommand = new SlashCommandBuilder()
  .setName("b")
  .setDescription("募集メッセージを送信します")
  .addStringOption((option) =>
    option
      .setName("note")
      .setNameLocalizations({ ja: "ひとこと" })
      .setDescription("ひとことを入力してください。例: 遠慮せずご参加ください！")
      .setRequired(true)
      .setMaxLength(200),
  )
  .addStringOption((option) =>
    option
      .setName("time")
      .setNameLocalizations({ ja: "時間" })
      .setDescription("時間を入力してください。例: 1時間、30分、未定")
      .setRequired(false)
      .setMaxLength(100),
  )
  .addStringOption((option) =>
    option
      .setName("purpose")
      .setNameLocalizations({ ja: "名目" })
      .setDescription("名目を入力してください。入力すると参加中VC名として設定されます")
      .setRequired(false)
      .setMaxLength(100),
  )
  .addBooleanOption((option) =>
    option
      .setName("anonymous")
      .setDescription("実行者が分からない形で募集を送る")
      .setRequired(false),
  );

export const addWadaiCommand = new SlashCommandBuilder()
  .setName("addwadai")
  .setDescription("おすすめ話題を追加します")
  .addStringOption((option) =>
    option
      .setName("content")
      .setDescription("追加する話題の内容")
      .setRequired(true)
      .setMaxLength(300),
  );

export const showWadaiCommand = new SlashCommandBuilder()
  .setName("showwadai")
  .setDescription("登録されているおすすめ話題を表示します");

export const delWadaiCommand = new SlashCommandBuilder()
  .setName("delwadai")
  .setDescription("添え字で指定したおすすめ話題を削除します")
  .addStringOption((option) =>
    option
      .setName("target")
      .setDescription("削除対象。例: 2")
      .setRequired(true)
      .setMaxLength(20),
  );

export const kokuchiCommand = new SlashCommandBuilder()
  .setName("kokuchi")
  .setDescription("会話練習会の告知を投稿します")
  .addStringOption((option) =>
    option
      .setName("weekday")
      .setDescription("告知に入れる曜日")
      .addChoices(
        { name: "火曜日", value: "火" },
        { name: "土曜日", value: "土" },
      )
      .setRequired(true),
  )
  .addChannelOption((option) =>
    option
      .setName("overview_channel")
      .setDescription("概要案内として表示するチャンネル")
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setRequired(false),
  )
  .addChannelOption((option) =>
    option
      .setName("channel")
      .setDescription("告知を送るチャンネル。省略時は /setting wadai の設定を使用")
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setRequired(false),
  )
  .addBooleanOption((option) =>
    option
      .setName("send_topic")
      .setDescription("最初の話題を告知と次回/splitvc後に送るか。省略時は送る")
      .setRequired(false),
  );

export const sendCallWaitCommand = new SlashCommandBuilder()
  .setName("sendcallwait")
  .setDescription("通話待機システムの募集メッセージを今すぐ送信します");

export const sendOteboCommand = new SlashCommandBuilder()
  .setName("sendotebo")
  .setDescription("お手軽募集の作成ボタン付きメッセージを送信します");

export const setupFormsCommand = new SlashCommandBuilder()
  .setName("setupforms")
  .setDescription("話題提供・提案要望・相談苦情フォームのボタンを設置します");

export const commands = [
  splitVoiceCommand.toJSON(),
  settingCommand.toJSON(),
  bCommand.toJSON(),
  addWadaiCommand.toJSON(),
  showWadaiCommand.toJSON(),
  delWadaiCommand.toJSON(),
  kokuchiCommand.toJSON(),
  sendCallWaitCommand.toJSON(),
  sendOteboCommand.toJSON(),
  setupFormsCommand.toJSON(),
];
