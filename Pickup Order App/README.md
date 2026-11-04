# Pickup Order App (KDKF Pickups)

An Uber-style "ding ding" app for farm pickups and errands. A dispatcher posts a
job, and the app pings drivers **one at a time, in priority order**, until
someone says **"I'll take it."**

## How it works

1. **A dispatcher posts a job.** There are usually one or two dispatchers. They enter
   *what* needs doing, *where*, *when it's due* (with quick buttons like
   "In 1 hr" or "By 5 PM"), and whether it's urgent.
2. **Driver #1 gets pinged** with a lock-screen notification and a sound. They have
   3 minutes to answer (1 minute if the job is urgent). Both times can be changed in Settings.
   - **I'll take it**: the job is theirs, and the dispatcher gets a "Jake took it" alert.
   - **Can't**, or no answer in time: the job rolls to driver #2, then #3, and so on.
3. **If nobody takes it**, the dispatcher is alerted and can tap **📣 Send to everyone**.
   This pings every driver at once, and the first one to say yes gets it.
4. **The driver taps "Picked up" and then "Done".** The dispatcher is notified at each step.
   If something comes up, the driver can tap **Can't do it after all** and the job goes to the next driver.
5. **Repeat pings.** Until the driver answers, they get pinged again every minute (change it in Settings), so a phone on silent buzzes several times.
6. **Due-time alerts.** The driver gets a reminder 30 minutes before the job is due. If the job isn't done by
   the due time, everyone involved gets an **Overdue** alert.

**Pickup and drop-off pins.** Each job can have a **Pick up at** spot and a **Drop off at** spot.
For each one, the dispatcher can type a name and drop an exact pin on a map. To place the pin, they can search Google (address or business;
setup in [GOOGLE_SEARCH_SETUP.md](GOOGLE_SEARCH_SETUP.md)), paste a Google Maps link, tap 🎯 Use my location, or tap the map (🛰 Satellite view helps for field gates and bins).
Drivers get a **🧭 Directions** button for each spot. It opens Apple Maps on iPhone and Google Maps on Android, with a button for the other app too.
Spots you use a lot (NAPA, the co-op, the shop) can be saved as one-tap buttons. The last drop-off is filled in automatically.
Manage saved places under **Settings**.

Every driver on the **Team** list is always in the rotation. There's no on/off switch.
To stop someone getting pinged, remove them from the Team list. A driver who can't go
just taps **Can't** and the job moves to the next person. If you add a new driver while a job is sitting
unclaimed, they get pinged for it right away.

The **Team** tab sets the ping order: use the ▲▼ arrows to choose who gets asked first.

There's no payment tracking or time clock. Drivers still clock in with your existing app.

## Why it's built this way: an installable web app (PWA)

This is a **Progressive Web App**. You send people a link, they tap
**Add to Home Screen**, and it becomes an app icon on their phone that sends real
push notifications, including on the lock screen.

| | This PWA | Native app (App Store / Play Store) | Text messages (SMS) |
|---|---|---|---|
| Lock-screen notifications | ✅ | ✅ | ✅ |
| Accept / decline in one tap | ✅ in app (Android: on the notification itself) | ✅ | Reply "Y" / "N" |
| Cost | Hosting only (~$5–10/mo) | $99/yr Apple + $25 Google + review process | ~1¢ per text (Twilio) + number fees |
| Updates | Instant, for everyone | Resubmit to app stores | n/a |
| Setup per driver | Open link → Add to Home Screen → sign in | Download from the store | Nothing |

**Caveats:**
- **iPhone:** iOS 16.4 or newer is required, and the app **must be opened from the Home Screen
  icon** (not from a Safari tab) before notifications can be turned on. The app shows these
  steps on screen. On iPhone, tapping the notification opens the app, where the big
  Accept / Can't buttons are. The buttons on the notification itself are an Android feature.
- iPhone notifications follow the phone's Silent/Focus settings. A native app is the only way to get
  "critical alert" sounds that break through silent mode.

**Possible next steps:**
- **Text-message backup:** if a driver doesn't open the app, also send them a text through Twilio.
- **Native app:** the same server can sit behind a native app built with Expo/React Native
  later. The dispatch logic stays the same.

## Running it

Requires Node.js 18 or newer.

```bash
cd "Pickup Order App"
npm install
npm start          # http://localhost:3000
npm test           # tests for the ping-the-next-driver logic
```

The first time you open it, you'll create the first dispatcher account (name + PIN).
Then go to **Team** and add the drivers, each with their own PIN.

### Putting it online (required for phones)

Push notifications only work over **HTTPS**. The server also has to run
**all the time**, because it handles the "no answer → next driver" timers. Pick an
always-on host, not a free tier that goes to sleep.

| Option | Cost | Notes |
|---|---|---|
| **Railway** | ~$5/mo | Easiest. Connect GitHub and it deploys. Add a volume for the data. |
| **Render (Starter + disk)** | ~$7–8/mo | Also easy. **Avoid the free tier**: it sleeps when idle and has no disk, so timers and data break. |
| **Fly.io** | ~$2–5/mo | Small VM + volume, pay as you go. A bit more technical. |
| **Farm computer + Cloudflare Tunnel** | $0 (or ~$60–100 one-time for a Raspberry Pi) | Runs on an always-on PC or Pi at the farm. The tunnel gives free HTTPS with no router changes. Goes down if farm power or internet does. |
| **Google Cloud e2-micro / Oracle Cloud Always Free** | $0 | Free small servers, but more setup (Linux, HTTPS). Google's free tier only covers certain US regions. |
| Vercel / Netlify / Firebase / Supabase free tiers | $0 | **Not a fit as-is.** They don't keep a server running for the timers. Would need a rewrite. |

Prices are approximate. Check current pricing before signing up.

**We're using Railway.** Follow the click-by-click guide in [RAILWAY_SETUP.md](RAILWAY_SETUP.md).

**General steps for other hosts:**
1. Create a new service from this GitHub repo, with the root directory set to `Pickup Order App`.
2. Build command: `npm install`. Start command: `npm start`.
3. Add a **persistent disk/volume** mounted at `/data`, and set these environment variables:
   - `DATA_DIR=/data` (where jobs and users are saved)
   - `TZ=America/Chicago` (your time zone, used for due times in notifications)
   - `CONTACT_EMAIL=you@kdkruegerfarms.com` (required by the push services)
4. Optionally, point a subdomain such as `pickups.kdkruegerfarms.com` at it.

You can also run it on any small Linux server or VPS behind HTTPS (Caddy or nginx).

### Getting each driver set up (2 minutes)
1. Text them the link.
2. **iPhone:** open it in Safari → Share → **Add to Home Screen** → open from the new icon.
   **Android:** open it in Chrome → menu → **Install app** (or Add to Home screen).
3. Sign in with their name and PIN.
4. Tap **🔔 Turn on notifications**, then **Send test** to make sure it dings.

## What's in the folder

```
server.js          Web server + API + push notifications
lib/dispatch.js    The ping-one-at-a-time logic (offers, timeouts, broadcast, reminders)
lib/store.js       Saves everything to data/db.json
public/            The phone app (screens, service worker for notifications, icons)
test/              Automated tests for the dispatch logic
```

The data is stored in a single JSON file, which is plenty for a farm crew. Back up
`data/db.json` if you want history. Push notification keys are created
automatically on first run and saved in the same file.
