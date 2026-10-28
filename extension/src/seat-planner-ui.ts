import {controlBolshoiHover, type HoverReport} from "./bolshoi-hover.js";
import {parseRubles, planSeats, type SeatConstraints, type SeatPlan} from "./seat-planner.js";

export function setupSeatPlanner(): void {
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const form = $<HTMLFormElement>("seatPlanForm");
  const area = $<HTMLSelectElement>("planArea");
  const status = $("planStatus");
  const output = $("seatOffers");
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let activeTab: number | undefined;
  let generation = 0;
  function clear(message = "Условия изменены. Нажмите «Найти билеты» заново.") {
    generation++; clearTimeout(expiryTimer); output.replaceChildren(); status.textContent = message;
  }
  async function getSource(epoch: number) {
    const [tab] = await chrome.tabs.query({active: true, currentWindow: true});
    if (tab?.id === undefined) throw new Error("Откройте схему нужного показа в активной вкладке.");
    activeTab = tab.id;
    async function command(action: "scan" | "read" | "stop") {
      const [execution] = await chrome.scripting.executeScript({target: {tabId: tab!.id!}, func: controlBolshoiHover, args: [action]});
      const result = execution?.result;
      if (!result) throw new Error("Не удалось прочитать схему из этой вкладки.");
      if (!result.ok) throw new Error(result.message);
      return result.report;
    }
    let report = await command("scan");
    while (report.status === "running") {
      if (epoch !== generation) {await command("stop"); throw new Error("Поиск остановлен.");}
      const scan = report.scan;
      status.textContent = scan ? `Проверяем схему: ${scan.visited} из ${scan.total}. Считано подсказок: ${report.samples.length}.` : "Начинаем автоматическое чтение схемы…";
      await new Promise(resolve => setTimeout(resolve, 150));
      report = await command("read");
    }
    if (epoch !== generation) throw new Error("Поиск остановлен.");
    if (report.version !== 3 || report.mode !== "automatic") throw new Error("Перезагрузите расширение и повторите поиск.");
    if (["context_changed", "page_changed"].includes(report.status)) throw new Error("Показ или условия страницы изменились. Повторите поиск.");
    if (report.status === "unsupported") {
      if (report.rejected.unrecognized > 0) throw new Error(`Подсказки открылись, но их формат не распознан. Проверено: ${report.scan?.visited ?? 0}. Поиск не завершён — это не означает, что билетов нет.`);
      throw new Error("Не удалось прочитать данные мест автоматически. Поиск не завершён; это не означает, что билетов нет.");
    }
    if (report.status === "interrupted" || report.status === "stopped") throw new Error("Поиск прерван действиями на странице. Повторите его, не трогая схему во время обхода.");
    if (report.status === "expired") throw new Error("Сайт не ответил за время обхода. Поиск не завершён — повторите попытку.");
    if (!report.scan?.complete) throw new Error("Не удалось завершить чтение схемы. Повторите поиск.");
    return {seats: report.samples, scan: report.scan};
  }
  function updateAreas(seats: {area: string}[]) {
    const previous = area.value;
    const values = [...new Set(seats.map(s => s.area))].sort();
    area.replaceChildren();
    const any = document.createElement("option"); any.value = ""; any.textContent = "Любой найденный сектор"; area.append(any);
    for (const value of values) {const option = document.createElement("option"); option.value = value; option.textContent = value; area.append(option);}
    if (previous && !values.includes(previous)) {
      const unavailable = document.createElement("option"); unavailable.value = previous; unavailable.textContent = `${previous} — нет в текущих наблюдениях`; unavailable.disabled = true; area.append(unavailable);
    }
    area.value = previous;
  }
  function readConstraints(): SeatConstraints {
    const quantity = Number($<HTMLInputElement>("planQuantity").value);
    const maxPerTicketKopecks = parseRubles($<HTMLInputElement>("planPerTicket").value);
    const total = $<HTMLInputElement>("planTotal").value.trim();
    return {quantity, maxPerTicketKopecks, maxTotalKopecks: total ? parseRubles(total) : maxPerTicketKopecks * quantity,
      adjacent: $<HTMLInputElement>("planAdjacent").checked, allowPassport: $<HTMLInputElement>("planPassport").checked, area: area.value || null};
  }
  const money = (kopecks: number) => new Intl.NumberFormat("ru-RU", {style: "currency", currency: "RUB"}).format(kopecks / 100);
  function render(plan: SeatPlan, scan: NonNullable<HoverReport["scan"]>) {
    output.replaceChildren();
    const messages: Record<NonNullable<SeatPlan["reason"]>, string> = {
      no_observations: "На текущей схеме не найдено мест для подбора. Повторите поиск, если наличие изменилось.",
      stale_observations: "Данные устарели. Повторите автоматический поиск.",
      no_eligible_seats: "Среди свежих наблюдений нет мест под эти условия. Проверьте цену, сектор и допуск мест по паспорту.",
      not_enough_seats: "Подходящих мест меньше, чем нужно билетов. Повторите поиск, если наличие изменилось.",
      no_adjacent_group: "Не найден набор с последовательными номерами в одном секторе и ряду без явного разрыва на схеме.",
      total_budget_exceeded: "Подходящие наборы превышают общий бюджет. Условия не изменены автоматически."
    };
    const omitted = plan.summary.invalid + plan.summary.stale + plan.summary.conflicting;
    const coverage = scan.failed || scan.truncated ? ` Не все подсказки прочитаны: ${scan.failed} не распознано${scan.truncated ? ", схема превышает лимит обхода" : ""}. Результат неполный.` : "";
    const suffix = omitted ? ` Пропущено недостоверных или устаревших записей: ${omitted}.` : "";
    status.textContent = (plan.reason ? messages[plan.reason] : `Найдено вариантов: ${plan.offers.length}. Подходящих считанных мест: ${plan.summary.eligible}.`) + suffix + coverage;
    for (const [index, offer] of plan.offers.entries()) {
      const card = document.createElement("article"); card.className = "seat-offer";
      const heading = document.createElement("h3"); heading.textContent = `Вариант ${index + 1} · ${money(offer.totalKopecks)}`;
      const list = document.createElement("ul");
      for (const seat of offer.seats) {
        const item = document.createElement("li");
        item.textContent = `${seat.area}, ряд ${seat.row}, место ${seat.seat} — ${money(seat.priceKopecks)}${seat.availability === "passport_required" ? " · по паспорту" : ""}`;
        list.append(item);
      }
      const note = document.createElement("p"); note.className = "note";
      note.textContent = offer.adjacency === "number_and_geometry_candidate" ? "Номера последовательные и элементы близки. Проверьте соседство и проходы на схеме." : offer.adjacency === "not_requested" ? "Соседство не требуется: места могут быть в разных рядах и секторах." : "Один билет.";
      card.append(heading, list, note); output.append(card);
    }
    if (plan.offers.length) {
      const expiresAt = Math.min(...plan.offers.map(o => o.expiresAt));
      expiryTimer = setTimeout(() => clear("Данные устарели. Повторите автоматический поиск."), Math.max(0, expiresAt - Date.now()));
    }
  }
  async function execute(refreshOnly: boolean) {
    if (busy) return;
    clear("Автоматически читаем схему текущего показа…");
    const epoch = generation;
    busy = true; $("cancelSeatSearch").hidden = false; form.inert = true; $<HTMLButtonElement>("refreshPlanAreas").disabled = true;
    try {
      const constraints = refreshOnly ? null : readConstraints();
      const {seats, scan} = await getSource(epoch);
      if (epoch !== generation) return;
      updateAreas(seats);
      if (refreshOnly) {status.textContent = `Считанных наблюдений: ${seats.length}. Укажите условия и нажмите «Найти билеты».`; return;}
      render(planSeats(seats, constraints!), scan);
    } catch (error) {if (epoch === generation) status.textContent = error instanceof Error ? error.message : "Не удалось выполнить подбор.";}
    finally {busy = false; $("cancelSeatSearch").hidden = true; form.inert = false; $<HTMLButtonElement>("refreshPlanAreas").disabled = false;}
  }
  $("cancelSeatSearch").addEventListener("click", () => clear("Поиск остановлен."));
  form.addEventListener("submit", event => {event.preventDefault(); void execute(false);});
  form.addEventListener("input", () => clear());
  form.addEventListener("change", () => clear());
  $("refreshPlanAreas").addEventListener("click", () => {void execute(true);});
  chrome.tabs.onUpdated.addListener((tabId, change) => {if (tabId === activeTab && (change.status === "loading" || change.url)) clear("Страница изменилась. Повторите автоматический поиск.");});
  for (const id of ["startHover", "readHover", "stopHover"]) $(id).addEventListener("click", () => clear("Наблюдения обновляются. Повторите подбор после чтения подсказок."));
  window.addEventListener("pagehide", () => {generation++; clearTimeout(expiryTimer); output.replaceChildren();});
}
