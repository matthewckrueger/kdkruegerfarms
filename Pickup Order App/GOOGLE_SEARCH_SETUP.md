# Turning on Google search for map pins

The map search in **+ New job** uses Google. To make it work, the app needs a Google
"API key", which is a password that lets the app ask Google Maps for addresses. Setup takes about 10 minutes.

**Cost:** Google gives a free monthly allowance (a few thousand searches a month at the time of writing).
A farm posting jobs every day will normally stay far under that, so it should cost **$0**. Google still
requires a card on file. Step 5 sets up an email alert in case usage ever goes over.

Until the key is added, the search box says "Google search is not set up yet". Dropping a pin by tapping
the map, **Use my location**, and pasting a Google Maps link all work without it.

---

## 1. Create a Google Cloud project
1. Go to **console.cloud.google.com** and sign in with the farm's Google account.
2. At the top, click the **project picker** → **New Project**.
3. Name it `KDKF Pickups` → **Create**, then make sure it's selected at the top.

## 2. Add billing
1. Open the menu (☰) → **Billing**.
2. **Link a billing account** and add a card. You won't be charged unless usage passes the free allowance.

## 3. Turn on the Places API
1. Menu (☰) → **APIs & Services** → **Library**.
2. Search for **Places API (New)** and click **Enable**.
   It must be the one that says **(New)**.

## 4. Create the key
1. **APIs & Services** → **Credentials** → **+ Create credentials** → **API key**.
2. Click **Edit API key** (or the key's name):
   - **API restrictions** → **Restrict key** → tick **Places API (New)** → OK.
   - **Application restrictions:** leave as **None**. The app's server uses the key, not people's browsers.
3. **Save**, then **copy the key** (it starts with `AIza…`).

Keep the key private. Don't text it around or post it anywhere.

## 5. Set a spending alert (recommended)
1. Menu (☰) → **Billing** → **Budgets & alerts** → **Create budget**.
2. Set the amount to **$1** and keep the email alerts on.
   You'll get an email if Google ever starts charging.

## 6. Give the key to the app (Railway)
1. In Railway, click your service → **Variables** → **+ New Variable**.
2. Name: `GOOGLE_MAPS_API_KEY`, Value: paste the key → **Add**.
3. Click **Deploy** if Railway asks you to apply changes.

## 7. Try it
Open the app → **+ New job** → **📍 Drop a pin** → search an address or business, like
`NAPA Brookings`. Pick the right result and the pin lands on it.

If it says "Google search is not responding":
- Check that **Places API (New)** is enabled (step 3).
- Check that the key is restricted to that API and not a different one (step 4).
- Check that billing is linked (step 2).
