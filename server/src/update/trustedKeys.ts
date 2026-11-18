/**
 * Public keys whose signature makes an update package installable (Ed25519, SPKI DER, base64).
 * Compiled into the app on purpose: a key can only be added or replaced by installing a package by
 * hand (START.bat), never from the web page. The private key is kept by whoever publishes releases
 * (the UPDATE_SIGNING_KEY secret of the release workflow); it is never stored in this repository.
 * To replace a lost or exposed key: add the new key here, release with the old key one last time,
 * then remove the old key in the next release.
 */
export const UPDATE_PUBLIC_KEYS: readonly string[] = ["MCowBQYDK2VwAyEAhPXD9PzNVl2Ozx13HJwhIE7kbYTawL/u1rfSByQNJfw="];
