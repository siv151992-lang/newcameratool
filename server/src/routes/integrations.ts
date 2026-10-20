import { Router } from "express";
import { z } from "zod";
import { actorOf, requirePermission } from "../auth/middleware.js";
import { param, parse } from "../lib/validate.js";
import {
  createIntegration,
  createIntegrationSchema,
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
 * Brand integration management. Reading needs settings:read; everything that changes an
 * integration or contacts a camera is administrator-only (settings:write) and audited.
 */
export const integrationsRouter = Router();
const read = requirePermission("settings:read");
const write = requirePermission("settings:write");
const pageQuery = z.object({ page: z.coerce.number().int().min(1).default(1), pageSize: z.coerce.number().int().min(1).max(100).default(20) });

integrationsRouter.get("/", read, async (_req, res) => {
  res.json(await listIntegrations());
});
integrationsRouter.post("/validate", write, async (req, res) => {
  const v = validateConfig(req.body?.config);
  res.json(v.valid ? { valid: true, credentialMode: v.credentialMode, issues: [] } : v);
});
integrationsRouter.post("/preview", write, async (req, res) => {
  res.json(previewMapping(parse(previewSchema, req.body)));
});
integrationsRouter.post("/", write, async (req, res) => {
  res.status(201).json(await createIntegration(parse(createIntegrationSchema, req.body), actorOf(req), req.ip));
});
integrationsRouter.get("/:key", read, async (req, res) => {
  res.json(await getIntegration(param(req, "key")));
});
integrationsRouter.patch("/:key", write, async (req, res) => {
  res.json(await updateIntegration(param(req, "key"), parse(updateIntegrationSchema, req.body), actorOf(req), req.ip));
});
integrationsRouter.delete("/:key", write, async (req, res) => {
  await deleteIntegration(param(req, "key"), actorOf(req), req.ip);
  res.status(204).end();
});
integrationsRouter.get("/:key/impact", read, async (req, res) => {
  res.json(await getImpact(param(req, "key")));
});
integrationsRouter.get("/:key/cameras", read, async (req, res) => {
  const q = parse(pageQuery, req.query);
  res.json(await listIntegrationCameras(param(req, "key"), q.page, q.pageSize));
});
integrationsRouter.get("/:key/tests", read, async (req, res) => {
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
