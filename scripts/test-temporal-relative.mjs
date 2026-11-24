#!/usr/bin/env node
import assert from 'node:assert/strict';
import { parseRelativeTemporal, parseTemporalInstant } from '../dist/canon/temporal.js';

console.log('[TEST] Checking parseRelativeTemporal keywords...');
const NOW = 1774350000000; // 2026-03-24T08:20:00.000Z

// 1. Keywords
const rNow = parseRelativeTemporal('now', NOW);
assert.ok(rNow);
assert.equal(rNow.timestamp, NOW);
assert.equal(rNow.direction, 'now');
assert.equal(rNow.offsetMs, 0);

const rYesterday = parseRelativeTemporal('yesterday', NOW);
assert.ok(rYesterday);
assert.equal(rYesterday.timestamp, NOW - 86400000);
assert.equal(rYesterday.direction, 'past');

const rTomorrow = parseRelativeTemporal('tomorrow', NOW);
assert.ok(rTomorrow);
assert.equal(rTomorrow.timestamp, NOW + 86400000);
assert.equal(rTomorrow.direction, 'future');

const rLastWeek = parseRelativeTemporal('last week', NOW);
assert.ok(rLastWeek);
assert.equal(rLastWeek.timestamp, NOW - 7 * 86400000);

const rLastMonth = parseRelativeTemporal('last month', NOW);
assert.ok(rLastMonth);
assert.equal(rLastMonth.timestamp, NOW - 30 * 86400000);

const rLastYear = parseRelativeTemporal('last year', NOW);
assert.ok(rLastYear);
assert.equal(rLastYear.timestamp, NOW - 365 * 86400000);

console.log('[OK] Keywords passed');

console.log('[TEST] Checking verbose relative offsets...');
const r3DaysAgo = parseRelativeTemporal('3 days ago', NOW);
assert.ok(r3DaysAgo);
assert.equal(r3DaysAgo.timestamp, NOW - 3 * 86400000);

const r2HoursAgo = parseRelativeTemporal('2 hours ago', NOW);
assert.ok(r2HoursAgo);
assert.equal(r2HoursAgo.timestamp, NOW - 2 * 3600000);

const r30MinAgo = parseRelativeTemporal('30 minutes ago', NOW);
assert.ok(r30MinAgo);
assert.equal(r30MinAgo.timestamp, NOW - 30 * 60000);

const rIn2Days = parseRelativeTemporal('in 2 days', NOW);
assert.ok(rIn2Days);
assert.equal(rIn2Days.timestamp, NOW + 2 * 86400000);
assert.equal(rIn2Days.direction, 'future');

console.log('[OK] Verbose relative offsets passed');

console.log('[TEST] Checking compact shorthands...');
const rMinus3d = parseRelativeTemporal('-3d', NOW);
assert.ok(rMinus3d);
assert.equal(rMinus3d.timestamp, NOW - 3 * 86400000);

const rMinus2h = parseRelativeTemporal('-2h', NOW);
assert.ok(rMinus2h);
assert.equal(rMinus2h.timestamp, NOW - 2 * 3600000);

const rPlus1w = parseRelativeTemporal('+1w', NOW);
assert.ok(rPlus1w);
assert.equal(rPlus1w.timestamp, NOW + 7 * 86400000);

console.log('[OK] Compact shorthands passed');

console.log('[TEST] Checking parseTemporalInstant integration...');
// Standard ISO
const isoMs = parseTemporalInstant('2026-05-01T12:00:00Z', 'test');
assert.equal(isoMs, Date.parse('2026-05-01T12:00:00Z'));

// Relative keyword
const relYesterday = parseTemporalInstant('yesterday', 'test', NOW);
assert.equal(relYesterday, NOW - 86400000);

// Relative verbose
const rel3DaysAgo = parseTemporalInstant('3 days ago', 'test', NOW);
assert.equal(rel3DaysAgo, NOW - 3 * 86400000);

// Invalid error throw
assert.throws(
  () => parseTemporalInstant('completely-bogus-time', 'test'),
  /not a valid ISO date or relative temporal expression/,
);

console.log('[OK] All Task 1 assertions passed');
