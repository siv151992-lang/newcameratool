import { hostGuard } from "../security/hostGuardInstance.js";
import { AxisAdapter } from "./axis/adapter.js";
import { DahuaAdapter } from "./dahua/adapter.js";
import { HikvisionAdapter } from "./hikvision/adapter.js";
import { CameraHttpClient } from "./http/cameraHttpClient.js";
import { OnvifAdapter } from "./onvif/adapter.js";
import { UniviewAdapter } from "./uniview/adapter.js";
import { CameraApiError, type BrandMeta, type CameraBrandAdapter } from "./types.js";

/**
 * Brand registry. Implemented adapters are registered here; brands that are only planned are
 * listed with metadata but cannot be selected for monitoring until an adapter exists and is tested.
 * Adapters marked "unverified" can be selected but have not yet been confirmed on real hardware.
 */
const PLANNED: BrandMeta[] = [];

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
    const aliases: Record<string, string> = {
      hik: "hikvision",
      hikvision: "hikvision",
      cpplus: "dahua",
      amcrest: "dahua",
      axiscommunications: "axis",
      unv: "uniview",
      genericonvif: "onvif",
    };
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
  registry.register(new DahuaAdapter(http));
  registry.register(new AxisAdapter(http));
  registry.register(new UniviewAdapter(http));
  registry.register(new OnvifAdapter(http));
  for (const p of PLANNED) registry.registerPlanned(p);
  return registry;
}

export const registry = createRegistry();
