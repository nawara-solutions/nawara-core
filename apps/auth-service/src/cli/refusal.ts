/**
 * V2 A12.4.3: a Core-authored refusal of an operator CLI (a missing argument, an unmet precondition). Its text is a reviewed template
 * written for the operator and never echoes a secret, so the CLI prints it; any other error is printed as its facts only
 * (`describeCliFailure`), never its message.
 */
export class CliRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliRefusal';
  }
}
