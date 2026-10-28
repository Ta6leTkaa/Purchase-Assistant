import assert from 'node:assert/strict';
import test from 'node:test';
import {JSDOM} from 'jsdom';
import {inspectBolshoiPage} from '../dist/extension/bolshoi-inspector.js';
function inspect(html, url='https://ticket.bolshoi.ru/order/private-token?auth=secret#private') {
  const dom=new JSDOM(html,{url}); const w=dom.window;
  // Geometry is provided by a browser in production; jsdom has no layout engine.
  w.Element.prototype.getClientRects=function(){return this.hidden ? [] : [{width:100,height:20}];};
  w.Element.prototype.getBoundingClientRect=function(){
    const width=Number(this.getAttribute('data-test-width')??0),height=Number(this.getAttribute('data-test-height')??0);
    return {x:Number(this.getAttribute('data-test-x')??0),y:Number(this.getAttribute('data-test-y')??0),width,height};
  };
  const execute=new Function('document','location','HTMLInputElement','HTMLSelectElement','getComputedStyle','scrollX','scrollY',`return (${inspectBolshoiPage.toString()})()`);
  try {return execute(w.document,w.location,w.HTMLInputElement,w.HTMLSelectElement,w.getComputedStyle.bind(w),0,0);}
  finally {w.close();}
}
test('exports only bounded structural hints, never values, titles, URLs, labels, options or tokens',()=>{
  const result=inspect(`<title>Private name</title><label>Фамилия <input required name="PRIVATE-NAME-ATTR" value="Private name"></label><label>Номер документа <input maxlength="10" value="PRIVATE-PASSPORT-1234"></label><label>Пароль <input type=password value="password-secret"></label><input type=hidden name=csrf value="csrf-secret"><select aria-label="Тип документа"><option>PRIVATE OPTION</option></select><a href="/pay?secret=LINK-TOKEN">Оплатить</a><iframe src="https://www.google.com/recaptcha/api2/anchor?token=CAPTCHA-TOKEN"></iframe>`);
  assert.equal(result.ok,true);
  assert.deepEqual(result.report.controls.map(c=>c.fieldHint),['last_name','document_number','password','document_type']);
  assert.equal(result.report.controls[0].required,true);
  assert.equal(result.report.controls[1].maxLength,10);
  assert.deepEqual(result.report.recognizedActions,['payment']);
  assert.equal(result.report.routeKind,'checkout'); assert.equal(result.report.captchaFrameDetected,true);
  assert.equal(result.report.scope,'top_document_only'); assert.equal(result.report.reservationVerified,false);
  const text=JSON.stringify(result);
  for(const secret of ['Private name','PRIVATE-PASSPORT','password-secret','csrf-secret','PRIVATE OPTION','LINK-TOKEN','CAPTCHA-TOKEN','private-token','auth=secret','PRIVATE-NAME-ATTR','Тип документа']) assert.equal(text.includes(secret),false,secret);
});
test('does not click, fill or submit and treats ambiguous labels as unknown',()=>{
  const result=inspect('<form><label>Имя и фамилия<input value="untouched"></label><input hidden value="secret"><button type=submit>Продолжить</button></form>');
  assert.equal(result.report.controls.length,1); assert.equal(result.report.controls[0].fieldHint,'unknown'); assert.deepEqual(result.report.recognizedActions,['next']);
});
test('refuses lookalike domains, nonstandard ports and insecure URLs',()=>{
  for(const url of ['https://ticket.bolshoi.ru.evil.test/', 'https://evil.test/', 'http://ticket.bolshoi.ru/', 'https://ticket.bolshoi.ru:8443/']) assert.equal(inspect('<input>',url).ok,false);
});
test('caps controls and does not infer a seat map from SVG presence',()=>{
  const result=inspect('<svg></svg>'+ '<input>'.repeat(250));
  assert.equal(result.report.controls.length,200);assert.equal(result.report.controlsTruncated,true);assert.equal(result.report.visibleSvgCount,1);assert.equal(result.report.fieldHintsAreAuthoritative,false);
});

test('inventories a repeated SVG seat map with bounded public metadata, without interpreting colors as availability',()=>{
  const seats=Array.from({length:24},(_,i)=>`<rect data-test-width="12" data-test-height="12" data-test-x="${i*15}" data-row="2" data-seat="${i+1}" data-price="1500" data-seat-id="PRIVATE-ID" class="seat available PRIVATE-CLASS" style="fill:white;stroke:red;cursor:pointer" aria-label="PRIVATE-NAME" data-user="PRIVATE-PASSPORT"/>`).join('');
  const result=inspect(`<svg data-test-width="700" data-test-height="500">${seats}</svg>`);
  assert.equal(result.report.version,2);
  const map=result.report.mapStructure;
  assert.equal(map.svgSurfaces[0].mapCandidate,true);assert.equal(map.candidateCount,24);
  assert.equal(map.seatCandidates[0].metadata.price,1500);assert.equal(map.seatCandidates[0].metadata.row,2);
  assert.equal(map.seatCandidates[0].metadata.seat,1);assert.deepEqual(map.seatCandidates[0].metadata.classHints,['available','seat']);
  assert.equal(map.seatCandidates[0].metadata.declaredState,null);
  assert.equal(map.availabilityVerified,false);assert.equal(map.seatIdentityVerified,false);
  const serialized=JSON.stringify(map);for(const secret of ['PRIVATE-ID','PRIVATE-CLASS','PRIVATE-NAME','PRIVATE-PASSPORT','data-user']) assert.equal(serialized.includes(secret),false);
});
test('finds HTML seats when the SVGs are only toolbar icons; ignores unique small icons',()=>{
  const seats=Array.from({length:30},(_,i)=>`<div class="place" data-test-width="14" data-test-height="14" data-test-x="${i*16}" data-status="reserved"></div>`).join('');
  const result=inspect(`<svg data-test-width="24" data-test-height="24"><path/></svg><button data-test-width="36" data-test-height="36">Icon</button>${seats}`);
  const map=result.report.mapStructure;
  assert.equal(map.svgSurfaces[0].mapCandidate,false);assert.equal(map.candidateCount,30);
  assert.equal(map.seatCandidates[0].tag,'div');assert.equal(map.seatCandidates[0].svgIndex,null);
  assert.equal(map.seatCandidates[0].metadata.declaredState,'reserved');assert.equal(map.availabilityVerified,false);
});
test('caps seat inventory, excludes hidden shapes and refuses arbitrary style URLs or nonnumeric seat attributes',()=>{
  const seats=Array.from({length:1600},(_,i)=>`<span data-test-width="12" data-test-height="12" data-test-x="${i*15}" data-price="PRIVATE-PRICE" data-seat="1234567890" style="fill:url(https://private.test/secret)"></span>`).join('');
  const result=inspect(seats+'<span hidden data-test-width="12" data-test-height="12"></span>');
  const map=result.report.mapStructure;
  assert.equal(map.candidateCount,1600);assert.equal(map.seatCandidates.length,1500);assert.equal(map.candidatesTruncated,true);
  assert.equal(map.seatCandidates[0].metadata.price,null);assert.equal(map.seatCandidates[0].metadata.seat,null);
  assert.equal(map.seatCandidates[0].style.fill,null);assert.equal(JSON.stringify(map).includes('private.test'),false);
});
