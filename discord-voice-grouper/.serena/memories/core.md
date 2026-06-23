# Project core
- Discord bot source is under `src/`; main runtime is `src/bot.js`, slash command definitions are `src/commands.js`, registration entrypoint is `src/register-commands.js`.
- Persistent per-guild configuration is JSON at `data/settings.json`, managed by `src/settings-store.js`; environment variables are fallback defaults.
- Main features: `/splitvc` grouping and PB voice-channel transfer, VC reminder/topic forms, daily topics/forms, DISBOARD bump reminder, and hourly call-wait recruitment.
- User-facing configuration/docs are in `.env.example` and `README.md`.
- Read `mem:tech_stack` for runtime details, `mem:conventions` for implementation patterns, and `mem:task_completion` before finishing code changes.