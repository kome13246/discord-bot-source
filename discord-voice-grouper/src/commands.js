import { ChannelType, PermissionFlagsBits, SlashCommandBuilder } from "discord.js";

export const setupProfileCommand = new SlashCommandBuilder()
  .setName("setup-profile").setDescription("プロフィール登録ボタンを設置します")
  .setDefaultMemberPermissions(PermissionFlagsBits.Administrator);

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
      .setName("zatudan")
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
          .setName("voice_reminder_parent_channel_2")
          .setDescription("VC繝ｪ繝槭う繝ｳ繝繝ｼ蟇ｾ雎｡縺ｮPB隕ｪVC 2")
          .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
          .setRequired(false),
      )
      .addChannelOption((option) =>
        option
          .setName("voice_reminder_parent_channel_3")
          .setDescription("VC繝ｪ繝槭う繝ｳ繝繝ｼ蟇ｾ雎｡縺ｮPB隕ｪVC 3")
          .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
          .setRequired(false),
      )
      .addChannelOption((option) =>
        option
          .setName("voice_reminder_parent_channel_4")
          .setDescription("VC繝ｪ繝槭う繝ｳ繝繝ｼ蟇ｾ雎｡縺ｮPB隕ｪVC 4")
          .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice)
          .setRequired(false),
      )
      .addChannelOption((option) =>
        option
          .setName("voice_reminder_parent_channel_5")
          .setDescription("VC繝ｪ繝槭う繝ｳ繝繝ｼ蟇ｾ雎｡縺ｮPB隕ｪVC 5")
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
      .setName("kokuchi")
      .setDescription("会話練習会告知の送信先設定を保存します")
      .addChannelOption((option) =>
        option
          .setName("announcement_channel")
          .setDescription("/kokuchi告知・/splitvc後のスタート案内送信先")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false),
      )
      .addChannelOption((option) => option.setName("overview_channel").setDescription("告知で案内する概要チャンネル").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false))
      .addStringOption((option) => option.setName("event_time").setDescription("開催予定時刻（JST、HH:mm）").setRequired(false))
      .addChannelOption((option) => option.setName("gathering_voice_channel").setDescription("開催時に使用する集合VC").addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice).setRequired(false))
      .addRoleOption((option) => option.setName("mention_role").setDescription("告知時に追加するメンションロール").setRequired(false))
      .addRoleOption((option) => option.setName("remove_mention_role").setDescription("告知メンションから外すロール").setRequired(false)),
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
      .addChannelOption((option) =>
        option
          .setName("review_send_channel")
          .setDescription("会話練習会の感想を運営へ送るチャンネル")
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false),
      )
      .addRoleOption((option) =>
        option
          .setName("moderator_role")
          .setDescription("相談・苦情フォームでメンションするモデレーターロール")
          .setRequired(false),
      )
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
      .addIntegerOption((option) =>
        option
          .setName("call_wait_interval_minutes")
          .setDescription("定時募集の間隔（JST 0:00基準）")
          .addChoices(
            { name: "30分", value: 30 },
            { name: "45分", value: 45 },
            { name: "60分", value: 60 },
          )
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
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("status_board")
      .setDescription("Bot運用ステータスボードを設置・解除します")
      .addChannelOption((option) => option
        .setName("channel")
        .setDescription("ステータスボードを設置するテキストチャンネル")
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
        .setRequired(false))
      .addBooleanOption((option) => option
        .setName("remove")
        .setDescription("既存のステータスボードを解除します")
        .setRequired(false)),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("vc_control")
      .setDescription("VCコントロールパネルを設定します")
      .addChannelOption((option) => option.setName("category").setDescription("対象カテゴリ").addChannelTypes(ChannelType.GuildCategory).setRequired(false))
      .addRoleOption((option) => option.setName("notify_role").setDescription("VCコントロール通知ロール").setRequired(false))
      .addBooleanOption((option) => option.setName("exit_schedule_keep_message").setDescription("退出予定の通知メッセージを残す").setRequired(false)),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("fukyo")
      .setDescription("布教チャンネルの週替わりテーマを設定します")
      .addChannelOption((option) => option.setName("channel").setDescription("テーマの投稿先チャンネル").addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement).setRequired(false))
      .addBooleanOption((option) => option.setName("enabled").setDescription("毎週月曜日6:00（JST）の自動投稿を有効にします").setRequired(false)),
  )
  .addSubcommand((subcommand) =>
    subcommand
      .setName("profile")
      .setDescription("自己紹介チャンネルを設定します")
      .addChannelOption((option) =>
        option
          .setName("introduction_channel")
          .setDescription("自己紹介を公開するテキストチャンネル")
          .addChannelTypes(ChannelType.GuildText)
          .setRequired(false),
      ),
  );

