import 'dotenv/config';
import {
  ChannelType,
  Client,
  GatewayIntentBits,
  TextChannel,
} from 'discord.js';
import { Rcon } from 'rcon-client';

const {
  DISCORD_TOKEN,
  DISCORD_CHANNEL_ID,
  RCON_HOST,
  RCON_PORT,
  RCON_PASSWORD,
  POLL_INTERVAL_MS,
} = process.env;

if (!DISCORD_TOKEN || !DISCORD_CHANNEL_ID || !RCON_HOST || !RCON_PORT || !RCON_PASSWORD) {
  console.error('Missing required environment variables. Check .env.');
  process.exit(1);
}

const POLL_MS = Number(POLL_INTERVAL_MS ?? 10000);
const COMMAND = 'luacmd rconevents peak';

// --- Discord client setup ---
const client = new Client({
  intents: [GatewayIntentBits.Guilds],
});

let targetChannel: TextChannel | null = null;
let timer: NodeJS.Timeout | null = null;

// Split messages to respect Discord 2000-char limit.
function splitMessage(content: string, maxLen = 1900): string[] {
  const chunks: string[] = [];
  let start = 0;
  while (start < content.length) {
    const end = Math.min(start + maxLen, content.length);
    chunks.push(content.slice(start, end));
    start = end;
  }
  return chunks;
}

// Poll once: connect -> send -> post -> close
async function pollOnce(): Promise<void> {
  // Connect fresh each poll (PZ RCON is often happiest with short-lived sessions)
  let rcon: Rcon | null = null;
  try {
    rcon = await Rcon.connect({
      host: RCON_HOST!,
      port: Number(RCON_PORT),
      password: RCON_PASSWORD!,
      // Optional: increase if your server can be slow to respond
      // timeout: 10000,
    });

    const response = await rcon.send(COMMAND);
    const trimmed = (response ?? '').trim();

    // Nothing to post? (If flush returns empty when no events)
    if (!trimmed) return;

    if (!targetChannel) return;

    console.log(response)

    // Ignore if only whitespace or empty
    if (!response || !response.replace(/\s+/g, '')) {
      return;
    }

    await targetChannel.send(response);

  } catch (err) {
    console.error('RCON poll error:', err);
    // Post a brief error notice to the channel (optional; comment out if too noisy)
    if (targetChannel) {
      await targetChannel.send(`⚠️ RCON poll failed: \`${(err as Error)?.message ?? String(err)}\``).catch(() => {});
    }
  } finally {
    try {
      await rcon?.end();
    } catch {
      // ignore
    }
  }
}

client.once('ready', async () => {
  try {
    const ch = await client.channels.fetch(DISCORD_CHANNEL_ID!);
    if (!ch || ch.type !== ChannelType.GuildText) {
      throw new Error('DISCORD_CHANNEL_ID is not a text channel I can post in.');
    }
    targetChannel = ch as TextChannel;

    console.log(`Logged in as ${client.user?.tag}. Polling every ${POLL_MS} ms.`);
    // Kick off immediately, then on interval
    await pollOnce();
    timer = setInterval(() => {
      pollOnce().catch((e) => console.error('pollOnce interval error:', e));
    }, POLL_MS);
  } catch (e) {
    console.error('Failed to initialize channel:', e);
    process.exit(1);
  }
});

client.on('error', (e) => {
  console.error('Discord client error:', e);
});

process.on('SIGINT', async () => {
  console.log('Shutting down…');
  if (timer) clearInterval(timer);
  try { await client.destroy(); } catch {}
  process.exit(0);
});

client.login(DISCORD_TOKEN);
