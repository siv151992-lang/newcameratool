import { randomUUID } from "node:crypto";
import dgram from "node:dgram";
import net from "node:net";

/** Where a camera's ONVIF device service is: protocol, port and path (the host is always the camera's own). */
export interface OnvifEndpoint {
  protocol: "http" | "https";
  port: number;
  path: string;
}

/**
 * Asks the camera where its ONVIF service is with a WS-Discovery Probe sent straight to it (UDP
 * port 3702). ONVIF cameras answer with their device service addresses (XAddrs), which often use a
 * port other than the web page's. Only replies from the camera's own address are read, and only the
 * protocol, port and path are taken: the camera is always contacted at its own address.
 */
export function probeOnvifEndpoint(address: string, timeoutMs = 2500): Promise<OnvifEndpoint | undefined> {
  const id = randomUUID();
  const probe =
    `<?xml version="1.0" encoding="UTF-8"?>` +
    `<e:Envelope xmlns:e="http://www.w3.org/2003/05/soap-envelope" xmlns:w="http://schemas.xmlsoap.org/ws/2004/08/addressing" ` +
    `xmlns:d="http://schemas.xmlsoap.org/ws/2005/04/discovery" xmlns:dn="http://www.onvif.org/ver10/network/wsdl">` +
    `<e:Header><w:MessageID>uuid:${id}</w:MessageID><w:To e:mustUnderstand="true">urn:schemas-xmlsoap-org:ws:2005:04:discovery</w:To>` +
    `<w:Action e:mustUnderstand="true">http://schemas.xmlsoap.org/ws/2005/04/discovery/Probe</w:Action></e:Header>` +
    `<e:Body><d:Probe><d:Types>dn:NetworkVideoTransmitter</d:Types></d:Probe></e:Body></e:Envelope>`;
  return new Promise((resolve) => {
    const socket = dgram.createSocket(net.isIPv6(address) ? "udp6" : "udp4");
    let done = false;
    const finish = (endpoint?: OnvifEndpoint) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.close();
      resolve(endpoint);
    };
    const timer = setTimeout(() => finish(), timeoutMs);
    socket.on("error", () => finish());
    socket.on("message", (msg, from) => {
      if (from.address.replace(/^::ffff:/, "") !== address.replace(/^::ffff:/, "")) return;
      const endpoint = parseXAddrs(msg.toString("utf8"));
      if (endpoint) finish(endpoint);
    });
    socket.send(probe, 3702, address, (err) => err && finish());
  });
}

/** The first usable device service address in a WS-Discovery ProbeMatch (XAddrs is a space-separated list). */
export function parseXAddrs(xml: string): OnvifEndpoint | undefined {
  const m = /<(?:\w+:)?XAddrs>([^<]+)<\/(?:\w+:)?XAddrs>/i.exec(xml);
  if (!m) return undefined;
  for (const raw of m[1]!.trim().split(/\s+/)) {
    try {
      const u = new URL(raw);
      if (u.protocol !== "http:" && u.protocol !== "https:") continue;
      const protocol = u.protocol === "https:" ? "https" : "http";
      return { protocol, port: u.port ? Number(u.port) : protocol === "https" ? 443 : 80, path: u.pathname || "/onvif/device_service" };
    } catch {
      // try the next one
    }
  }
  return undefined;
}

/** Ports cameras commonly serve ONVIF on, tried when the camera does not answer discovery. */
export const COMMON_ONVIF_ENDPOINTS: OnvifEndpoint[] = [
  { protocol: "http", port: 80, path: "/onvif/device_service" },
  { protocol: "http", port: 8000, path: "/onvif/device_service" },
  { protocol: "http", port: 8080, path: "/onvif/device_service" },
  { protocol: "http", port: 2020, path: "/onvif/device_service" },
  { protocol: "http", port: 8899, path: "/onvif/device_service" },
  { protocol: "http", port: 10080, path: "/onvif/device_service" },
  { protocol: "https", port: 443, path: "/onvif/device_service" },
];
