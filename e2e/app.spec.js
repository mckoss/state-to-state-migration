import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
const GREEN = '#12782f'; // --arrow-in (light)
const RED = '#b3262a'; // --arrow-out (light)

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
        strokeWidth: Number(g.querySelector('.shaft').getAttribute('stroke-width')),
        o: a.o,
        d: a.d,
      };
    });
  });
}

const hashParams = (page) => new URL(page.url()).hash.slice(1);

test('loads with version, datasets and map', async ({ page }) => {
  await open(page);
  await expect(page.locator('#version')).toHaveText(`v${pkg.version}`);
  const years = await page.locator('#year option').allTextContents();
  expect(years).toHaveLength(19);
  expect(years[0]).toBe('ACS 1-year, 2024');
  expect(years.at(-1)).toBe('ACS 1-year, 2005');
  expect(years.some((y) => y.includes('2020'))).toBe(false);
  await expect(page.locator('#map-title')).toHaveText('Migration between states, 2024');
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
  await open(page);
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
    // Arrows ending at Texas are inflows (green); arrows leaving it are outflows (red).
    expect(x.stroke).toBe(x.d === tx ? GREEN : RED);
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
  await expect(page.locator('#popest-table thead')).toContainText('Population, July 2025');
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
