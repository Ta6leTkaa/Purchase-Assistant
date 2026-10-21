import type {PersonProfile} from "./profile.js";

/** Self-contained function: Chrome serializes it into the selected tab. No imports at runtime. */
export function autofillPage(people: readonly PersonProfile[], apply: boolean) {
  type Field = "firstName" | "lastName" | "birthDate" | "documentNumber";
  type Binding = {input: HTMLInputElement; value: string};
  const url = new URL(location.href);
  // Explicit allowlist until a real site adapter has acceptance tests.
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1" ||
      url.port !== "4173" || url.pathname !== "/family.html") {
    return {ok: false, message: "Пока поддерживается только локальная демоформа на порту 4173.", count: 0};
  }
  if (!people.length || new Set(people.map(p => p.id)).size !== people.length) {
    return {ok: false, message: "Выберите разных людей.", count: 0};
  }
  const detect = (input: HTMLInputElement): Field | undefined => {
    // Exact identifiers avoid the legacy substring collision between name and surname.
    const key = input.name.trim().toLowerCase();
    const aliases: Record<string, Field> = {
      first_name: "firstName", last_name: "lastName",
      birth_date: "birthDate", passport_number: "documentNumber"
    };
    return aliases[key];
  };
  const groups = [...document.querySelectorAll<HTMLFieldSetElement>("fieldset[data-person-index]")];
  if (groups.length !== people.length) {
    return {ok: false, message: "Число групп формы должно совпадать с числом выбранных людей.", count: 0};
  }
  const bindings: Binding[] = [];
  const indexes = new Set<number>();
  for (const group of groups) {
    const rawIndex = group.dataset.personIndex ?? "";
    if (!/^(0|[1-9][0-9]*)$/.test(rawIndex)) {
      return {ok: false, message: "Некорректный индекс участника.", count: 0};
    }
    const index = Number(rawIndex);
    const person = people[index];
    if (!person || indexes.has(index)) {
      return {ok: false, message: "Не удалось однозначно распределить людей по группам.", count: 0};
    }
    indexes.add(index);
    const seen = new Set<Field>();
    for (const input of group.querySelectorAll<HTMLInputElement>("input")) {
      const field = detect(input);
      if (!field) {
        if (input.required) return {ok: false, message: "В форме есть неизвестное обязательное поле.", count: 0};
        continue;
      }
      if (seen.has(field) || input.disabled || input.readOnly || !["text", "date"].includes(input.type)) {
        return {ok: false, message: "Неоднозначное или недоступное поле. Заполнение отменено.", count: 0};
      }
      seen.add(field);
      if (field === "documentNumber" && person.documents.length !== 1) {
        return {ok: false, message: "Для этой демоформы нужен ровно один документ у каждого человека.", count: 0};
      }
      const value = field === "documentNumber" ? person.documents[0]?.number : person[field];
      if (!value || (input.value !== "" && input.value !== value)) {
        return {ok: false, message: "Нет значения или поле уже содержит другие данные. Проверьте форму.", count: 0};
      }
      bindings.push({input, value});
    }
    if (seen.size !== 4) return {ok: false, message: "Найден неполный набор полей участника.", count: 0};
  }
  if (!apply) return {ok: true, message: `Готово к заполнению: ${people.length} чел., ${bindings.length} полей. Порядок — как в списке.`, count: bindings.length};
  // Validate the entire plan before writing any value. Never click or submit.
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  if (!setter) return {ok: false, message: "Браузер не поддерживает заполнение.", count: 0};
  for (const {input, value} of bindings) {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", {bubbles: true}));
    input.dispatchEvent(new Event("change", {bubbles: true}));
  }
  return {ok: true, message: `Заполнено ${bindings.length} полей. Проверьте данные в открытой вкладке.`, count: bindings.length};
}
