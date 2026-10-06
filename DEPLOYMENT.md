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
