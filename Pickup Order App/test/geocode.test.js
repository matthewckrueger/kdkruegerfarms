const test = require('node:test');
const assert = require('node:assert');
const { search } = require('../lib/geocode');

function fakeFetch(responses, seen = []) {
  return async (url, opts) => {
    seen.push({ url: String(url), opts });
    const body = responses[new URL(url).host];
    if (body === undefined) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => body };
  };
}

test('searches Google Places near the map center', async () => {
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  const seen = [];
  const results = await search('NAPA Brookings', { lat: 44.3, lng: -96.8 }, fakeFetch({
    'places.googleapis.com': { places: [
      { displayName: { text: 'NAPA Auto Parts' }, formattedAddress: '1 6th St, Brookings, SD 57006', location: { latitude: 44.31, longitude: -96.78 } },
    ] },
  }, seen));
  assert.equal(results[0].name, 'NAPA Auto Parts');
  assert.equal(results[0].lat, 44.31);
  assert.equal(seen[0].opts.headers['X-Goog-Api-Key'], 'test-key');
  assert.equal(JSON.parse(seen[0].opts.body).locationBias.circle.center.latitude, 44.3);
});

test('friendly errors when Google is down or not set up', async () => {
  process.env.GOOGLE_MAPS_API_KEY = 'test-key';
  await assert.rejects(search('x', null, fakeFetch({})), /not responding/);
  delete process.env.GOOGLE_MAPS_API_KEY;
  await assert.rejects(search('x', null, fakeFetch({})), /not set up/);
});
