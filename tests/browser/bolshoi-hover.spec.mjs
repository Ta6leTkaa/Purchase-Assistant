import {test, expect, chromium} from '@playwright/test';
import {controlBolshoiHover} from '../../dist/extension/bolshoi-hover.js';
let browser, page;
test.beforeAll(async()=>{browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});});
test.afterAll(async()=>{await browser.close();});
test.beforeEach(async()=>{
  page=await browser.newPage();
  const seats=Array.from({length:24},(_,i)=>`<rect class="seat" data-test-index="${i}" x="${20+i*20}" y="180" width="12" height="12" fill="white" stroke="red"/>`).join('');
  const body=`<!doctype html><html><head><style>body{margin:0}.tip{position:absolute;background:white;width:196px;padding:8px;font:14px/24px sans-serif;border:1px solid gray;display:none}</style></head><body><input value="PRIVATE-PASSPORT"><svg width="700" height="300">${seats}</svg><div id="tip" class="tip"></div><div id="otherTip" class="tip"></div><script>
    window.clicks=0;window.submits=0;window.mode='normal';window.price='7 500';window.area='Особая ложа';window.state='Доступно по паспорту';window.delay=0;window.side='';window.inline=false;window.duplicateNumbers=false;window.alternateSides=false;
    document.addEventListener('click',()=>window.clicks++);document.addEventListener('submit',()=>window.submits++);
    document.querySelectorAll('rect.seat').forEach((node,index)=>{
      node.addEventListener('pointerover',event=>{
        if(window.mode==='trustedOnly'&&!event.isTrusted)return;
        if(window.mode==='stale')return;
        const show=()=>{
          const tip=document.querySelector('#tip');const rect=node.getBoundingClientRect();
          const side=window.alternateSides?(index%2?'Правая сторона':'Левая сторона'):window.side;
          const number=window.duplicateNumbers?Math.floor(index/2)+1:index+1;
          const fields=[window.area,(side?side+', ':'')+'Ряд 3, Место '+number,window.price+' ₽',window.state];
          tip.innerHTML=fields.map(value=>window.inline?'<span>'+value+' </span>':'<div>'+value+'</div>').join('');
          tip.style.left=(rect.right+10)+'px';tip.style.top='40px';tip.style.display='block';
          if(window.mode==='ambiguous'){const other=document.querySelector('#otherTip');other.innerHTML=tip.innerHTML.replace('Место '+(index+1),'Место 99');other.style.left=(rect.left-210)+'px';other.style.top='40px';other.style.display='block';}
        };
        if(window.delay)setTimeout(show,window.delay);else show();
      });
      node.addEventListener('pointerout',()=>{if(window.mode!=='stale'){document.querySelector('#tip').style.display='none';document.querySelector('#otherTip').style.display='none';}});
    });
  </script></body></html>`;
  await page.route('**/*',route=>route.fulfill({contentType:'text/html; charset=utf-8',body}));
  await page.goto('https://ticket.bolshoi.ru/show/synthetic-only?token=PRIVATE-TOKEN');
});
test.afterEach(async()=>{await page.close();});
const read=async()=>(await page.evaluate(controlBolshoiHover,'read')).report;
async function hover(index=4){await page.locator('rect.seat').nth(index).hover();}
async function samples(count=1){await expect.poll(async()=>(await read()).samples.length).toBe(count);return (await read()).samples;}

