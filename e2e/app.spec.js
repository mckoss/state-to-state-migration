import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const GREEN = '#12782f'; // --arrow-in (light)
const RED = '#b3262a'; // --arrow-out (light)
const GRAY = '#7d7b75'; // --arrow-ns (light): net direction not significant

// Fail any test that logs a console error or throws in the page.
test.beforeEach(async ({ page }, testInfo) => {
  const errors = [];
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
  page.on('pageerror', (e) => errors.push(String(e)));
  testInfo.errors_ = errors;
});
test.afterEach(async ({}, testInfo) => {
  expect(testInfo.errors_, 'console errors').toEqual([]);
});

/** Open the app at a hash and wait until the map and year chart have drawn. */
async function open(page, hash = '') {
  await page.goto(`/${hash}`);
  await expect(page.locator('#map path.state')).toHaveCount(52);
  await expect(page.locator('#history svg')).toBeVisible();
}

/** The site's data index (datasets, states, population-estimates metadata). */
async function dataIndex(page) {
  return (await page.request.get('/data/index.json')).json();
}

/** Index of a state (by postal code) in the site's state list. */
async function idx(page, abbr) {
  const index = await (await page.request.get('/data/index.json')).json();
  return index.states.findIndex((s) => s.abbr === abbr);
}

/** Arrow data as bound by d3: origin/destination indices, value, width, color. */
function arrows(page) {
  return page.evaluate(() => {
    return [...document.querySelectorAll('#map g.arrow')].map((g) => {
      const a = g.__data__;
      return {
        value: a.value,
        w: a.w,
        kind: a.kind,
        stroke: g.querySelector('.shaft').getAttribute('stroke'),
        moe: a.moe,
        strokeWidth: Number(g.querySelector('.shaft').getAttribute('stroke-width')),
        o: a.o,
        d: a.d,
      };
    });
  });
}

const hashParams = (page) => new URL(page.url()).hash.slice(1);

// These tests must keep passing when the monthly data refresh adds a year, so
// they read the newest year from the data and pin value checks to fixed years.
test('loads with version, datasets and map', async ({ page }) => {
  await open(page);
  const index = await dataIndex(page);
  const latest = Math.max(...index.acs.map((a) => a.year));
  await expect(page.locator('#version')).toHaveText(`v${pkg.version}`);
  const years = await page.locator('#year optgroup[label="Single year"] option').allTextContents();
  await expect(page.locator('#year optgroup[label="Combined"] option')).toHaveCount(index.combined.length);
  expect(years).toHaveLength(index.acs.length);
  expect(years.length).toBeGreaterThanOrEqual(19);
  expect(years[0]).toBe(`ACS 1-year, ${latest}`);
  expect(years).toContain('ACS 1-year, 2024');
  expect(years.at(-1)).toBe('ACS 1-year, 2005');
  expect(years.some((y) => y.includes('2020'))).toBe(false);
  await expect(page.locator('#map-title')).toHaveText(`Migration between states, ${latest}`);
  await expect(page.locator('#acs-range')).toHaveText(`2005–${latest}`);
  await expect(page.locator('.pe-vintage').first()).toHaveText(String(index.popest.vintage));

  await page.selectOption('#year', '2024');
  await expect(page.locator('#stats')).toContainText('7,188,344');
});

test('all-states view: neutral arrows and top-N slider', async ({ page }) => {
  await open(page);
  let a = await arrows(page);
  expect(a).toHaveLength(12);
  expect(new Set(a.map((x) => x.kind))).toEqual(new Set(['netpair']));
  await expect(page.locator('#map .arrow-label')).toHaveCount(12);

  await page.locator('#topn').fill('5');
  await expect(page.locator('#map g.arrow')).toHaveCount(5);
  expect(hashParams(page)).toContain('top=5');

  await page.getByRole('radio', { name: 'In & out' }).click();
  a = await arrows(page);
  expect(new Set(a.map((x) => x.kind))).toEqual(new Set(['gross']));
});

test('click a state to focus it, click again or Esc to return', async ({ page }) => {
  await open(page, '#year=2024');
  await page.locator('#map path.state[aria-label="Montana"]').click();
  await expect(page.locator('#map-title')).toHaveText('Montana: migration with other states, 2024');
  expect(hashParams(page)).toContain('state=MT');
  await expect(page.locator('#state')).toHaveValue('MT');

  await page.locator('#map path.state[aria-label="Montana"]').click();
  await expect(page.locator('#map-title')).toHaveText('Migration between states, 2024');
  expect(hashParams(page)).not.toContain('state=');

  // Keyboard: focus a state and press Enter; Esc returns to all states.
  await page.locator('#map path.state[aria-label="Texas"]').focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('#map-title')).toContainText('Texas');
  await page.locator('body').press('Escape');
  await expect(page.locator('#map-title')).toHaveText('Migration between states, 2024');
});

