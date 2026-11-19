export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeEmail(value: unknown): string {
  if (typeof value !== "string") {
    throw new ValidationError("El email es obligatorio.");
  }
  const email = value.trim().toLowerCase();
  if (!email || email.length > 254 || !EMAIL_PATTERN.test(email)) {
    throw new ValidationError("El email no es válido.");
  }
  return email;
}

export function normalizeName(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string") {
    throw new ValidationError("El nombre no es válido.");
  }
  const name = value.trim();
  if (name.length > 80) {
    throw new ValidationError("El nombre no puede superar 80 caracteres.");
  }
  return name;
}

export function validateNewPassword(value: unknown): string {
  if (typeof value !== "string") {
    throw new ValidationError("La contraseña es obligatoria.");
  }
  if (value.length < 10) {
    throw new ValidationError("La contraseña debe tener al menos 10 caracteres.");
  }
  if (value.length > 200) {
    throw new ValidationError("La contraseña no puede superar 200 caracteres.");
  }
  if (!value.trim()) {
    throw new ValidationError("La contraseña no puede ser solo espacios.");
  }
  return value;
}

export function readPasswordInput(value: unknown): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 200) {
    throw new ValidationError("Credenciales inválidas.");
  }
  return value;
}

export function readOptionalCode(value: unknown): string {
  if (value === undefined || value === null) return "";
  if (typeof value !== "string" || value.length > 200) {
    throw new ValidationError("El código de registro no es válido.");
  }
  return value.trim();
}