test('captures screenshot-shaped tooltip, links rect, exports only parsed public data, never clicks',async()=>{
  await page.evaluate(controlBolshoiHover,'start');await hover();
  const [seat]=await samples();
  expect(seat.area).toBe('Особая ложа');expect(seat.row).toBe(3);expect(seat.seat).toBe(5);
  expect(seat.priceKopecks).toBe(750000);expect(seat.availability).toBe('passport_required');
  expect(seat.rectIndex).toBe(5);expect(seat.svgIndex).toBe(1);expect(seat.reference).toBe('svg_1:rect_5');
  expect(seat.geometry.x).toBeGreaterThan(0);expect(seat.associationVerified).toBe(false);
  expect(JSON.stringify(await read())).not.toContain('PRIVATE');
  expect(await page.locator('input').inputValue()).toBe('PRIVATE-PASSPORT');
  expect(await page.evaluate(()=>[window.clicks,window.submits])).toEqual([0,0]);
  const stopped=await page.evaluate(controlBolshoiHover,'stop');expect(stopped.report.status).toBe('stopped');
  await hover(6);expect((await read()).samples).toHaveLength(1);
});
test('reads current price with nonbreaking spaces and kopecks; updates same element without duplicates',async()=>{
  await page.evaluate(()=>{window.price='12\u00a0500,50';window.area='Ложа 2, правая сторона';window.state='Доступно';});
  await page.evaluate(controlBolshoiHover,'start');await hover(1);
  const [seat]=await samples();expect(seat.priceKopecks).toBe(1250050);expect(seat.area).toBe('Ложа 2, правая сторона');
  await page.mouse.move(5,330);await page.evaluate(()=>window.price='13 000');await hover(1);
  await expect.poll(async()=>(await read()).samples[0]?.priceKopecks).toBe(1300000);expect((await read()).samples).toHaveLength(1);
});
test('does not attach previous tooltip to the next hovered seat',async()=>{
  await page.evaluate(controlBolshoiHover,'start');await hover(4);await samples();
  await page.evaluate(()=>window.mode='stale');await hover(5);
  await expect.poll(async()=>(await read()).rejected.stale).toBeGreaterThan(0);
  expect((await read()).samples).toHaveLength(1);expect((await read()).samples[0].seat).toBe(5);
});
test('ignores delayed tooltip after pointer leaves the seat and removes detached samples',async()=>{
  await page.evaluate(()=>window.delay=250);await page.evaluate(controlBolshoiHover,'start');await hover();
  await page.mouse.move(5,330);await expect(page.locator('#tip')).toBeVisible();expect((await read()).samples).toHaveLength(0);
  await page.evaluate(()=>{window.delay=0;document.querySelector('#tip').style.display='none';});await hover();await samples();
  await page.locator('rect.seat').nth(4).evaluate(node=>node.remove());expect((await read()).samples).toHaveLength(0);
});
test('rejects unsupported arbitrary text rather than exporting it',async()=>{
  await page.evaluate(()=>window.area='PRIVATE-PERSON');await page.evaluate(controlBolshoiHover,'start');await hover();
  await expect.poll(async()=>(await read()).rejected.unrecognized).toBeGreaterThan(0);expect((await read()).samples).toHaveLength(0);
  expect(JSON.stringify(await read())).not.toContain('PRIVATE');
});
test('untrusted synthetic hover is ignored; page change clears observations',async()=>{
  await page.evaluate(controlBolshoiHover,'start');
  await page.locator('rect.seat').nth(4).dispatchEvent('pointerover',{bubbles:true});
  expect((await read()).samples).toHaveLength(0);
  await page.mouse.move(5,330);await page.evaluate(()=>document.querySelector('#tip').style.display='none');await hover();await samples();
  await page.evaluate(()=>history.pushState({},'', '/show/different'));
  const changed=await read();expect(changed.status).toBe('page_changed');expect(changed.samples).toHaveLength(0);
});
test('session expires and listeners stop after two minutes',async()=>{
  await page.clock.install();await page.evaluate(controlBolshoiHover,'start');
  await page.clock.fastForward(120_100);expect((await read()).status).toBe('expired');
});

test('rejects two simultaneous nearby tooltips rather than guessing which belongs to a seat',async()=>{
  await page.evaluate(()=>window.mode='ambiguous');await page.evaluate(controlBolshoiHover,'start');await hover(12);
  await expect.poll(async()=>(await read()).rejected.ambiguous).toBeGreaterThan(0);expect((await read()).samples).toHaveLength(0);
});

test('form context change clears observations and records capture time',async()=>{
  await page.evaluate(controlBolshoiHover,'start');await hover();const [seat]=await samples();
  expect(seat.observedAt).toBeGreaterThan(Date.now()-10000);expect((await read()).version).toBe(3);
  await page.locator('input').focus();await page.locator('input').press('End');await page.locator('input').press('x');await page.locator('input').press('Tab');
  await expect.poll(async()=>(await read()).status).toBe('context_changed');expect((await read()).samples).toHaveLength(0);
});

test('context guard invalidates previously collected seats even after manual stop',async()=>{
  await page.evaluate(controlBolshoiHover,'start');await hover();await samples();await page.evaluate(controlBolshoiHover,'stop');
  await page.locator('input').focus();await page.locator('input').press('End');await page.locator('input').press('x');await page.locator('input').press('Tab');
  expect((await read()).status).toBe('context_changed');expect((await read()).samples).toHaveLength(0);
});

