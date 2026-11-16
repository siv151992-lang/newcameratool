import { beforeAll, describe, expect, it } from "vitest";
import { pool } from "../../src/db/pool.js";
import { createRegistry } from "../../src/integrations/registry.js";
import { syncBrands } from "../../src/services/brandService.js";
import { prepareDb } from "../helpers.js";

beforeAll(prepareDb);

describe("built-in brands added in an update", () => {
  it("keep a brand an administrator already added under the same name", async () => {
    // As on an installation where "Vivotek" was added (works like ONVIF) before it was built in.
    await pool.query("UPDATE camera_brands SET integration_type = 'alias', based_on = 'onvif', display_name = 'Vivotek (ours)' WHERE key = 'vivotek'");
    try {
      const registry = createRegistry();
      await syncBrands(registry); // must not fail on the existing row
      const row = (await pool.query("SELECT integration_type, display_name FROM camera_brands WHERE key = 'vivotek'")).rows[0];
      expect(row).toEqual({ integration_type: "alias", display_name: "Vivotek (ours)" });
      expect(registry.get("vivotek").meta).toMatchObject({ displayName: "Vivotek (ours)", integrationType: "alias", basedOn: "onvif" });
      expect(registry.list().filter((b) => b.key === "vivotek")).toHaveLength(1);
    } finally {
      await pool.query("UPDATE camera_brands SET integration_type = 'builtin', based_on = NULL, display_name = 'Vivotek' WHERE key = 'vivotek'");
    }
  });
});
