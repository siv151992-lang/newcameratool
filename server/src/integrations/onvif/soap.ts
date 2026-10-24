import { createHash, randomBytes } from "node:crypto";

/** SOAP 1.2 envelopes for ONVIF, with an optional WS-Security UsernameToken (PasswordDigest). */

export const NS = {
  soap: "http://www.w3.org/2003/05/soap-envelope",
  tds: "http://www.onvif.org/ver10/device/wsdl",
  tst: "http://www.onvif.org/ver10/storage/wsdl",
  trc: "http://www.onvif.org/ver10/recording/wsdl",
  tse: "http://www.onvif.org/ver10/search/wsdl",
  trt: "http://www.onvif.org/ver10/media/wsdl",
  trp: "http://www.onvif.org/ver10/replay/wsdl",
  tt: "http://www.onvif.org/ver10/schema",
  wsse: "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-secext-1.0.xsd",
  wsu: "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-wssecurity-utility-1.0.xsd",
} as const;

const PASSWORD_DIGEST = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-username-token-profile-1.0#PasswordDigest";
const BASE64_BINARY = "http://docs.oasis-open.org/wss/2004/01/oasis-200401-wss-soap-message-security-1.0#Base64Binary";

export const escapeXml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" })[c]!);

/** WS-Security PasswordDigest = Base64(SHA-1(nonce + created + password)). */
export function passwordDigest(nonce: Buffer, created: string, password: string): string {
  return createHash("sha1").update(Buffer.concat([nonce, Buffer.from(created + password, "utf8")])).digest("base64");
}

export interface SecurityToken {
  username: string;
  password: string;
  /** Device time in epoch ms; the camera rejects tokens created too far from its own clock. */
  now: number;
  nonce?: Buffer;
}

function securityHeader({ username, password, now, nonce = randomBytes(16) }: SecurityToken): string {
  const created = new Date(now).toISOString().replace(/\.\d{3}Z$/, "Z");
  return (
    `<wsse:Security xmlns:wsse="${NS.wsse}" xmlns:wsu="${NS.wsu}" soap:mustUnderstand="1">` +
    `<wsse:UsernameToken>` +
    `<wsse:Username>${escapeXml(username)}</wsse:Username>` +
    `<wsse:Password Type="${PASSWORD_DIGEST}">${passwordDigest(nonce, created, password)}</wsse:Password>` +
    `<wsse:Nonce EncodingType="${BASE64_BINARY}">${nonce.toString("base64")}</wsse:Nonce>` +
    `<wsu:Created>${created}</wsu:Created>` +
    `</wsse:UsernameToken></wsse:Security>`
  );
}

export function soapEnvelope(body: string, security?: SecurityToken): string {
  return (
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<soap:Envelope xmlns:soap="${NS.soap}" xmlns:tds="${NS.tds}" xmlns:tst="${NS.tst}" xmlns:trc="${NS.trc}" xmlns:tse="${NS.tse}" xmlns:trt="${NS.trt}" xmlns:trp="${NS.trp}" xmlns:tt="${NS.tt}">` +
    (security ? `<soap:Header>${securityHeader(security)}</soap:Header>` : "") +
    `<soap:Body>${body}</soap:Body></soap:Envelope>`
  );
}
