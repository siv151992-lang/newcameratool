import { Router } from "express";
import { z } from "zod";
import { actorOf, orgOf, requirePermission } from "../auth/middleware.js";
import { param, parse } from "../lib/validate.js";
import { acknowledgeAlert, alertListQuery, getAlert, listAlerts, resolveAlert } from "../services/alertService.js";

export const alertsRouter = Router();
const noteSchema = z.object({ note: z.string().trim().max(500).optional() }).strict();

alertsRouter.get("/", requirePermission("alerts:read"), async (req, res) => {
  res.json(await listAlerts(orgOf(req), parse(alertListQuery, req.query)));
});

alertsRouter.get("/:id", requirePermission("alerts:read"), async (req, res) => {
  res.json(await getAlert(orgOf(req), param(req)));
});

alertsRouter.post("/:id/acknowledge", requirePermission("alerts:manage"), async (req, res) => {
  const { note } = parse(noteSchema, req.body ?? {});
  await acknowledgeAlert(orgOf(req), param(req), actorOf(req), note, req.ip);
  res.json(await getAlert(orgOf(req), param(req)));
});

alertsRouter.post("/:id/resolve", requirePermission("alerts:manage"), async (req, res) => {
  const { note } = parse(noteSchema, req.body ?? {});
  await resolveAlert(orgOf(req), param(req), actorOf(req), note, req.ip);
  res.json(await getAlert(orgOf(req), param(req)));
});
