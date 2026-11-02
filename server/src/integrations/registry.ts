import { hostGuard } from "../security/hostGuardInstance.js";
import { AxisAdapter } from "./axis/adapter.js";
import { BoschAdapter } from "./bosch/adapter.js";
import { MilestoneAdapter } from "./milestone/adapter.js";
import { DahuaAdapter } from "./dahua/adapter.js";
import { HanwhaAdapter } from "./hanwha/adapter.js";
import { HikvisionAdapter } from "./hikvision/adapter.js";
import { CameraHttpClient } from "./http/cameraHttpClient.js";
import { OnvifAdapter } from "./onvif/adapter.js";
import { PanasonicAdapter } from "./panasonic/adapter.js";
import { PramaAdapter } from "./prama/adapter.js";
import { ReolinkAdapter } from "./reolink/adapter.js";
import { UniviewAdapter } from "./uniview/adapter.js";
import { pool, type Queryable } from "../db/pool.js";
import { ConfigurableAdapter, type ConfigurableMeta } from "./configurable/adapter.js";
import { credentialModeFor, integrationConfigSchema, type IntegrationConfig } from "./configurable/config.js";
import { CameraApiError, type BrandMeta, type CameraBrandAdapter } from "./types.js";

/**
 * Brand registry. Built-in adapters (Mode B: trusted code in this repository) are registered in
 * code; configurable API integrations (Mode A) are loaded from camera_brands by refresh(). Only
 * enabled integrations can be selected for cameras or used for monitoring; a disabled one keeps
 * its cameras, history and alerts but is not checked. Planned brands are listed but unusable.
 */
const PLANNED: BrandMeta[] = [];
const BUILTIN_VERSION = "1.0.0";

interface BrandState {
  status: "draft" | "tested" | "enabled" | "disabled";
  displayName: string;
  type: "builtin" | "configurable" | "alias";
  /** Credentials cameras need and whether they must use HTTPS, from the active configuration. */
  credentials: "user_password" | "secret" | "none";
  httpsOnly: boolean;
}

export class BrandRegistry {
  private readonly adapters = new Map<string, CameraBrandAdapter>();
  private readonly planned = new Map<string, BrandMeta>();
  private configured = new Map<string, ConfigurableAdapter>();
  /** "Works like" brands: a built-in adapter under the brand's own name. */
  private aliases = new Map<string, CameraBrandAdapter>();
  private states = new Map<string, BrandState>();
  private refreshedAt = 0;

  constructor(readonly http?: CameraHttpClient) {}

  register(adapter: CameraBrandAdapter) {
    this.adapters.set(adapter.meta.key, adapter);
  }
  registerPlanned(meta: BrandMeta) {
    this.planned.set(meta.key, meta);
  }

  /** Builds an adapter for a configuration without registering it (used to test drafts). */
  createConfigurable(info: ConfigurableMeta, config: IntegrationConfig): ConfigurableAdapter {
    if (!this.http) throw new Error("This registry has no HTTP client");
    return new ConfigurableAdapter(this.http, info, config);
  }

