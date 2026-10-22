const {chromium}=require(process.env.PRISM_PLAYWRIGHT_MODULE || 'playwright');
const output = process.env.PRISM_SCAN_OUTPUT || '.scan-check';
const fs=require('node:fs');const assert=require('node:assert/strict');
(async()=>{
 const executablePath=process.env.PRISM_CHROMIUM_PATH || (fs.existsSync('/usr/bin/chromium') ? '/usr/bin/chromium' : undefined);
 const browser=await chromium.launch({headless:true,...(executablePath ? {executablePath} : {}),args:['--no-sandbox']});const page=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1});
 const counts={};let releaseMe,releasePower,meDone=false,powerDone=false;const meHeld=new Promise(r=>releaseMe=r),powerHeld=new Promise(r=>releasePower=r);
 const machine={publicId:'demo',name:'测试机台',kind:'machine',coinAfterSwipe:false,capabilities:{card:true,power:true,coin:false,door:false,mahjong:true},shop:{publicId:'demo',name:'测试店铺',billingEnabled:false,locationEnabled:false,heroUrl:null}};
 await page.route('**/api/**',async route=>{const url=new URL(route.request().url());counts[url.pathname]=(counts[url.pathname]||0)+1;let data;
 if(url.pathname==='/api/v1/me'){await meHeld;meDone=true;data={user:{id:'u',username:'test',displayName:'测试玩家',role:'user',hasShops:false}};}
 else if(url.pathname==='/api/v1/machines/session') data={machine};
 else if(url.pathname==='/api/v1/cards') data={cards:[{id:'card',label:'测试 Aime',accessCode:'12345678901234567890',disabledAt:null}],authorizationRequired:false};
 else if(url.pathname==='/api/v1/devices/session/state') data={gate:'ready',power:'unmanaged',coinUsed:false,mahjong:{capacity:4,seats:[]},device:{watching:false,power:null,climate:null}};
 else if(url.pathname==='/api/v1/devices/session/device'){await powerHeld;powerDone=true;data={watching:false,power:null,climate:null};}
 else if(url.pathname==='/api/v1/shops/demo')data={shop:{publicId:'demo',name:'测试店铺',billingEnabled:false,locationEnabled:false},membership:null,pricing:[]};
 else data={};
 await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data})});});
 await page.goto(`${process.env.PRISM_SCAN_ORIGIN || 'http://127.0.0.1:4173'}/m#ticket=opaque-test`);await page.getByText('测试店铺',{exact:true}).waitFor();assert.equal(meDone,false);
 fs.mkdirSync(output,{recursive:true});await page.screenshot({path:`${output}/scan-auth-loading.png`,fullPage:true});
 releaseMe();await page.getByText('测试 Aime',{exact:true}).waitFor();assert.equal(powerDone,false);
 // The machine's power is asked for without holding the cards back, and the header says so while it is.
 const checking=page.getByText(/^测试机台 · (正在获取电源状态|Checking power status)$/);
 await checking.waitFor();
 await page.screenshot({path:`${output}/scan-cards-before-power.png`,fullPage:true});
 await page.waitForTimeout(7000);assert.equal(counts['/api/v1/shops/demo'],1);assert.ok(counts['/api/v1/devices/session/state']>=2);assert.equal(counts['/api/v1/devices/session/device'],1);assert.equal(counts['/api/v1/devices/session/power'],undefined);
 console.log('PASS hero before auth, cards before HA, one shop metadata GET during dynamic polling, one power read and no power polling',counts);releasePower();
 await checking.waitFor({state:'detached'});
 // A watched device arrives with its power in the first read: the page uses it as is, with no state read
 // before the next poll is due and no read of Home Assistant at all.
 {
  const watched=await browser.newPage({viewport:{width:390,height:844},deviceScaleFactor:1,locale:'zh-CN'});const seen={};
  await watched.route('**/api/**',async route=>{const url=new URL(route.request().url());seen[url.pathname]=(seen[url.pathname]||0)+1;let data;
   if(url.pathname==='/api/v1/me')data={user:{id:'u',username:'test',displayName:'测试玩家',role:'user',hasShops:false}};
   else if(url.pathname==='/api/v1/devices/session/bootstrap')data={machine:{...machine,capabilities:{card:true,power:true,coin:false,door:false}},state:{gate:'ready',coinUsed:false,mahjong:null,device:{watching:true,power:'off',climate:null}}};
   else if(url.pathname==='/api/v1/cards')data={cards:[],authorizationRequired:false};
   else if(url.pathname==='/api/v1/shops/demo')data={shop:{publicId:'demo',name:'测试店铺',billingEnabled:false,locationEnabled:false},membership:null,pricing:[]};
   else data={};
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data})});});
  await watched.goto(`${process.env.PRISM_SCAN_ORIGIN || 'http://127.0.0.1:4173'}/m#ticket=v1.opaque-test`);
  await watched.getByText('设备尚未开机',{exact:true}).waitFor();
  assert.equal(seen['/api/v1/devices/session/bootstrap'],1);assert.equal(seen['/api/v1/machines/session'],undefined);
  assert.equal(seen['/api/v1/devices/session/state'],undefined);assert.equal(seen['/api/v1/devices/session/device'],undefined);assert.equal(seen['/api/v1/devices/session/power'],undefined);
  assert.equal(await watched.getByText('正在获取电源状态').count(),0);
  await watched.screenshot({path:`${output}/scan-watched-power-off.png`,fullPage:true});await watched.close();
  console.log('PASS watched device shows its power from the first read without asking again',seen);
 }
 for (const [locale,copy,checkout,billing] of [['zh-CN','余额不足，请充值后再结账，计费会继续','结账','计费中'],['en-US','Not enough balance. Top up and check out again; billing continues.','Check out','Billing in progress']]) {
  const checkoutPage=await browser.newPage({viewport:{width:390,height:844},locale});let confirmations=0;
  await checkoutPage.route('**/api/**',async route=>{const path=new URL(route.request().url()).pathname;let data;
   if(path==='/api/v1/me')data={user:{id:'u',username:'test',displayName:'测试玩家',role:'user',hasShops:false}};
   else if(path==='/api/v1/shops/demo')data={shop:{publicId:'demo',name:'测试店铺',billingEnabled:true,locationEnabled:false,identityBindingRequired:false},membership:{playerId:'p',identityBound:true},entryPricing:[]};
   else if(path.endsWith('/player/me'))data={wallet:[],activeSession:{id:'visit',startedAt:'2026-10-05T06:00:00Z'}};
   else if(path.endsWith('/player/billing-inputs'))data={playerId:'player',billingSnapshot:{version:1,capturedAt:'2026-10-05T07:00:00Z',assetDefinitions:[],currentPricingConfigs:[{id:'fixed',kind:'charge.fixed',name:'入场',enabled:true,status:'active',createdAt:'2026-01-01T00:00:00Z',updatedAt:'2026-01-01T00:00:00Z',provider:{id:'fixed',amount:12}}],pricingReleases:[],players:[{playerId:'player',sessions:[{id:'visit',playerId:'player',startedAt:'2026-10-05T06:00:00Z',status:'active',paymentStatus:'unpaid',pricingConfigIds:['fixed'],metadata:{}}],holdings:[],pastAppliedAdjustments:[],pricingPaidHistory:{},capPaidHistory:{}}]}};
   else if(path.endsWith('/checkout/preview'))data={settlementPreview:{total:12},chargeItems:[],adjustments:[]};
   else if(path.endsWith('/checkout/confirm')){confirmations++;// As the server answers: player text in the request's language, the diagnostic only in reason.
    await route.fulfill({status:409,contentType:'application/json',body:JSON.stringify({error:{code:'INSUFFICIENT_BALANCE',message:copy,reason:'Insufficient currency holdings for this operation.',notice:{code:'INSUFFICIENT_BALANCE',level:'warning',display:'dialog',flow:'none',title:locale==='en-US'?'Insufficient balance':'余额不足',body:copy,actions:[{kind:'dismiss',label:locale==='en-US'?'OK':'知道了'}]}}})});return;}
   else data={};
   await route.fulfill({status:200,contentType:'application/json',body:JSON.stringify({data})});
  });
  await checkoutPage.goto(`${process.env.PRISM_SCAN_ORIGIN || 'http://127.0.0.1:4173'}/t/demo`);
  const button=checkoutPage.getByRole('button',{name:checkout,exact:true});await button.click();await checkoutPage.getByRole('dialog').filter({hasText:copy}).waitFor();
  assert.equal(await checkoutPage.getByText('Insufficient currency holdings for this operation.',{exact:true}).count(),0);
  assert.equal(await button.isEnabled(),true);assert.equal(confirmations,1);
  assert.equal(await checkoutPage.getByText(billing,{exact:true}).count()>0,true);
  await checkoutPage.screenshot({path:`${output}/checkout-insufficient-${locale}.png`,fullPage:true});await checkoutPage.close();
 }
 console.log('PASS localized balance rejection retains the bill and permits manual retry');await browser.close();
})().catch(e=>{console.error(e);process.exit(1)});
