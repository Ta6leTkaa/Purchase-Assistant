import {documentLabels, maskedDocument, type PersonProfile} from "./profile.js";
import {autofillPage} from "./autofill.js";
import {Vault, VAULT_STORAGE_KEY} from "./vault.js";
import {BrowserVaultStore} from "./browser-store.js";
import {idleLock} from "./idle-lock.js";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const vault = new Vault(new BrowserVaultStore());
const list = $("people"), status = $("status");
const preview = $<HTMLButtonElement>("preview"), fill = $<HTMLButtonElement>("fill");
const consent = $<HTMLInputElement>("consent"), password = $<HTMLInputElement>("password");
let reviewedTabId: number | undefined;
let busy = false;
const idle = idleLock(() => lock());
function resetReview() {reviewedTabId = undefined; fill.disabled = true; consent.checked = false;}
function lock() {
  vault.lock(); resetReview(); password.value = ""; list.replaceChildren();
  $("workspace").hidden = true; $("lock").hidden = true; $("gate").hidden = false;
  status.textContent = "Хранилище заблокировано.";
}
function renderPeople() {
  list.replaceChildren(); resetReview();
  const people = vault.people(); $("empty").hidden = people.length > 0;
  for (const [index, person] of people.entries()) {
    const row = document.createElement("div"); row.className = "person";
    const label = document.createElement("label"); label.className = "check";
    const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.value = person.id; checkbox.dataset.person = String(index);
    label.append(checkbox, document.createTextNode(person.displayName)); row.append(label);
    const docLabel = document.createElement("label"); docLabel.textContent = "Документ";
    const select = document.createElement("select"); select.dataset.person = String(index); select.setAttribute("aria-label", `Документ: ${person.displayName}`);
    const empty = document.createElement("option"); empty.value = "-1"; empty.textContent = person.documents.length ? "Выберите документ" : "Документов нет"; select.append(empty);
    for (const [i, doc] of person.documents.entries()) {
      const option = document.createElement("option"); option.value = String(i);
      option.textContent = `${documentLabels[doc.type]} · ${maskedDocument(doc.number)}`;
      if (doc.expiresAt && doc.expiresAt < new Date().toISOString().slice(0, 10)) {option.disabled = true; option.textContent += " · срок истёк";}
      select.append(option);
    }
    if (person.documents.length === 1 && !select.options[1]?.disabled) select.value = "0";
    docLabel.append(select); row.append(docLabel); list.append(row);
  }
  $("workspace").hidden = false; $("gate").hidden = true; $("lock").hidden = false;
}
function selectedPeople(): PersonProfile[] {
  return vault.people().flatMap((person, index) => {
    if (!list.querySelector<HTMLInputElement>(`input[data-person="${index}"]`)?.checked) return [];
    const choice = Number(list.querySelector<HTMLSelectElement>(`select[data-person="${index}"]`)?.value ?? -1);
    const doc = person.documents[choice];
    if (!doc) throw new Error(`Выберите документ для профиля «${person.displayName}».`);
    if (doc.expiresAt && doc.expiresAt < new Date().toISOString().slice(0, 10)) throw new Error("Срок действия документа истёк.");
    return [{...person, documents: [doc]}];
  });
}
async function run(apply: boolean) {
  if (busy) return;
  busy = true; preview.disabled = true; fill.disabled = true;
  list.inert = true; consent.disabled = true;
  try {
    if (apply && (!consent.checked || reviewedTabId === undefined)) throw new Error("Сначала проверьте форму и разрешите заполнение.");
    await vault.assertFresh();
    const people = selectedPeople();
    if (!people.length) throw new Error("Выберите хотя бы одного человека.");
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (tab?.id === undefined) throw new Error("Откройте вкладку с демоформой.");
    if (apply && reviewedTabId !== tab.id) throw new Error("Вкладка изменилась. Проверьте форму заново.");
    if (!vault.unlocked) throw new Error("Хранилище заблокировано.");
    const [execution] = await chrome.scripting.executeScript({target: {tabId: tab.id}, func: autofillPage, args: [people, apply]});
    if (!vault.unlocked) return;
    const result = execution?.result;
    if (!result) throw new Error("Не удалось проверить форму. Откройте http://127.0.0.1:4173/family.html.");
    status.textContent = result.message;
    reviewedTabId = !apply && result.ok ? tab.id : undefined; consent.checked = false; idle.touch();
  } catch (error) {
    resetReview();
    if (!vault.unlocked) lock();
    status.textContent = error instanceof Error ? error.message : "Не удалось открыть страницу. Откройте демоформу и повторите проверку.";
  } finally {
    busy = false; list.inert = false; consent.disabled = false;
    preview.disabled = false; fill.disabled = !consent.checked || reviewedTabId === undefined;
  }
}
$("manage").addEventListener("click", () => {void chrome.runtime.openOptionsPage();});
$("lock").addEventListener("click", () => lock());
list.addEventListener("change", () => {resetReview(); status.textContent = "Участники изменены. Проверьте форму заново.";});
consent.addEventListener("change", () => {fill.disabled = !consent.checked || reviewedTabId === undefined;});
preview.addEventListener("click", () => {void run(false);});
fill.addEventListener("click", () => {void run(true);});
$<HTMLFormElement>("unlockForm").addEventListener("submit", event => {
  event.preventDefault(); if (busy) return;
  const secret = password.value; password.value = ""; busy = true; $<HTMLButtonElement>("unlock").disabled = true;
  status.textContent = "Разблокировка…";
  void vault.unlock(secret).then(() => {renderPeople(); status.textContent = "Выберите участников покупки."; idle.touch();})
    .catch(error => {lock(); status.textContent = error instanceof Error ? error.message : "Не удалось открыть хранилище.";})
    .finally(() => {busy = false; $<HTMLButtonElement>("unlock").disabled = false;});
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && VAULT_STORAGE_KEY in changes) {lock(); status.textContent = "Профили изменены. Разблокируйте хранилище заново.";}
});
void vault.exists().then(exists => {
  $("gate").hidden = false;
  $("gateText").textContent = exists ? "Разблокируйте профили для этой покупки." : "Создайте хранилище в разделе «Мои люди».";
  $("unlockForm").hidden = !exists;
}).catch(() => {status.textContent = "Не удалось прочитать хранилище. Перезагрузите расширение.";});
