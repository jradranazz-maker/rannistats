# Turning on push notifications

This is a one-time setup. Afterwards the notifications run themselves, and the
website keeps deploying to GitHub Pages exactly as it does now.

Roughly ten minutes, most of it waiting for installs.

---

## What you're setting up, and why it needs anything at all

Your site is static files. A static file can't notice that a game ended — no
code of yours is running when your phone is in your pocket. So the alerts come
from a small program that lives on Cloudflare's servers and wakes up once a
minute:

```
  jradranazz-maker.github.io/rannistats     ← unchanged. Same repo, same uploads.
            │
            │  "this device wants KC alerts"
            ▼
  rannistats-push.<you>.workers.dev         ← new. ~400 lines, in push-worker/
            │
            │  every minute: ask ESPN what changed
            ▼
        your lock screen
```

It costs nothing. Cloudflare's free tier allows 100,000 requests a day; this
uses about 1,500.

---

## Step 1 — Cloudflare account

Sign up at <https://dash.cloudflare.com/sign-up>. Free plan. No card.

## Step 2 — Install the command-line tool

You need Node.js first (<https://nodejs.org>, the LTS download). Then, in a
terminal — on Windows, press Start and type "powershell":

```powershell
cd $HOME\Downloads\rannistats-upload\push-worker
npx wrangler login
```

A browser window opens to confirm; click Allow. That's the only time you'll log
in.

## Step 3 — Create the storage

This is where device subscriptions and the last-seen scoreboard live:

```powershell
npx wrangler kv namespace create PUSH_KV
```

It prints something like:

```
[[kv_namespaces]]
binding = "PUSH_KV"
id = "8f3c1e2a9b7d4f6081c5a2e3d4b5c6a7"
```

Open `wrangler.toml` and replace `PASTE_YOUR_KV_NAMESPACE_ID_HERE` with that
`id` value. Save.

## Step 4 — Deploy

```powershell
npx wrangler deploy
```

It prints your Worker's address:

```
Published rannistats-push
  https://rannistats-push.jradr.workers.dev
```

**Copy that URL.** Check it works by opening it in a browser — you should see
something like `{"ok":true,"subscriptions":0,"lastCronRun":null}`.

## Step 5 — Tell the website where the Worker is

Open `push-config.json` (it's in the repo root, next to `index.html`) and put
your URL in:

```json
{ "api": "https://rannistats-push.jradr.workers.dev" }
```

Upload that one small file to GitHub the usual way. **You do not need to
re-upload `index.html` for this** — the page reads the address at runtime, so
changing the Worker's address later is a one-line edit to this file.

## Step 6 — Turn it on, on your phone

On iPhone this order matters:

1. Open the site in **Safari** (not Instagram's or another app's browser).
2. Share icon → **Add to Home Screen**.
3. Open RanniStats **from the Home Screen icon**.
4. Tap the **bell** in the header → **Turn on notifications** → Allow.
5. Tap **Send a test**. A notification should arrive within a second or two.

Apple only allows web notifications for apps added to the Home Screen. In a
Safari tab, or in an in-app browser, the bell will tell you so rather than
showing a switch that can't work.

On Android, steps 1–2 are optional; it works in a normal Chrome tab too.

---

## What gets sent

Three independent toggles, each following your favorited teams:

| Toggle | Fires | Volume |
|---|---|---|
| **Final scores** | A game your team played goes final | 1–2 a week per team |
| **Injury news** | ESPN posts an injury story tagged to your team | A few a week |
| **Scoring plays** | Every touchdown and field goal, live | Up to a dozen a game |

Scoring plays default to **off**. They're up to a minute behind the broadcast,
because one minute is as often as Cloudflare will run a scheduled job — fine if
you're following from your phone, annoying if you're watching the game.

Changing your favorite teams updates the alerts automatically; you don't have to
revisit the bell.

---

## Checking on it

- `https://<your-worker>.workers.dev/` — subscriber count and the last time the
  cron ran.
- `npx wrangler tail` — live log of what the Worker is doing, including what it
  decided to send and why.

## If notifications stop

- **On iPhone, check the app is still on the Home Screen.** Deleting and
  re-adding it creates a new subscription; open the bell once to re-register.
- Clearing your browser's site data drops the subscription. Same fix.
- The Worker prunes dead subscriptions automatically: push services answer
  `410 Gone` for a device that's disappeared, which is the only notice anyone
  gets that an app was deleted.

## Privacy

There are no accounts, and the Worker stores no name, email, or device id. What
it keeps per device is the push endpoint URL the browser generated, that
endpoint's encryption keys, your team abbreviations, and three booleans.
Deleting your subscription — the **Turn off** button — erases the record.

Notification payloads are encrypted before they leave the Worker (RFC 8291), so
Apple's and Google's push services relay the alerts without being able to read
them.

The signing keypair that identifies the Worker to those push services is
generated by the Worker itself on first use and kept in its own storage. It is
never printed, copied, or committed — there's no secret for you to handle.
