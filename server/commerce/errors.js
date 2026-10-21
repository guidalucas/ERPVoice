export class CommerceError extends Error {
  constructor(code, message, status = 422, details = undefined) {
    super(message); this.name = 'CommerceError'; this.code = code; this.status = status;
    if (details !== undefined) this.details = details;
  }
}
export const fail = (code, message, status = 422, details) => { throw new CommerceError(code, message, status, details); };
