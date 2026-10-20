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

## v60 - leaderboards

`leaderboard.js` (new file, required by `server.js`) serves:

- `POST /lb/submit` - the game posts a signed-in player's trophies and wins
- `GET /lb/top?board=trophies|wins&n=50` - the top list

Only Google / Discord sign-ins can post: sign-in now hands the game a token
signed by the server. Set `LEADERBOARD_SECRET` to any long random text so
tokens stay valid if you ever change the Google or Discord keys (without it
the secret is derived from those keys).

Scores come from players' phones. The server caps a new account's first
score (2000 trophies / 100 wins), lets a score grow by only about one win a
minute, takes one score per account every 15 s, and 20 a minute per
address. A patient cheater can still climb at a real player's speed.

**Keeping the boards** - Render's free plan has no permanent disk, so by
default the boards live in memory and are wiped on every deploy or restart.
To keep them, create a free Redis database at upstash.com and add on Render:

| Variable | Value |
|---|---|
| `UPSTASH_REDIS_REST_URL` | the database's REST URL |
| `UPSTASH_REDIS_REST_TOKEN` | the database's REST token |

`/health` shows `"leaderboard": {"storage": "upstash"}` when it is in use.

Measured on a machine limited to the free plan (0.1 CPU): 1000 signed-in
players each posting a score every ~20 s plus 20 board views a second -
95% of requests answered within 10 ms; 5000 players plus 50 views a second -
95% within 0.4 s. Boards refresh within 2 s of a new score.

## v61 - Daily BLINDS board, usage stats

New and changed files: analytics.js (new), leaderboard.js, pages.js, server.js, package.json, test/daily.test.js. Upload them all and redeploy.

### Usage stats dashboard
1. In Render, open the service, go to Environment and add `STATS_KEY`. Its value can be any long password, for example a random string of 20+ characters. Keep it private.
2. Save. Render restarts the server.
3. Open `https://blinds-3kcj.onrender.com/stats?key=YOUR_STATS_KEY` in your browser to see the dashboard. `/stats.json?key=...` gives the same numbers as JSON.

Without `STATS_KEY` the dashboard is switched off. The game still sends counts and the server still keeps them.

### Keep everything across restarts (recommended now)
Without Upstash, the TOP 100 boards, the Daily BLINDS boards and the usage counts live in memory and are wiped every time Render restarts or redeploys the server. Set `UPSTASH_REDIS_REST_URL` and `UPSTASH_REDIS_REST_TOKEN` (see the v60 section) and all three are kept. Usage counts are written in batches every 30 seconds, so they use very few Upstash commands.

### New endpoints
- `POST /lb/daily/submit`, `GET /lb/daily/top?day=N`: the Daily BLINDS board. One result per player per day; only today's or yesterday's results are accepted; scores must be 16-25; each day is deleted after 8 days.
- `POST /lb/delete {token}`: DELETE ACCOUNT in the game calls this to remove the player from the TOP 100 boards.
- `POST /a/batch`: usage events. Limited to 30 batches a minute per address and 6 per install, 60 events and 8 KB per batch, and 3000 distinct labels a day.
- `GET /health` now also shows `analytics` numbers.

## v62 - friends

New and changed files: friends.js (new), server.js, pages.js, package.json, test/friends.test.js. Upload them all and redeploy. No new environment variables are needed.

- `POST /fr/hello` - the game says "I'm here" every few seconds while it is open (every 6 s on the menus with friends, 4 s on the friends screen, 25 s in a match, 12 s with no friends yet) and gets back how its friends are doing, invites, and who added it.
- `POST /fr/add`, `/fr/invite`, `/fr/answer`, `/fr/cancel` - adding a friend and invites. An invite is only passed on for a room that is open and waiting, to a player who is online, not in a match, and has the inviter on their list (or was added by them in the last 15 minutes).
- Who is online and invites are kept in memory (they last about a minute). Friend codes, names and "X added you" notes go into Upstash when it is set up, so they survive restarts.
- Busy server: when hellos arrive faster than 120 a second, every reply asks the games to slow down (up to 5x) until it settles. `FRIENDS_TARGET_RATE` changes the 120 on a bigger instance.
- `/health` now has a `friends` section (online, hellos, adds, invites, slow).

Load test on a machine limited to Render's free size (0.1 CPU, 512 MB): 3,000 / 6,000 / 10,000 players with the game open, adding friends and inviting - 95% of hellos answered within 2 ms, 99% within 100 ms, server memory under 120 MB. Without the slow-down, 3,000 players overloaded it.

### Update check (v62)
`GET /version` returns `{"latest": LATEST_VERSION, "min": MIN_VERSION}` (0 when not set). Games from v62 on show an UPDATE button when `latest` is higher than their own version, and a "please update" message when `min` is higher. After you release v63, set `LATEST_VERSION=63` on Render. Use `MIN_VERSION` only when old games must update (for example if online matches change).

## v63 - cloud saves

New file `cloud.js` (plus `server.js`, `pages.js`, `package.json`, `test/cloud.test.js`). Redeploy.
Nothing new to set on Render: it uses the same `UPSTASH_REDIS_REST_URL` / `UPSTASH_REDIS_REST_TOKEN`
as the leaderboard and friends. Without Upstash the backups live in memory and vanish on every
restart, so make sure Upstash is set (check `/health`: `"cloud": {"storage": "upstash", ...}`).

Endpoints (all POST, JSON): `/cs/save {token, data}`, `/cs/load {token}`, `/cs/delete {token}`.
`token` is the signed token a Google / Discord sign-in gets, so only signed-in players have a
backup and nobody can read anyone else's. Limits: one save per account every 8 s, 48 KB per save,
60 calls per address per minute. The game saves at most about once a minute while playing.

Upstash use: one command per save or load. Roughly one save per match, so 1,000 daily players
playing 10 matches is about 10,000 commands a day. Keep an eye on the Upstash dashboard as
the game grows.

## v64 - sign-in fix

`auth.js` changed: the sign-in answer can now be collected again for 2 minutes (the game asks
again if its first answer got lost), and the "You are signed in!" page has a BACK TO BLINDS
button. Optional setting: `APP_PACKAGE` (default `com.dmello.blinds`) - the Android package the
button opens. Redeploy.

## v76 - rewarded ads switch

**Redeploy the relay** to get `/config` and `/app-ads.txt`.

| Variable | Value |
|---|---|
| `ADS_ON` | `true` turns ads on in every copy of the game (next time it starts). Remove it or set `false` to turn them off. |
| `ADMOB_REWARDED_ID` | your AdMob **rewarded ad unit** ID, `ca-app-pub-XXXXXXXXXXXXXXXX/YYYYYYYYYY`. Until it is set the game shows Google's test ad (no money). |
| `ADMOB_PUB_ID` | your AdMob publisher ID, `pub-XXXXXXXXXXXXXXXX`. Makes `https://blinds-3kcj.onrender.com/app-ads.txt` work. |

`npm test` also runs `test/ads.test.js`.
