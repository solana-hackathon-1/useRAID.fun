import { chromium, expect } from '@playwright/test';
import {readFile,writeFile} from 'node:fs/promises';
const directory=new URL('.',import.meta.url);const resource=JSON.parse(await readFile(new URL('preview-resources.json',directory),'utf8'));
const browser=await chromium.launch();const checks=[];
try{
 for(const [name,viewport] of [['desktop',{width:1440,height:1000}],['mobile',{width:390,height:844}]]){
  const page=await browser.newPage({viewport});
  const response=await page.goto(resource.openUrl);
  await expect(page.getByRole('heading',{name:'Record assessment review',exact:true})).toBeVisible();
  await expect(page.getByLabel('Review outcome',{exact:true})).toBeEnabled();
  await expect(page.getByText(/Synthetic approved assessment guidance/)).toBeVisible();
  const label=await page.locator('label[for=assessment-decision]').boundingBox();const control=await page.getByLabel('Review outcome',{exact:true}).boundingBox();
  if(!label||!control||label.y+label.height>control.y)throw Error('Label geometry failed');
  const overflow=await page.locator('body').evaluate(e=>e.scrollWidth>window.innerWidth);if(overflow)throw Error('Overflow');
  await page.screenshot({path:new URL('preview-'+name+'.png',directory).pathname,fullPage:true});
  await page.getByRole('heading',{name:'Record assessment review',exact:true}).scrollIntoViewIfNeeded();
  await page.screenshot({path:new URL('preview-form-'+name+'.png',directory).pathname});
  checks.push({name,status:response.status(),formEnabled:true,approvedPolicy:true,noOverflow:true,labelsAboveControls:true,url:page.url()});await page.close();
 }
 await writeFile(new URL('preview-verified.json',directory),JSON.stringify({resource,checks,verifiedAt:new Date().toISOString(),mode:'development',synthetic:true},null,2)+'\n');
 console.log(JSON.stringify({openUrl:resource.openUrl,mode:'development',checks}));
}finally{await browser.close();}
