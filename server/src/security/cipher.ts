import { resolve } from "node:path";
import { config } from "../config.js";
import { logger } from "../lib/logger.js";
import { CredentialCipher, parseKeyConfig } from "./crypto.js";
import { loadOrCreateKeyFile } from "./keyFile.js";

let instance: CredentialCipher | undefined;

/** Key from CREDENTIAL_KEY_FILE, generated on first start when no key is configured. */
function keyFromFile(): string {
  const path = resolve(config.CREDENTIAL_KEY_FILE);
  const { key, created } = loadOrCreateKeyFile(path);
  if (created) {
    logger.warn(
      { path },
      "Generated a new credential encryption key. Back up this file separately from database backups: " +
        "without it, stored camera passwords cannot be decrypted.",
    );
  } else {
    logger.info({ path }, "Using the credential encryption key from file");
  }
  return key;
}

/** Lazily created so a missing key fails loudly at first use with a clear message. */
export function getCipher(): CredentialCipher {
  instance ??= new CredentialCipher(
    parseKeyConfig(config.CREDENTIAL_ENCRYPTION_KEY, config.CREDENTIAL_ENCRYPTION_KEYS, config.CREDENTIAL_KEY_VERSION, keyFromFile),
    config.CREDENTIAL_KEY_VERSION,
  );
  return instance;
}
