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
      .setName("shuffle")
      .setDescription("ランダムに並べ替えるか")
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
  .setDescription("PB連携に使うロール・チャンネル・通知文を設定します")
  .addSubcommand((subcommand) =>
    subcommand
      .setName("set")
      .setDescription("PB連携設定を保存します")
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
          .setDescription("PBが子VCを作るカテゴリ。未設定なら自動検出します")
          .addChannelTypes(ChannelType.GuildCategory)
          .setRequired(false),
      )
      .addChannelOption((option) =>
       option
        .setName("waiting_vc_category")
        .setDescription("待機VC作成先カテゴリ")
        .addChannelTypes(ChannelType.GuildCategory)
        .setRequired(false)
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
          .setName("bosyu_channel")
          .setDescription("/bosyuを使用できるチャンネル")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false),
      )
      .addRoleOption((option) =>
        option
          .setName("bosyu_mention_role")
          .setDescription("/bosyuでメンションするロール")
          .setRequired(false),
      )
      .addRoleOption((option) =>
        option
          .setName("voice_participant_role")
          .setDescription("VC参加者に付与するロール")
          .setRequired(false),
      )
      .addBooleanOption((option) =>
        option
          .setName("voice_reminder_enabled")
          .setDescription("VCリマインダー機能を有効または無効にする")
          .setRequired(false),
      )
      .addChannelOption((option) =>
        option
          .setName("voice_reminder_channel")
          .setDescription("リマインダー送信先テキストチャンネル")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false),
      )
      .addChannelOption((option) =>
        option
          .setName("voice_topic_channel")
          .setDescription("旧設定。現在の話題フォームでは使用しません")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false),
      )
      .addChannelOption((option) =>
        option
          .setName("voice_reminder_parent_channel")
          .setDescription("リマインダー対象のPB親ボイスチャンネル")
          .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
          .setRequired(false),
      )
      .addChannelOption((option) =>
        option
          .setName("voice_reminder_child_category")
          .setDescription("リマインダー対象のPB子VCカテゴリ。未設定ならPB子VCカテゴリを自動検出します")
          .addChannelTypes(ChannelType.GuildCategory)
          .setRequired(false),
      )
      .addChannelOption((option) =>
        option
          .setName("wadaich")
          .setDescription("毎朝6時のおすすめ話題を送るテキストチャンネル")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false),
      )
      .addChannelOption((option) =>
        option
          .setName("post_split_wadai_channel")
          .setDescription("/splitvc後のおすすめ話題を送るテキストチャンネル")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false),
      )
      .addChannelOption((option) =>
        option
          .setName("split_start_channel")
          .setDescription("/splitvc後のスタート・途中参加案内を送るテキストチャンネル")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false),
      )
      .addChannelOption((option) =>
        option
          .setName("log_channel")
          .setDescription("運用ログをまとめるテキストチャンネル")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false),
      )
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
          .setDescription("フォーム送信内容の転送先テキストチャンネル")
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
    subcommand.setName("show").setDescription("現在のPB連携設定を表示します"),
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
      .setDescription("時間を入力してください。例: 1時間、30分、〇〇まで（省略可）")
      .setRequired(false)
      .setMaxLength(100),
  )
  .addStringOption((option) =>
    option
      .setName("purpose")
      .setNameLocalizations({ ja: "名目" })
      .setDescription("名目を入力してください。例: ゲーム、作業、雑談（省略可）。入力するとVC名として設定されます。")
      .setRequired(false)
      .setMaxLength(100),
  );

export const addWadaiCommand = new SlashCommandBuilder()
  .setName("addwadai")
  .setDescription("おすすめ話題を追加します")
  .addIntegerOption((option) =>
    option
      .setName("category")
      .setDescription("1:大まかな話題 2:最近ベース 3:思考実験・ディベート")
      .addChoices(
        { name: "1 大まかな話題", value: 1 },
        { name: "2 最近ベースの話題", value: 2 },
        { name: "3 思考実験・ディベート", value: 3 },
      )
      .setRequired(true),
  )
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
      .setDescription("削除対象。例: 1-2")
      .setRequired(true)
      .setMaxLength(20),
  );

export const sendWadaiCommand = new SlashCommandBuilder()
  .setName("sendwadai")
  .setDescription("本日のお薦め話題を今すぐ投稿します");

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
  sendWadaiCommand.toJSON(),
  setupFormsCommand.toJSON(),
];
