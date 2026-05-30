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
      .addChannelOption((option) =>
        option
          .setName("voice_topic_channel")
          .setDescription("フォーム送信後の話題投稿先チャンネル")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
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
          .setName("voice_reminder_parent_channel")
          .setDescription("リマインダー対象のPB親ボイスチャンネル")
          .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
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
      .setDescription("名目を入力してください。例: ゲーム、作業、雑談（省略可）")
      .setRequired(false)
      .setMaxLength(100),
  );

export const commands = [
  splitVoiceCommand.toJSON(),
  settingCommand.toJSON(),
  bCommand.toJSON(),
];
