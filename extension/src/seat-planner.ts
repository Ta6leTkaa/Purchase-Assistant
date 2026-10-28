import type {HoverSeat} from "./bolshoi-hover.js";

export const OBSERVATION_MAX_AGE_MS = 120_000;
export interface SeatConstraints {
  quantity: number;
  maxPerTicketKopecks: number;
  maxTotalKopecks: number;
  adjacent: boolean;
  allowPassport: boolean;
  area: string | null;
}
export interface ObservedSeat extends HoverSeat {observedAt: number}
export interface SeatOffer {
  seats: ObservedSeat[];
  totalKopecks: number;
  expiresAt: number;
  adjacency: "single_seat" | "not_requested" | "number_and_geometry_candidate";
}
export interface SeatPlan {
  offers: SeatOffer[];
  reason: "no_observations" | "stale_observations" | "no_eligible_seats" | "not_enough_seats" | "no_adjacent_group" | "total_budget_exceeded" | null;
  summary: {received: number; invalid: number; stale: number; conflicting: number; eligible: number};
  requiresReview: true;
  adjacencyVerified: false;
}
export function parseRubles(value: string): number {
  const normalized = value.trim().replace(/[\u00a0\u202f]/g, " ");
  const match = /^(\d{1,7}|\d{1,3}(?: \d{3}){1,2})(?:[.,](\d{1,2}))?$/.exec(normalized);
  if (!match) throw new Error("Укажите сумму в рублях, например 7500 или 7500,50.");
  const kopecks = Number(match[1]!.replace(/ /g, "")) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  if (!Number.isSafeInteger(kopecks) || kopecks <= 0 || kopecks > 400_000_000) throw new Error("Сумма должна быть больше нуля и не больше 4 000 000 ₽.");
  return kopecks;
}
function areaKey(value: string): string {return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLocaleLowerCase("ru");}
function validArea(value: unknown): value is string {
  return typeof value === "string" && value.length <= 100 && /^(особая ложа|партер|амфитеатр|бельэтаж|бенуар|балкон|ложа|галерея|ярус)(?: \d{1,2})?(?:, (?:левая|правая|центральная) сторона)?$/i.test(value);
}
function positive(value: unknown, max: number): value is number {return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= max;}
function validateConstraints(value: SeatConstraints): void {
  if (!value || !positive(value.quantity, 4)) throw new Error("Подбор поддерживает от 1 до 4 билетов. Лимит тарифа проверяется на сайте.");
  if (!positive(value.maxPerTicketKopecks, 100_000_000) || !positive(value.maxTotalKopecks, 400_000_000)) throw new Error("Проверьте максимальную цену билета и всего заказа.");
  if (typeof value.adjacent !== "boolean" || typeof value.allowPassport !== "boolean" || (value.area !== null && !validArea(value.area))) throw new Error("Проверьте условия подбора.");
}
function decodeSeat(value: unknown): ObservedSeat | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!positive(v.svgIndex, 1000) || !positive(v.rectIndex, 100_000) || v.reference !== `svg_${v.svgIndex}:rect_${v.rectIndex}` ||
      !validArea(v.area) || !positive(v.row, 9999) || !positive(v.seat, 9999) || !positive(v.priceKopecks, 100_000_000) ||
      v.currency !== "RUB" || !["available", "passport_required", "occupied", "unavailable", "selected"].includes(String(v.availability)) ||
      !["observed_after_manual_hover", "observed_after_automatic_hover"].includes(String(v.association)) || v.associationVerified !== false || !positive(v.observedAt, Number.MAX_SAFE_INTEGER)) return null;
  const g = v.geometry as Record<string, unknown> | null;
  if (!g || typeof g !== "object" || ![g.x, g.y, g.width, g.height].every(n => typeof n === "number" && Number.isFinite(n)) ||
      (g.x as number) < -1 || (g.x as number) > 2 || (g.y as number) < -1 || (g.y as number) > 2 ||
      (g.width as number) <= 0 || (g.width as number) > 1 || (g.height as number) <= 0 || (g.height as number) > 1) return null;
  // Copy only the public fields this planner actually uses.
  return {reference: v.reference, svgIndex: v.svgIndex, rectIndex: v.rectIndex, area: v.area.trim(), row: v.row, seat: v.seat,
    priceKopecks: v.priceKopecks, currency: "RUB", availability: v.availability as ObservedSeat["availability"],
    geometry: {x: g.x as number, y: g.y as number, width: g.width as number, height: g.height as number},
    observedAt: v.observedAt, association: v.association as ObservedSeat["association"], associationVerified: false};
}
function identity(seat: ObservedSeat): string {return JSON.stringify([areaKey(seat.area), seat.row, seat.seat]);}
function compareSeat(a: ObservedSeat, b: ObservedSeat): number {
  const areaA = areaKey(a.area), areaB = areaKey(b.area);
  return (areaA < areaB ? -1 : areaA > areaB ? 1 : 0) || a.row - b.row || a.seat - b.seat || a.svgIndex - b.svgIndex || a.rectIndex - b.rectIndex;
}
function compareOffer(a: SeatOffer, b: SeatOffer): number {
  if (a.totalKopecks !== b.totalKopecks) return a.totalKopecks - b.totalKopecks;
  for (let i = 0; i < a.seats.length; i++) {const diff = compareSeat(a.seats[i]!, b.seats[i]!); if (diff) return diff;}
  return 0;
}
function makeOffer(seats: ObservedSeat[], adjacent: boolean): SeatOffer {
  return {seats: [...seats].sort(compareSeat), totalKopecks: seats.reduce((sum, s) => sum + s.priceKopecks, 0),
    expiresAt: Math.min(...seats.map(s => s.observedAt + OBSERVATION_MAX_AGE_MS)),
    adjacency: seats.length === 1 ? "single_seat" : adjacent ? "number_and_geometry_candidate" : "not_requested"};
}
function likelyNeighbors(a: ObservedSeat, b: ObservedSeat): boolean {
  if (a.svgIndex !== b.svgIndex || areaKey(a.area) !== areaKey(b.area) || a.row !== b.row || b.seat - a.seat !== 1) return false;
  const ga = a.geometry, gb = b.geometry;
  const dx = Math.abs((ga.x + ga.width / 2) - (gb.x + gb.width / 2)) / ((ga.width + gb.width) / 2);
  const dy = Math.abs((ga.y + ga.height / 2) - (gb.y + gb.height / 2)) / ((ga.height + gb.height) / 2);
  // A conservative geometry check rejects obvious gaps/overlap. It cannot certify an aisle-free pair.
  return dx <= 2.5 && dy <= 1.5 && (dx >= 0.8 || dy >= 0.8);
}
export function planSeats(values: unknown, constraints: SeatConstraints, now = Date.now()): SeatPlan {
  validateConstraints(constraints);
  if (!Number.isSafeInteger(now) || now <= 0) throw new Error("Не удалось проверить время наблюдений.");
  if (!Array.isArray(values) || values.length > 1500) throw new Error("Получен некорректный список мест.");
  const summary = {received: values.length, invalid: 0, stale: 0, conflicting: 0, eligible: 0};
  const result: SeatPlan = {offers: [], reason: null, summary, requiresReview: true, adjacencyVerified: false};
  if (!values.length) {result.reason = "no_observations"; return result;}
  const references = new Map<string, ObservedSeat>();
  const blocked = new Set<string>();
  for (const value of values) {
    const seat = decodeSeat(value);
    if (!seat || seat.observedAt > now + 1000) {summary.invalid++; continue;}
    if (now - seat.observedAt >= OBSERVATION_MAX_AGE_MS) {summary.stale++; continue;}
    const previous = references.get(seat.reference);
    if (previous) {
      const {observedAt: ignoredA, ...a} = previous;
      const {observedAt: ignoredB, ...b} = seat;
      if (JSON.stringify(a) !== JSON.stringify(b)) blocked.add(seat.reference);
      else if (seat.observedAt > previous.observedAt) references.set(seat.reference, seat);
    } else references.set(seat.reference, seat);
  }
  const identities = new Map<string, string>();
  for (const seat of references.values()) {
    const other = identities.get(identity(seat));
    if (other && other !== seat.reference) {blocked.add(other); blocked.add(seat.reference);}
    else identities.set(identity(seat), seat.reference);
  }
  summary.conflicting = blocked.size;
  const fresh = [...references.values()].filter(s => !blocked.has(s.reference));
  const eligible = fresh.filter(s => (s.availability === "available" || (s.availability === "passport_required" && constraints.allowPassport)) &&
    s.priceKopecks <= constraints.maxPerTicketKopecks && (constraints.area === null || areaKey(s.area) === areaKey(constraints.area)));
  summary.eligible = eligible.length;
  if (!eligible.length) {result.reason = summary.stale > 0 && !fresh.length ? "stale_observations" : "no_eligible_seats"; return result;}
  if (eligible.length < constraints.quantity) {result.reason = "not_enough_seats"; return result;}
  const candidates: SeatOffer[] = [];
  if (constraints.adjacent && constraints.quantity > 1) {
    const groups = new Map<string, ObservedSeat[]>();
    for (const seat of eligible) {
      const key = JSON.stringify([seat.svgIndex, areaKey(seat.area), seat.row]);
      const group = groups.get(key) ?? []; group.push(seat); groups.set(key, group);
    }
    for (const group of groups.values()) {
      group.sort((a, b) => a.seat - b.seat);
      for (let start = 0; start <= group.length - constraints.quantity; start++) {
        const seats = group.slice(start, start + constraints.quantity);
        if (seats.slice(1).every((s, i) => likelyNeighbors(seats[i]!, s))) candidates.push(makeOffer(seats, true));
      }
    }
    if (!candidates.length) {result.reason = "no_adjacent_group"; return result;}
    result.offers = candidates.filter(o => o.totalKopecks <= constraints.maxTotalKopecks).sort(compareOffer).slice(0, 3);
  } else {
    // Enumerate the three cheapest k-combinations with a small monotone frontier, not all n-choose-k sets.
    const sorted = [...eligible].sort((a, b) => a.priceKopecks - b.priceKopecks || compareSeat(a, b));
    type Node = {indexes: number[]; offer: SeatOffer};
    const initial = Array.from({length: constraints.quantity}, (_, i) => i);
    const frontier: Node[] = [{indexes: initial, offer: makeOffer(initial.map(i => sorted[i]!), false)}];
    const seen = new Set([initial.join(",")]);
    while (frontier.length && result.offers.length < 3) {
      frontier.sort((a, b) => compareOffer(a.offer, b.offer));
      const node = frontier.shift()!;
      if (node.offer.totalKopecks > constraints.maxTotalKopecks) break;
      result.offers.push(node.offer);
      for (let pos = 0; pos < node.indexes.length; pos++) {
        const indexes = [...node.indexes]; indexes[pos] = indexes[pos]! + 1;
        if (indexes[pos]! >= (indexes[pos + 1] ?? sorted.length) || seen.has(indexes.join(","))) continue;
        seen.add(indexes.join(",")); frontier.push({indexes, offer: makeOffer(indexes.map(i => sorted[i]!), false)});
      }
    }
  }
  if (!result.offers.length) result.reason = "total_budget_exceeded";
  return result;
}
