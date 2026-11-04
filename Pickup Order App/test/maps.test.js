const test = require('node:test');
const assert = require('node:assert');
const { coordsFromUrl, SHORT_LINK } = require('../lib/maps');

test('reads pins from Google and Apple Maps links', () => {
  // Place page: exact pin (!3d!4d) wins over the map view (@)
  assert.deepEqual(
    coordsFromUrl('https://www.google.com/maps/place/NAPA/@44.30,-96.80,15z/data=!4m6!3m5!1s0x0:0x0!8m2!3d44.3114!4d-96.7984'),
    { lat: 44.3114, lng: -96.7984 });
  assert.deepEqual(coordsFromUrl('https://www.google.com/maps/search/?api=1&query=44.5,-96.25'), { lat: 44.5, lng: -96.25 });
  assert.deepEqual(coordsFromUrl('https://maps.google.com/?q=44.5%2C-96.25'), { lat: 44.5, lng: -96.25 });
  assert.deepEqual(coordsFromUrl('https://maps.apple.com/?ll=44.1,-96.2&q=Shop'), { lat: 44.1, lng: -96.2 });
  assert.deepEqual(coordsFromUrl('https://www.google.com/maps/@44.2,-96.3,17z'), { lat: 44.2, lng: -96.3 });
  assert.equal(coordsFromUrl('https://maps.app.goo.gl/abc123'), null);
  assert.ok(SHORT_LINK.test('https://maps.app.goo.gl/abc123'));
  assert.ok(!SHORT_LINK.test('https://evil.example.com/maps'));
});
