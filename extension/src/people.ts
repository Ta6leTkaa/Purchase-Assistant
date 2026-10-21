import {documentLabels, maskedDocument, validateProfile, type PersonDocument, type PersonProfile} from "./profile.js";
import {Vault, VAULT_STORAGE_KEY, MAX_BACKUP_BYTES} from "./vault.js";
import {BrowserVaultStore} from "./browser-store.js";
import {idleLock} from "./idle-lock.js";
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const vault = new Vault(new BrowserVaultStore());
let exists = false, busy = false, editId: string | null = null, deleteId: string | null = null;
const status = $("status");
const editor = $<HTMLDialogElement>("editor");
const deleteDialog = $<HTMLDialogElement>("deleteDialog");
const personForm = $<HTMLFormElement>("personForm");
const gateForm = $<HTMLFormElement>("gateForm");
const password = $<HTMLInputElement>("password");
const repeatPassword = $<HTMLInputElement>("repeatPassword");
function input(name: string) {return personForm.elements.namedItem(name) as HTMLInputElement;}
function clearSecrets() {
  for (const field of document.querySelectorAll<HTMLInputElement>('input[type="password"]:not([data-document])')) field.value = "";
}
function lock(message = "Хранилище заблокировано.") {
  vault.lock(); editId = null; deleteId = null;
  editor.close(); deleteDialog.close(); personForm.reset(); $("documents").replaceChildren();
  $("people").replaceChildren(); $("deleteText").textContent = "";
  $<HTMLFormElement>("restoreForm").reset(); clearSecrets();
  render(); status.textContent = message;
}
const idle = idleLock(() => lock("Хранилище заблокировано после бездействия или закрытия страницы."));
function render() {
  $("gate").hidden = vault.unlocked; $("workspace").hidden = !vault.unlocked; $("lock").hidden = !vault.unlocked;
  $("gateTitle").textContent = exists ? "Разблокируйте хранилище" : "Создайте защищённое хранилище";
  $("gateText").textContent = exists ? "Введите пароль, который вы задали на этом устройстве." : "Придумайте длинный уникальный пароль, минимум 12 символов. Он защищает данные всей семьи.";
  $("gateSubmit").textContent = exists ? "Разблокировать" : "Создать хранилище";
  $("repeatLabel").hidden = exists; repeatPassword.required = !exists; password.minLength = exists ? 0 : 12;
  $("recoveryNotice").hidden = exists;
  $("people").replaceChildren();
  if (!vault.unlocked) return;
  const people = vault.people();
  $("count").textContent = `Профилей: ${people.length} из 100`;
  $("empty").hidden = people.length !== 0;
  for (const person of people) {
    const card = document.createElement("article"); card.className = "card";
    const title = document.createElement("h3"); title.textContent = person.displayName;
    const name = document.createElement("p"); name.textContent = [person.lastName, person.firstName, person.middleName].filter(Boolean).join(" ");
    card.append(title, name);
    for (const value of [person.birthDate ? `Дата рождения: ${person.birthDate.split("-").reverse().join(".")}` : "", person.email, person.phone]) {
      if (value) {const p = document.createElement("p"); p.className = "meta"; p.textContent = value; card.append(p);}
    }
    for (const doc of person.documents) {
      const p = document.createElement("p"); p.className = "meta";
      p.textContent = `${documentLabels[doc.type]} · ${maskedDocument(doc.number)}`;
      if (doc.expiresAt && doc.expiresAt < new Date().toISOString().slice(0, 10)) {p.textContent += " · срок истёк"; p.classList.add("warning");}
      card.append(p);
    }
    if (!person.documents.length) {const p = document.createElement("p"); p.className = "meta"; p.textContent = "Документы пока не добавлены"; card.append(p);}
    const actions = document.createElement("div"); actions.className = "actions";
    const edit = document.createElement("button"); edit.className = "secondary"; edit.textContent = "Изменить";
    edit.addEventListener("click", () => openEditor(person));
    const remove = document.createElement("button"); remove.className = "secondary"; remove.textContent = "Удалить";
    remove.addEventListener("click", () => {deleteId = person.id; $("deleteText").textContent = person.displayName; deleteDialog.showModal();});
    actions.append(edit, remove); card.append(actions); $("people").append(card);
  }
}
async function run(operation: () => Promise<void>) {
  if (busy) return;
  busy = true; status.textContent = "Подождите…";
  // Inert protects all controls, including newly-rendered ones, without altering form state.
  document.querySelector("main")!.inert = true;
  for (const dialog of document.querySelectorAll("dialog")) dialog.inert = true;
  try {await operation(); idle.touch();}
  catch (error) {
    const message = error instanceof Error ? error.message : "Не удалось выполнить действие. Повторите попытку.";
    if (!vault.unlocked) render();
    status.textContent = message;
    if (editor.open) $("editorStatus").textContent = message;
  } finally {
    busy = false; document.querySelector("main")!.inert = false;
    for (const dialog of document.querySelectorAll("dialog")) dialog.inert = false;
    clearSecrets();
  }
}
function addDocument(value?: PersonDocument) {
  if ($("documents").children.length >= 10) {$("editorStatus").textContent = "Можно добавить до 10 документов."; return;}
  const row = document.createElement("fieldset"); row.className = "document";
  const legend = document.createElement("legend"); legend.textContent = "Документ"; row.append(legend);
  const typeLabel = document.createElement("label"); typeLabel.textContent = "Тип документа";
  const select = document.createElement("select"); select.name = "documentType";
  for (const [key, label] of Object.entries(documentLabels)) {const option = document.createElement("option"); option.value = key; option.textContent = label; select.append(option);}
  select.value = value?.type ?? "internal_passport"; typeLabel.append(select);
  const numberLabel = document.createElement("label"); numberLabel.textContent = "Номер (с серией, если есть)";
  const number = document.createElement("input"); number.name = "documentNumber"; number.type = "password"; number.required = true; number.maxLength = 64; number.autocomplete = "off"; number.value = value?.number ?? ""; numberLabel.append(number);
  // Document inputs are distinct from vault passwords; only wiped on close/lock.
  number.dataset.document = "true";
  const show = document.createElement("button"); show.type = "button"; show.className = "secondary"; show.textContent = "Показать номер";
  show.addEventListener("click", () => {number.type = number.type === "password" ? "text" : "password"; show.textContent = number.type === "password" ? "Показать номер" : "Скрыть номер";});
  const expiryLabel = document.createElement("label"); expiryLabel.textContent = "Действует до, если указан срок";
  const expiry = document.createElement("input"); expiry.name = "documentExpiry"; expiry.type = "date"; expiry.min = "1900-01-01"; expiry.value = value?.expiresAt ?? ""; expiryLabel.append(expiry);
  const remove = document.createElement("button"); remove.type = "button"; remove.className = "secondary"; remove.textContent = "Убрать документ"; remove.addEventListener("click", () => row.remove());
  row.append(typeLabel, numberLabel, show, expiryLabel, remove); $("documents").append(row);
}
function openEditor(person?: PersonProfile) {
  editId = person?.id ?? null; personForm.reset(); $("documents").replaceChildren(); $("editorStatus").textContent = "";
  $("editorTitle").textContent = person ? "Изменить человека" : "Новый человек";
  for (const name of ["firstName", "lastName", "middleName", "displayName", "birthDate", "email", "phone"] as const) input(name).value = person?.[name] ?? "";
  input("birthDate").max = new Date().toISOString().slice(0, 10);
  for (const doc of person?.documents ?? []) addDocument(doc);
  editor.showModal(); input("firstName").focus();
}
// Don't erase document fields when an unrelated save fails.
function clearVaultPasswords() {
  for (const field of document.querySelectorAll<HTMLInputElement>('input[type="password"]:not([data-document])')) field.value = "";
}
gateForm.addEventListener("submit", event => {
  event.preventDefault();
  const secret = password.value, repeated = repeatPassword.value; clearVaultPasswords();
  void run(async () => {
    if (!exists && secret !== repeated) throw new Error("Пароли не совпадают.");
    if (exists) await vault.unlock(secret); else await vault.create(secret);
    exists = true; render(); status.textContent = "Хранилище открыто. Можно добавлять и изменять людей.";
  });
});
$("lock").addEventListener("click", () => lock());
$("add").addEventListener("click", () => openEditor());
$("addDocument").addEventListener("click", () => addDocument());
$("cancelEdit").addEventListener("click", () => editor.close());
editor.addEventListener("close", () => {personForm.reset(); $("documents").replaceChildren(); editId = null;});
personForm.addEventListener("submit", event => {
  event.preventDefault();
  let person: PersonProfile;
  try {
    const firstName = input("firstName").value.trim(), lastName = input("lastName").value.trim();
    person = validateProfile({id: editId ?? crypto.randomUUID(), firstName, lastName,
      displayName: input("displayName").value.trim() || `${firstName} ${lastName}`,
      middleName: input("middleName").value, birthDate: input("birthDate").value,
      email: input("email").value, phone: input("phone").value,
      documents: [...$("documents").querySelectorAll("fieldset")].map(row => ({
        type: row.querySelector<HTMLSelectElement>("select")!.value,
        number: row.querySelector<HTMLInputElement>('[name="documentNumber"]')!.value,
        expiresAt: row.querySelector<HTMLInputElement>('[name="documentExpiry"]')!.value
      }))});
  } catch (error) {$("editorStatus").textContent = error instanceof Error ? error.message : "Проверьте профиль."; return;}
  void run(async () => {await vault.save(person); editor.close(); render(); status.textContent = "Профиль сохранён.";});
});
$("cancelDelete").addEventListener("click", () => deleteDialog.close());
$("confirmDelete").addEventListener("click", () => {
  const id = deleteId;
  if (id) void run(async () => {await vault.remove(id); deleteDialog.close(); deleteId = null; render(); status.textContent = "Профиль удалён.";});
});
$("export").addEventListener("click", () => {void run(async () => {
  const copy = await vault.backup();
  const url = URL.createObjectURL(new Blob([copy], {type: "application/json"}));
  const link = document.createElement("a"); link.href = url; link.download = `purchase-assistant-backup-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  status.textContent = "Зашифрованная копия скачана. Храните пароль отдельно.";
});});
$<HTMLFormElement>("changeForm").addEventListener("submit", event => {
  event.preventDefault();
  const old = $<HTMLInputElement>("oldPassword").value, secret = $<HTMLInputElement>("newPassword").value,
    repeated = $<HTMLInputElement>("newPasswordRepeat").value;
  clearVaultPasswords();
  void run(async () => {
    if (secret !== repeated) throw new Error("Новые пароли не совпадают.");
    await vault.changePassword(old, secret); render(); status.textContent = "Пароль изменён. Скачайте новую резервную копию.";
  });
});
$<HTMLFormElement>("restoreForm").addEventListener("submit", event => {
  event.preventDefault();
  const file = $<HTMLInputElement>("backupFile").files?.[0];
  const secret = $<HTMLInputElement>("backupPassword").value;
  if (!file || !$<HTMLInputElement>("replaceConsent").checked) return;
  clearVaultPasswords();
  void run(async () => {
    if (file.size > MAX_BACKUP_BYTES) throw new Error("Резервная копия слишком большая (максимум 2 МБ).");
    await vault.restore(await file.text(), secret); exists = true;
    $<HTMLFormElement>("restoreForm").reset(); $("restorePanel").removeAttribute("open");
    render(); status.textContent = "Профили восстановлены. Для разблокировки используйте пароль этой копии.";
  });
});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && VAULT_STORAGE_KEY in changes && !busy) {
    exists = changes[VAULT_STORAGE_KEY]?.newValue !== undefined;
    lock("Хранилище изменено в другом окне. Разблокируйте его заново.");
  }
});
void run(async () => {exists = await vault.exists(); render(); status.textContent = "";});