test('focused state, Net mode: in is green, out is red', async ({ page }) => {
  await open(page, '#year=2024&state=TX');
  await expect(page.locator('#stats')).toContainText('+76,506');
  const tx = await idx(page, 'TX');
  const a = await arrows(page);
  expect(a).toHaveLength(12);
  for (const x of a) {
    // Arrows ending at Texas are inflows (green), arrows leaving it outflows (red),
    // unless the net isn't significant, when its direction is unknown (gray).
    if (x.value <= x.moe) expect(x.stroke).toBe(GRAY);
    else expect(x.stroke).toBe(x.d === tx ? GREEN : RED);
  }
  // California is Texas's largest net source in 2024 (+31,714 → "32k").
  const top = a.reduce((m, x) => (x.value > m.value ? x : m));
  expect(top.value).toBe(31714);
  expect(top.stroke).toBe(GREEN);
  await expect(page.locator('#map .arrow-label', { hasText: /^32k$/ })).toHaveCount(1);
});

test('focused state, In & out mode: both directions, width proportional to movers', async ({ page }) => {
  await open(page, '#year=2024&state=CA&mode=both');
  const a = await arrows(page);
  expect(a.length).toBeGreaterThan(12);
  expect(a.length).toBeLessThanOrEqual(24);
  expect(a.filter((x) => x.kind === 'in').every((x) => x.stroke === GREEN)).toBe(true);
  expect(a.filter((x) => x.kind === 'out').every((x) => x.stroke === RED)).toBe(true);
  expect(a.some((x) => x.kind === 'in')).toBe(true);
  expect(a.some((x) => x.kind === 'out')).toBe(true);

  const max = Math.max(...a.map((x) => x.value));
  for (const x of a) {
    expect(x.strokeWidth).toBeCloseTo(Math.max(1, (10 * x.value) / max), 5);
  }
});

test('hovering an arrow highlights it and shows values', async ({ page }) => {
  await open(page, '#year=2024&state=CA&mode=both');
  const ca = await idx(page, 'CA');
  const tx = await idx(page, 'TX');
  const pt = await page.evaluate(([o, d]) => {
    const g = [...document.querySelectorAll('#map g.arrow')].find((n) => n.__data__.o === o && n.__data__.d === d);
    const hit = g.querySelector('.hit');
    const p = hit.getPointAtLength(hit.getTotalLength() * 0.5);
    const m = hit.getScreenCTM();
    return { x: p.x * m.a + m.e, y: p.y * m.d + m.f };
  }, [ca, tx]);
  await page.mouse.move(pt.x, pt.y);
  const tip = page.locator('#tooltip');
  await expect(tip).toBeVisible();
  await expect(tip).toContainText('Out of California to Texas');
  await expect(tip).toContainText('77,161 ± 9,059');
  await expect(tip).toContainText('45,447 ± 6,640');
  await expect(tip).toContainText('−31,714 ± 11,232');
  // The hovered arrow stays solid; every other arrow fades.
  const others = page.locator('#map g.arrow:not(.hover)');
  await expect(page.locator('#map g.arrow.hover')).toHaveCount(1);
  await expect(page.locator('#map g.arrow.hover')).toHaveCSS('opacity', '1');
  await expect(others.first()).toHaveCSS('opacity', '0.2');

  await page.mouse.move(5, 5);
  await expect(tip).toBeHidden();
  await expect(others.first()).toHaveCSS('opacity', '1');
});

test('clicking an arrow focuses the partner state', async ({ page }) => {
  await open(page, '#year=2024&state=CA&mode=both');
  await page.locator('#map g.arrow .hit').first().click({ force: true });
  await expect(page.locator('#map-title')).not.toContainText('California');
  expect(hashParams(page)).not.toContain('state=CA');
});

