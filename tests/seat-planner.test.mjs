import assert from 'node:assert/strict';
import test from 'node:test';
import {planSeats,parseRubles,OBSERVATION_MAX_AGE_MS} from '../dist/extension/seat-planner.js';
const now=1_800_000_000_000;
const constraints={quantity:2,maxPerTicketKopecks:800000,maxTotalKopecks:1500000,adjacent:true,allowPassport:true,area:null};
function seat(number,patch={}) {
  return {reference:`svg_7:rect_${number}`,svgIndex:7,rectIndex:number,geometry:{x:0.1+number*0.018,y:0.89,width:0.01267,height:0.015931},area:'Особая ложа',row:3,seat:number,priceKopecks:750000,currency:'RUB',availability:'passport_required',observedAt:now-1000,association:'observed_after_manual_hover',associationVerified:false,...patch};
}
const actual=[seat(5,{rectIndex:295,reference:'svg_7:rect_295',geometry:{height:0.015931,width:0.01267,x:0.523877,y:0.895833}}),seat(4,{rectIndex:292,reference:'svg_7:rect_292',geometry:{height:0.015931,width:0.01267,x:0.54142,y:0.893382}}),seat(3,{rectIndex:288,reference:'svg_7:rect_288',geometry:{height:0.015931,width:0.01267,x:0.561886,y:0.890931}})];
test('observed example produces pairs 3–4 and 4–5 for 15,000 rubles independent of SVG order',()=>{
  const plan=planSeats(actual,constraints,now);
  assert.equal(plan.reason,null);assert.deepEqual(plan.offers.map(o=>o.seats.map(s=>s.seat)),[[3,4],[4,5]]);
  assert.deepEqual(plan.offers.map(o=>o.totalKopecks),[1500000,1500000]);
  assert.equal(plan.requiresReview,true);assert.equal(plan.adjacencyVerified,false);
  assert.equal(plan.offers[0].adjacency,'number_and_geometry_candidate');
  assert.equal(plan.offers[0].expiresAt,now-1000+OBSERVATION_MAX_AGE_MS);
});
test('individual and total budgets are hard bounds including single kopeck differences',()=>{
  assert.equal(planSeats(actual,{...constraints,maxPerTicketKopecks:749999},now).offers.length,0);
  assert.equal(planSeats(actual,{...constraints,maxTotalKopecks:1499999},now).reason,'total_budget_exceeded');
  assert.equal(planSeats(actual,{...constraints,quantity:3,maxTotalKopecks:2250000},now).offers[0].totalKopecks,2250000);
  assert.equal(planSeats(actual,{...constraints,quantity:4,maxTotalKopecks:3000000},now).reason,'not_enough_seats');
});
test('occupied, unavailable and selected seats cannot become offers; passport places require explicit opt-in',()=>{
  for(const availability of ['occupied','unavailable','selected']) assert.equal(planSeats([seat(1,{availability}),seat(2)],constraints,now).reason,'not_enough_seats');
  assert.equal(planSeats(actual,{...constraints,allowPassport:false},now).reason,'no_eligible_seats');
  const available=[seat(1,{availability:'available'}),seat(2,{availability:'available'})];
  assert.equal(planSeats(available,{...constraints,allowPassport:false},now).offers.length,1);
});
test('sector constraints are exact and never expanded implicitly',()=>{
  assert.equal(planSeats(actual,{...constraints,area:'Партер'},now).offers.length,0);
  assert.equal(planSeats(actual,{...constraints,area:'Особая ложа'},now).offers.length,2);
});
test('adjacent candidates need one SVG, area, row, consecutive numbers and no obvious geometry gap',()=>{
  for(const pair of [[seat(1),seat(3)],[seat(1),seat(2,{row:4})],[seat(1),seat(2,{area:'Партер'})],[seat(1),seat(2,{svgIndex:8,reference:'svg_8:rect_2'})],[seat(1),seat(2,{geometry:{x:0.8,y:0.89,width:0.01267,height:0.015931}})],[seat(1),seat(2,{geometry:seat(1).geometry})]]) {
    assert.equal(planSeats(pair,constraints,now).reason,'no_adjacent_group');
    assert.equal(planSeats(pair,{...constraints,adjacent:false},now).offers.length,1);
  }
});
test('no-adjacency mode finds cheapest combinations across sectors and rows',()=>{
  const values=[seat(1,{priceKopecks:10000}),seat(2,{priceKopecks:20000,area:'Партер'}),seat(3,{priceKopecks:30000,row:6}),seat(4,{priceKopecks:40000})];
  const plan=planSeats(values,{...constraints,adjacent:false},now);
  assert.deepEqual(plan.offers.map(o=>o.totalKopecks),[30000,40000,50000]);
  assert.ok(plan.offers.every(o=>o.adjacency==='not_requested'));
});
test('cheapest-combination search matches an independent exhaustive oracle on small inventories',()=>{
  function combinations(array,count,start=0,prefix=[]){if(!count)return[prefix];return array.flatMap((s,i)=>i<start?[]:combinations(array,count-1,i+1,[...prefix,s]));}
  for(let run=0;run<25;run++)for(const quantity of [1,2,3,4]) {
    const values=Array.from({length:8},(_,i)=>seat(i+1,{priceKopecks:10000+((run*17+i*31)%13)*1000,availability:'available'}));
    const budget=30000+run*3000;
    const eligible=combinations(values,quantity).map(c=>c.reduce((sum,s)=>sum+s.priceKopecks,0)).filter(sum=>sum<=budget).sort((a,b)=>a-b).slice(0,3);
    const plan=planSeats(values,{...constraints,quantity,adjacent:false,maxTotalKopecks:budget},now);
    assert.deepEqual(plan.offers.map(o=>o.totalKopecks),eligible);
    assert.equal(new Set(plan.offers.map(o=>o.seats.map(s=>s.reference).sort().join(','))).size,plan.offers.length);
  }
});
test('stale, undated, future and malformed observations are excluded',()=>{
  assert.equal(planSeats(actual.map(s=>({...s,observedAt:now-OBSERVATION_MAX_AGE_MS})),constraints,now).reason,'stale_observations');
  for(const patch of [{observedAt:undefined},{observedAt:now+1001},{priceKopecks:NaN},{priceKopecks:-1},{geometry:{x:NaN,y:0,width:.01,height:.01}},{currency:'USD'},{reference:'PRIVATE'},{area:'<script>private</script>'}]) {
    const plan=planSeats([seat(1,patch),seat(2)],constraints,now);
    assert.equal(plan.offers.length,0);assert.equal(plan.summary.invalid,1);
  }
  assert.equal(planSeats([],constraints,now).reason,'no_observations');
});
test('conflicting references and duplicate identities are excluded, identical duplicate observations deduplicate',()=>{
  assert.equal(planSeats([seat(1),seat(1,{priceKopecks:10000}),seat(2)],constraints,now).summary.conflicting,1);
  const conflicting=planSeats([seat(1),seat(1,{rectIndex:3,reference:'svg_7:rect_3'}),seat(2)],constraints,now);
  assert.equal(conflicting.summary.conflicting,2);assert.equal(conflicting.offers.length,0);
  const same=planSeats([seat(1),seat(1,{observedAt:now-100}),seat(2)],constraints,now);
  assert.equal(same.offers.length,1);assert.equal(same.offers[0].seats[0].observedAt,now-100);
});
test('money parser uses exact kopecks and rejects malformed or overflowing prices',()=>{
  for(const [value,expected] of [['7500',750000],['7 500,50',750050],['7\u00a0500.5',750050],['0,01',1],[' 8000 ',800000]])assert.equal(parseRubles(value),expected);
  for(const value of ['','-1','0','NaN','Infinity','1e4','7500руб','1,123','75 00','999999999999999'])assert.throws(()=>parseRubles(value));
});
test('invalid constraints fail instead of being silently corrected',()=>{
  for(const patch of [{quantity:0},{quantity:5},{quantity:1.5},{maxPerTicketKopecks:Infinity},{maxTotalKopecks:-1},{adjacent:'yes'},{allowPassport:1},{area:'unknown'}])assert.throws(()=>planSeats(actual,{...constraints,...patch},now));
  assert.throws(()=>planSeats(null,constraints,now));assert.throws(()=>planSeats(Array(1501).fill(actual[0]),constraints,now));
});
test('does not mutate observations or constraints and returns independent records',()=>{
  const values=structuredClone(actual);const before=JSON.stringify(values);const limits=Object.freeze({...constraints});
  const result=planSeats(values,limits,now);result.offers[0].seats[0].geometry.x=999;
  assert.equal(JSON.stringify(values),before);
});

test('automatic inventory beyond one hundred seats is considered, including cheapest seats at the end',()=>{
  const values=Array.from({length:1500},(_,i)=>seat(i+1,{association:'observed_after_automatic_hover',priceKopecks:i>=1498?10000:750000,geometry:{x:(i%50)*.018,y:Math.floor(i/50)*.018,width:.012,height:.012}}));
  const plan=planSeats(values,{...constraints,adjacent:false},now);
  assert.equal(plan.summary.eligible,1500);assert.deepEqual(plan.offers[0].seats.map(s=>s.seat),[1499,1500]);assert.equal(plan.offers[0].totalKopecks,20000);
});

test('opposite sides of a hall never merge into an adjacent pair with consecutive seat numbers',()=>{
  const values=[seat(1,{area:'Амфитеатр, левая сторона'}),seat(2,{area:'Амфитеатр, правая сторона'})];
  assert.equal(planSeats(values,constraints,now).reason,'no_adjacent_group');
  assert.equal(planSeats(values,{...constraints,adjacent:false},now).offers.length,1);
});
