import assert from 'node:assert/strict';
import test from 'node:test';
import {Vault, VaultConflictError, parseEnvelope, KDF_ITERATIONS} from '../dist/extension/vault.js';
import {demoPeople, validateProfile, validateProfiles, maskedDocument} from '../dist/extension/profile.js';
class MemoryStore {
  value;
  pending = Promise.resolve();
  fail = false;
  async read() {return structuredClone(this.value);}
  async write(value) {if (this.fail) throw new Error('Storage quota exceeded'); this.value = structuredClone(value);}
  async exclusive(operation) {
    const prior = this.pending;
    let release;
    this.pending = new Promise(resolve => {release = resolve;});
    await prior;
    try {return await operation();} finally {release();}
  }
}
const password = 'correct horse family vault 42';
const newerPassword = 'a different family password 73';
const person = {...demoPeople[0], id: 'synthetic-person', displayName: 'Private demo name', email: 'synthetic@example.test', phone: '+7 (000) 000-00-00', documents: [{type: 'internal_passport', number: 'SYNTHETIC-PASSPORT-1234'}]};
async function setup() {const store = new MemoryStore(); const vault = new Vault(store); await vault.create(password); return {store, vault};}

test('CRUD persists after restart; disk and backup contain only ciphertext', async () => {
  const {store, vault} = await setup();
  await vault.save(person);
  const serialized = JSON.stringify(store.value);
  for (const secret of [person.firstName, person.displayName, person.email, person.documents[0].number, password]) assert.equal(serialized.includes(secret), false);
  const restarted = new Vault(store);
  assert.equal(await restarted.exists(), true);
  assert.throws(() => restarted.people(), /разблокируйте/);
  await restarted.unlock(password);
  assert.deepEqual(restarted.people(), [person]);
  const copied = restarted.people(); copied[0].firstName = 'Mutation';
  assert.equal(restarted.people()[0].firstName, person.firstName);
  await restarted.save({...person, middleName: 'Updated'});
  assert.equal(restarted.people().length, 1);
  assert.equal(restarted.people()[0].middleName, 'Updated');
  const before = store.value;
  await restarted.remove(person.id);
  assert.deepEqual(restarted.people(), []);
  assert.notEqual(store.value.iv, before.iv);
  assert.notEqual(store.value.revision, before.revision);
  assert.equal(store.value.iterations, KDF_ITERATIONS);
  restarted.lock(); await restarted.unlock(password); assert.deepEqual(restarted.people(), []);
});
test('wrong password and tampered ciphertext cannot open data', async () => {
  const {store, vault} = await setup(); await vault.save(person); vault.lock();
  await assert.rejects(vault.unlock('incorrect password'), /Неверный пароль/);
  assert.equal(vault.unlocked, false);
  const backup = structuredClone(store.value);
  const data = Buffer.from(store.value.ciphertext, 'base64'); data[3] ^= 1;
  store.value.ciphertext = data.toString('base64');
  await assert.rejects(vault.unlock(password), /Неверный пароль/);
  assert.equal(vault.unlocked, false);
  store.value = backup; store.value.revision = crypto.randomUUID();
  await assert.rejects(vault.unlock(password), /Неверный пароль/);
});
test('password change re-encrypts all data and invalidates old password', async () => {
  const {store, vault} = await setup(); await vault.save(person);
  const oldSalt = store.value.salt;
  await assert.rejects(vault.changePassword('wrong', newerPassword), /Неверный пароль/);
  assert.equal(store.value.salt, oldSalt);
  await vault.changePassword(password, newerPassword);
  assert.notEqual(store.value.salt, oldSalt);
  vault.lock(); await assert.rejects(vault.unlock(password), /Неверный пароль/);
  await vault.unlock(newerPassword); assert.deepEqual(vault.people(), [person]);
});
test('encrypted backup restores, rejects invalid copies without replacing existing data', async () => {
  const {vault} = await setup(); await vault.save(person);
  const text = await vault.backup();
  const second = await setup(); await second.vault.save({...demoPeople[1], id: 'existing'});
  const before = structuredClone(second.store.value);
  await assert.rejects(second.vault.restore(text, 'wrong'), /Неверный пароль/);
  await assert.rejects(second.vault.restore('{oops', password), /не является/);
  assert.deepEqual(second.store.value, before);
  await second.vault.restore(text, password);
  assert.deepEqual(second.vault.people(), [person]);
  assert.notEqual(second.store.value.revision, JSON.parse(text).revision);
  second.vault.lock(); await second.vault.unlock(password); assert.deepEqual(second.vault.people(), [person]);
  const empty = new Vault(new MemoryStore()); await empty.restore(text, password); assert.deepEqual(empty.people(), [person]);
  const damagedStore = new MemoryStore(); damagedStore.value = {broken: true};
  const recovered = new Vault(damagedStore); await recovered.restore(text, password); assert.deepEqual(recovered.people(), [person]);
});
test('stale windows cannot overwrite profiles or export stale data', async () => {
  const {store, vault} = await setup();
  const other = new Vault(store); await other.unlock(password);
  await vault.save(person);
  await assert.rejects(other.save(demoPeople[1]), VaultConflictError);
  assert.equal(other.unlocked, false);
  await other.unlock(password);
  await vault.remove(person.id);
  await assert.rejects(other.backup(), VaultConflictError);
  await vault.assertFresh(); assert.deepEqual(vault.people(), []);
});
test('concurrent edits are serialized and one stale write is rejected', async () => {
  const {store, vault} = await setup();
  const other = new Vault(store); await other.unlock(password);
  const results = await Promise.allSettled([vault.save(person), other.save(demoPeople[1])]);
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  const reader = new Vault(store); await reader.unlock(password); assert.equal(reader.people().length, 1);
});
test('failed persistence keeps old data and reports failure', async () => {
  const {store, vault} = await setup(); await vault.save(person);
  const before = structuredClone(store.value); store.fail = true;
  await assert.rejects(vault.remove(person.id), /quota/);
  assert.deepEqual(vault.people(), [person]); assert.deepEqual(store.value, before);
});
test('locking during derivation does not resurrect a session', async () => {
  const {vault} = await setup(); vault.lock();
  const unlocking = vault.unlock(password); vault.lock();
  await assert.rejects(unlocking, /заблокировано/); assert.equal(vault.unlocked, false);
});
test('second create cannot overwrite an existing vault', async () => {
  const {store, vault} = await setup(); const before = structuredClone(store.value);
  await assert.rejects(new Vault(store).create(password), VaultConflictError);
  await assert.rejects(vault.create('short'), /12/); assert.deepEqual(store.value, before);
});
test('untrusted backup envelopes have strict version, size and KDF bounds', async () => {
  const {store, vault} = await setup();
  for (const patch of [{version: 2}, {iterations: 1}, {iterations: 2_000_001}, {salt: 'not base64'}, {iv: ''}, {extra: 'secret'}, {ciphertext: ''}]) {
    assert.throws(() => parseEnvelope({...store.value, ...patch}));
  }
  await assert.rejects(vault.restore('x'.repeat(2_000_001), password), /слишком большой/);
});
test('profile validation supports optional fields, multiple documents and rejects invalid data', () => {
  const minimal = {id:'one', firstName:'  Анна ',lastName:' Примерова ',displayName:' Мама ',documents:[]};
  assert.equal(validateProfile(minimal).firstName, 'Анна');
  assert.equal(validateProfile({...minimal, documents:person.documents}).documents.length, 1);
  for (const patch of [{firstName:''}, {birthDate:'2025-02-30'}, {birthDate:'2999-01-01'}, {email:'bad'}, {phone:'test'}, {documents:[{type:'unknown',number:'x'}]}, {documents:[...person.documents,...person.documents]}, {extra:'secret'}]) {
    assert.throws(() => validateProfile({...minimal,...patch}));
  }
  assert.throws(() => validateProfiles([minimal,minimal]));
  assert.throws(() => validateProfiles(Array.from({length:101},(_,i)=>({...minimal,id:String(i)}))));
  assert.equal(maskedDocument('123'), '••••'); assert.equal(maskedDocument('12345678'), '•••• 5678');
});
