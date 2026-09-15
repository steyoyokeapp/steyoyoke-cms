import { createPublishedArtist } from "./artist-fixtures";
import { expect, test, type Page } from "@playwright/test";

async function signIn(page: Page, viewer = false) {
  await page.goto('/sign-in');
  await page.getByLabel('Email').fill(process.env[viewer ? 'SEED_VIEWER_EMAIL' : 'SEED_EDITOR_EMAIL']!);
  await page.getByLabel('Password').fill(process.env[viewer ? 'SEED_VIEWER_PASSWORD' : 'SEED_EDITOR_PASSWORD']!);
  await page.getByRole('button', {name: 'Sign in'}).click();
  await expect(page).toHaveURL(/\/admin\/artists$/);
}
async function reloadAction(page: Page, name: string) {
  await Promise.all([page.waitForEvent('load'), page.getByRole('button', {name, exact:true}).click()]);
  await page.waitForLoadState('networkidle');
}
async function artist(page: Page, label: string, name: string) {
  await page.getByRole('combobox', {name:label, exact:true}).fill(name);
  await page.getByRole('option', {name, exact:true}).click();
}
async function add(page: Page, title: string) {
  await page.getByRole('combobox', {name:'Add Track', exact:true}).fill(title);
  await page.getByRole('listbox',{name:'Track choices'}).getByRole('option').filter({hasText:title}).click();
  await page.getByRole('button', {name:'Add Track', exact:true}).click();
}
async function artwork(page: Page, replace = false) {
  await page.getByLabel(replace ? 'Replace artwork' : 'Upload artwork').setInputFiles({name:`release-test-${Date.now()}.png`, mimeType:'image/png', buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64')});
  await expect(page.getByRole('status', {name:'artwork processing status'})).toHaveText('READY', {timeout:30000});
  await expect(page.getByAltText('Release artwork')).toBeVisible();
}
async function responsive(page: Page, kind: string) {
  for (const width of [1440,430,390]) {
    await page.setViewportSize({width,height:1000});
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    await page.evaluate(() => window.scrollTo(0,0));
    await page.screenshot({path:`test-results/release-${kind}-${width}.png`,fullPage:true});
  }
  await page.setViewportSize({width:1440,height:1000});
}

test('Complete Release creation, editable defaults, artwork replacement, atomic ordering and frozen publication', async ({page}) => {
  test.setTimeout(180000); page.setDefaultTimeout(15000);
  const errors:string[]=[]; page.on('pageerror',e=>errors.push(e.message));
  await signIn(page);
  const stamp=Date.now(), name=`RELEASE TEST Artist ${stamp}`, secondaryName=`RELEASE TEST Secondary ${stamp}`;
  const primary=await createPublishedArtist(page,name); await createPublishedArtist(page,secondaryName);
  await page.goto('/admin/releases/new'); await page.waitForLoadState('networkidle');
  await page.getByRole('combobox',{name:'Label',exact:true}).selectOption({label:'Inner Symphony'});
  const labelId=await page.getByRole('combobox',{name:'Label',exact:true}).inputValue();
  const trackTitles=['A','B','C'].map(letter=>`RELEASE TEST Track ${letter} ${stamp}`);
  const tracks=[];
  for (const title of trackTitles) {
    const r=await page.request.post('/api/admin/tracks',{headers:{Origin:new URL(page.url()).origin},data:{title,primaryArtistId:primary.id,labelId,durationMs:225000}}); expect(r.status()).toBe(201);
    const track=await r.json(); tracks.push(track);
    const pub=await page.request.post(`/api/admin/tracks/${track.id}/actions`,{headers:{Origin:new URL(page.url()).origin},data:{action:'publish',expectedWorkingVersion:track.workingVersion}}); expect(pub.ok()).toBe(true);
  }
  await page.getByLabel('Title',{exact:true}).fill(`RELEASE TEST ${stamp}`);
  await page.getByRole('textbox',{name:'Catalogue',exact:true}).fill('SYYK303');
  for (const [label,path] of [['Spotify','spotify'],['Apple Music','applemusic'],['Bandcamp','bandcamp'],['Beatport','beatport'],['Traxsource','traxsource']] as const) await expect(page.getByLabel(label,{exact:true})).toHaveValue(`https://syykrec.com/syyk303/${path}`);
  await page.getByLabel('Spotify',{exact:true}).fill('https://example.com/manual-spotify');
  await page.getByRole('textbox',{name:'Catalogue',exact:true}).fill('SYYKBLK104');
  await expect(page.getByLabel('Spotify',{exact:true})).toHaveValue('https://example.com/manual-spotify');
  await expect(page.getByLabel('Beatport',{exact:true})).toHaveValue('https://syykrec.com/syykblk104/beatport');
  await artist(page,'Primary Artist',name); await artist(page,'Secondary Artist',secondaryName);
  await page.getByLabel('Release Date',{exact:true}).fill('2026-09-15'); await artwork(page);
  for(const title of trackTitles) await add(page,title);
  await page.getByRole('button',{name:'Remove Track 3',exact:true}).click();
  await page.getByRole('button',{name:'Move Track 2 up',exact:true}).click();
  await expect(page.locator('.release-ordered-tracks li')).toHaveCount(2);
  await responsive(page,'create');
  const created=page.waitForResponse(r=>r.url().endsWith('/api/admin/releases')&&r.request().method()==='POST');
  await page.getByRole('button',{name:'Create release',exact:true}).click(); const createdResponse=await created; expect(createdResponse.status()).toBe(201); const release=await createdResponse.json();
  await expect(page).toHaveURL(new RegExp(`/admin/releases/${release.id}$`)); await page.waitForLoadState('networkidle');
  await expect(page.getByRole('textbox',{name:'Catalogue',exact:true})).toHaveValue('SYYKBLK104');
  await expect(page.locator('.release-ordered-tracks li').first()).toContainText(trackTitles[1]!);
  await responsive(page,'edit');
  await reloadAction(page,'Publish now');
  const delivered=async()=>{const r=await page.request.get(`/index.php/cms/api/${release.legacyId}?filter=releasecomplete`,{headers:{'X-Csrf-Token':process.env.LEGACY_API_KEY_A!}}); expect(r.ok()).toBe(true); return (await r.json()).releasecomplete;};
  expect((await delivered()).tracks.map((t:{title:string})=>t.title)).toEqual([trackTitles[1],trackTitles[0]]);
  await page.getByRole('textbox',{name:'Catalogue',exact:true}).fill('SyYk305'); await artwork(page,true);
  await page.getByRole('button',{name:'Move Track 2 up',exact:true}).click(); await add(page,trackTitles[2]!);
  const mutations:string[]=[]; page.on('request',r=>{if(r.url().includes(`/api/admin/releases/${release.id}`)&&['PATCH','PUT'].includes(r.method()))mutations.push(r.method());});
  await reloadAction(page,'Save changes'); expect(mutations).toEqual(['PATCH']);
  await expect(page.getByRole('textbox',{name:'Catalogue',exact:true})).toHaveValue('SyYk305');
  await expect(page.getByLabel('Spotify',{exact:true})).toHaveValue('https://example.com/manual-spotify');
  expect((await delivered()).tracks.map((t:{title:string})=>t.title)).toEqual([trackTitles[1],trackTitles[0]]);
  await reloadAction(page,'Publish now'); expect((await delivered()).tracks.map((t:{title:string})=>t.title)).toEqual(trackTitles);
  await page.getByLabel('Schedule time').fill('2099-01-01T12:00'); await reloadAction(page,'Schedule'); await expect(page.locator('.release-operational-form > p .status')).toHaveText('SCHEDULED');
  await reloadAction(page,'Cancel schedule'); await reloadAction(page,'Unpublish');
  await page.getByRole('button',{name:'Delete release',exact:true}).click(); await expect(page.getByRole('dialog')).toBeVisible(); await page.getByRole('button',{name:'Cancel',exact:true}).click();
  await page.getByRole('button',{name:'Delete release',exact:true}).click(); await page.getByRole('button',{name:'Confirm archive',exact:true}).click(); await expect(page).toHaveURL(/\/admin\/releases$/);
  await page.goto(`/admin/releases/${release.id}`); await page.getByRole('button',{name:'Restore release',exact:true}).click(); await reloadAction(page,'Confirm restore'); await expect(page.locator('.release-operational-form > p .status')).toHaveText('UNPUBLISHED');
  expect(errors).toEqual([]);
});

test('Viewer cannot mutate Releases',async({page})=>{
  await signIn(page,true); await page.goto('/admin/releases');
  await expect(page.getByRole('link',{name:'Create Release',exact:true})).toHaveCount(0);
  await page.locator('a.table-row').first().click();
  await expect(page.getByRole('button',{name:'Save changes',exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Publish now',exact:true})).toHaveCount(0);
  const denied=await page.request.patch(`/api/admin/releases/${new URL(page.url()).pathname.split('/').at(-1)}`,{data:{}}); expect(denied.status()).toBe(403);
});

test('Track search stays lazy, bounded and keyboard accessible',async({page})=>{
  await signIn(page);
  const requests:string[]=[]; page.on('request',r=>{if(r.url().includes('/api/admin/choices'))requests.push(r.url());});
  await page.goto('/admin/releases/new'); await page.waitForLoadState('networkidle'); expect(requests).toEqual([]);
  const input=page.getByRole('combobox',{name:'Add Track',exact:true});
  await input.fill('RELEASE TEST Track');
  await expect(page.getByRole('listbox',{name:'Track choices'}).getByRole('option').first()).toBeVisible();
  expect(await page.getByRole('listbox',{name:'Track choices'}).getByRole('option').count()).toBeLessThanOrEqual(25);
  await input.press('ArrowDown'); await input.press('Enter');
  await expect(page.getByRole('button',{name:'Add Track',exact:true})).toBeEnabled();
  await page.getByRole('button',{name:'Add Track',exact:true}).click();
  await expect(page.locator('.release-ordered-tracks li')).toHaveCount(1);
  await input.fill('RELEASE TEST Track'); await expect(page.getByRole('listbox',{name:'Track choices'}).getByRole('option').first()).toBeVisible();
  await expect(page.getByRole('listbox',{name:'Track choices'}).getByRole('option').filter({hasText:'Already added'})).toHaveCount(1);
  await input.press('Escape'); await expect(input).toHaveAttribute('aria-expanded','false');
  expect(requests.every(url=>new URL(url).searchParams.get('kind')==='track')).toBe(true);
  await page.route('**/api/admin/choices?*', async route => {
    const q=new URL(route.request().url()).searchParams.get('q');
    if(q!=='slow'&&q!=='latest')return route.continue();
    if(q==='slow')await new Promise(resolve=>setTimeout(resolve,800));
    await route.fulfill({json:[{id:'00000000-0000-4000-8000-000000000001',title:q==='slow'?'Stale result':'Latest result',primaryArtistName:'Test',labelName:'Test',status:'DRAFT',publishedRevisionId:null,publishedRevisionNumber:null}]}).catch(()=>{});
  });
  const slow=page.waitForRequest(r=>new URL(r.url()).searchParams.get('q')==='slow');
  await input.fill('slow'); await slow; await input.fill('latest');
  await expect(page.getByRole('option',{name:/Latest result/})).toBeVisible();
  await page.waitForTimeout(900);
  await expect(page.getByRole('option',{name:/Stale result/})).toHaveCount(0);
  await expect(page.getByRole('option',{name:/Latest result/})).toBeVisible();

});
