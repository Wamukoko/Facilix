import { test } from "node:test";
import assert from "node:assert/strict";
import { geocodeQuery, clearGeocodeCache } from "../src/geocode.js";

function fakeFetch(json, status = 200) {
  return async (url, opts) => {
    calls.push({ url, opts });
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => json,
    };
  };
}

let calls = [];

test("geocodeQuery returns normalized rows for a hit", async () => {
  clearGeocodeCache();
  calls = [];
  const fetcher = fakeFetch([
    { lat: "-1.2863", lon: "36.7829", display_name: "Kilimani, Nairobi, Kenya" },
    { lat: "0", lon: "0", display_name: null },
  ]);
  const rows = await geocodeQuery("  Kilimani Rd  ", fetcher);
  assert.equal(rows.length, 2);
  assert.equal(rows[0].lat, -1.2863);
  assert.equal(rows[0].lng, 36.7829);
  assert.equal(rows[0].display_name, "Kilimani, Nairobi, Kenya");
  assert.match(calls[0].url, /q=Kilimani%20Rd/);
  assert.match(calls[0].opts.headers["User-Agent"], /FacilixDemo/);
});

test("geocodeQuery drops malformed rows and non-arrays", async () => {
  clearGeocodeCache();
  const fetcher = fakeFetch([{ lat: "nope", lon: "nope" }, { display_name: "x" }]);
  const rows = await geocodeQuery("nowhere", fetcher);
  assert.equal(rows.length, 0);

  const fetcher2 = fakeFetch({ not: "an array" });
  const rows2 = await geocodeQuery("anything else", fetcher2);
  assert.equal(rows2.length, 0);
});

test("geocodeQuery caches per normalized query and never refetches", async () => {
  clearGeocodeCache();
  calls = [];
  const fetcher = fakeFetch([{ lat: "1", lon: "2", display_name: "A" }]);
  await geocodeQuery("  Upper Hill  ", fetcher);
  await geocodeQuery("upper hill", fetcher);
  await geocodeQuery("UPPER HILL", fetcher);
  assert.equal(calls.length, 1, "only the first distinct query hits the network");
});

test("geocodeQuery returns [] for an empty query without fetching", async () => {
  clearGeocodeCache();
  calls = [];
  const fetcher = fakeFetch([]);
  const rows = await geocodeQuery("   ", fetcher);
  assert.equal(rows.length, 0);
  assert.equal(calls.length, 0);
});

test("geocodeQuery rejects on a non-OK geocoder response", async () => {
  clearGeocodeCache();
  const fetcher = fakeFetch({ error: "oops" }, 503);
  await assert.rejects(() => geocodeQuery("somewhere", fetcher), /503/);
});
