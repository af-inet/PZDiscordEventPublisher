import "dotenv/config";
import {
  ActivityType,
  ChannelType,
  Client,
  GatewayIntentBits,
  TextChannel,
} from "discord.js";
import { Rcon } from "rcon-client";

const {
  DISCORD_TOKEN,
  DISCORD_CHANNEL_ID,
  RCON_HOST,
  RCON_PORT,
  RCON_PASSWORD,
  POLL_INTERVAL_MS,
} = process.env;

if (
  !DISCORD_TOKEN || !DISCORD_CHANNEL_ID || !RCON_HOST || !RCON_PORT ||
  !RCON_PASSWORD
) {
  console.error("Missing required environment variables. Check .env.");
  process.exit(1);
}

const POLL_MS = Number(POLL_INTERVAL_MS ?? 10000);
const COMMAND = "luacmd rconevents flush";

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

let lastCount = -1;

async function updateChannelTopicIfChanged(count: number) {
  if (!targetChannel) return;
  if (count === lastCount) return; // only when it changes
  lastCount = count;

  // Only text channels have topics
  if ("setTopic" in targetChannel) {
    try {
      await (targetChannel as TextChannel).setTopic(`Players online: ${count}`);
    } catch (e) {
      console.error("Failed to set topic:", e);
    }
  }
}

async function setPresence(count: number) {
  const name = `${count} survivor${count === 1 ? "" : "s"} online`;
  await client.user?.setPresence({
    activities: [{ name, type: ActivityType.Watching }],
    status: "online",
  });
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Robust-ish parser for Project Zomboid `players` responses.
function parsePlayerCount(resp: string): number {
  const text = resp ?? "";
  // Common header like: "Players connected (3):"
  const m = text.match(/Players?\s+connected\s*\((\d+)\)/i);
  if (m) return Number(m[1]);

  // Fallback: count non-empty lines excluding obvious headers
  const lines = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return 0;

  // If the first line looks like a header, drop it, then count the rest.
  const rest = lines[0].toLowerCase().includes("player")
    ? lines.slice(1)
    : lines;
  return rest.length;
}

// Poll once: connect -> send -> post -> close
async function pollOnce(): Promise<void> {
  // Connect fresh each poll (PZ RCON is often happiest with short-lived sessions)
  let rcon: Rcon | null = null;
  try {
    console.log(`polling ${RCON_HOST}:${RCON_PORT}`);
    rcon = await Rcon.connect({
      host: RCON_HOST!,
      port: Number(RCON_PORT),
      password: RCON_PASSWORD!,
      // Optional: increase if your server can be slow to respond
      timeout: 15000,
    });

    // 1) Query players and update presence
    try {
      const playersResp = await rcon.send("players");
      const count = parsePlayerCount(playersResp ?? "");
      await setPresence(count);
      await updateChannelTopicIfChanged(count);
    } catch (err: any) {
      // Keep running even if players query fails
      if (err.toString().toLowerCase() == "error: connection closed") {
        // Connection closed simply means the server is paused, that's okay - set presence to zero.
        await setPresence(0);
        await updateChannelTopicIfChanged(0);
      } else {
        console.error("RCON poll error:", err);
      }
    }

    const response = await rcon.send(COMMAND);
    const trimmed = (response ?? "").trim();
    // Nothing to post? (If flush returns empty when no events)
    if (!trimmed) {
      console.log("response empty");
      return;
    }
    if (!targetChannel) {
      console.log("targetChannel empty");
      return;
    }
    console.log("response:");
    console.log(response);

    // Ignore if only whitespace or empty
    if (!response || !response.replace(/\s+/g, "")) {
      return;
    }

    const parts = splitMessage(trimmed);
    for (const part of parts) {
      await targetChannel.send(part);
    }
  } catch (err: any) {
    // It's normal to get poll errors, for example when the server is in "PauseEmpty" mode, it won't respond to RCON events.
    // In this case we can lower the pressure a bit by sleeping for a while.
    if (err.toString().toLowerCase() == "error: connection closed") {
      console.log("Connection closed.");
    } else {
      console.error("RCON poll error:", err);
    }
    console.log("waiting 1 minute...");
    await sleep(1000 * 60);

    // TODO: we might want to catch different errors and report them to discord.
    // if (targetChannel) {
    //   await targetChannel.send(`⚠️ RCON poll failed: \`${(err as Error)?.message ?? String(err)}\``).catch(() => {});
    // }
  } finally {
    try {
      await rcon?.end();
    } catch {
      // ignore
    }
  }
}

client.once("ready", async () => {
  try {
    const ch = await client.channels.fetch(DISCORD_CHANNEL_ID!);
    if (!ch || ch.type !== ChannelType.GuildText) {
      throw new Error(
        "DISCORD_CHANNEL_ID is not a text channel I can post in.",
      );
    }
    targetChannel = ch as TextChannel;

    console.log(
      `Logged in as ${client.user?.tag}. Polling every ${POLL_MS} ms.`,
    );
    // Kick off immediately, then on interval
    await pollOnce();
    timer = setInterval(() => {
      pollOnce().catch((e) => console.error("pollOnce interval error:", e));
    }, POLL_MS);
  } catch (e) {
    console.error("Failed to initialize channel:", e);
    process.exit(1);
  }
});

client.on("error", (e) => {
  console.error("Discord client error:", e);
});

process.on("SIGINT", async () => {
  console.log("Shutting down...");
  if (timer) clearInterval(timer);
  try {
    await client.destroy();
  } catch {}
  process.exit(0);
});

client.login(DISCORD_TOKEN);
