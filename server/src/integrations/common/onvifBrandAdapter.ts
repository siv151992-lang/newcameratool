import type { CameraHttpClient } from "../http/cameraHttpClient.js";
import { OnvifAdapter } from "../onvif/adapter.js";
import { fetchSnapshot } from "../snapshot.js";
import { CameraApiError, type BrandMeta, type CameraConfig } from "../types.js";

/**
 * A base for brands read over ONVIF (Profile S and G) under their own name: storage, recording
 * status, recordings and playback, device information and the live stream address all come over
 * ONVIF. A new brand declares its meta and, if it has one, its own picture address (tried first,
 * ONVIF's when it fails).
 *
 *   export class BoschAdapter extends OnvifBrandAdapter {
 *     override readonly meta = { key: "bosch", displayName: "Bosch", … };
 *     protected readonly snapshotPath = "/snap.jpg?JpegSize=M";
 *   }
 */
export abstract class OnvifBrandAdapter extends OnvifAdapter {
  abstract override readonly meta: BrandMeta;
  /** The brand's own picture address, if any. */
  protected readonly snapshotPath?: string;

  constructor(protected readonly client: CameraHttpClient) {
    super(client);
  }

  override async getSnapshot(camera: CameraConfig) {
    if (!this.snapshotPath) return super.getSnapshot(camera);
    try {
      return await fetchSnapshot(this.client, camera, this.snapshotPath);
    } catch (err) {
      if (err instanceof CameraApiError && (err.code === "AUTH_FAILED" || err.code === "PERMISSION_DENIED")) throw err;
      return super.getSnapshot(camera);
    }
  }
}
