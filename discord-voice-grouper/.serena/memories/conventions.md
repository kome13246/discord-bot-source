# Conventions
- ESM imports and semicolon-terminated JavaScript; two-space indentation.
- Slash command schemas are centralized in `src/commands.js`; interaction handling and scheduling are centralized in `src/bot.js`.
- Guild settings are updated with partial patches via `saveGuildSettings`; persisted values override environment fallback.
- Configuration renames should preserve old stored/env values as silent fallbacks where practical, while removing obsolete options from command schemas and docs.
- Discord messages should set `allowedMentions` explicitly when mentions are intentional or must be suppressed.
- Japanese user-visible text is used throughout.