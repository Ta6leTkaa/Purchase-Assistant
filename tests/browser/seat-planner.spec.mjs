import {test,expect,chromium} from '@playwright/test';
import {mkdtemp,cp,readFile,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

test('real extension: automatic inventory -> budget preview -> invalidation, without manual hover or site clicks',async()=>{
  test.setTimeout(60_000);
  const folder=await mkdtemp(path.join(tmpdir(),'purchase-seat-planner-test-'));
  let context;
  try{
    const extension=path.join(folder,'extension');await cp(path.resolve('dist/extension'),extension,{recursive:true});
    const manifest=JSON.parse(await readFile(path.join(extension,'manifest.json'),'utf8'));
    // Only this temporary test copy has host access; all requests to this origin are intercepted below.
    manifest.host_permissions=['https://ticket.bolshoi.ru/*'];manifest.background={service_worker:'test-bootstrap.js'};
    await writeFile(path.join(extension,'manifest.json'),JSON.stringify(manifest));
    await writeFile(path.join(extension,'test-bootstrap.js'),'chrome.runtime.onInstalled.addListener(() => {});');
    context=await chromium.launchPersistentContext(path.join(folder,'browser'),{channel:'chromium',headless:true,args:[`--disable-extensions-except=${extension}`,`--load-extension=${extension}`],...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
    const worker=context.serviceWorkers()[0]??await context.waitForEvent('serviceworker');const base=`chrome-extension://${new URL(worker.url()).hostname}`;
    const rects=Array.from({length:24},(_,i)=>`<rect class="seat${[2,3,4].includes(i)?'':' unavailable'}" x="${20+i*20}" y="180" width="12" height="12" fill="white" stroke="red"/>`).join('');
    await context.route('https://ticket.bolshoi.ru/**',route=>route.fulfill({contentType:'text/html; charset=utf-8',body:`<!doctype html><html><head><style>body{margin:0}#tip{display:none;position:absolute;top:40px;width:196px;padding:8px;font:14px/24px sans-serif;background:white}</style></head><body><svg width="700" height="300">${rects}</svg><div id="tip"></div><script>window.currentArea='Амфитеатр';window.siteClicks=0;document.addEventListener('click',()=>window.siteClicks++);document.querySelectorAll('rect').forEach((r,i)=>{r.addEventListener('pointerover',()=>{const t=document.querySelector('#tip');t.innerHTML='<div>'+window.currentArea+'</div><div>Левая сторона, Ряд 3, Место '+(i+1)+'</div><div>7 500 ₽</div><div>Доступно по паспорту</div>';t.style.left=(r.getBoundingClientRect().right+10)+'px';t.style.display='block';});r.addEventListener('pointerout',()=>document.querySelector('#tip').style.display='none');});</script></body></html>`}));
    const target=await context.newPage();await target.goto('https://ticket.bolshoi.ru/show/synthetic-planner-only');
    const popup=await context.newPage();await popup.clock.install();await popup.setViewportSize({width:400,height:1000});await popup.goto(`${base}/popup.html`);
    const tabId=await popup.evaluate(async()=>{const tabs=await chrome.tabs.query({});return tabs.find(t=>t.url?.includes('/show/synthetic-planner-only'))?.id;});
    expect(tabId).toBeDefined();
    // A tab-opened popup does not have Chrome's real action popup focus semantics.
    // Stub only the active-tab selection; executeScript and the isolated-world collector are real.
    await popup.evaluate(id=>{chrome.tabs.query=async()=>[{id}];},tabId);
    await popup.locator('#planPerTicket').fill('8000');await popup.locator('#planTotal').fill('15000');await popup.locator('#planPassport').check();
    await popup.getByRole('button',{name:'Найти билеты',exact:true}).click();
    await expect(popup.locator('.seat-offer')).toHaveCount(2,{timeout:15000});await expect(popup.locator('#planStatus')).toContainText('Найдено вариантов: 2');
    await expect(popup.locator('.seat-offer').first()).toContainText('место 3');await expect(popup.locator('.seat-offer').first()).toContainText('место 4');
    await expect(popup.locator('.seat-offer').first()).not.toContainText('место 5');
    await expect(popup.locator('.seat-offer').last()).toContainText('место 5');
    await popup.screenshot({path:'test-results/seat-planner.png',fullPage:true});
    await popup.locator('#planTotal').fill('14999,99');await expect(popup.locator('.seat-offer')).toHaveCount(0);
    await popup.getByRole('button',{name:'Найти билеты',exact:true}).click();await expect(popup.locator('#planStatus')).toContainText('превышают общий бюджет');
    await popup.locator('#planTotal').fill('15000');await popup.locator('#planPassport').uncheck();await popup.getByRole('button',{name:'Найти билеты',exact:true}).click();
    await expect(popup.locator('#planStatus')).toContainText('нет мест под эти условия');await expect(popup.locator('.seat-offer')).toHaveCount(0);
    await popup.locator('#planPassport').check();await popup.getByRole('button',{name:'Найти билеты',exact:true}).click();await expect(popup.locator('.seat-offer')).toHaveCount(2);
    await popup.clock.fastForward(120_100);await expect(popup.locator('.seat-offer')).toHaveCount(0);await expect(popup.locator('#planStatus')).toContainText('устарели');
    await target.evaluate(()=>window.currentArea='PRIVATE-AREA');
    await popup.getByRole('button',{name:'Найти билеты',exact:true}).click();
    await expect(popup.locator('#planStatus')).toContainText('Подсказки открылись, но их формат не распознан');
    await expect(popup.locator('#planStatus')).not.toContainText('Сайт не открыл');
    expect(await target.evaluate(()=>window.siteClicks)).toBe(0);
  }finally{if(context)await context.close();await rm(folder,{recursive:true,force:true});}
});
