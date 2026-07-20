export class AiControlSdkError extends Error {
  readonly code: string;

  public constructor(code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "AiControlSdkError";
    this.code = code;
  }
}
