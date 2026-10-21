import {demoPeople} from "./profile.js";
import {autofillPage} from "./autofill.js";

const list = document.querySelector<HTMLDivElement>("#people")!;
const status = document.querySelector<HTMLOutputElement>("#status")!;
const preview = document.querySelector<HTMLButtonElement>("#preview")!;
const fill = document.querySelector<HTMLButtonElement>("#fill")!;
const consent = document.querySelector<HTMLInputElement>("#consent")!;
let reviewedTabId: number | undefined;
for (const person of demoPeople) {
  const label = document.createElement("label");
  const checkbox = document.createElement("input");
  checkbox.type = "checkbox"; checkbox.value = person.id; checkbox.checked = true;
  label.append(checkbox, document.createTextNode(person.displayName));
  list.append(label);
}
function resetReview() {
  reviewedTabId = undefined; fill.disabled = true; consent.checked = false;
  status.textContent = "Проверьте форму перед заполнением.";
}
list.addEventListener("change", resetReview);
consent.addEventListener("change", () => {fill.disabled = !consent.checked || reviewedTabId === undefined;});
async function run(apply: boolean) {
  preview.disabled = true; fill.disabled = true;
  try {
    const people = demoPeople.filter(p => list.querySelector<HTMLInputElement>(`input[value="${p.id}"]`)?.checked);
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (tab?.id === undefined) throw new Error("Откройте вкладку с демоформой.");
    if (apply && (!consent.checked || reviewedTabId !== tab.id)) throw new Error("Сначала проверьте эту вкладку и разрешите заполнение.");
    const [execution] = await chrome.scripting.executeScript({target: {tabId: tab.id}, func: autofillPage, args: [people, apply]});
    const result = execution?.result;
    if (!result) throw new Error("Не удалось проверить форму.");
    status.textContent = result.message;
    reviewedTabId = !apply && result.ok ? tab.id : undefined;
    consent.checked = false;
  } catch {
    reviewedTabId = undefined;
    status.textContent = "Откройте http://127.0.0.1:4173/family.html и повторите проверку.";
  } finally {
    preview.disabled = false;
    fill.disabled = !consent.checked || reviewedTabId === undefined;
  }
}
preview.addEventListener("click", () => {void run(false);});
fill.addEventListener("click", () => {void run(true);});
