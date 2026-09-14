import { test, expect, type Page } from '@playwright/test';
const prefix = `Track workflow ${Date.now()}`;
let artist: { id: string; name: string }; let secondary: { id: string; name: string }; let labelId: string;
test.beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!); if(url.hostname !== '127.0.0.1' || url.pathname !== '/steyoyoke_cms_local') throw new Error('Local only');
  const { prisma } = await import('../../src/lib/prisma');
  const { createArtist, publishArtist } = await import('../../src/modules/artists/service');
  const user=await prisma.user.findFirstOrThrow({where:{role:'ADMIN'}});
  const actor={userId:user.id,role:'ADMIN' as const};
  artist=await createArtist(actor,{name:prefix+' Artist'}); await publishArtist(actor,artist.id,{expectedWorkingVersion:1});
  secondary=await createArtist(actor,{name:prefix+' Secondary'}); await publishArtist(actor,secondary.id,{expectedWorkingVersion:1});
  labelId=(await prisma.label.findFirstOrThrow({where:{active:true}})).id;
  await prisma.$disconnect();
});
async function login(page:Page) {
  await page.goto('/sign-in'); await page.getByLabel('Email').fill(process.env.SEED_ADMIN_EMAIL!); await page.getByLabel('Password').fill(process.env.SEED_ADMIN_PASSWORD!);
  await page.getByRole('button',{name:'Sign in',exact:true}).click(); await expect(page).toHaveURL(/\/admin\/artists$/);
}
test('simple Track create, bounded Artist selection, edit and operational delete',async({page})=>{
  await login(page); await page.goto('/admin/tracks/new');
  for(const text of ['SoundCloud','Revision History','Audit Trail','Compatibility JSON']) await expect(page.getByText(text,{exact:true})).toHaveCount(0);
  await expect(page.getByRole('button',{name:'Create track',exact:true})).toBeVisible();
  await expect(page.locator('input[name="duration"]')).toHaveCount(0);
  await page.getByLabel('Title',{exact:true}).fill(prefix);
  const combo=page.getByRole('combobox',{name:'Primary Artist',exact:true}); await combo.fill(prefix);
  await page.getByRole('option',{name:artist.name,exact:true}).click();
  await page.getByRole('combobox',{name:'Secondary Artist',exact:true}).fill(secondary.name);
  await page.getByRole('option',{name:secondary.name,exact:true}).click();
  await page.getByRole('combobox',{name:'Label',exact:true}).selectOption(labelId);
  await page.getByLabel('Spotify',{exact:true}).fill('https://example.com/manual');
  await page.locator('input[type="file"]').nth(1).setInputFiles({name:prefix.replaceAll(' ','-')+'.png',mimeType:'image/png',buffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=','base64')});
  await expect(page.getByRole('status',{name:'artwork processing status'})).toHaveText('READY',{timeout:20000});
  await expect(page.getByAltText('Track artwork')).toBeVisible();
  await page.getByRole('button',{name:'Create track',exact:true}).click();
  await expect(page).toHaveURL(/\/admin\/tracks\/[0-9a-f-]+$/);
  await expect(page.getByRole('combobox',{name:'Secondary Artist',exact:true})).toHaveValue(secondary.name);
  await expect(page.getByAltText('Track artwork')).toBeVisible();
  await page.getByLabel('Title',{exact:true}).fill(prefix+' edited');
  await page.getByRole('button',{name:'Save changes',exact:true}).click();
  await expect(page.getByLabel('Title',{exact:true})).toHaveValue(prefix+' edited');
  await expect(page.getByLabel('Spotify',{exact:true})).toHaveValue('https://example.com/manual');
  await page.getByRole('button',{name:'Delete track',exact:true}).click();
  await expect(page.getByRole('dialog')).toBeVisible(); await page.getByRole('button',{name:'Confirm delete',exact:true}).click();
  await expect(page).toHaveURL(/\/admin\/tracks$/); await expect(page.getByText(prefix+' edited',{exact:true})).toHaveCount(0);
});
test('new audio fills only untouched stores and processing stops at READY',async({page})=>{
  await login(page); await page.goto('/admin/tracks/new');
  await page.getByLabel('Spotify',{exact:true}).fill('https://example.com/manual');
  await page.route('**/api/admin/tracks/audio',route=>route.fulfill({json:{id:'test-audio',url:'https://upload.test/source',headers:{}}}));
  await page.route('https://upload.test/source',route=>route.fulfill({status:200,body:''}));
  await page.route('**/api/admin/tracks/audio/test-audio',route=>route.fulfill({json:{id:'test-audio',status:'READY',originalFilename:'SYYK302_10.wav',legacyAudioId:'SYYK302_10',durationMs:381000}}));
  await page.locator('input[type="file"]').first().setInputFiles({name:'SYYK302_10.wav',mimeType:'audio/wav',buffer:Buffer.from('UI fixture; worker bytes validated separately')});
  await expect(page.getByRole('status',{name:'audio processing status'})).toHaveText('READY');
  await expect(page.getByLabel('Spotify',{exact:true})).toHaveValue('https://example.com/manual');
  await expect(page.getByLabel('Apple Music',{exact:true})).toHaveValue('https://syykrec.com/syyk302/applemusic');
  await expect(page.getByText('Duration: 06:21',{exact:true})).toBeVisible();
  await page.setViewportSize({width:390,height:844});
  expect(await page.evaluate(()=>document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