  /** Reloads integration states and enabled configurable integrations from the database. */
  async refresh(db: Queryable = pool): Promise<void> {
    const { rows } = await db.query(
      `SELECT b.key, b.display_name, b.status, b.integration_type, b.integration_version, b.notes, b.default_protocol,
              b.default_http_port, b.default_https_port, b.based_on, v.config, v.version
       FROM camera_brands b LEFT JOIN brand_integration_versions v ON v.id = b.active_version_id
       WHERE b.deleted_at IS NULL`,
    );
    const states = new Map<string, BrandState>();
    const configured = new Map<string, ConfigurableAdapter>();
    const aliases = new Map<string, CameraBrandAdapter>();
    for (const r of rows) {
      const auth = r.config?.auth?.type as string | undefined;
      states.set(r.key, {
        status: r.status, displayName: r.display_name, type: r.integration_type,
        credentials: auth ? credentialModeFor(auth as IntegrationConfig["auth"]["type"]) : "user_password",
        httpsOnly: auth === "basic" || auth === "bearer" || auth === "api_key",
      });
      const base = r.based_on ? this.adapters.get(r.based_on) : undefined;
      if (r.integration_type === "alias" && r.status === "enabled" && base) {
        aliases.set(r.key, worksLike(base, {
          key: r.key, displayName: r.display_name, notes: r.notes ?? base.meta.notes,
          defaultPorts: { http: r.default_http_port ?? base.meta.defaultPorts.http, https: r.default_https_port ?? base.meta.defaultPorts.https },
          defaultProtocol: r.default_protocol,
        }));
        continue;
      }
      if (r.integration_type !== "configurable" || r.status !== "enabled" || !r.config || !this.http) continue;
      const parsed = integrationConfigSchema.safeParse(r.config);
      if (!parsed.success) continue; // never monitor with a configuration that no longer validates
      configured.set(
        r.key,
        this.createConfigurable(
          {
            key: r.key, displayName: r.display_name, version: r.integration_version, versionNumber: r.version, notes: r.notes,
            defaultPorts: { http: r.default_http_port ?? 80, https: r.default_https_port ?? 443 },
            defaultProtocol: r.default_protocol,
          },
          parsed.data,
        ),
      );
    }
    this.states = states;
    this.configured = configured;
    this.aliases = aliases;
    this.refreshedAt = Date.now();
  }

  /** Refreshes when the last load is older than maxAgeMs (the worker calls this every tick). */
  async refreshIfStale(maxAgeMs = 30_000): Promise<void> {
    if (Date.now() - this.refreshedAt >= maxAgeMs) await this.refresh();
  }

  get(key: string): CameraBrandAdapter {
    const state = this.states.get(key);
    const adapter = this.configured.get(key) ?? this.aliases.get(key) ?? this.adapters.get(key);
    if (adapter && (!state || state.status === "enabled")) return adapter;
    if (state && state.status !== "enabled") {
      throw new CameraApiError(
        "UNSUPPORTED_BRAND",
        state.status === "disabled"
          ? `The ${state.displayName} integration is disabled. An administrator can enable it in Settings → Camera brands.`
          : `The ${state.displayName} integration is not enabled yet (${state.status}).`,
      );
    }
    const planned = this.planned.get(key);
    throw new CameraApiError(
      "UNSUPPORTED_BRAND",
      planned ? `${planned.displayName} support is planned but not implemented yet` : `Unknown camera brand "${key}"`,
    );
  }

  /** Enabled for new cameras and monitoring. */
  isSupported(key: string) {
    const state = this.states.get(key);
    if (state && state.status !== "enabled") return false;
    return this.adapters.has(key) || this.configured.has(key) || this.aliases.has(key);
  }

  /** A built-in adapter whatever its status (tests run even while it is disabled). */
  builtinAdapter(key: string): CameraBrandAdapter | undefined {
    return this.adapters.get(key);
  }

  /** Credentials a camera of this brand needs, whatever the integration's status. */
  credentialsOf(key: string): "user_password" | "secret" | "none" {
    return this.adapters.has(key) ? "user_password" : (this.states.get(key)?.credentials ?? "user_password");
  }

  /** True when the brand's credentials are only ever sent over HTTPS. */
  requiresHttps(key: string): boolean {
    return !this.adapters.has(key) && (this.states.get(key)?.httpsOnly ?? false);
  }

  isBuiltin(key: string) {
    return this.adapters.has(key);
  }

  /** Metadata of a built-in adapter whatever its status (for the Camera brands page). */
  builtinMeta(key: string): BrandMeta | undefined {
    const a = this.adapters.get(key);
    return a ? withDefaults(a.meta) : undefined;
  }

  builtins(): BrandMeta[] {
    return [...this.adapters.values()].map((a) => withDefaults(a.meta));
  }

