// Parser checks against figures published in the Census tables.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import XLSX from 'xlsx';
import { STATES, parseGrid, stateIndex } from './build-data.mjs';

const RAW = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'data', 'raw', 'acs');
const idx = (abbr) => STATES.findIndex((s) => s[1] === abbr);
const load = (file) => {
  const wb = XLSX.readFile(path.join(RAW, file));
  return parseGrid(XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: true, defval: null }));
};
// est[destination][origin]
const flow = (m, from, to) => m.est[idx(to)][idx(from)];

test('stateIndex ignores footnote markers and spacing', () => {
  assert.equal(stateIndex('United States2'), -1);
  assert.equal(stateIndex('Texas'), idx('TX'));
  assert.equal(stateIndex('District of Columbia '), idx('DC'));
  assert.equal(stateIndex('New York*'), idx('NY'));
});

test('wide layout with population columns (2022)', () => {
  const m = load('acs1_2022.xlsx');
  assert.equal(flow(m, 'CA', 'TX'), 102442);
  assert.equal(m.found, 52 * 51);
});

test('wide layout without population columns (2005)', () => {
  const m = load('acs1_2005.xls');
  // Row "Alaska", column "Alabama" in the source sheet.
  assert.equal(flow(m, 'AL', 'AK'), 152);
  assert.equal(flow(m, 'AK', 'AL'), 608);
  assert.equal(m.found, 52 * 51);
});

test('long layout (2024)', () => {
  const m = load('acs1_2024.xlsx');
  assert.equal(flow(m, 'CA', 'TX'), 77161);
  assert.equal(flow(m, 'TX', 'CA'), 45447);
  assert.equal(flow(m, 'AK', 'AL'), 387);
  assert.equal(m.moe[idx('AL')][idx('AK')], 404);
  assert.equal(flow(m, 'NC', 'PR'), null, 'suppressed "N" cells stay null');
});
