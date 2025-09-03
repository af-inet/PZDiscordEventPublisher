# rconevents-discord-publisher

This is a simple discord bots designed to be used with:

https://github.com/af-inet/PZRconEvents

## Features

1. poll your Project Zomboid RCON server for events, and then publish them to a discord channel.

2. display the current number of players through the presence and channel topic API

## Usage

Make sure you have a `.env` file with the following settings:

```txt
DISCORD_TOKEN=
DISCORD_CHANNEL_ID=
RCON_HOST=
RCON_PORT=
RCON_PASSWORD=
POLL_INTERVAL_MS=45000
```

POLL_INTERVAL_MS controls how often you poll the RCON server.

Run the bot with deno:

```
deno --allow-env --allow-read --allow-net ./index.ts
```

or compile with typescript and run with node

```
tsc
node ./dist/index.js
```