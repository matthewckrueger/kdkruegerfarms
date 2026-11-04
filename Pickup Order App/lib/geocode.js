// Address / business search, using Google Places (Text Search).
// Needs GOOGLE_MAPS_API_KEY - see GOOGLE_SEARCH_SETUP.md.
const { cleanPin } = require('./dispatch');

const TIMEOUT = 8000;

async function getJson(fetchFn, url, opts = {}) {
  const r = await fetchFn(url, { ...opts, signal: AbortSignal.timeout(TIMEOUT) });
  if (!r.ok) throw new Error(`${new URL(url).host} ${r.status}`);
  return r.json();
}

// center = { lat, lng } of the map the dispatcher is looking at (for nearby results first)
async function google(q, center, fetchFn) {
  const key = process.env.GOOGLE_MAPS_API_KEY;
  const body = { textQuery: q, regionCode: 'US', maxResultCount: 6 };
  if (center) body.locationBias = { circle: { center: { latitude: center.lat, longitude: center.lng }, radius: 50000 } };
  const out = await getJson(fetchFn, 'https://places.googleapis.com/v1/places:searchText', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Goog-Api-Key': key,
      'X-Goog-FieldMask': 'places.displayName,places.formattedAddress,places.location',
    },
    body: JSON.stringify(body),
  });
  return (out.places || []).map((p) => ({
    name: p.displayName?.text || p.formattedAddress,
    address: p.formattedAddress || '',
    ...cleanPin(p.location?.latitude, p.location?.longitude),
  }));
}

async function search(q, center, fetchFn = fetch) {
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    throw new Error('Google search is not set up yet. You can still tap the map to drop a pin, or paste a Google Maps link.');
  }
  try {
    return (await google(q, center, fetchFn)).filter((r) => r.lat != null);
  } catch {
    throw new Error('Google search is not responding. Try again, or paste a Google Maps link.');
  }
}

module.exports = { search };
