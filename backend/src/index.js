import express from "express";
import cors from "cors";
import "dotenv/config";

import { requireAuth } from "./middleware/auth.js";
import { errorHandler, notFound } from "./middleware/errors.js";
import { apiLimiter, authLimiter } from "./middleware/rateLimit.js";
import { startScheduler } from "./scheduler.js";
import { startWebhookWorker } from "./events.js";

import authRouter from "./routes/auth.js";
import propertiesRouter from "./routes/properties.js";
import assetsRouter from "./routes/assets.js";
import workOrdersRouter from "./routes/workOrders.js";
import reliabilityRouter from "./routes/reliability.js";
import inventoryRouter from "./routes/inventory.js";
import purchaseOrdersRouter from "./routes/purchaseOrders.js";
import reportsRouter from "./routes/reports.js";
import notificationsRouter from "./routes/notifications.js";
import quotesRouter from "./routes/quotes.js";
import complianceRouter from "./routes/compliance.js";
import maintenancePlansRouter from "./routes/maintenancePlans.js";
import suppliersRouter from "./routes/suppliers.js";
import contractsRouter from "./routes/contracts.js";
import invoicesRouter from "./routes/invoices.js";
import usersRouter from "./routes/users.js";
import configRouter from "./routes/config.js";
import documentsRouter from "./routes/documents.js";
import meterReadingsRouter from "./routes/meterReadings.js";
import webhooksRouter from "./routes/webhooks.js";
import integrationsRouter, { dataDictionaryHandler } from "./routes/integrations.js";
import syncRouter from "./routes/sync.js";
import triageRouter from "./routes/triage.js";
import auditLogRouter from "./routes/auditLog.js";
import budgetsRouter from "./routes/budgets.js";

const app = express();
app.use(cors());
// 35mb body cap so offline evidence (base64 photos/videos up to the 20MB
// file cap) can travel through /sync/ops without tripping the 100kb default.
app.use(express.json({ limit: "35mb" }));

// Behind a reverse proxy (production), trust a single hop so rate limiting
// and client IPs are accurate. Enable with TRUST_PROXY=1 in the environment.
if (process.env.TRUST_PROXY === "1") {
  app.set("trust proxy", 1);
}

app.get("/health", (req, res) => res.json({ status: "ok" }));

// Public documentation endpoint — describes the API for integrators.
app.get("/api/integrations/data-dictionary", dataDictionaryHandler);

app.use("/api", apiLimiter);
app.use("/api/auth", authLimiter, authRouter);

// All routes below require a valid JWT; requireAuth attaches req.orgId
// so every query is automatically scoped to the caller's organization.
app.use("/api/properties", requireAuth, propertiesRouter);
app.use("/api/assets", requireAuth, assetsRouter);
app.use("/api/work-orders", requireAuth, workOrdersRouter);
app.use("/api/maintenance-plans", requireAuth, maintenancePlansRouter);
app.use("/api/suppliers", requireAuth, suppliersRouter);
app.use("/api/contracts", requireAuth, contractsRouter);
app.use("/api/reliability", requireAuth, reliabilityRouter);
app.use("/api/inventory", requireAuth, inventoryRouter);
app.use("/api/purchase-orders", requireAuth, purchaseOrdersRouter);
app.use("/api/reports", requireAuth, reportsRouter);
app.use("/api/notifications", requireAuth, notificationsRouter);
app.use("/api/work-orders/:workOrderId/quotes", requireAuth, quotesRouter);
app.use("/api/compliance", requireAuth, complianceRouter);
app.use("/api/users", requireAuth, usersRouter);
app.use("/api/config", requireAuth, configRouter);
app.use("/api/meter-readings", requireAuth, meterReadingsRouter);
app.use("/api/invoices", requireAuth, invoicesRouter);
app.use("/api/webhooks", requireAuth, webhooksRouter);
app.use("/api/integrations", requireAuth, integrationsRouter);
app.use("/api/sync", requireAuth, syncRouter);
app.use("/api/triage", requireAuth, triageRouter);
app.use("/api/audit-log", requireAuth, auditLogRouter);
app.use("/api/budgets", requireAuth, budgetsRouter);
app.use("/api", requireAuth, documentsRouter);

app.use(notFound);
app.use(errorHandler);

const PORT = process.env.PORT || 4000;
app.listen(PORT, () => {
  console.log(`API listening on port ${PORT}`);
  startScheduler();
  startWebhookWorker();
});
