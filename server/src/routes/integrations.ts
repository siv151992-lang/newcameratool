import { type Request, Router } from "express";
import { z } from "zod";
import { actorOf, orgOf, requirePermission } from "../auth/middleware.js";
import { SYSTEM_PERMISSION } from "../auth/sessions.js";
import { param, parse } from "../lib/validate.js";
import {
  createIntegration,
  createIntegrationSchema,
  createWorksLikeIntegration,
  createWorksLikeSchema,
  detectBrand,
  detectSchema,
  deleteIntegration,
  disableIntegration,
  enableIntegration,
  getImpact,
  getIntegration,
  listIntegrationCameras,
  listIntegrations,
  listIntegrationTests,
  previewMapping,
  previewSchema,
  reassignCameras,
  testIntegration,
  testIntegrationSchema,
  updateIntegration,
  updateIntegrationSchema,
  validateConfig,
} from "../services/integrationService.js";
import { integrationLimiter } from "./limits.js";

/**
 * Brand integration management. Integrations serve every organization, so only the system
 * administrator changes them; Org Admins (settings:read) can look. Every change is audited.
 */
export const integrationsRouter = Router();
const read = requirePermission("settings:read");
const write = requirePermission(SYSTEM_PERMISSION);
const system = requirePermission(SYSTEM_PERMISSION);
/** Org Admins see their own organization's cameras; the system administrator sees every organization's. */
const cameraScope = (req: Request) => (req.auth!.user.isSystemAdmin ? null : orgOf(req));
const pageQuery = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) });

integrationsRouter.get("/", read, async (req, res) => {
  res.json(await listIntegrations(cameraScope(req)));
});
integrationsRouter.post("/validate", write, async (req, res) => {
  const v = validateConfig(req.body?.config);
  res.json(v.valid ? { valid: true, credentialMode: v.credentialMode, issues: [] } : v);
});
integrationsRouter.post("/preview", write, async (req, res) => {
  res.json(previewMapping(parse(previewSchema, req.body)));
});
// Adding a brand the simple way: find which built-in adapter one of its cameras works with, then
// save the brand as working like it.
integrationsRouter.post("/detect", write, integrationLimiter, async (req, res) => {
  res.json(await detectBrand(parse(detectSchema, req.body)));
});
integrationsRouter.post("/works-like", write, async (req, res) => {
  res.status(201).json(await createWorksLikeIntegration(parse(createWorksLikeSchema, req.body), actorOf(req), req.ip));
});

integrationsRouter.post("/", write, async (req, res) => {
  res.status(201).json(await createIntegration(parse(createIntegrationSchema, req.body), actorOf(req), req.ip));
});
integrationsRouter.get("/:key", read, async (req, res) => {
  res.json(await getIntegration(param(req, "key"), cameraScope(req)));
});
integrationsRouter.patch("/:key", write, async (req, res) => {
  res.json(await updateIntegration(param(req, "key"), parse(updateIntegrationSchema, req.body), actorOf(req), req.ip));
});
integrationsRouter.delete("/:key", write, async (req, res) => {
  await deleteIntegration(param(req, "key"), actorOf(req), req.ip);
  res.status(204).end();
});
integrationsRouter.get("/:key/impact", system, async (req, res) => {
  res.json(await getImpact(param(req, "key")));
});
integrationsRouter.get("/:key/cameras", read, async (req, res) => {
  const q = parse(pageQuery, req.query);
  res.json(await listIntegrationCameras(param(req, "key"), cameraScope(req), q.page, q.pageSize));
});
integrationsRouter.get("/:key/tests", system, async (req, res) => {
  const q = parse(pageQuery, req.query);
  res.json(await listIntegrationTests(param(req, "key"), q.page, q.pageSize));
});
integrationsRouter.post("/:key/test", write, integrationLimiter, async (req, res) => {
  res.json(await testIntegration(param(req, "key"), parse(testIntegrationSchema, req.body), actorOf(req), req.ip));
});
integrationsRouter.post("/:key/enable", write, async (req, res) => {
  const body = parse(z.object({ versionId: z.string().uuid().optional() }).strict(), req.body ?? {});
  res.json(await enableIntegration(param(req, "key"), body.versionId, actorOf(req), req.ip));
});
integrationsRouter.post("/:key/disable", write, async (req, res) => {
  res.json(await disableIntegration(param(req, "key"), actorOf(req), req.ip));
});
integrationsRouter.post("/:key/reassign", write, async (req, res) => {
  const body = parse(z.object({ toKey: z.string().min(1).max(60) }).strict(), req.body);
  res.json(await reassignCameras(param(req, "key"), body.toKey, actorOf(req), req.ip));
});