test('dataset picker and year chart change the year', async ({ page }) => {
  await open(page, '#state=NY');
  await page.selectOption('#year', '2010');
  await expect(page.locator('#map-title')).toHaveText('New York: migration with other states, 2010');
  expect(hashParams(page)).toContain('year=2010');
  await expect(page.locator('#stats')).toContainText('−91,740');

  // Year columns run 2005..2025; index 10 is 2015.
  await page.locator('#history svg rect').nth(10).click();
  await expect(page.locator('#map-title')).toHaveText('New York: migration with other states, 2015');
  // The 2020 column has no ACS table and is not clickable.
  await page.locator('#history svg rect').nth(15).click();
  await expect(page.locator('#map-title')).toContainText('2015');
});

test('flow table rows select states and headers sort', async ({ page }) => {
  await open(page, '#year=2024');
  const rows = page.locator('#flows-table tbody tr');
  await expect(rows).toHaveCount(52);
  // Default sort: net, descending.
  await expect(rows.first().locator('td').first()).toHaveText('Texas');
  await page.locator('#flows-table th', { hasText: 'State' }).click();
  await expect(rows.first().locator('td').first()).toHaveText('Alabama');
  await page.locator('#flows-table th', { hasText: 'State' }).click();
  await expect(rows.first().locator('td').first()).toHaveText('Wyoming');

  await rows.filter({ hasText: 'Florida' }).click();
  await expect(page.locator('#map-title')).toContainText('Florida');
  await expect(page.locator('#flows-table tbody tr')).toHaveCount(51);
});

test('population estimates table: year picker and sorting', async ({ page }) => {
  await open(page);
  const rows = page.locator('#popest-table tbody tr');
  await expect(rows).toHaveCount(52);
  const latestPe = Math.max(...(await dataIndex(page)).popest.years);
  await expect(page.locator('#popest-table thead')).toContainText(`Population, July ${latestPe}`);
  await page.selectOption('#popest-year', '2023');
  await expect(page.locator('#popest-table thead')).toContainText('Population, July 2023');
  expect(hashParams(page)).toContain('pe=2023');
  await page.locator('#popest-table th', { hasText: 'Net domestic' }).click();
  // Toggled to ascending: the largest net domestic loss comes first.
  const first = Number((await rows.first().locator('td').nth(3).textContent()).replace(/[^\d]/g, ''));
  expect((await rows.first().locator('td').nth(3).textContent()).startsWith('−')).toBe(true);
  expect(first).toBeGreaterThan(100000);
});

test('no horizontal scroll at phone width', async ({ browser }) => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  await open(page, '#year=2023&state=FL&mode=both');
  const [scrollW, innerW] = await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth]);
  expect(scrollW).toBeLessThanOrEqual(innerW);
  await page.close();
});

test('estimates within their margin of error are flagged as not significant', async ({ page }) => {
  // Pennsylvania's 2024 net (−16,233 ± 18,778) is not statistically different from zero.
  await open(page, '#year=2024&state=PA');
  await expect(page.locator('#stats .stat.ns')).toContainText('−16,233');
  await expect(page.locator('#stats .stat.ns')).toContainText('not significant');

  // Washington's (+17,404) is significant once the published in/out margins are used
  // (± 15,947; the square-root-of-sums approximation alone gives ± 17,557).
  await open(page, '#year=2024&state=WA&top=20');
  await expect(page.locator('#stats')).toContainText('+17,404');
  await expect(page.locator('#stats')).toContainText('± 15,947');
  await expect(page.locator('#stats .stat.ns')).toHaveCount(0);

  // Massachusetts: +711 ± 1,755 for WA — the 90% range spans zero.
  await page.locator('#map path.state[aria-label="Massachusetts"]').hover({ force: true });
  await expect(page.locator('#tooltip')).toContainText('+711 ± 1,755');
  await expect(page.locator('#tooltip .tt-warn')).toContainText('−1,044 to +2,466');
  await page.mouse.move(2, 2);
  const ma = page.locator('#flows-table tbody tr', { hasText: 'Massachusetts' });
  await expect(ma.locator('td.ns')).toHaveText('+711');
  // California: +17k net to WA is significant, so not grayed.
  await expect(page.locator('#flows-table tbody tr', { hasText: 'California' }).locator('td.ns')).toHaveCount(0);

  // Arrows are dashed and gray exactly when the net is within its margin of error,
  // and only significant arrows carry a number.
  const a = await page.evaluate(() => [...document.querySelectorAll('#map g.arrow')].map((g) => ({
    value: g.__data__.value,
    moe: g.__data__.moe,
    dashed: g.querySelector('.shaft').hasAttribute('stroke-dasharray'),
    stroke: g.querySelector('.shaft').getAttribute('stroke'),
  })));
  expect(a.some((x) => x.dashed)).toBe(true);
  for (const x of a) {
    expect(x.dashed).toBe(x.value <= x.moe);
    if (x.dashed) expect(x.stroke).toBe(GRAY);
  }
  await expect(page.locator('#map .arrow-label')).toHaveCount(a.filter((x) => !x.dashed).length);
  await expect(page.locator('#arrow-legend')).toContainText('direction not significant');
  await expect(page.locator('#legend')).toContainText('Not statistically significant');
  // Massachusetts (+711 ± 1,755 for WA) is shaded neutral, not green.
  await expect(page.locator('#map path.state[aria-label="Massachusetts"]')).toHaveAttribute('fill', '#f0efec');
});

