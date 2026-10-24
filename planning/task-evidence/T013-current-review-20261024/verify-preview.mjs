import {chromium,expect} from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
const directory=new URL('.',import.meta.url),resource=JSON.parse(await readFile(new URL('preview-resources.json',directory),'utf8'));
const browser=await chromium.launch(),checks=[];
try{
 for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]){
  const page=await browser.newPage({viewport});const errors=[];page.on('pageerror',error=>errors.push(error.message));const response=await page.goto(resource.openUrl);
  await expect(page.getByRole('heading',{name:'Review appointments',exact:true})).toBeVisible();await expect(page.getByLabel('Evaluator account ID',{exact:true})).toBeEnabled();await expect(page.getByText(/Current observation: ACTIVE/)).toBeVisible();
  expect(await page.getByLabel('Expiry (UTC)',{exact:true}).inputValue()).toBe('');expect(await page.content()).not.toMatch(/review-private-answer-marker|review-private-explanation-marker/);expect(await page.locator('meta[name="robots"]').getAttribute('content')).toContain('noindex');
  expect(await page.locator('body').evaluate(e=>e.scrollWidth<=window.innerWidth)).toBe(true);
  const target=new URL(resource.url).searchParams.get('submissionId');const api=await page.request.get(new URL('/api/v1/admin/practice/review-assignments?submissionId='+target,resource.url).href);expect(api.status()).toBe(200);expect(api.headers()['cache-control']).toBe('private, no-store');expect((await api.json()).page.entries).toHaveLength(1);
  await page.screenshot({path:new URL('preview-'+name+'.png',directory).pathname,fullPage:true});
  await page.getByRole('heading',{name:'New appointment',exact:true}).scrollIntoViewIfNeeded();const label=await page.locator('label[for=manager-evaluator]').boundingBox(),control=await page.getByLabel('Evaluator account ID',{exact:true}).boundingBox();if(!label||!control||label.y+label.height>control.y)throw Error('Label overlaps evaluator control');
  await page.screenshot({path:new URL('preview-form-'+name+'.png',directory).pathname});expect(errors).toEqual([]);checks.push({name,status:response.status(),authorizedCurrentMetadata:true,issueFormEnabled:true,noDefaultExpiry:true,protectedApi:true,noCaseAnswers:true,noOverflow:true,labelsAboveControls:true,pageErrors:errors});await page.close();
 }
 await writeFile(new URL('preview-verified.json',directory),JSON.stringify({resource,checks,verifiedAt:new Date().toISOString(),mode:'development',synthetic:true},null,2)+'\n');console.log(JSON.stringify({openUrl:resource.openUrl,checks}));
}finally{await browser.close();}
