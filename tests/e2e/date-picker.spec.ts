import {test,expect} from '@playwright/test';
import {createPublishedArtist} from './artist-fixtures';
for(const timezoneId of ['America/Los_Angeles','Pacific/Auckland'])test(`Shared catalogue dates in ${timezoneId}`,async({browser})=>{
 test.setTimeout(150000);const context=await browser.newContext({timezoneId,viewport:{width:1440,height:1000}}),page=await context.newPage();
 await page.goto('/sign-in');await page.waitForLoadState('networkidle');await page.getByLabel('Email').fill(process.env.SEED_EDITOR_EMAIL!);await page.getByLabel('Password').fill(process.env.SEED_EDITOR_PASSWORD!);await page.getByRole('button',{name:'Sign in',exact:true}).click();await page.waitForURL('**/admin/artists');
 const name=`DATE TEST ${Date.now()}`,primary=await createPublishedArtist(page,name);const errors:string[]=[];page.on('pageerror',e=>errors.push(e.message));
 for(const kind of ['releases','podcasts']){
  const label=kind==='releases'?'Release Date':'Episode Date',field=page.getByRole('textbox',{name:label,exact:true});
  await page.goto(`/admin/${kind}/new`);await page.waitForLoadState('networkidle');
  for(const mode of ['create','edit']){
   if(mode==='edit')await expect(field).toHaveValue('15/09/2026');
   if(mode==='create'){await field.click();await expect(page.locator('.cms-calendar [aria-current=date]')).toHaveCount(1);await page.keyboard.press('Escape');await expect(field).toBeFocused();}
   await page.getByLabel('Title',{exact:true}).fill(name);
   if(mode==='create'){await page.getByRole('combobox',{name:'Primary Artist',exact:true}).fill(name);await page.getByRole('option',{name,exact:true}).click();await page.getByRole('combobox',{name:'Label',exact:true}).selectOption({label:'Steyoyoke'});}
   if(kind==='podcasts'){await page.getByLabel('Complete tracklist').fill('Test - Track 1;00:00');await page.getByRole('button',{name:'Validate tracklist',exact:true}).click();}
   await field.fill('31/02/2026');await field.press('Tab');await expect(page.getByText('Enter a valid date in DD/MM/YYYY format.',{exact:true})).toBeVisible();expect(await field.evaluate((el:HTMLInputElement)=>el.checkValidity())).toBe(false);
   await page.getByRole('button',{name:mode==='create'?(kind==='releases'?'Create release':'Create podcast'):'Save changes',exact:true}).click();await expect(field).toBeFocused();expect(await field.evaluate((el:HTMLInputElement)=>el.validity.valid)).toBe(false);
   await field.fill('29/02/2024');await page.getByRole('button',{name:`Open ${label} calendar`,exact:true}).click();
   const dialog=page.getByRole('dialog',{name:`${label} calendar`,exact:true});await expect(dialog.getByRole('button',{name:'29 February 2024',exact:true})).toHaveAttribute('aria-pressed','true');
   await dialog.getByRole('button',{name:'Previous month',exact:true}).click();await expect(field).toHaveValue('29/02/2024');await dialog.getByRole('button',{name:'Next month',exact:true}).click();
   await dialog.getByLabel('Calendar year').fill('2026');await expect(dialog.getByRole('button',{name:'29 February 2026',exact:true})).toHaveCount(0);await dialog.getByLabel('Calendar year').fill('2024');await dialog.getByLabel('Calendar year').press('Enter');await expect(dialog).toBeVisible();await expect(field).toHaveValue('29/02/2024');
   await dialog.getByRole('button',{name:'29 February 2024',exact:true}).focus();await page.keyboard.press('ArrowRight');await expect(dialog.getByRole('button',{name:'1 March 2024',exact:true})).toBeFocused();await page.keyboard.press('Enter');await expect(field).toHaveValue('01/03/2024');await expect(field).toBeFocused();
   for(const width of [1440,430,390]){await page.setViewportSize({width,height:1000});await page.getByRole('button',{name:`Open ${label} calendar`,exact:true}).click();const rect=await dialog.boundingBox();expect(rect!.x).toBeGreaterThanOrEqual(0);expect(rect!.x+rect!.width).toBeLessThanOrEqual(width);expect(rect!.y+rect!.height).toBeLessThanOrEqual(1000);expect(await page.evaluate(()=>document.documentElement.scrollWidth)).toBe(width);if(timezoneId==='America/Los_Angeles')await page.screenshot({path:`test-results/date-${kind}-${mode}-${width}.png`});await page.keyboard.press('Escape');await expect(dialog).not.toBeVisible();}
   await page.setViewportSize({width:1440,height:1000});
   if(kind==='releases'){const beside=await page.getByRole('combobox',{name:'Secondary Artist',exact:true}).boundingBox(),date=await field.boundingBox();expect(Math.abs(beside!.y-date!.y)).toBeLessThan(2);}
   await page.getByRole('button',{name:`Open ${label} calendar`,exact:true}).click();await page.getByRole('button',{name:'Clear date',exact:true}).click();await expect(field).toHaveValue('');
   await field.fill('15/09/2026');const save=mode==='create'?(kind==='releases'?'Create release':'Create podcast'):'Save changes';
   const response=page.waitForResponse(r=>r.url().includes(`/api/admin/${kind}`)&&r.request().method()===(mode==='create'?'POST':'PATCH'));
   const navigation=mode==='edit'?page.waitForEvent('load'):page.waitForURL(new RegExp(`/admin/${kind}/[0-9a-f-]+$`));
   await page.getByRole('button',{name:save,exact:true}).click();expect((await response).ok()).toBe(true);await navigation;await page.waitForLoadState('networkidle');
   const record=await (await page.request.get(`/api/admin/${kind}/${new URL(page.url()).pathname.split('/').at(-1)}`)).json();expect(record[kind==='releases'?'releaseDate':'episodeDate']).toBe('2026-09-15T00:00:00.000Z');await expect(field).toHaveValue('15/09/2026');

  }
 }
 expect(errors).toEqual([]);await context.close();
});
