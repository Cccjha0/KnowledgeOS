export class PkbError extends Error {
  readonly code: string;
  readonly details?: unknown;

  constructor(code: string, message: string, details?: unknown) {
    super(message);
    this.name = "PkbError";
    this.code = code;
    this.details = details;
  }
}
