#!/usr/bin/env node
// Usage: set DISCORD_TOKEN and CHANNEL_ID then `node scripts/try-voice-status-rest.js`
// This attempts to PUT to /channels/:id/voice-status with a JSON { status } body and prints the response.

(async () => {
  const token = process.env.DISCORD_TOKEN;
  const channelId = process.env.CHANNEL_ID;
  const statusText = process.env.STATUS_TEXT ?? "雑談中です";

  if (!token || !channelId) {
    console.error("Require DISCORD_TOKEN and CHANNEL_ID environment variables.");
    console.error("Example: DISCORD_TOKEN=bot-token CHANNEL_ID=123 STATUS_TEXT=\"雑談中です\" node scripts/try-voice-status-rest.js");
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
  const url = `https://discord.com/api/v10/channels/${channelId}/voice-status`;

  console.log(`PUT ${url}`);
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: statusText }),
    });

    console.log(`HTTP ${res.status} ${res.statusText}`);
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      console.log('Response JSON:', JSON.stringify(json, null, 2));
    } catch {
      console.log('Response Text:', text);
    }
  } catch (err) {
    console.error('Request failed:', err.message);
  }

  console.log('\nAlso trying PATCH /channels/:id with same status field for comparison');
  try {
    const url2 = `https://discord.com/api/v10/channels/${channelId}`;
    const res2 = await fetch(url2, {
      method: 'PATCH',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ status: statusText }),
    });
    console.log(`HTTP ${res2.status} ${res2.statusText}`);
    const text2 = await res2.text();
    try {
      const json2 = JSON.parse(text2);
      console.log('PATCH Response JSON:', JSON.stringify(json2, null, 2));
    } catch {
      console.log('PATCH Response Text:', text2);
    }
  } catch (err) {
    console.error('PATCH request failed:', err.message);
  }

  console.log('\nDone.');
})();
