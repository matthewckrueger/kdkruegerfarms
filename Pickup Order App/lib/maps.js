// Reading map pins out of pasted Google/Apple Maps links.
const { cleanPin } = require('./dispatch');

// Find coordinates inside a Google/Apple Maps URL. Prefers the exact place
// (!3d..!4d..) over the map's viewport center (@lat,lng).
function coordsFromUrl(u) {
  let s = u;
  try { s = decodeURIComponent(u); } catch {}
  const m = s.match(/!3d(-?\d+\.\d+)!4d(-?\d+\.\d+)/) ||
    s.match(/[?&](?:q|query|ll|daddr|destination|sll)=(-?\d+\.\d+),\s*(-?\d+\.\d+)/) ||
    s.match(/@(-?\d+\.\d+),(-?\d+\.\d+)/);
  return m ? cleanPin(m[1], m[2]) : null;
}
const SHORT_LINK = /^https:\/\/(maps\.app\.goo\.gl|goo\.gl\/maps|maps\.google\.com|www\.google\.com\/maps|maps\.apple\.com|maps\.apple)\b/i;

module.exports = { coordsFromUrl, SHORT_LINK };
