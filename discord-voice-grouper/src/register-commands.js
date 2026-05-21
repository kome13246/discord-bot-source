import "./load-env.js";
import { REST, Routes } from "discord.js";
import { commands } from "./commands.js";

const { DISCORD_TOKEN, DISCORD_CLIENT_ID, DISCORD_GUILD_ID } = process.env;

if (!DISCORD_TOKEN || !DISCORD_CLIENT_ID) {
  throw new Error("DISCORD_TOKEN and DISCORD_CLIENT_ID are required.");
}

const snowflakePattern = /^\d{17,20}$/;

if (!snowflakePattern.test(DISCORD_CLIENT_ID)) {
  throw new Error(
    "DISCORD_CLIENT_ID must be a numeric Discord application client ID.",
  );
}

if (DISCORD_GUILD_ID && !snowflakePattern.test(DISCORD_GUILD_ID)) {
  throw new Error(
    "DISCORD_GUILD_ID must be a numeric Discord server ID. Remove it for global command registration.",
  );
}

const rest = new REST({ version: "10" }).setToken(DISCORD_TOKEN);
const route = DISCORD_GUILD_ID
  ? Routes.applicationGuildCommands(DISCORD_CLIENT_ID, DISCORD_GUILD_ID)
  : Routes.applicationCommands(DISCORD_CLIENT_ID);

const scope = DISCORD_GUILD_ID ? `guild ${DISCORD_GUILD_ID}` : "global";

console.log(`Registering slash commands for ${scope}...`);
await rest.put(route, { body: commands });
console.log("Slash commands registered.");
