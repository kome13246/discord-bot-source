#!/usr/bin/env node
// Usage: set DISCORD_TOKEN and CHANNEL_ID then `node scripts/try-channel-status.js`
// This script PATCHes the channel endpoint with a `status` property to observe the API response.

(async () => {
  const token = process.env.DISCORD_TOKEN;
  const channelId = process.env.CHANNEL_ID;

  if (!token || !channelId) {
    console.error("Require DISCORD_TOKEN and CHANNEL_ID environment variables.");
    console.error("Example: DISCORD_TOKEN=bot-token CHANNEL_ID=123 node scripts/try-channel-status.js");
    process.exit(1);
  }

  const fetchFn = globalThis.fetch || (typeof require === 'function' ? (() => {
    try { return require('node-fetch'); } catch (e) { return null; }
  })() : null);

  if (!fetchFn) {
    console.error("No global fetch available. Run on Node 18+ or install node-fetch (npm install node-fetch) and re-run.");
    process.exit(1);
  }

  const fetch = fetchFn.fetch ? fetchFn.fetch.bind(fetchFn) : fetchFn;

  const url = `https://discord.com/api/v10/channels/${channelId}`;

  const testPayloads = [
    { payload: { status: "テストステータス" }, label: "PATCH with status" },
    { payload: { topic: "試験用トピック" }, label: "PATCH with topic (text channels only)" },
    { payload: { name: "try-channel-status-test" }, label: "PATCH with name" },
  ];

  for (const item of testPayloads) {
    console.log(`\n--- ${item.label} ---`);
    try {
      const res = await fetch(url, {
        method: 'PATCH',
        headers: {
          Authorization: `Bot ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(item.payload),
      });

      console.log(`HTTP ${res.status} ${res.statusText}`);
      let bodyText;
      try {
        bodyText = await res.text();
        console.log('Body:', bodyText);
      } catch (e) {
        console.error('Failed to read body:', e.message);
      }
    } catch (error) {
      console.error('Request failed:', error.message);
    }
  }

  console.log('\nDone.');
})();
