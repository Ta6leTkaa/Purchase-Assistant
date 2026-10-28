import {test, expect, chromium} from '@playwright/test';
import {inspectBolshoiPage} from '../../dist/extension/bolshoi-inspector.js';

test('read-only geometry inventory in real Chromium on an intercepted synthetic page',async()=>{
  const browser=await chromium.launch({headless:true,...(process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE?{executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE}:{})});
  try{
    const page=await browser.newPage();
    const svg=Array.from({length:24},(_,i)=>`<rect x="${i*18+5}" y="20" width="12" height="12" data-seat="${i+1}" data-row="2" data-price="1500" stroke="red" fill="white"/>`).join('');
    const html=Array.from({length:24},(_,i)=>`<span class="place" data-seat="${i+1}" data-row="3" style="display:inline-block;width:12px;height:12px;margin:3px;border:1px solid green;cursor:pointer"></span>`).join('');
    await page.route('**/*',route=>route.fulfill({contentType:'text/html',body:`<!doctype html><html><body><label>Фамилия<input value="PRIVATE-PERSON"></label><svg width="700" height="300">${svg}</svg><div>${html}</div><button>Продолжить</button></body></html>`}));
    await page.goto('https://ticket.bolshoi.ru/show/synthetic-only?token=PRIVATE-TOKEN');
    await page.evaluate(()=>{window.testClicks=0;document.addEventListener('click',()=>window.testClicks++);});
    const result=await page.evaluate(inspectBolshoiPage);
    expect(result.ok).toBe(true);
    expect(result.report.mapStructure.svgSurfaces[0].mapCandidate).toBe(true);
    expect(result.report.mapStructure.seatCandidates.filter(s=>s.tag==='rect')).toHaveLength(24);
    expect(result.report.mapStructure.seatCandidates.filter(s=>s.tag==='span')).toHaveLength(24);
    expect(result.report.mapStructure.seatCandidates.some(s=>s.metadata.price===1500)).toBe(true);
    expect(result.report.mapStructure.availabilityVerified).toBe(false);
    expect(JSON.stringify(result)).not.toContain('PRIVATE');
    expect(await page.locator('input').inputValue()).toBe('PRIVATE-PERSON');
    expect(await page.evaluate(()=>window.testClicks)).toBe(0);
  }finally{await browser.close();}
});
