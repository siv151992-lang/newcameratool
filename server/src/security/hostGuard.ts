import { lookup } from "node:dns/promises";
import { BlockList, isIP } from "node:net";

/**
 * SSRF protection for outbound camera requests.
 * Every camera address is resolved and must (a) not be in a forbidden range
 * (loopback, link-local/cloud metadata, multicast, unspecified...) and
 * (b) fall inside the configured camera networks allowlist.
 * The resolved address is then pinned for the actual connection to prevent DNS rebinding.
 */

const HOSTNAME_RE = /^(?=.{1,253}$)(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))*$/i;

export class HostNotAllowedError extends Error {
  constructor(message: string, public readonly code: "INVALID_HOST" | "HOST_NOT_ALLOWED" | "DNS_FAILED") {
    super(message);
  }
}

/** Normalises a user-supplied host: trims, lower-cases, strips IPv6 brackets. Throws on invalid syntax. */
export function normalizeHost(input: string): string {
  let host = input.trim().toLowerCase();
  if (host.startsWith("[") && host.endsWith("]")) host = host.slice(1, -1);
  if (!host) throw new HostNotAllowedError("Host is required", "INVALID_HOST");
  if (/[/@?#\s]/.test(host) || host.includes("://")) {
    throw new HostNotAllowedError("Enter only an IP address or hostname, without http://, paths or credentials", "INVALID_HOST");
  }
  if (isIP(host)) return host;
  if (/^[\d.]+$/.test(host)) throw new HostNotAllowedError(`"${input}" is not a valid IPv4 address`, "INVALID_HOST");
  if (!HOSTNAME_RE.test(host)) throw new HostNotAllowedError(`"${input}" is not a valid hostname`, "INVALID_HOST");
  return host;
}

export interface HostGuardOptions {
  allowedNetworks: string;   // comma-separated CIDRs
  allowLoopback?: boolean;
}

function addCidr(list: BlockList, cidr: string) {
  const [addr, prefix] = cidr.trim().split("/");
  if (!addr) return;
  const family = isIP(addr) === 6 ? "ipv6" : "ipv4";
  if (!isIP(addr)) throw new Error(`Invalid CIDR in CAMERA_ALLOWED_NETWORKS: ${cidr}`);
  list.addSubnet(addr, prefix === undefined ? (family === "ipv4" ? 32 : 128) : Number(prefix), family);
}

export class HostGuard {
  private readonly forbidden = new BlockList();
  private readonly allowed = new BlockList();
  private readonly loopback = new BlockList();

  constructor(private readonly opts: HostGuardOptions) {
    for (const c of ["0.0.0.0/8", "169.254.0.0/16", "224.0.0.0/4", "240.0.0.0/4", "100.100.100.200/32"]) addCidr(this.forbidden, c);
    for (const c of ["::/128", "fe80::/10", "ff00::/8", "fd00:ec2::254/128"]) addCidr(this.forbidden, c);
    addCidr(this.loopback, "127.0.0.0/8");
    addCidr(this.loopback, "::1/128");
    for (const c of opts.allowedNetworks.split(",").filter((s) => s.trim())) addCidr(this.allowed, c);
  }

  /** Throws HostNotAllowedError unless the address may be contacted. */
  checkAddress(address: string): void {
    let ip = address;
    let family: "ipv4" | "ipv6" = isIP(ip) === 6 ? "ipv6" : "ipv4";
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(ip);
    if (mapped) {
      ip = mapped[1]!;
      family = "ipv4";
    }
    if (this.loopback.check(ip, family)) {
      if (this.opts.allowLoopback) return;
      throw new HostNotAllowedError(`Address ${address} is a loopback address and cannot be monitored`, "HOST_NOT_ALLOWED");
    }
    if (this.forbidden.check(ip, family)) {
      throw new HostNotAllowedError(`Address ${address} is in a reserved range and cannot be contacted`, "HOST_NOT_ALLOWED");
    }
    if (!this.allowed.check(ip, family)) {
      throw new HostNotAllowedError(
        `Address ${address} is outside the allowed camera networks (CAMERA_ALLOWED_NETWORKS)`,
        "HOST_NOT_ALLOWED",
      );
    }
  }

  /** Resolves the host and returns the first permitted address to connect to. */
  async resolve(host: string): Promise<{ address: string; family: 4 | 6 }> {
    const normalized = normalizeHost(host);
    const ipFamily = isIP(normalized);
    let addresses: { address: string; family: number }[];
    if (ipFamily) {
      addresses = [{ address: normalized, family: ipFamily }];
    } else {
      try {
        addresses = await lookup(normalized, { all: true });
      } catch {
        throw new HostNotAllowedError(`Could not resolve hostname "${host}"`, "DNS_FAILED");
      }
    }
    // Every resolved address must be allowed: a hostname mixing internal and external
    // answers is refused rather than silently picking one.
    for (const a of addresses) this.checkAddress(a.address);
    const first = addresses[0]!;
    return { address: first.address, family: first.family === 6 ? 6 : 4 };
  }
}