  /** Resolves a user-entered brand name ("Hikvision", "HIK", ...) to a registry key. */
  resolveKey(input: string): string | undefined {
    const s = input.trim().toLowerCase().replace(/[\s_-]+/g, "");
    const aliases: Record<string, string> = {
      hik: "hikvision",
      hikvision: "hikvision",
      // Prama Hikvision (India): Hikvision firmware, listed as its own brand.
      prama: "prama",
      pramahikvision: "prama",
      pramahikvisionindia: "prama",
      cpplus: "dahua",
      amcrest: "dahua",
      axiscommunications: "axis",
      unv: "uniview",
      genericonvif: "onvif",
      hanwha: "hanwha",
      hanwhavision: "hanwha",
      hanwhavisionwisenet: "hanwha",
      hanwhatechwin: "hanwha",
      wisenet: "hanwha",
      samsungtechwin: "hanwha",
      panasonic: "panasonic",
      ipro: "panasonic",
      panasonicipro: "panasonic",
      reolink: "reolink",
      // Brands sold on Hikvision firmware (the same API).
      hilook: "hikvision",
      hiwatch: "hikvision",
      annke: "hikvision",
      lts: "hikvision",
      ltsecurity: "hikvision",
      // Brands sold on Dahua firmware.
      lorex: "dahua",
      icrealtime: "dahua",
      imou: "dahua",
      milestone: "milestone",
      xprotect: "milestone",
      milestonexprotect: "milestone",
      milestoneopennetworkbridge: "milestone",
      bosch: "bosch",
      boschsecurity: "bosch",
      // Brands without an API of their own here: their cameras are read over ONVIF.
      vivotek: "onvif",
      sony: "onvif",
      avigilon: "onvif",
      milesight: "onvif",
      tiandy: "onvif",
      tplink: "onvif",
      tplinkvigi: "onvif",
      vigi: "onvif",
      mobotix: "onvif",
    };
    const key = aliases[s] ?? s;
    if (this.adapters.has(key) || this.planned.has(key) || this.states.has(key)) return key;
    // Configured integrations can also be named by their display name.
    for (const [k, st] of this.states) if (st.displayName.toLowerCase().replace(/[\s_-]+/g, "") === s) return k;
    return undefined;
  }

  /** Integrations that can be selected for cameras now, plus planned ones. */
  list(): BrandMeta[] {
    const builtin = [...this.adapters.values()].filter((a) => this.isSupported(a.meta.key)).map((a) => withDefaults(a.meta));
    return [...builtin, ...[...this.configured.values()].map((a) => a.meta), ...[...this.aliases.values()].map((a) => a.meta), ...this.planned.values()];
  }
}

/**
 * A built-in adapter under another brand's name: every method is the built-in one (the same code,
 * tests and fixes); only the name, ports and notes are the brand's.
 */
function worksLike(base: CameraBrandAdapter, own: Pick<BrandMeta, "key" | "displayName" | "defaultPorts"> & Partial<BrandMeta>): CameraBrandAdapter {
  const adapter = Object.create(base) as CameraBrandAdapter;
  Object.defineProperty(adapter, "meta", { value: { ...withDefaults(base.meta), ...own, integrationType: "alias", basedOn: base.meta.key }, enumerable: true });
  return adapter;
}

function withDefaults(meta: BrandMeta): BrandMeta {
  return { version: BUILTIN_VERSION, integrationType: "builtin", credentials: "user_password", defaultProtocol: "http", ...meta };
}

export function createRegistry(http = new CameraHttpClient(hostGuard)): BrandRegistry {
  const registry = new BrandRegistry(http);
  registry.register(new HikvisionAdapter(http));
  registry.register(new PramaAdapter(http));
  registry.register(new DahuaAdapter(http));
  registry.register(new AxisAdapter(http));
  registry.register(new UniviewAdapter(http));
  registry.register(new OnvifAdapter(http));
  registry.register(new HanwhaAdapter(http));
  registry.register(new PanasonicAdapter(http));
  registry.register(new ReolinkAdapter(http));
  registry.register(new BoschAdapter(http));
  registry.register(new MilestoneAdapter(http));
  for (const p of PLANNED) registry.registerPlanned(p);
  return registry;
}

export const registry = createRegistry();
