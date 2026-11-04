# Putting KDKF Pickups online with Railway

This takes about 20 minutes. When you're done, the app will live at
**https://pickups.kdkruegerfarms.com**.

You'll need:
- Your GitHub login
- A login for wherever `kdkruegerfarms.com` is managed (GoDaddy, Squarespace, Google/Squarespace Domains, Cloudflare, etc.)
- A credit card for Railway's Hobby plan (about $5/month, shared by all your apps)

> **Before you start:** Railway deploys from a branch of the GitHub repo. The app
> should be merged into **main** first, so updates go out from one place.
> (If it isn't merged yet, you can pick the `claude/pickup-order-app-concept-o9qk4w`
> branch in step 3 instead.)

---

## 1. Create a Railway account
1. Go to **railway.com** and choose **Login → Continue with GitHub**.
2. Choose the **Hobby** plan and add your card.

## 2. Create the project from GitHub
1. Click **New Project → Deploy from GitHub repo**.
2. If asked, click **Configure GitHub App** and give Railway access to the
   **kdkruegerfarms** repository (only that repo is fine).
3. Pick **matthewckrueger/kdkruegerfarms**.

The first build may fail. That's expected, because Railway is looking at the
top of the repo instead of the app's folder. The next step fixes it.

## 3. Point it at the app folder
Click the new service box, then go to **Settings**:
- **Source → Root Directory:** `/Pickup Order App`
- **Source → Branch:** `main` (or the claude branch, see the note above)

Railway reads `railway.json` in that folder for the start command and the health check.

## 4. Add storage (important!)
Without storage, all jobs and users are **wiped every time the app updates**.

1. Right-click the service box (or press **Ctrl/Cmd + K** and type "volume"),
   then choose **Attach Volume** / **Add Volume**.
2. **Mount path:** `/data`

The app finds the volume automatically. No extra setting is needed.

## 5. Add two settings (Variables tab)
| Name | Value |
|---|---|
| `TZ` | Your time zone, e.g. `America/Chicago` (Central) or `America/Denver` (Mountain) |
| `CONTACT_EMAIL` | Your email. Apple/Google push services require a contact address. |

Railway redeploys after you save.

## 6. Make sure it's running
1. **Settings → Networking → Generate Domain.** You'll get something like
   `kdk-pickups-production.up.railway.app`.
2. Open that link. You should see **"Welcome! Let's set things up."**
3. **Create your dispatcher account right away.** The first person to open
   the site becomes the dispatcher, so don't share the link before you do this.

## 7. Use your own address: pickups.kdkruegerfarms.com
1. In Railway: **Settings → Networking → Custom Domain**, enter
   `pickups.kdkruegerfarms.com`.
2. Railway shows a **CNAME** record, and sometimes also a **TXT** record for verification.
3. Log in to wherever kdkruegerfarms.com is managed → **DNS settings** → add:
   - Type **CNAME**, Name/Host **pickups**, Value = the target Railway showed you
   - Plus the TXT record if Railway listed one
   - *(If your DNS is on Cloudflare: set the cloud to **gray / DNS only**.)*
4. Wait 5–30 minutes. Railway shows a green check, and the secure (https)
   certificate is set up automatically.

This doesn't touch your website or email. It only adds the `pickups` address.

## 8. Get the team set up
1. Open **https://pickups.kdkruegerfarms.com**, sign in, go to **Team**, and add
   each driver with a PIN.
2. Text each driver the link. On their phone:
   - **iPhone:** open in Safari → Share → **Add to Home Screen** → open from the icon
   - **Android:** open in Chrome → menu → **Install app**
   - Sign in → **Turn on notifications** → **Send test**
3. Post a test job and watch it ding. 🔔

---

## Good to know
- **Updates:** any change pushed to the branch redeploys automatically in about 1–2 minutes.
  Data on the volume is kept.
- **Keep it at 1 copy (replica).** Don't scale it up. The app is built to run as a
  single copy.
- **More apps later:** add them as new services in the same Railway account. They share
  the plan, and each gets its own `something.kdkruegerfarms.com`.
- **Backup:** in Railway you can open the volume or use the CLI to download `/data/db.json`.
- **Something wrong?** Click the service → **Deployments → View logs**. If you see
  `WARNING: no Railway volume attached`, redo step 4.
