import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import test from 'node:test';
import {JSDOM} from 'jsdom';
import {autofillPage} from '../dist/extension/autofill.js';
import {demoPeople} from '../dist/extension/profile.js';
const fixture = await readFile(new URL('./fixtures/family.html', import.meta.url), 'utf8');
function page(url = 'http://127.0.0.1:4173/family.html') {
  const dom = new JSDOM(fixture, {url});
  // Use the page realm as Chrome does; do not run scripts embedded in the fixture.
  // jsdom without runScripts shares globals; bind only the DOM APIs the function uses.
  const execute = new Function('document', 'location', 'HTMLInputElement', 'Event', 'people', 'apply',
    `return (${autofillPage.toString()})(people, apply)`);
  return {document: dom.window.document, fill: (people = demoPeople, apply = true) =>
    execute(dom.window.document, dom.window.location, dom.window.HTMLInputElement, dom.window.Event, people, apply),
    close: () => dom.window.close()};
}
test('preview does not write and reports eight fields', () => {
  const p = page();
  try {
    assert.deepEqual(p.fill(demoPeople, false), {ok: true, count: 8, message: 'Готово к заполнению: 2 чел., 8 полей. Порядок — как в списке.'});
    assert.ok([...p.document.querySelectorAll('input')].every(i => i.value === ''));
  } finally {p.close();}
});
test('keeps profiles in their groups, dispatches events, never submits', () => {
  const p = page();
  try {
    let submits = 0, inputs = 0, changes = 0;
    p.document.addEventListener('submit', () => submits++);
    p.document.addEventListener('input', () => inputs++);
    p.document.addEventListener('change', () => changes++);
    // Reverse DOM order: group index, not field occurrence, selects the person.
    const form = p.document.querySelector('form');
    form.prepend(p.document.querySelector('[data-person-index="1"]'));
    assert.equal(p.fill().ok, true);
    for (const [index, person] of demoPeople.entries()) {
      const group = p.document.querySelector(`[data-person-index="${index}"]`);
      assert.equal(group.querySelector('[name="first_name"]').value, person.firstName);
      assert.equal(group.querySelector('[name="last_name"]').value, person.lastName);
      assert.equal(group.querySelector('[name="birth_date"]').value, person.birthDate);
      assert.equal(group.querySelector('[name="passport_number"]').value, person.documents[0].number);
    }
    assert.equal(submits, 0); assert.equal(inputs, 8); assert.equal(changes, 8);
  } finally {p.close();}
});
for (const [name, mutate] of [
  ['duplicate group index', d => {d.querySelector('[data-person-index="1"]').dataset.personIndex = '0';}],
  ['missing group index', d => {d.querySelector('[data-person-index="1"]').removeAttribute('data-person-index');}],
  ['unknown required field', d => {const i = d.createElement('input'); i.name = 'citizenship'; i.required = true; d.querySelector('fieldset').append(i);}],
  ['duplicate profile field', d => {d.querySelector('fieldset').append(d.querySelector('input').cloneNode());}],
  ['readonly field', d => {d.querySelector('input').readOnly = true;}],
  ['missing field', d => {d.querySelector('[name="birth_date"]').remove();}]
]) test(`rejects ${name} before any write`, () => {
  const p = page();
  try {mutate(p.document); assert.equal(p.fill().ok, false); assert.ok([...p.document.querySelectorAll('input')].every(i => i.value === ''));}
  finally {p.close();}
});
test('does not overwrite another value or partially fill', () => {
  const p = page();
  try {
    const last = p.document.querySelectorAll('[name="passport_number"]')[1]; last.value = 'existing';
    assert.equal(p.fill().ok, false);
    assert.equal(last.value, 'existing'); assert.equal(p.document.querySelector('input').value, '');
  } finally {p.close();}
});
test('rejects ambiguous documents and participant selection', () => {
  const p = page();
  try {
    assert.equal(p.fill([]).ok, false);
    assert.equal(p.fill([demoPeople[0]]).ok, false);
    assert.equal(p.fill([demoPeople[0], demoPeople[0]]).ok, false);
    assert.equal(p.fill([{...demoPeople[0], documents: []}, demoPeople[1]]).ok, false);
    assert.equal(p.fill([{...demoPeople[0], documents: [...demoPeople[0].documents, ...demoPeople[0].documents]}, demoPeople[1]]).ok, false);
  } finally {p.close();}
});
for (const url of ['https://example.com/family.html', 'http://127.0.0.1:4173/other.html', 'http://127.0.0.1:4174/family.html']) {
  test(`refuses unsupported URL ${url}`, () => {const p = page(url); try {assert.equal(p.fill().ok, false);} finally {p.close();}});
}
test('manifest grants only on-demand active-tab access', async () => {
  const manifest = JSON.parse(await readFile(new URL('../dist/extension/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting']);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.background, undefined);
});
