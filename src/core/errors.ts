export class VenueError extends Error {
  override readonly name = "VenueError";

  constructor(
    message: string,
    readonly venue: string,
    readonly code: string | number,
    readonly retryable = false,
    options?: ErrorOptions,
  ) {
    super(message, options);
  }
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
}

export class InvariantError extends Error {
  override readonly name = "InvariantError";
}
