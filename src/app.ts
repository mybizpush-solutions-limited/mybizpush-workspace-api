import express, { Router } from "express";
import cors from "cors";
import helmet from "helmet";
import cookieParser from "cookie-parser";
import morgan from "morgan";
import { env, isProd } from "./config/env";
import { errorHandler, notFoundHandler } from "./middleware/error";
import { authRouter } from "./modules/auth/auth.routes";
import { usersRouter } from "./modules/users/users.routes";
import { departmentsRouter } from "./modules/departments/departments.routes";
import { projectsRouter } from "./modules/projects/projects.routes";
import { tasksRouter, issuesRouter } from "./modules/workitems/workitems.routes";
import { commentsRouter } from "./modules/comments/comments.routes";
import { activityRouter } from "./modules/activity/activity.routes";
import { notificationsRouter } from "./modules/notifications/notifications.routes";
import { preferencesRouter } from "./modules/preferences/preferences.routes";
import { meetingsRouter } from "./modules/meetings/meetings.routes";
import { labelsRouter } from "./modules/labels/labels.routes";
import { rolesRouter } from "./modules/roles/roles.routes";
import { meRouter } from "./modules/me/me.routes";
import { attachmentsRouter } from "./modules/attachments/attachments.routes";
import { aiRouter } from "./modules/ai/ai.routes";
import { digestsRouter } from "./modules/digests/digests.routes";
import { googleRouter } from "./modules/google/google.routes";
import { githubRouter } from "./modules/github/github.routes";
import { healthRouter } from "./modules/health/health.routes";

// All versioned business endpoints live under this prefix.
export const API_PREFIX = "/api/v1";

export function createApp() {
  const app = express();

  app.use(helmet());
  app.use(
    cors({
      origin: env.CORS_ORIGINS,
      credentials: true, // allow the refresh-token cookie
    }),
  );
  // Capture the raw body so the GitHub webhook can verify its HMAC signature.
  app.use(
    express.json({
      verify: (req, _res, buf) => {
        (req as unknown as { rawBody?: Buffer }).rawBody = buf;
      },
    }),
  );
  app.use(cookieParser());
  if (!isProd) app.use(morgan("dev"));

  // Infra/liveness endpoint stays unversioned.
  app.use("/api/health", healthRouter);

  // Versioned API (v1)
  const v1 = Router();
  v1.use("/auth", authRouter);
  v1.use("/users", usersRouter);
  v1.use("/me", meRouter);
  v1.use("/departments", departmentsRouter);
  v1.use("/projects", projectsRouter);
  v1.use("/tasks", tasksRouter);
  v1.use("/issues", issuesRouter);
  v1.use("/comments", commentsRouter);
  v1.use("/activity", activityRouter);
  v1.use("/notifications", notificationsRouter);
  v1.use("/preferences", preferencesRouter);
  v1.use("/meetings", meetingsRouter);
  v1.use("/labels", labelsRouter);
  v1.use("/roles", rolesRouter);
  v1.use("/attachments", attachmentsRouter);
  v1.use("/ai", aiRouter);
  v1.use("/digests", digestsRouter);
  v1.use("/google", googleRouter);
  v1.use("/github", githubRouter);
  app.use(API_PREFIX, v1);

  // Fallbacks
  app.use(notFoundHandler);
  app.use(errorHandler);

  return app;
}
