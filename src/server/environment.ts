import dotenv from 'dotenv';
import { resolve } from 'node:path';

/** Root-level environment file used only by backend modules. */
export const SERVER_ENV_FILE = resolve(process.cwd(), '.env');

/** Loads the root .env without overriding explicitly supplied process values. */
export function loadServerEnvironment(): void {
  dotenv.config({ path: SERVER_ENV_FILE, override: false });
}
