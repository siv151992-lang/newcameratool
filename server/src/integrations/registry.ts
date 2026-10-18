import { hostGuard } from "../security/hostGuardInstance.js";
import { HikvisionAdapter } from "./hikvision/adapter.js";
import { CameraHttpClient } from "./http/cameraHttpClient.js";
import { CameraApiError, type BrandMeta, type CameraBrandAdapter } from "./types.js";

/**
 * Brand registry. Implemented adapters are registered here; brands that are only planned are
 * listed with metadata but cannot be selected for monitoring until an adapter exists and is tested.
 */
const PLANNED: BrandMeta[] = [
  {
    key: "dahua",
    displayName: "Dahua (incl. CP Plus, Amcrest)",
    supportStatus: "planned",
    authMethods: ["digest"],
    defaultPorts: { http: 80, https: 443 },
    capabilities: [],
    storageEndpoint: "GET /cgi-bin/storageDevice.cgi?action=getDeviceAllInfo (to be verified)",
    notes: "Planned. Not implemented or tested yet.",
  },
  {
    key: "axis",
    displayName: "Axis",
    supportStatus: "planned",
    authMethods: ["digest"],
    defaultPorts: { http: 80, https: 443 },
    capabilities: [],
    storageEndpoint: "GET /axis-cgi/disks/list.cgi (VAPIX, to be verified)",
    notes: "Planned. Not implemented or tested yet.",
  },
  {
    key: "uniview",
    displayName: "Uniview",
    supportStatus: "planned",
    authMethods: ["digest"],
    defaultPorts: { http: 80, https: 443 },
    capabilities: [],
    notes: "Planned. Storage API documentation still needs to be confirmed.",
  },
  {
    key: "onvif",
    displayName: "Generic ONVIF",
    supportStatus: "planned",
    authMethods: ["ws-security"],
    defaultPorts: { http: 80, https: 443 },
    capabilities: [],
    notes: "Planned. ONVIF has no universal storage-capacity API; support would be per device profile.",
  },
];

export class BrandRegistry {
  private readonly adapters = new Map<string, CameraBrandAdapter>();
  private readonly planned = new Map<string, BrandMeta>();

  register(adapter: CameraBrandAdapter) {
    this.adapters.set(adapter.meta.key, adapter);
  }
  registerPlanned(meta: BrandMeta) {
    this.planned.set(meta.key, meta);
  }

  get(key: string): CameraBrandAdapter {
    const adapter = this.adapters.get(key);
    if (!adapter) {
      const planned = this.planned.get(key);
      throw new CameraApiError(
        "UNSUPPORTED_BRAND",
        planned ? `${planned.displayName} support is planned but not implemented yet` : `Unknown camera brand "${key}"`,
      );
    }
    return adapter;
  }

  isSupported(key: string) {
    return this.adapters.has(key);
  }

  /** Resolves a user-entered brand name ("Hikvision", "HIK", ...) to a registry key. */
  resolveKey(input: string): string | undefined {
    const s = input.trim().toLowerCase().replace(/[\s_-]+/g, "");
    const aliases: Record<string, string> = { hik: "hikvision", hikvision: "hikvision", cpplus: "dahua", amcrest: "dahua" };
    const key = aliases[s] ?? s;
    return this.adapters.has(key) || this.planned.has(key) ? key : undefined;
  }

  list(): BrandMeta[] {
    return [...[...this.adapters.values()].map((a) => a.meta), ...this.planned.values()];
  }
}

export function createRegistry(http = new CameraHttpClient(hostGuard)): BrandRegistry {
  const registry = new BrandRegistry();
  registry.register(new HikvisionAdapter(http));
  for (const p of PLANNED) registry.registerPlanned(p);
  return registry;
}

export const registry = createRegistry();
