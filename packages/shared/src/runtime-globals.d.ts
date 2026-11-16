/**
 * The WHATWG URL class exists in both Node and browsers. This package loads
 * neither the DOM nor the Node type libraries (its code must run in both), so
 * only the members it uses are declared here. Not emitted to dist: consumers
 * use their own runtime's full declaration.
 */
declare class URL {
  constructor(input: string, base?: string);
  readonly protocol: string;
  readonly hostname: string;
  readonly port: string;
  readonly username: string;
  readonly password: string;
}
