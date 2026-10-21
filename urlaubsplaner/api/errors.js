export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class ConflictError extends HttpError {
  constructor() {
    super(409, 'Dieser Eintrag wurde inzwischen geändert. Bitte lade die Seite neu.');
  }
}
