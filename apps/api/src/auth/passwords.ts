import { hash, verify } from "@node-rs/argon2";

/**
 * argon2id (the library default) with OWASP's baseline parameters:
 * 19 MiB of memory, 2 iterations, 1 lane. Memory-hard, so GPU cracking of a
 * leaked hash is expensive. Parameters are stored inside each hash, so they
 * can be raised later without breaking existing passwords.
 */
const OPTIONS = { memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export function hashPassword(password: string): Promise<string> {
  return hash(password, OPTIONS);
}

export function verifyPassword(passwordHash: string, password: string): Promise<boolean> {
  return verify(passwordHash, password);
}

let dummyHash: Promise<string> | undefined;

/**
 * Burns the same time as a real check. Login calls it when the email doesn't
 * exist, so response time doesn't reveal which emails have accounts.
 */
export async function verifyAgainstDummy(password: string): Promise<false> {
  dummyHash ??= hashPassword("dummy password used only to equalize timing");
  await verify(await dummyHash, password);
  return false;
}
