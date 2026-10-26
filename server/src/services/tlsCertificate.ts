import { X509Certificate } from "node:crypto";
import net from "node:net";
import tls from "node:tls";
import { HttpError } from "../lib/errors.js";
import { HostNotAllowedError, normalizeHost } from "../security/hostGuard.js";
import { hostGuard } from "../security/hostGuardInstance.js";

export interface CameraCertificate {
  pem: string;
  fingerprint256: string;
  subject: string;
  issuer: string;
  validFrom: string;
  validTo: string;
  selfSigned: boolean;
}

/**
 * The certificate a camera presents on HTTPS, read without trusting it, so the user can check its
 * fingerprint and trust that exact certificate for the camera (stored as its TLS CA certificate).
 * Nothing is sent to the camera but the TLS handshake.
 */
export async function fetchCameraCertificate(rawHost: string, port: number, timeoutMs = 8000): Promise<CameraCertificate> {
  let host: string;
  let address: string;
  try {
    host = normalizeHost(rawHost);
    ({ address } = await hostGuard.resolve(host));
  } catch (err) {
    throw new HttpError(400, "HOST_NOT_ALLOWED", err instanceof HostNotAllowedError ? err.message : "Invalid camera address");
  }
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: address, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false });
    const fail = (message: string) => {
      socket.destroy();
      reject(new HttpError(422, "TLS_CERTIFICATE_UNAVAILABLE", message));
    };
    socket.setTimeout(timeoutMs, () => fail(`The camera did not answer on port ${port} within ${Math.round(timeoutMs / 1000)} seconds`));
    socket.once("error", (err: Error & { code?: string }) =>
      fail(err.code === "ECONNREFUSED" ? `Nothing is listening on port ${port}: turn on HTTPS in the camera, or check the port` : `The camera's HTTPS could not be reached (${err.code ?? err.message})`),
    );
    socket.once("secureConnect", () => {
      const raw = socket.getPeerCertificate(true)?.raw;
      socket.end();
      if (!raw) return fail("The camera sent no certificate");
      const cert = new X509Certificate(raw);
      resolve({
        pem: cert.toString().trim(),
        fingerprint256: cert.fingerprint256,
        subject: cert.subject.replace(/\n/g, ", "),
        issuer: cert.issuer.replace(/\n/g, ", "),
        validFrom: new Date(cert.validFrom).toISOString(),
        validTo: new Date(cert.validTo).toISOString(),
        selfSigned: cert.subject === cert.issuer,
      });
    });
  });
}
