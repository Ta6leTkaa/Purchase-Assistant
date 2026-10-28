export interface HoverSeat {
  observedAt: number;
  reference: string;
  svgIndex: number;
  rectIndex: number;
  geometry: {x: number; y: number; width: number; height: number};
  area: string;
  row: number;
  seat: number;
  priceKopecks: number;
  currency: "RUB";
  availability: "available" | "passport_required" | "occupied" | "unavailable" | "selected";
  association: "observed_after_manual_hover" | "observed_after_automatic_hover";
  associationVerified: false;
}
export interface HoverReport {
  format: "purchase-assistant-bolshoi-hover";
  version: 3;
  mode: "manual" | "automatic";
  scan: {total: number; visited: number; read: number; failed: number; skipped: number; complete: boolean; truncated: boolean} | null;
  status: "running" | "stopped" | "expired" | "page_changed" | "limit_reached" | "idle" | "context_changed" | "completed" | "unsupported" | "interrupted";
  samples: HoverSeat[];
  rejected: {stale: number; ambiguous: number; unrecognized: number};
  maxSamples: number;
  reservationVerified: false;
}
export type HoverResult = {ok: true; report: HoverReport} | {ok: false; message: string};

/** Isolated-world reader: manual diagnostics or sequential, click-free synthetic hover scan. */
export function controlBolshoiHover(action: "start" | "read" | "stop" | "scan"): HoverResult {
  if (location.protocol !== "https:" || location.hostname !== "ticket.bolshoi.ru" ||
      (location.port && location.port !== "443") || !/^\/show\/[^/]+\/?$/.test(location.pathname)) {
    return {ok: false, message: "Откройте схему мест конкретного показа на ticket.bolshoi.ru."};
  }
  interface Session {readerRevision?: number; read: () => HoverReport; stop: (reason?: HoverReport["status"]) => void; dispose?: () => void; url: string}
  const scope = globalThis as typeof globalThis & {__purchaseAssistantHoverV3?: Session; __purchaseAssistantHoverV2?: Session; __purchaseAssistantHoverV1?: {stop: () => void}};
  scope.__purchaseAssistantHoverV1?.stop(); delete scope.__purchaseAssistantHoverV1;
  scope.__purchaseAssistantHoverV2?.dispose?.(); scope.__purchaseAssistantHoverV2?.stop(); delete scope.__purchaseAssistantHoverV2;
  if (scope.__purchaseAssistantHoverV3 && scope.__purchaseAssistantHoverV3.readerRevision !== 2) {
    scope.__purchaseAssistantHoverV3.dispose?.(); scope.__purchaseAssistantHoverV3.stop(); delete scope.__purchaseAssistantHoverV3;
  }
  const empty = (): HoverReport => ({format: "purchase-assistant-bolshoi-hover", version: 3, mode: "manual", scan: null,
    status: "idle", samples: [], rejected: {stale: 0, ambiguous: 0, unrecognized: 0}, maxSamples: 100, reservationVerified: false});
  const existing = scope.__purchaseAssistantHoverV3;
  if (existing && existing.url !== location.href) {
    existing.stop("page_changed"); delete scope.__purchaseAssistantHoverV3;
    if (action === "read" || action === "stop") return {ok: true, report: existing.read()};
  }
  const current = scope.__purchaseAssistantHoverV3;
  if (action === "read") return {ok: true, report: current?.read() ?? empty()};
  if (action === "stop") {current?.stop(); return {ok: true, report: current?.read() ?? empty()};}
  if (current?.read().status === "running" && current.read().mode === (action === "scan" ? "automatic" : "manual")) return {ok: true, report: current.read()};

  current?.dispose?.();
  const url = location.href; // Kept only in this isolated world; never exported.
  const report = empty(); report.status = "running";
  report.mode = action === "scan" ? "automatic" : "manual"; report.maxSamples = action === "scan" ? 1500 : 100;
  const samples = new Map<Element, HoverSeat>();
  const rejected = report.rejected;
  let active: {node: SVGRectElement; baseline: Map<Element, string>; started: number; done: boolean} | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let expiry: ReturnType<typeof setTimeout>;
  let watcher: ReturnType<typeof setInterval>;
  let scanningNode: SVGRectElement | null = null;
  const visible = (node: Element) => {
    if (!node.isConnected || !node.getClientRects().length) return false;
    const style = getComputedStyle(node);
    return style.display !== "none" && style.visibility !== "hidden" && style.visibility !== "collapse" && Number(style.opacity || "1") > 0;
  };
  type Details = Pick<HoverSeat, "area" | "row" | "seat" | "priceKopecks" | "currency" | "availability">;
  const parse = (text: string): Details | null => {
    if (text.length > 800) return null;
    // Labels can be inline, wrapped, or split across nested spans. Keep only a bounded,
    // strictly validated grammar, not assumptions about line breaks between blocks.
    const normalized = text.split(/[\r\n]+/).map(line => line.trim()).filter(line => line && !["i", "ⓘ"].includes(line))
      .join(" ").replace(/[\u00a0\u202f]/g, " ").replace(/\s+/g, " ").trim();
    const pattern = /^(.{1,120}?)\s+Ряд\s*(?:№\s*)?(\d{1,4})\s*[,;]?\s*Место\s*(?:№\s*)?(\d{1,4})\s+(\d{1,7}|\d{1,3}(?: \d{3}){1,2})(?:[.,](\d{2}))?\s*(?:₽|руб\.?|RUB)\s+(?:[iⓘ]\s*)?(Доступно по паспорту|Доступно|Занято|Недоступно|Выбрано)$/i;
    const match = pattern.exec(normalized);
    if (!match) return null;
    // A side can be in the heading or on the next line before "Ряд". It remains
    // part of area identity, so left and right rows with equal numbers never merge.
    const heading = match[1]!.replace(/[,;]\s*$/, "").trim();
    const areaPattern = /^(особая ложа|партер|амфитеатр|бельэтаж|бенуар|балкон|ложа|галерея|ярус)(?:\s+(?:№\s*)?(\d{1,2}))?(?:[ ,–-]+(левая|правая|центральная)(?:\s+(?:сторона|часть))?)?$/i;
    const areaMatch = areaPattern.exec(heading);
    if (!areaMatch) return null;
    const titles: Record<string, string> = {"особая ложа": "Особая ложа", "партер": "Партер", "амфитеатр": "Амфитеатр", "бельэтаж": "Бельэтаж", "бенуар": "Бенуар", "балкон": "Балкон", "ложа": "Ложа", "галерея": "Галерея", "ярус": "Ярус"};
    const area = titles[areaMatch[1]!.toLowerCase()]! + (areaMatch[2] ? ` ${Number(areaMatch[2])}` : "") + (areaMatch[3] ? `, ${areaMatch[3].toLowerCase()} сторона` : "");
    const statuses: Record<string, HoverSeat["availability"]> = {"доступно по паспорту": "passport_required", "доступно": "available", "занято": "occupied", "недоступно": "unavailable", "выбрано": "selected"};
    const row = Number(match[2]), seat = Number(match[3]);
    const priceKopecks = Number(match[4]!.replace(/ /g, "")) * 100 + Number(match[5] ?? "0");
    if (row < 1 || seat < 1 || !Number.isSafeInteger(priceKopecks) || priceKopecks <= 0 || priceKopecks > 100_000_000) return null;
    return {area, row, seat, priceKopecks, currency: "RUB", availability: statuses[match[6]!.toLowerCase()]!};
  };
  let unreadableVisible = false;
  const unreadableNodes = new WeakSet<Element>();
  const tooltips = (): {node: HTMLElement; details: Details; signature: string}[] => {
    const result: {node: HTMLElement; details: Details; signature: string}[] = [];
    unreadableVisible = false;
    const unreadable: HTMLElement[] = [];
    for (const node of [...document.querySelectorAll<HTMLElement>("div,aside,section,[role=tooltip],[data-popper-placement],[data-tippy-root]")].slice(0, 3000)) {
      if (!(node instanceof HTMLElement) || !visible(node) || node.querySelector("input,textarea,select,form")) continue;
      const rect = node.getBoundingClientRect();
      if (rect.width < 90 || rect.width > 500 || rect.height < 40 || rect.height > 320) continue;
      const text = node.innerText;
      const details = parse(text);
      if (details) result.push({node, details, signature: JSON.stringify(details)});
      else if (/Ряд\s*(?:№\s*)?\d/i.test(text) && /Место\s*(?:№\s*)?\d/i.test(text) && /₽|руб|RUB/i.test(text)) unreadable.push(node);
    }
    for (const node of unreadable) {
      if (result.some(item => node.contains(item.node) || item.node.contains(node))) continue;
      unreadableVisible = true;
      if (!unreadableNodes.has(node)) {unreadableNodes.add(node); rejected.unrecognized++;}
    }
    // Wrappers around the same tooltip are one candidate; keep the innermost one.
    return result.filter(item => !result.some(other => other !== item && item.node.contains(other.node)));
  };
  const checkPage = () => {
    if (location.href !== url) {stop("page_changed"); return false;}
    return report.status === "running";
  };
  const sample = () => {
    timer = undefined;
    if (!checkPage() || !active || active.done || !active.node.isConnected || !visible(active.node)) return;
    if (!active.node.matches(":hover") || Date.now() - active.started < 180) return;
    const seatBounds = active.node.getBoundingClientRect();
    const candidates = tooltips().filter(item => {
      const rect = item.node.getBoundingClientRect();
      const gapX = Math.max(rect.left - seatBounds.right, seatBounds.left - rect.right, 0);
      const gapY = Math.max(rect.top - seatBounds.bottom, seatBounds.top - rect.bottom, 0);
      return gapX <= 100 && gapY <= 100;
    });
    if (candidates.length !== 1) {if (candidates.length > 1) rejected.ambiguous++; else rejected.unrecognized++; return;}
    const candidate = candidates[0]!;
    if ([...active.baseline.values()].includes(candidate.signature)) {rejected.stale++; return;}
    active.done = true; addSample(active.node, candidate.details, "observed_after_manual_hover");
  };
  const addSample = (node: SVGRectElement, details: Details, association: HoverSeat["association"]): boolean => {
    const seatBounds = node.getBoundingClientRect();
    const svg = node.closest("svg");
    if (!svg || !visible(svg)) return false;
    const bounds = svg.getBoundingClientRect();
    if (bounds.width <= 0 || bounds.height <= 0) return false;
    const rects = [...svg.querySelectorAll("rect.seat")];
    const rectIndex = rects.indexOf(node) + 1;
    const svgIndex = [...document.querySelectorAll("svg")].filter(visible).indexOf(svg) + 1;
    if (rectIndex <= 0 || svgIndex <= 0) return false;
    const round = (n: number) => Math.round(n * 1_000_000) / 1_000_000;
    const value: HoverSeat = {...details, observedAt: Date.now(), reference: `svg_${svgIndex}:rect_${rectIndex}`, svgIndex, rectIndex,
      geometry: {x: round((seatBounds.x - bounds.x) / bounds.width), y: round((seatBounds.y - bounds.y) / bounds.height), width: round(seatBounds.width / bounds.width), height: round(seatBounds.height / bounds.height)},
      association, associationVerified: false};
    // Identical venue coordinates reported for two different DOM seats are ambiguous.
    const duplicate = [...samples.entries()].find(([element, seat]) => element !== node && seat.area === value.area && seat.row === value.row && seat.seat === value.seat);
    if (duplicate) {samples.delete(duplicate[0]); rejected.ambiguous++; return false;}
    samples.set(node, value);
    if (report.mode === "manual" && samples.size >= report.maxSamples) stop("limit_reached");
    return true;
  };
  const schedule = () => {
    if (!timer && active && !active.done && checkPage()) timer = setTimeout(sample, Math.max(80, 200 - (Date.now() - active.started)));
  };
  const over = (event: Event) => {
    if (!event.isTrusted || !checkPage() || !(event.target instanceof Element)) return;
    if (report.mode === "automatic") {stop("interrupted"); return;}
    const node = event.target.closest("svg rect.seat");
    if (!(node instanceof SVGRectElement) || active?.node === node || !visible(node)) return;
    const svg = node.closest("svg")!;
    const bounds = svg.getBoundingClientRect();
    if (bounds.width < 150 || bounds.height < 100 || svg.querySelectorAll("rect.seat").length < 20) return;
    clearTimeout(timer); timer = undefined;
    active = {node, baseline: new Map(tooltips().map(item => [item.node, item.signature])), started: Date.now(), done: false};
    schedule();
  };
  const out = (event: Event) => {
    if (!event.isTrusted || report.mode === "automatic" || !(event.target instanceof Element) || !active) return;
    if (event.target === active.node || active.node.contains(event.target)) {active = null; clearTimeout(timer); timer = undefined;}
  };
  const observer = new MutationObserver(schedule);
  function stop(reason: HoverReport["status"] = "stopped") {
    const invalidating = reason === "page_changed" || reason === "context_changed";
    if (report.status !== "running" && !invalidating) return;
    report.status = reason;
    active = null; clearTimeout(timer); clearTimeout(expiry); clearInterval(watcher); observer.disconnect();
    if (scanningNode) {leave(scanningNode); scanningNode = null;}
    document.removeEventListener("pointerdown", interrupt, true); document.removeEventListener("keydown", interrupt, true);
    document.removeEventListener("pointerover", over, true); document.removeEventListener("pointerout", out, true);
    document.removeEventListener("visibilitychange", visibility);
    if (invalidating) {
      window.removeEventListener("pagehide", pagehide); document.removeEventListener("change", contextChange, true);
      samples.clear();
    }
  }
  const interrupt = (event: Event) => {if (report.mode === "automatic" && event.isTrusted) stop("interrupted");};
  const contextChange = (event: Event) => {if (event.isTrusted) stop("context_changed");};
  const pagehide = () => stop("page_changed");
  const visibility = () => {if (document.hidden) stop();};
  const mouse = (node: SVGRectElement, type: string) => {
    const rect = node.getBoundingClientRect();
    const options = {bubbles: !["mouseenter", "mouseleave", "pointerenter", "pointerleave"].includes(type), cancelable: true, view: window,
      clientX: rect.left + rect.width / 2, clientY: rect.top + rect.height / 2, relatedTarget: null};
    node.dispatchEvent(type.startsWith("pointer") ? new PointerEvent(type, {...options, pointerType: "mouse", isPrimary: true}) : new MouseEvent(type, options));
  };
  function leave(node: SVGRectElement) {
    for (const type of ["mouseout", "mouseleave", "pointerout", "pointerleave"]) mouse(node, type);
  }
  const pause = () => new Promise<void>(resolve => setTimeout(resolve, 16));
  const waitForTooltip = async (baseline: Set<string>, milliseconds: number) => {
    const deadline = performance.now() + milliseconds;
    let previous: string | null = null;
    let unreadableSince: number | null = null;
    do {
      if (!checkPage() || !scanningNode?.isConnected) return null;
      const candidates = tooltips();
      if (candidates.length > 1) {rejected.ambiguous++; return null;}
      if (unreadableVisible) {
        if (candidates.length) {rejected.ambiguous++; return null;}
        unreadableSince ??= performance.now();
        if (performance.now() - unreadableSince >= 80) return null;
      } else unreadableSince = null;
      const candidate = candidates[0];
      if (candidate && !baseline.has(candidate.signature)) {
        if (previous === candidate.signature) return candidate.details;
        previous = candidate.signature;
      } else previous = null;
      await pause();
    } while (performance.now() < deadline);
    return null;
  };
  async function runScan() {
    if (!checkPage()) return;
    const maps = [...document.querySelectorAll("svg")].filter(svg => {
      const rect = svg.getBoundingClientRect();
      return visible(svg) && rect.width >= 150 && rect.height >= 100 && svg.querySelectorAll("rect.seat").length >= 20;
    });
    const all = maps.flatMap(svg => [...svg.querySelectorAll<SVGRectElement>("rect.seat")]);
    const eligible = all.filter(node => !node.classList.contains("unavailable") && visible(node));
    // Saturated outlines only prioritize attempts; tooltip text still decides availability.
    const priority = (node: Element) => {
      if (node.classList.contains("available") || node.classList.contains("free")) return 2;
      const parts = getComputedStyle(node).stroke.match(/^rgb\(\s*(\d+)[, ]+\s*(\d+)[, ]+\s*(\d+)\s*\)$/);
      const values = parts?.slice(1).map(Number);
      return values && Math.max(...values) - Math.min(...values) > 30 ? 1 : 0;
    };
    eligible.sort((a, b) => priority(b) - priority(a));
    const nodes = eligible.slice(0, 1500);
    report.scan = {total: nodes.length, visited: 0, read: 0, failed: 0, skipped: all.length - eligible.length, complete: false, truncated: eligible.length > 1500};
    if (!maps.length) {stop("unsupported"); return;}
    let consecutiveFailures = 0;
    for (const node of nodes) {
      if (!checkPage()) return;
      if (!node.isConnected || !visible(node)) {stop("context_changed"); return;}
      // Clear the prior tooltip via departure events, then require a fresh result.
      const baseline = new Set(tooltips().map(t => t.signature));
      scanningNode = node;
      for (const type of ["pointerover", "pointerenter", "mouseover", "mouseenter", "pointermove", "mousemove"]) mouse(node, type);
      const details = await waitForTooltip(baseline, 350);
      if (!checkPage()) return;
      report.scan.visited++;
      if (details && addSample(node, details, "observed_after_automatic_hover")) {report.scan.read++; consecutiveFailures = 0;}
      else {report.scan.failed++; consecutiveFailures++;}
      leave(node); scanningNode = null;
      // Do not keep probing an unsupported UI for the full timeout.
      if (consecutiveFailures >= 5 && report.scan.read === 0 && rejected.unrecognized === 0) {stop("unsupported"); return;}
    }
    report.scan.complete = true;
    stop(report.scan.read || !nodes.length ? "completed" : "unsupported");
  }

  document.addEventListener("pointerdown", interrupt, true); document.addEventListener("keydown", interrupt, true);
  document.addEventListener("change", contextChange, true);
  document.addEventListener("pointerover", over, true); document.addEventListener("pointerout", out, true);
  window.addEventListener("pagehide", pagehide); document.addEventListener("visibilitychange", visibility);
  observer.observe(document.documentElement, {subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ["class", "style", "hidden", "aria-hidden"]});
  expiry = setTimeout(() => stop("expired"), report.mode === "automatic" ? 30_000 : 120_000); watcher = setInterval(checkPage, 1000);
  scope.__purchaseAssistantHoverV3 = {url, readerRevision: 2, stop, dispose: () => stop("page_changed"), read: () => {
    checkPage();
    for (const node of samples.keys()) if (!node.isConnected) samples.delete(node);
    return structuredClone({...report, samples: [...samples.values()]});
  }};
  if (report.mode === "automatic") queueMicrotask(() => {void runScan().catch(() => stop("unsupported"));});
  return {ok: true, report: scope.__purchaseAssistantHoverV3.read()};
}
