import { Router } from "express";
import { orgOf, requirePermission } from "../auth/middleware.js";
import { param, parse } from "../lib/validate.js";
import { accessEventsQuery, listAccessEvents, listAccessPoints, listAccessSystems } from "../services/accessService.js";

/** Access control: systems with their readers and doors, and access events. Added and edited as /cameras. */
export const accessRouter = Router();
const read = requirePermission("cameras:read");

accessRouter.get("/", read, async (req, res) => {
  res.json(await listAccessSystems(orgOf(req)));
});

accessRouter.get("/events", read, async (req, res) => {
  res.json(await listAccessEvents(orgOf(req), parse(accessEventsQuery, req.query)));
});

accessRouter.get("/:id/points", read, async (req, res) => {
  res.json(await listAccessPoints(orgOf(req), param(req)));
});