test('population-estimates map: green gain, red loss, measure and units toggles', async ({ page }) => {
  await open(page);
  const latestPe = Math.max(...(await dataIndex(page)).popest.years);
  await expect(page.locator('#pe-map path.state')).toHaveCount(52);
  await expect(page.locator('#pe-map-title')).toHaveText(`Net migration, July ${latestPe - 1} – June ${latestPe}`);

  // Pinned to the 2024-25 estimates: Texas gained, California lost (total net migration).
  await page.selectOption('#popest-year', '2025');
  const fill = (name) => page.locator(`#pe-map path.state[aria-label="${name}"]`).getAttribute('fill');
  const gains = ['#d3efda', '#8ed3a1', '#34a057', '#1b7537']; // --in-1..4 (light)
  const losses = ['#f9d3d1', '#ef9391', '#dc4c4b', '#a82c2c']; // --loss-1..4 (light)
  expect(gains).toContain(await fill('Texas'));
  expect(losses).toContain(await fill('California'));

  await page.locator('#pe-map path.state[aria-label="Texas"]').hover({ force: true });
  await expect(page.locator('#tooltip')).toContainText('Net migration');
  await expect(page.locator('#tooltip')).toContainText('International');
  await page.mouse.move(2, 2);

  await page.locator('#pe-measure').getByRole('radio', { name: 'Domestic' }).click();
  await page.locator('#pe-units').getByRole('radio', { name: 'Per 1,000 residents' }).click();
  await expect(page.locator('#pe-map-title')).toContainText('Net domestic migration per 1,000 residents');
  expect(hashParams(page)).toContain('pem=domestic');
  expect(hashParams(page)).toContain('peu=rate');
  // The top "Arrows" toggle is unaffected by the map's toggles.
  await expect(page.getByRole('radio', { name: 'Net', exact: true })).toHaveAttribute('aria-checked', 'true');

  // Clicking a state focuses it on the flow map above.
  await page.locator('#pe-map path.state[aria-label="Idaho"]').click({ force: true });
  await expect(page.locator('#map-title')).toContainText('Idaho');
  await expect(page.locator('#pe-map path.state.selected')).toHaveAttribute('aria-label', 'Idaho');
});

test('combined datasets sum the last 5 and 10 surveys', async ({ page }) => {
  await open(page, '#year=2024');
  const index = await dataIndex(page);
  const last5 = index.combined.find((c) => c.key === 'last5');
  const last10 = index.combined.find((c) => c.key === 'last10');
  expect(last5.years).toHaveLength(5);
  expect(last10.years).toHaveLength(10);
  expect(last5.years).not.toContain(2020);

  // The combined total equals the sum of the yearly totals.
  const yearly = Object.fromEntries(index.acs.map((a) => [a.year, a.interstateMovers]));
  expect(last5.interstateMovers).toBe(last5.years.reduce((s, y) => s + yearly[y], 0));

  await page.selectOption('#year', 'last10');
  const span = `${last10.years[0]}–${last10.years.at(-1)}`;
  await expect(page.locator('#map-title')).toHaveText(`Migration between states, ${span} combined`);
  await expect(page.locator('#stats')).toContainText(last10.interstateMovers.toLocaleString('en-US'));
  expect(hashParams(page)).toContain('year=last10');
  await expect(page.locator('#map g.arrow')).toHaveCount(12);

  // One state: the year chart highlights the surveys included.
  await page.selectOption('#state', 'TX');
  await expect(page.locator('#map-title')).toHaveText(`Texas: migration with other states, ${span} combined`);
  await expect(page.locator('#flows-title')).toContainText(`${span} combined`);
  const bold = await page.locator('#history svg .tick text').evaluateAll((ts) =>
    ts.filter((t) => t.style.fontWeight === '700').map((t) => t.textContent));
  expect(bold).toHaveLength(10);

  // Clicking a year bar returns to that single year.
  await page.locator('#history svg rect').nth(19).click(); // 2024
  await expect(page.locator('#map-title')).toHaveText('Texas: migration with other states, 2024');
});

