# BLINDS relay deployment

The Godot project is configured to use:

`wss://blinds-3kcj.onrender.com/ws`

Render should run:

- Build command: `npm install`
- Start command: `node server.js`

The relay server listens on `process.env.PORT` and binds to `0.0.0.0`, which is
required by Render. The `/` URL is a simple health check; the game uses `/ws`.

Do not put the Godot project files in this repository. This repository should
contain the contents of `relay-server/`, especially `server.js` and
`package.json`.

## v16 notes

- **Redeploy the relay.** v16's `server.js` fixes a crash (a single `null`
  packet used to kill the process) and adds validation, a message-kind
  whitelist, a 16 KB packet cap, per-socket rate limiting and stricter room
  teardown. The v16 game still works against the old relay, but you won't get
  the protection until you redeploy.
- **Cold starts.** On Render's free plan the service sleeps when idle and can
  take 30-60 s to wake. The game now pings `/` when the PLAY screen opens
  (`Net.warm_up()`) and waits up to 45 s, but for a smooth first match use a
  paid instance, or an external uptime monitor hitting `/` every ~10 minutes.
- **Tests.** `npm install && npm test` starts the server on a spare port and
  checks pairing, room teardown, malformed packets (including bare `null`),
  oversize packets, floods and normal traffic.

## v38 - sign in with Google / Discord

`auth.js` adds the sign-in endpoints (`/auth/providers`, `/auth/start`,
`/auth/poll`, `/auth/callback/<provider>`). A provider only switches on when
its keys are set as environment variables on Render:

| Variable | Value |
|---|---|
| `PUBLIC_URL` | the service's public address, e.g. `https://blinds-3kcj.onrender.com` |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Cloud Console -> APIs & Services -> Credentials -> OAuth client ID (type "Web application") |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | Discord Developer Portal -> your application -> OAuth2 |

Redirect URIs to register with each provider:

- Google: `<PUBLIC_URL>/auth/callback/google`
- Discord: `<PUBLIC_URL>/auth/callback/discord`

Until the keys are set the game shows "not switched on yet" under the Google /
Discord buttons; username + password accounts keep working regardless.
**Redeploy the relay** to pick this up. `npm test` also runs `test/auth.test.js`
(fake provider, no real Google needed).

## v57 - load and attack test, server limits

**Redeploy the relay** to get these. Nothing changes in how you deploy it.

What the server now does on its own:

- refuses connections past a ceiling (default 5000 players) and past 40 from
  one address, before the WebSocket handshake;
- closes a connection that does nothing for 30 s, a player stuck in the
  quick-match queue for 5 min, a host waiting alone for 20 min, and a room
  where nothing has been sent for 10 min;
- limits packets to 4 KB, 40 a second and 16 KB a second per player (a real
  player's busiest second is about 16 packets / 1.3 KB);
- drops a player who has stopped reading instead of holding their data;
- closes a connection that tries more than 8 wrong room codes;
- limits sign-in starts to 10 a minute per address;
- drops half-open web requests after 10 s;
- on shutdown (every deploy) closes every player at once, so their bot takes
  over immediately.

Optional environment variables on Render:

| Variable | Default | Meaning |
|---|---|---|
| `MAX_CONNECTIONS` | 5000 | players connected at the same time |
| `MAX_PER_IP` | 40 | connections from one address |
| `MAX_NEW_PER_IP_PER_MIN` | 120 | new connections a minute from one address |

`https://<your-service>/health` shows live numbers (players, rooms, peak,
refused, kicked, memory). While anyone is connected the same line is written
to the Render log once a minute.

Measured on a test machine limited to the size of Render's instances (not on
Render itself, and without real internet in between):

| Instance size | Players at once | Delay for 95% of moves |
|---|---|---|
| 0.1 CPU / 512 MB (free) | 1000 | 0.05 s |
| 0.1 CPU / 512 MB (free) | 2000 | 0.15 s |
| 0.1 CPU / 512 MB (free) | 4000 | 0.4 s |
| 0.5 CPU / 512 MB | 10000 | 0.05 s |
| 0.5 CPU / 512 MB | 15000 | 0.15 s (set `MAX_CONNECTIONS=20000`) |

Memory was never the limit (about 150 MB at 5000 players); CPU is.

Still true after v57:

- The free plan sleeps when idle; the first player waits 30-60 s (the game
  falls back to a bot match meanwhile).
- It is one process with everything in memory. A deploy or crash ends every
  online match in progress (each player carries on against a bot).
- Someone with thousands of addresses can still fill the 5000 places with
  junk connections for as long as they keep it up; real players then get bot
  matches. The server itself stays up. Proper protection against that is done
  in front of the server (Render / Cloudflare), not in it.
- `npm test` now also runs `test/limits.test.js`.

## v58 - web pages

`pages.js` (new file, required by `server.js`) serves:

- `/about` - home page
- `/privacy` - privacy policy
- `/terms` - terms of service

Environment variables on Render:

| Variable | Meaning |
|---|---|
| `CONTACT_EMAIL` | shown as the contact address on all three pages |
| `DEVELOPER_NAME` | your name or studio name (optional) |

Use these links on Google's OAuth Branding page and in the Play Store listing.
Read the privacy policy before you publish it: it describes what the game does
as of v58 (no adverts, no analytics, progress saved on the device). If you add
adverts, analytics or cloud saves later, it must be updated.
