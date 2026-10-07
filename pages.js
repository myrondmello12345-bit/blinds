// BLINDS web pages (v58): a home page, a privacy policy and terms.
// Google's sign-in setup and the Play Store listing both ask for these links.
//   /about    home page
//   /privacy  privacy policy
//   /terms    terms of service
// Set these environment variables on Render so the pages show your details:
//   CONTACT_EMAIL    where players can reach you (required for the policy to be complete)
//   DEVELOPER_NAME   your name or studio name (default "the BLINDS developer")
const UPDATED = '6 October 2026';

const esc = (t) => String(t).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function shell(title, body) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">` +
    `<meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)}</title>` +
    `<style>body{font-family:system-ui,Segoe UI,Roboto,sans-serif;background:#173B4D;color:#FFF7E8;margin:0;line-height:1.55}` +
    `main{max-width:720px;margin:0 auto;padding:40px 22px 60px}h1{color:#FFD33D;font-size:2rem;margin:0 0 6px}` +
    `h2{color:#FFD33D;font-size:1.15rem;margin:30px 0 6px}a{color:#5CD6FF}p,li{font-size:1rem}` +
    `.small{color:#B9C9CF;font-size:.9rem}nav{margin:22px 0 0}nav a{margin-right:18px}</style></head>` +
    `<body><main>${body}<nav><a href="/about">Home</a><a href="/privacy">Privacy policy</a><a href="/terms">Terms</a></nav></main></body></html>`;
}

function contactLine() {
  const email = process.env.CONTACT_EMAIL || '';
  return email
    ? `<a href="mailto:${esc(email)}">${esc(email)}</a>`
    : `the contact address shown on the game's store page`;
}

function about() {
  const dev = esc(process.env.DEVELOPER_NAME || 'the BLINDS developer');
  return shell('BLINDS', `<h1>BLINDS</h1><p class="small">A 5 x 5 race-to-five-lines game for two players.</p>` +
    `<p>Fill your board, take turns calling numbers, and be the first to complete five lines. ` +
    `Play on one device, against a friend with a room code, or against a random opponent online.</p>` +
    `<p>BLINDS is made by ${dev}. Questions: ${contactLine()}.</p>`);
}

function privacy() {
  const dev = esc(process.env.DEVELOPER_NAME || 'the BLINDS developer');
  return shell('BLINDS - Privacy policy', `<h1>Privacy policy</h1><p class="small">BLINDS, by ${dev}. Last updated ${UPDATED}.</p>` +
    `<h2>The short version</h2><p>BLINDS keeps your progress on your own device. We do not run adverts, we do not use analytics or tracking, and we do not sell or share personal information.</p>` +
    `<h2>What stays on your device</h2><p>Your player name, coins, diamonds, trophies, level, purchased items, settings and any username-and-password account you create in the game are saved only on your device. Passwords are stored in a scrambled (salted and hashed) form. Uninstalling the game or clearing its data removes all of this.</p>` +
    `<h2>Online matches</h2><p>When you play online, your device connects to our match server. The server passes game messages between you and your opponent: your board, the numbers called, pause and rematch requests, preset chat messages, and the player name, character, trophy count and level shown on the match-up screen. These messages are passed on and not stored.</p>` +
    `<p>Like any internet service, the server sees your IP address while you are connected. It is used only to keep the service running and to limit abuse (for example, too many connections from one address), is kept in memory for a few minutes, and is not written to a database. Our hosting provider (Render) may keep its own technical logs.</p>` +
    `<h2>Sign in with Google or Discord</h2><p>If you choose to sign in with Google or Discord, you sign in on that company's own page. We receive only your account's ID number and display name. Our server holds them for up to 10 minutes so the game can collect them, then discards them. The game saves them on your device to remember that you are signed in. We never see your password, email address, contacts or anything else in your account.</p>` +
    `<h2>Purchases</h2><p>Diamond packs are bought through Google Play. Google handles the payment; we never see your card or payment details. The game is told only that a purchase was completed.</p>` +
    `<h2>Children</h2><p>BLINDS does not knowingly collect personal information from children. The game has no free-text chat; online messages are chosen from a fixed list.</p>` +
    `<h2>Your choices</h2><p>You can play without signing in and without playing online. To remove your data, clear the game's data or uninstall it. To withdraw a Google or Discord sign-in, sign out in the game and remove BLINDS from your Google or Discord account's connected apps.</p>` +
    `<h2>Changes</h2><p>If this policy changes, the new version will be posted on this page with a new date.</p>` +
    `<h2>Contact</h2><p>Questions or requests: ${contactLine()}.</p>`);
}

function terms() {
  const dev = esc(process.env.DEVELOPER_NAME || 'the BLINDS developer');
  return shell('BLINDS - Terms', `<h1>Terms of service</h1><p class="small">BLINDS, by ${dev}. Last updated ${UPDATED}.</p>` +
    `<h2>Playing the game</h2><p>BLINDS is provided for personal entertainment. Please play fairly: do not cheat, use modified versions of the game online, or try to disrupt the match server or other players.</p>` +
    `<h2>Coins, diamonds and items</h2><p>Coins, diamonds and cosmetic items exist only inside the game, have no cash value and cannot be exchanged or refunded for money except where the law or Google Play's refund rules require it. They are stored on your device and are lost if the game's data is deleted.</p>` +
    `<h2>Online play</h2><p>Online play depends on a server that may be unavailable at times. If an opponent leaves or the connection drops, a computer player may take over so the match can finish.</p>` +
    `<h2>No warranty</h2><p>The game is provided "as is", without guarantees that it will always be available or free of errors, to the extent the law allows.</p>` +
    `<h2>Contact</h2><p>${contactLine()}</p>`);
}

// Returns true when it handled the request.
function handle(req, res) {
  const path = String(req.url || '').split('?')[0].replace(/\/+$/, '') || '/';
  const pages = { '/about': about, '/privacy': privacy, '/terms': terms };
  if (!pages[path]) return false;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'public, max-age=300' });
  res.end(pages[path]());
  return true;
}

module.exports = { handle };
