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

export const commands = [splitVoiceCommand.toJSON()];
