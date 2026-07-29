import type { SchemaField, FieldValue } from "@/lib/types";

export interface ValidationResult {
  valid: boolean;
  error?: string;
}

export function validateFieldValue(field: SchemaField, value: string): ValidationResult {
  if (!value.trim()) return { valid: true };

  switch (field.type) {
    case "enum": {
      if (!field.options || field.options.length === 0) return { valid: true };
      const match = field.options.some(
        (opt) => opt.toLowerCase() === value.trim().toLowerCase(),
      );
      if (!match) {
        return {
          valid: false,
          error: `Giá trị không hợp lệ. Chấp nhận: ${field.options.join(", ")}`,
        };
      }
      return { valid: true };
    }
    case "number": {
      const num = Number(value.trim());
      if (Number.isNaN(num)) {
        return { valid: false, error: "Giá trị phải là số" };
      }
      return { valid: true };
    }
    case "boolean": {
      const normalized = value.trim().toLowerCase();
      const validValues = ["true", "false", "yes", "no", "1", "0"];
      if (!validValues.includes(normalized)) {
        return {
          valid: false,
          error: "Giá trị không hợp lệ. Chấp nhận: true/false/yes/no/1/0",
        };
      }
      return { valid: true };
    }
    case "string":
    default:
      return { valid: true };
  }
}

export function validateValues(fields: SchemaField[], values: FieldValue[]): Map<string, ValidationResult> {
  const byName = new Map(values.map((v) => [v.name, v.value]));
  const results = new Map<string, ValidationResult>();

  for (const field of fields) {
    const value = byName.get(field.name) ?? "";
    results.set(field.name, validateFieldValue(field, value));
  }

  return results;
}
