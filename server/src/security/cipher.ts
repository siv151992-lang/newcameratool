import { config } from "../config.js";
import { CredentialCipher, parseKeyConfig } from "./crypto.js";

let instance: CredentialCipher | undefined;

/** Lazily created so a missing key fails loudly at first use with a clear message. */
export function getCipher(): CredentialCipher {
  instance ??= new CredentialCipher(
    parseKeyConfig(config.CREDENTIAL_ENCRYPTION_KEY, config.CREDENTIAL_ENCRYPTION_KEYS, config.CREDENTIAL_KEY_VERSION),
    config.CREDENTIAL_KEY_VERSION,
  );
  return instance;
}
