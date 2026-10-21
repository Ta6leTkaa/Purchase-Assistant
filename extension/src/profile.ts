export type DocumentType = "internal_passport" | "international_passport" | "birth_certificate";
export interface PersonDocument {
  type: DocumentType;
  number: string;
  expiresAt?: string;
}
export interface PersonProfile {
  id: string;
  displayName: string;
  firstName: string;
  lastName: string;
  middleName?: string;
  birthDate?: string;
  email?: string;
  phone?: string;
  documents: readonly PersonDocument[];
}
export const documentLabels: Record<DocumentType, string> = {
  internal_passport: "Паспорт РФ",
  international_passport: "Загранпаспорт",
  birth_certificate: "Свидетельство о рождении"
};

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Некорректный профиль.");
  return value as Record<string, unknown>;
}
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.trim().length > max || /[\u0000-\u001f]/u.test(value)) {
    throw new Error(`Проверьте поле «${label}».`);
  }
  return value.trim();
}
function keys(value: Record<string, unknown>, allowed: string[]) {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error("Неизвестные поля профиля.");
}
export function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value && Number(value.slice(0, 4)) >= 1900;
}
export function validateProfile(value: unknown): PersonProfile {
  const input = object(value);
  keys(input, ["id", "displayName", "firstName", "lastName", "middleName", "birthDate", "email", "phone", "documents"]);
  const profile: PersonProfile = {
    id: text(input.id, "идентификатор", 100),
    displayName: text(input.displayName, "название профиля", 100),
    firstName: text(input.firstName, "имя", 100),
    lastName: text(input.lastName, "фамилия", 100),
    documents: []
  };
  if (input.middleName !== undefined && input.middleName !== "") profile.middleName = text(input.middleName, "отчество", 100);
  if (input.birthDate !== undefined && input.birthDate !== "") {
    const date = text(input.birthDate, "дата рождения", 10);
    const today = new Date().toISOString().slice(0, 10);
    if (!validDate(date) || date > today) throw new Error("Укажите существующую дату рождения, не позднее сегодняшней.");
    profile.birthDate = date;
  }
  if (input.email !== undefined && input.email !== "") {
    const email = text(input.email, "email", 254);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Проверьте email.");
    profile.email = email;
  }
  if (input.phone !== undefined && input.phone !== "") {
    const phone = text(input.phone, "телефон", 40);
    if (!/^\+?[\d ()-]+$/.test(phone) || !/^\d{7,16}$/.test(phone.replace(/\D/g, ""))) throw new Error("Проверьте номер телефона.");
    profile.phone = phone;
  }
  if (!Array.isArray(input.documents) || input.documents.length > 10) throw new Error("Можно сохранить до 10 документов на человека.");
  profile.documents = input.documents.map(value => {
    const doc = object(value);
    keys(doc, ["type", "number", "expiresAt"]);
    const type = doc.type;
    if (type !== "internal_passport" && type !== "international_passport" && type !== "birth_certificate") throw new Error("Выберите тип документа.");
    const result: PersonDocument = {type, number: text(doc.number, "номер документа", 64)};
    if (doc.expiresAt !== undefined && doc.expiresAt !== "") {
      const date = text(doc.expiresAt, "срок действия", 10);
      if (!validDate(date)) throw new Error("Проверьте срок действия документа.");
      result.expiresAt = date;
    }
    return result;
  });
  const signatures = profile.documents.map(d => `${d.type}:${d.number.replace(/\s/g, "").toLocaleUpperCase()}`);
  if (new Set(signatures).size !== signatures.length) throw new Error("Один документ указан дважды.");
  return profile;
}
export function validateProfiles(value: unknown): PersonProfile[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("Хранилище поддерживает до 100 человек.");
  const people = value.map(validateProfile);
  if (new Set(people.map(p => p.id)).size !== people.length) throw new Error("Повторяются идентификаторы людей.");
  return people;
}
export function maskedDocument(number: string): string {
  return number.length <= 4 ? "••••" : `•••• ${number.slice(-4)}`;
}
// Only used by automated tests; never inserted into a user's vault automatically.
export const demoPeople: readonly PersonProfile[] = [
  {id: "demo-adult", displayName: "Тестовый взрослый", firstName: "Тест", lastName: "Примеров",
    birthDate: "1990-01-01", documents: [{type: "internal_passport", number: "DEMO-ADULT"}]},
  {id: "demo-child", displayName: "Тестовый ребёнок", firstName: "Пример", lastName: "Примеров",
    birthDate: "2016-02-02", documents: [{type: "birth_certificate", number: "DEMO-CHILD"}]}
];
