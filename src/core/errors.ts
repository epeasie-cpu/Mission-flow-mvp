/** Typed command failures. Authorization denials are Forbidden; missing or hidden taskers are NotFound. */

export class Forbidden extends Error {
  readonly code = "forbidden" as const;
  constructor(message = "Forbidden") {
    super(message);
    this.name = "Forbidden";
  }
}

export class InvalidTransition extends Error {
  readonly code = "invalid_transition" as const;
  constructor(message = "Invalid transition") {
    super(message);
    this.name = "InvalidTransition";
  }
}

export class ValidationError extends Error {
  readonly code = "validation" as const;
  constructor(message = "Validation failed") {
    super(message);
    this.name = "ValidationError";
  }
}

export class Conflict extends Error {
  readonly code = "conflict" as const;
  constructor(message = "Conflict") {
    super(message);
    this.name = "Conflict";
  }
}

export class NotFound extends Error {
  readonly code = "not_found" as const;
  constructor(message = "Not found") {
    super(message);
    this.name = "NotFound";
  }
}
