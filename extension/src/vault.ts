import {validateProfiles, validateProfile, type PersonProfile} from "./profile.js";

export const VAULT_STORAGE_KEY = "purchaseAssistantVault";
export const MAX_BACKUP_BYTES = 2_000_000;
export const KDF_ITERATIONS = 600_000;
export interface VaultEnvelope {
  format: "purchase-assistant-vault";
  version: 1;
  kdf: "PBKDF2-SHA256";
  iterations: number;
  salt: string;
  iv: string;
  revision: string;
  ciphertext: string;
}
export interface VaultStore {
  read(): Promise<unknown>;
  write(value: VaultEnvelope): Promise<void>;
  exclusive<T>(operation: () => Promise<T>): Promise<T>;
}
export class VaultError extends Error {}
export class VaultConflictError extends VaultError {
  constructor() {super("Хранилище изменено в другом окне. Разблокируйте его заново; последние изменения сохранены.");}
}
const encoder = new TextEncoder();
function base64(bytes: Uint8Array): string {
  let result = "";
  for (let i = 0; i < bytes.length; i += 8192) result += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(result);
}
function bytes(value: unknown, max: number): Uint8Array {
  if (typeof value !== "string" || value.length > max || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw new VaultError("Неверный формат резервной копии.");
  try {
    const result = Uint8Array.from(atob(value), c => c.charCodeAt(0));
    if (base64(result) !== value) throw new Error();
    return result;
  } catch {throw new VaultError("Неверный формат резервной копии.");}
}
export function parseEnvelope(value: unknown): VaultEnvelope {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new VaultError("Хранилище повреждено или имеет неизвестный формат.");
  const v = value as Record<string, unknown>;
  const fields = ["format", "version", "kdf", "iterations", "salt", "iv", "revision", "ciphertext"];
  if (Object.keys(v).length !== fields.length || Object.keys(v).some(k => !fields.includes(k)) ||
      v.format !== "purchase-assistant-vault" || v.version !== 1 || v.kdf !== "PBKDF2-SHA256" ||
      !Number.isInteger(v.iterations) || (v.iterations as number) < KDF_ITERATIONS || (v.iterations as number) > 2_000_000 ||
      typeof v.revision !== "string" || !/^[0-9a-f-]{36}$/.test(v.revision) ||
      bytes(v.salt, 24).length !== 16 || bytes(v.iv, 16).length !== 12 || bytes(v.ciphertext, MAX_BACKUP_BYTES).length < 16) {
    throw new VaultError("Хранилище повреждено или имеет неизвестный формат.");
  }
  return structuredClone(v) as unknown as VaultEnvelope;
}
function aad(v: Omit<VaultEnvelope, "ciphertext">): Uint8Array {
  return encoder.encode(JSON.stringify([v.format, v.version, v.kdf, v.iterations, v.salt, v.iv, v.revision]));
}
function checkPassword(password: string) {
  if (password.length < 12 || password.length > 256 || !password.trim()) throw new VaultError("Пароль должен содержать от 12 до 256 символов. Используйте длинную уникальную фразу.");
}
async function derive(password: string, salt: string, iterations: number): Promise<CryptoKey> {
  const secret = encoder.encode(password);
  try {
    const material = await crypto.subtle.importKey("raw", secret, "PBKDF2", false, ["deriveKey"]);
    return await crypto.subtle.deriveKey({name: "PBKDF2", salt: bytes(salt, 24), iterations, hash: "SHA-256"}, material,
      {name: "AES-GCM", length: 256}, false, ["encrypt", "decrypt"]);
  } finally {secret.fill(0);}
}
async function seal(people: readonly PersonProfile[], key: CryptoKey, settings: Pick<VaultEnvelope, "salt" | "iterations">): Promise<VaultEnvelope> {
  const header = {format: "purchase-assistant-vault" as const, version: 1 as const, kdf: "PBKDF2-SHA256" as const,
    iterations: settings.iterations, salt: settings.salt, iv: base64(crypto.getRandomValues(new Uint8Array(12))), revision: crypto.randomUUID()};
  const plain = encoder.encode(JSON.stringify({version: 1, people: validateProfiles(people)}));
  try {
    const ciphertext = await crypto.subtle.encrypt({name: "AES-GCM", iv: bytes(header.iv, 16), additionalData: aad(header), tagLength: 128}, key, plain);
    return {...header, ciphertext: base64(new Uint8Array(ciphertext))};
  } finally {plain.fill(0);}
}
async function open(envelope: VaultEnvelope, key: CryptoKey): Promise<PersonProfile[]> {
  let plain: ArrayBuffer;
  try {
    plain = await crypto.subtle.decrypt({name: "AES-GCM", iv: bytes(envelope.iv, 16), additionalData: aad(envelope), tagLength: 128}, key, bytes(envelope.ciphertext, MAX_BACKUP_BYTES));
  } catch {throw new VaultError("Неверный пароль или повреждённое хранилище.");}
  const data = new Uint8Array(plain);
  try {
    const payload: unknown = JSON.parse(new TextDecoder().decode(data));
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error();
    const value = payload as Record<string, unknown>;
    if (value.version !== 1 || Object.keys(value).some(k => k !== "version" && k !== "people")) throw new Error();
    return validateProfiles(value.people);
  } catch {throw new VaultError("Некорректные данные внутри хранилища.");}
  finally {data.fill(0);}
}
interface Session {key: CryptoKey; envelope: VaultEnvelope; people: PersonProfile[]}
export class Vault {
  private session: Session | null = null;
  private epoch = 0;
  constructor(private readonly store: VaultStore) {}
  get unlocked(): boolean {return this.session !== null;}
  async exists(): Promise<boolean> {return (await this.store.read()) !== undefined;}
  lock(): void {this.epoch++; this.session = null;}
  private alive(epoch: number) {
    if (epoch !== this.epoch) throw new VaultError("Хранилище заблокировано. Разблокируйте его заново.");
  }
  private require(): Session {
    if (!this.session) throw new VaultError("Сначала разблокируйте хранилище.");
    return this.session;
  }
  people(): PersonProfile[] {return structuredClone(this.require().people);}
  async create(password: string): Promise<void> {
    checkPassword(password);
    const epoch = this.epoch;
    const salt = base64(crypto.getRandomValues(new Uint8Array(16)));
    const key = await derive(password, salt, KDF_ITERATIONS);
    const envelope = await seal([], key, {salt, iterations: KDF_ITERATIONS});
    await this.store.exclusive(async () => {
      this.alive(epoch);
      if (await this.exists()) throw new VaultConflictError();
      this.alive(epoch);
      await this.store.write(envelope);
    });
    this.alive(epoch);
    this.session = {key, envelope, people: []};
  }
  async unlock(password: string): Promise<void> {
    this.lock();
    const epoch = this.epoch;
    const envelope = parseEnvelope(await this.store.read());
    if (password.length > 256) throw new VaultError("Пароль слишком длинный.");
    const key = await derive(password, envelope.salt, envelope.iterations);
    const people = await open(envelope, key);
    this.alive(epoch);
    // Refuse stale sessions if a password or data changed during derivation.
    const current = parseEnvelope(await this.store.read());
    if (current.revision !== envelope.revision) throw new VaultConflictError();
    this.alive(epoch);
    this.session = {key, envelope, people};
  }
  async assertFresh(): Promise<void> {
    const session = this.require();
    const current = parseEnvelope(await this.store.read());
    if (current.revision !== session.envelope.revision) {this.lock(); throw new VaultConflictError();}
    if (this.session !== session) throw new VaultError("Хранилище заблокировано.");
  }
  private async commit(people: PersonProfile[], key?: CryptoKey, settings?: Pick<VaultEnvelope, "salt" | "iterations">): Promise<void> {
    const session = this.require();
    const epoch = this.epoch;
    const envelope = await seal(people, key ?? session.key, settings ?? session.envelope);
    await this.store.exclusive(async () => {
      this.alive(epoch);
      const current = parseEnvelope(await this.store.read());
      if (current.revision !== session.envelope.revision) {this.lock(); throw new VaultConflictError();}
      this.alive(epoch);
      await this.store.write(envelope);
    });
    this.alive(epoch);
    this.session = {key: key ?? session.key, envelope, people: structuredClone(people)};
  }
  async save(value: unknown): Promise<void> {
    const person = validateProfile(value);
    const people = this.people();
    const index = people.findIndex(p => p.id === person.id);
    if (index === -1) people.push(person); else people[index] = person;
    await this.commit(validateProfiles(people));
  }
  async remove(id: string): Promise<void> {
    const people = this.people();
    if (!people.some(p => p.id === id)) throw new VaultError("Профиль не найден.");
    await this.commit(people.filter(p => p.id !== id));
  }
  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    checkPassword(newPassword);
    if (currentPassword.length > 256) throw new VaultError("Пароль слишком длинный.");
    const session = this.require();
    const epoch = this.epoch;
    const oldKey = await derive(currentPassword, session.envelope.salt, session.envelope.iterations);
    await open(session.envelope, oldKey);
    const salt = base64(crypto.getRandomValues(new Uint8Array(16)));
    const key = await derive(newPassword, salt, KDF_ITERATIONS);
    this.alive(epoch);
    await this.commit(session.people, key, {salt, iterations: KDF_ITERATIONS});
  }
  async backup(): Promise<string> {
    await this.assertFresh();
    return JSON.stringify(this.require().envelope, null, 2);
  }
  async restore(text: string, password: string): Promise<void> {
    if (encoder.encode(text).length > MAX_BACKUP_BYTES || password.length > 256) throw new VaultError("Файл или пароль слишком большой.");
    const before = await this.store.read();
    const expected = JSON.stringify(before);
    let parsed: unknown;
    try {parsed = JSON.parse(text);} catch {throw new VaultError("Файл не является резервной копией.");}
    const imported = parseEnvelope(parsed);
    const epoch = this.epoch;
    const key = await derive(password, imported.salt, imported.iterations);
    const people = await open(imported, key);
    // Re-encrypt with fresh IV and revision to invalidate sessions from the previous vault.
    const envelope = await seal(people, key, imported);
    await this.store.exclusive(async () => {
      this.alive(epoch);
      const raw = await this.store.read();
      if (JSON.stringify(raw) !== expected) throw new VaultConflictError();
      this.alive(epoch);
      await this.store.write(envelope);
    });
    this.alive(epoch);
    this.session = {key, envelope, people};
  }
}
