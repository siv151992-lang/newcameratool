import { config } from "../config.js";
import { getNetworkSettings } from "../services/networkSettings.js";
import { HostGuard } from "./hostGuard.js";

export const hostGuard = new HostGuard({
  allowedNetworks: config.CAMERA_ALLOWED_NETWORKS,
  allowLoopback: config.CAMERA_ALLOW_LOOPBACK,
  loadAllowedNetworks: async () => (await getNetworkSettings()).allowedNetworks,
});