async function completeScan() {
  await expect.poll(async()=>(await read()).status,{timeout:10000}).not.toBe('running');
  return await read();
}
test('automatic scan reads all tooltip records without any physical hover or click',async()=>{
  await page.evaluate(controlBolshoiHover,'scan');const report=await completeScan();
  expect(report.status).toBe('completed');expect(report.mode).toBe('automatic');expect(report.scan.complete).toBe(true);
  expect(report.samples).toHaveLength(24);expect(report.scan.visited).toBe(24);expect(report.scan.failed).toBe(0);
  expect(report.samples.every(s=>s.association==='observed_after_automatic_hover')).toBe(true);
  expect(new Set(report.samples.map(s=>s.seat)).size).toBe(24);
  expect(await page.evaluate(()=>[window.clicks,window.submits])).toEqual([0,0]);
  expect(await page.locator('.seat.selected').count()).toBe(0);
});
test('automatic scan skips explicit unavailable rectangles without requiring manual enumeration',async()=>{
  await page.locator('rect.seat').evaluateAll(nodes=>nodes.forEach((n,i)=>{if(![2,3,4].includes(i))n.classList.add('unavailable');}));
  await page.evaluate(controlBolshoiHover,'scan');const report=await completeScan();
  expect(report.samples.map(s=>s.seat)).toEqual([3,4,5]);expect(report.scan.skipped).toBe(21);expect(report.scan.total).toBe(3);
});
test('trusted-only site produces unsupported result, never a false sold-out conclusion',async()=>{
  await page.evaluate(()=>window.mode='trustedOnly');await page.evaluate(controlBolshoiHover,'scan');const report=await completeScan();
  expect(report.status).toBe('unsupported');expect(report.scan.complete).toBe(false);expect(report.samples).toHaveLength(0);expect(report.scan.failed).toBe(5);
  expect(await page.evaluate(()=>window.clicks)).toBe(0);
});
test('stopping automatic scan prevents delayed site responses from adding samples',async()=>{
  await page.evaluate(()=>window.delay=200);await page.evaluate(controlBolshoiHover,'scan');await page.evaluate(controlBolshoiHover,'stop');
  await expect(page.locator('#tip')).toBeVisible();expect((await read()).status).toBe('stopped');expect((await read()).samples).toHaveLength(0);
});
test('automatic scan refuses old tooltip content and multiple simultaneous tooltip candidates',async()=>{
  await page.evaluate(()=>window.mode='ambiguous');await page.evaluate(controlBolshoiHover,'scan');const report=await completeScan();
  expect(report.status).toBe('unsupported');expect(report.samples).toHaveLength(0);expect(report.rejected.ambiguous).toBeGreaterThan(0);
});

test('regression: automatic scan parses screenshot format with side before row and continues past five seats',async()=>{
  await page.evaluate(()=>{window.area='Амфитеатр';window.side='Левая сторона';});
  await page.evaluate(controlBolshoiHover,'scan');const report=await completeScan();
  expect(report.status).toBe('completed');expect(report.scan.visited).toBe(24);expect(report.scan.failed).toBe(0);
  expect(report.samples).toHaveLength(24);expect(report.samples.every(s=>s.area==='Амфитеатр, левая сторона')).toBe(true);
  expect(report.samples[0].row).toBe(3);expect(report.samples[0].priceKopecks).toBe(750000);
});
test('side identity keeps equal row/place numbers on left and right as separate seats',async()=>{
  await page.evaluate(()=>{window.area='Амфитеатр';window.alternateSides=true;window.duplicateNumbers=true;});
  await page.evaluate(controlBolshoiHover,'scan');const report=await completeScan();
  expect(report.samples).toHaveLength(24);expect(report.rejected.ambiguous).toBe(0);
  expect(report.samples.filter(s=>s.seat===1).map(s=>s.area).sort()).toEqual(['Амфитеатр, левая сторона','Амфитеатр, правая сторона']);
});
test('wrapped and inline tooltip fields parse without depending on block line breaks',async()=>{
  await page.evaluate(()=>{window.area='Амфитеатр';window.side='Правая сторона';window.inline=true;document.querySelector('#tip').style.width='100px';});
  await page.evaluate(controlBolshoiHover,'start');await hover();const [seat]=await samples();
  expect(seat.area).toBe('Амфитеатр, правая сторона');expect(seat.row).toBe(3);expect(seat.seat).toBe(5);expect(seat.priceKopecks).toBe(750000);
});
test('visible unrecognized formats are counted and do not trigger the five-missing-tooltips bailout',async()=>{
  await page.evaluate(()=>{window.area='PRIVATE-PERSON';window.side='Левая сторона';});
  await page.evaluate(controlBolshoiHover,'scan');const report=await completeScan();
  expect(report.status).toBe('unsupported');expect(report.scan.visited).toBe(24);expect(report.scan.complete).toBe(true);
  expect(report.rejected.unrecognized).toBeGreaterThan(0);expect(report.samples).toHaveLength(0);
  expect(JSON.stringify(report)).not.toContain('PRIVATE-PERSON');
});
