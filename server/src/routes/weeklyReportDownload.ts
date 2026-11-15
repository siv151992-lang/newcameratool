import type { Request, Response } from "express";
import { audit } from "../services/auditService.js";
import { buildWeeklyReport, XLSX_TYPE } from "../services/weeklyReportService.js";
import { actorOf, orgOf } from "../auth/middleware.js";

/** Sends the weekly report workbook (Cameras page and Settings use the same download). */
export async function sendWeeklyReportXlsx(req: Request, res: Response, timeZone: string) {
  const report = await buildWeeklyReport(orgOf(req), timeZone);
  await audit({ actor: actorOf(req), ip: req.ip, action: "camera.weekly_report_exported", entityType: "camera", details: {} });
  res.set("Content-Type", XLSX_TYPE).set("Content-Disposition", `attachment; filename="${report.fileName}"`).send(report.xlsx);
}
