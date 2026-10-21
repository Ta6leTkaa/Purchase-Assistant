/** Adapted from the legacy Identity model. No real profiles are bundled. */
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
  birthDate: string;
  documents: readonly PersonDocument[];
}
export const demoPeople: readonly PersonProfile[] = [
  {id: "demo-adult", displayName: "Тестовый взрослый", firstName: "Тест", lastName: "Примеров",
    birthDate: "1990-01-01", documents: [{type: "internal_passport", number: "DEMO-ADULT"}]},
  {id: "demo-child", displayName: "Тестовый ребёнок", firstName: "Пример", lastName: "Примеров",
    birthDate: "2016-02-02", documents: [{type: "birth_certificate", number: "DEMO-CHILD"}]}
];
