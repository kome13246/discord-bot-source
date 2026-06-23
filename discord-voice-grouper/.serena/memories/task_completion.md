# Task completion
- Run `node --check` for every changed JavaScript file.
- Run `git diff --check`.
- Inspect focused `git diff` for changed files and ensure unrelated dirty work is preserved.
- When command definitions change, tell the user slash commands must be re-registered with `npm run register` and the bot redeployed/restarted.
- There is currently no npm test or lint script; report this limitation when relevant.