export const showReviewCommand = new SlashCommandBuilder()
  .setName("show")
  .setDescription("会話練習会の感想集計を表示します")
  .addSubcommand((subcommand) => subcommand
    .setName("review")
    .setDescription("感想を集計します")
    .addStringOption((option) => option.setName("question").setDescription("集計する質問").setRequired(true).addChoices(
      { name: "1：どれくらい喋れた？", value: "1" },
      { name: "2：時間はどう感じた？", value: "2" },
      { name: "3：会話の練習になった？", value: "3" },
      { name: "all：すべて", value: "all" },
    ))
    .addIntegerOption((option) => option.setName("recent").setDescription("直近の開催回数").setMinValue(1).setRequired(false)));

export const botStatusCommand = new SlashCommandBuilder()
  .setName("botstatus")
  .setDescription("Bot運用ステータスを確認・更新・管理します")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild)
  .addSubcommand((subcommand) => subcommand.setName("show").setDescription("現在状態をEphemeral表示します"))
  .addSubcommand((subcommand) => subcommand.setName("refresh").setDescription("状態を再取得してボードを更新します"))
  .addSubcommand((subcommand) => subcommand.setName("manage").setDescription("管理操作メニューを表示します"));

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
  .addIntegerOption((option) =>
    option
      .setName("set")
      .setDescription("告知を自動送信する時刻")
      .setMinValue(0)
      .setMaxValue(24)
      .setRequired(false),
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
          .setDescription("告知を送るチャンネル。省略時は /setting kokuchi の設定を使用")
      .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
      .setRequired(false),
  );

export const addFukyoCommand = new SlashCommandBuilder()
  .setName("addfukyo")
  .setDescription("布教テーマを追加します")
  .addStringOption((option) => option.setName("theme").setDescription("追加するテーマ").setRequired(true).setMaxLength(50));

export const showFukyoCommand = new SlashCommandBuilder()
  .setName("showfukyo")
  .setDescription("登録されている布教テーマを表示します");

export const delFukyoCommand = new SlashCommandBuilder()
  .setName("delfukyo")
  .setDescription("番号で布教テーマを削除します")
  .addIntegerOption((option) => option.setName("number").setDescription("/showfukyo の番号").setRequired(true).setMinValue(1));

export const sendFukyoCommand = new SlashCommandBuilder()
  .setName("sendfukyo")
  .setDescription("布教テーマを投稿します")
  .addIntegerOption((option) => option.setName("theme_number").setDescription("/showfukyo の番号（省略時は未使用からランダム）").setRequired(false).setMinValue(1));

export const sendCallWaitCommand = new SlashCommandBuilder()
  .setName("sendcallwait")
  .setDescription("通話待機システムの募集メッセージを今すぐ送信します");

export const removeCommand = new SlashCommandBuilder()
  .setName("remove")
  .setDescription("Botが付与した参加者ロールを一括で解除します")
  .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
  .addSubcommand((subcommand) => subcommand
    .setName("role")
    .setDescription("splitvcとVC集合の参加者ロールを一括解除します"));

export const sendOteboCommand = new SlashCommandBuilder()
  .setName("sendotebo")
  .setDescription("お手軽募集の作成ボタン付きメッセージを送信します");

export const setupFormsCommand = new SlashCommandBuilder()
  .setName("setupforms")
  .setDescription("話題提供・提案要望・相談苦情フォームのボタンを設置します");

export const commands = [
  setupProfileCommand.toJSON(),
  splitVoiceCommand.toJSON(),
  settingCommand.toJSON(),
  botStatusCommand.toJSON(),
  showReviewCommand.toJSON(),
  bCommand.toJSON(),
  addWadaiCommand.toJSON(),
  showWadaiCommand.toJSON(),
  delWadaiCommand.toJSON(),
  addFukyoCommand.toJSON(),
  showFukyoCommand.toJSON(),
  delFukyoCommand.toJSON(),
  sendFukyoCommand.toJSON(),
  kokuchiCommand.toJSON(),
  removeCommand.toJSON(),
  sendCallWaitCommand.toJSON(),
  sendOteboCommand.toJSON(),
  setupFormsCommand.toJSON(),
];
