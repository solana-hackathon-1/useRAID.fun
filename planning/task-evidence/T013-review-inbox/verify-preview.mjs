import {chromium,expect} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
const directory=new URL('.',import.meta.url),resource=JSON.parse(await readFile(new URL('preview-resources.json',directory),'utf8'));
const browser=await chromium.launch(),checks=[];
try{
 for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]] ){
  const page=await browser.newPage({viewport});const errors=[];page.on('pageerror',e=>errors.push(e.message));
  const response=await page.goto(resource.openUrl);await expect(page.getByRole('heading',{name:'Your practice reviews',exact:true})).toBeVisible();await expect(page.getByRole('listitem')).toHaveCount(2);
  await expect(page.getByRole('heading',{name:'Ownership review',exact:true})).toBeVisible();await expect(page.getByRole('heading',{name:'Skill assessment',exact:true})).toBeVisible();
  if(await page.locator('body').evaluate(e=>e.scrollWidth>window.innerWidth))throw Error('Overflow');
  const html=await page.content();if(/review-private-answer-marker|review-private-explanation-marker/.test(html))throw Error('Private evidence present in metadata inbox');
  expect(await page.locator('meta[name=robots]').getAttribute('content')).toContain('noindex');
  const api=await page.request.get(new URL('/api/v1/practice/reviews',resource.url).href);expect(api.status()).toBe(200);expect(api.headers()['cache-control']).toBe('private, no-store');expect((await api.json()).entries).toHaveLength(2);
  await page.screenshot({path:new URL('preview-'+name+'.png',directory).pathname,fullPage:true});
  const own=page.getByRole('listitem').filter({has:page.getByRole('heading',{name:'Ownership review',exact:true})});
  await own.getByRole('link',{name:'Read original case'}).focus();await page.keyboard.press('Enter');await expect(page.getByRole('heading',{name:'Original submission',exact:true})).toBeVisible();
  expect(errors).toEqual([]);checks.push({name,status:response.status(),currentOwnAssignments:2,noPrivateEvidenceInInbox:true,protectedApi:true,noOverflow:true,noIndex:true,keyboardCaseLink:true,pageErrors:errors});await page.close();
 }
 const report={resource,checks,verifiedAt:new Date().toISOString(),mode:'development',synthetic:true};await writeFile(new URL('preview-verified.json',directory),JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({openUrl:resource.openUrl,checks}));
}finally{await browser.close();}
