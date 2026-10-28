import {setupSeatPlanner} from "./seat-planner-ui.js";
import {controlBolshoiHover, type HoverReport} from "./bolshoi-hover.js";
import {inspectBolshoiPage} from "./bolshoi-inspector.js";
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

// Discovery is independent of the vault and does not request profile data.
let discovery: string | null = null;
const inspectButton = $<HTMLButtonElement>("inspectBolshoi");
inspectButton.addEventListener("click", () => {
  if (inspectButton.disabled) return;
  inspectButton.disabled = true; discovery = null;
  $("downloadDiscovery").hidden = true; $("discoveryReport").hidden = true; $("discoveryReport").textContent = "";
  $("discoveryStatus").textContent = "Читаем структуру страницы…";
  void (async () => {
    try {
      const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
      if (tab?.id === undefined) throw new Error();
      const [execution] = await chrome.scripting.executeScript({target: {tabId: tab.id}, func: inspectBolshoiPage});
      const result = execution?.result;
      if (!result) throw new Error();
      if (!result.ok) {$("discoveryStatus").textContent = result.message; return;}
      discovery = JSON.stringify(result.report, null, 2);
      $("discoveryReport").textContent = discovery; $("discoveryReport").hidden = false; $("downloadDiscovery").hidden = false;
      $("discoveryStatus").textContent = `Полей: ${result.report.controls.length}. Встроенных окон: ${result.report.frameCount} (их содержимое не прочитано). Кандидатов на места: ${result.report.mapStructure.candidateCount}. Их доступность и бронь не подтверждены.`;
    } catch {$("discoveryStatus").textContent = "Не удалось прочитать страницу. Откройте официальный билетный сайт и нажмите значок расширения в этой вкладке.";}
    finally {inspectButton.disabled = false;}
  })();
});
$("downloadDiscovery").addEventListener("click", () => {
  if (!discovery) return;
  const url = URL.createObjectURL(new Blob([discovery], {type: "application/json"}));
  const link = document.createElement("a"); link.href = url; link.download = "bolshoi-page-structure.json";
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});

// Passive collection survives closing the popup, in the isolated world of this tab only.
let hoverReport: HoverReport | null = null;
const hoverButtons = ["startHover", "readHover", "stopHover"].map(id => $<HTMLButtonElement>(id));
async function hoverCommand(action: "start" | "read" | "stop") {
  for (const button of hoverButtons) button.disabled = true;
  hoverReport = null; $("downloadHover").hidden = true; $("hoverSamples").replaceChildren();
  try {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (tab?.id === undefined) throw new Error();
    const [execution] = await chrome.scripting.executeScript({target: {tabId: tab.id}, func: controlBolshoiHover, args: [action]});
    const result = execution?.result;
    if (!result) throw new Error();
    if (!result.ok) {$("hoverStatus").textContent = result.message; return;}
    hoverReport = result.report;
    const states: Record<HoverReport["status"], string> = {completed: "Автоматический обход завершён.", unsupported: "Не удалось автоматически прочитать подсказки сайта.", interrupted: "Обход остановлен из-за действий на странице.",running: "Чтение включено на 2 минуты. Закройте это окно и наведите курсор на места, не нажимая. Затем откройте расширение и нажмите «Показать собранные места».", stopped: "Чтение остановлено.", expired: "Две минуты истекли. Чтение остановлено.", page_changed: "Страница изменилась, старые наблюдения удалены.", limit_reached: "Собрано 100 мест. Чтение остановлено.", idle: "Сначала включите чтение подсказок.", context_changed: "Условия страницы изменились. Соберите подсказки заново."};
    $("hoverStatus").textContent = `${states[result.report.status]} Собрано: ${result.report.samples.length}. Привязку к местам ещё нужно проверить; бронь не создаётся.`;
    for (const seat of result.report.samples) {
      const line = document.createElement("p");
      const price = new Intl.NumberFormat("ru-RU", {style: "currency", currency: "RUB"}).format(seat.priceKopecks / 100);
      const statuses = {available: "Доступно", passport_required: "По паспорту", occupied: "Занято", unavailable: "Недоступно", selected: "Выбрано"};
      line.textContent = `${seat.area}, ряд ${seat.row}, место ${seat.seat} · ${price} · ${statuses[seat.availability]}`;
      $("hoverSamples").append(line);
    }
    $("downloadHover").hidden = result.report.samples.length === 0;
  } catch {$("hoverStatus").textContent = "Не удалось прочитать вкладку. Откройте схему мест Большого и повторите действие.";}
  finally {for (const button of hoverButtons) button.disabled = false;}
}
$("startHover").addEventListener("click", () => {void hoverCommand("start");});
$("readHover").addEventListener("click", () => {void hoverCommand("read");});
$("stopHover").addEventListener("click", () => {void hoverCommand("stop");});
$("downloadHover").addEventListener("click", () => {
  if (!hoverReport) return;
  const url = URL.createObjectURL(new Blob([JSON.stringify(hoverReport, null, 2)], {type: "application/json"}));
  const link = document.createElement("a"); link.href = url; link.download = "bolshoi-hover-seats.json";
  document.body.append(link); link.click(); link.remove(); setTimeout(() => URL.revokeObjectURL(url), 1000);
});

setupSeatPlanner();