test('the ± margins are explained, and the link keeps the current view', async ({ page }) => {
  await open(page, '#year=2024&state=WA');
  await expect(page.locator('#margins h2')).toHaveText('About the ± numbers');
  await expect(page.locator('#margins')).toContainText('Why the margins can be so large');
  await page.locator('#stats a.moe').first().click();
  await expect(page.locator('#margins-title')).toBeInViewport();
  // The hash still holds the view: Washington stays selected.
  await expect.poll(() => hashParams(page)).toContain('state=WA');
  await expect(page.locator('#map-title')).toContainText('Washington');
  await expect(page.locator('#flows-sub a[href="#margins"]')).toHaveCount(1);
});

test('sentiment mode compares move rates per resident', async ({ page }) => {
  await open(page, '#year=2024&state=CA');
  await page.getByRole('radio', { name: 'Sentiment' }).click();
  expect(hashParams(page)).toContain('mode=sent');
  await expect(page.locator('#map-title')).toHaveText('California: migration sentiment, 2024');
  await expect(page.locator('#legend')).toContainText('Sentiment toward CA');

  // Arrows point toward the favored state: green into CA, red out of it, gray if not significant.
  const ca = await idx(page, 'CA');
  const a = await page.evaluate(() => [...document.querySelectorAll('#map g.arrow')].map((g) => ({
    o: g.__data__.o, d: g.__data__.d, value: g.__data__.value, sig: g.__data__.sig,
    stroke: g.querySelector('.shaft').getAttribute('stroke'),
  })));
  expect(a.length).toBeGreaterThan(0);
  for (const x of a) {
    expect(x.value).toBeGreaterThanOrEqual(1);
    if (!x.sig) expect(x.stroke).toBe(GRAY);
    else expect(x.stroke).toBe(x.d === ca ? GREEN : RED);
  }

  // Nevada: 21,133 moved to CA out of ~3.2M Nevadans (658 per 100k); 53,289 moved
  // the other way out of ~39M Californians (136 per 100k): 4.84x.
  await page.locator('#map path.state[aria-label="Nevada"]').hover({ force: true, position: { x: 30, y: 60 } });
  await expect(page.locator('#tooltip')).toContainText('4.84×');
  await expect(page.locator('#tooltip')).toContainText('658');
  await page.mouse.move(2, 2);

  // The table lists rates and the ratio, strongest first.
  await expect(page.locator('#flows-table thead')).toContainText('Sentiment toward CA');
  await expect(page.locator('#flows-table tbody tr').first().locator('td').first()).toHaveText('Alaska');

  // Washington and Arizona: 225 ± 42 vs 116 ± 35 per 100k gives 1.94x, 90% range 1.25-2.62x.
  await page.selectOption('#state', 'WA');
  await page.locator('#map path.state[aria-label="Arizona"]').hover({ force: true, position: { x: 40, y: 60 } });
  const tip = page.locator('#tooltip');
  await expect(tip).toContainText('225 ± 42 per 100k');
  await expect(tip).toContainText('116 ± 35 per 100k');
  await expect(tip).toContainText('1.94×');
  await expect(tip).toContainText('1.25–2.62×');
  await page.mouse.move(2, 2);
  // From Washington's side the same pair is the inverse: 0.52x (0.38-0.80x).
  const az = page.locator('#flows-table tbody tr', { hasText: 'Arizona' });
  await expect(az).toContainText('0.52×');
  await expect(az).toContainText('0.38–0.80×');
  // Gray exactly when the ratio's 90% range includes 1x.
  const sent = await page.evaluate(() => [...document.querySelectorAll('#map g.arrow')].map((g) => ({
    sig: g.__data__.sig, kLo: g.__data__.ps.kLo,
  })));
  for (const x of sent) expect(x.sig).toBe(x.kLo > 1);

  // All states: no shading, the most lopsided pairs instead.
  await page.selectOption('#state', '');
  await expect(page.locator('#map-title')).toHaveText('Migration sentiment between states, 2024');
  await expect(page.locator('#legend')).toContainText("States aren't shaded");
  await expect(page.locator('#flows-title')).toHaveText('Most lopsided pairs of states, 2024');
  await expect(page.locator('#sentiment h2')).toHaveText('About the sentiment view');
});
