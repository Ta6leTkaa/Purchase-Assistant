import {VAULT_STORAGE_KEY, type VaultEnvelope, type VaultStore} from "./vault.js";
export class BrowserVaultStore implements VaultStore {
  private readonly ready = chrome.storage.local.setAccessLevel({accessLevel: "TRUSTED_CONTEXTS"});
  async read(): Promise<unknown> {
    await this.ready;
    const result = await chrome.storage.local.get(VAULT_STORAGE_KEY);
    return result[VAULT_STORAGE_KEY] as unknown;
  }
  async write(value: VaultEnvelope): Promise<void> {
    await this.ready;
    await chrome.storage.local.set({[VAULT_STORAGE_KEY]: value});
  }
  async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    return navigator.locks.request("purchase-assistant-vault-write", operation);
  }
}
