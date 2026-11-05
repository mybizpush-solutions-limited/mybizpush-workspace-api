import { Router } from "express";
import { z } from "zod";
import { Op } from "sequelize";
import { asyncHandler, badRequest } from "../../lib/errors";
import { requireAuth } from "../../middleware/auth";
import { validateBody } from "../../middleware/validate";
import { isExpoPushToken } from "../../lib/push";
import { DEVICE_PLATFORMS, DeviceToken } from "../../models";

// Push token registration for the mobile app (API-CHANGES A003). The app
// registers after sign-in and whenever Expo rotates the token, and removes it
// on sign-out so a shared phone stops receiving the previous user's pushes.
export const devicesRouter = Router();
devicesRouter.use(requireAuth);

const registerSchema = z.object({
  token: z.string().trim().min(1).max(255),
  platform: z.enum(DEVICE_PLATFORMS),
  deviceName: z.string().trim().max(120).optional(),
  appVersion: z.string().trim().max(40).optional(),
});

const unregisterSchema = z.object({ token: z.string().trim().min(1).max(255) });

devicesRouter.post(
  "/",
  validateBody(registerSchema),
  asyncHandler(async (req, res) => {
    const body = req.body as z.infer<typeof registerSchema>;
    if (!isExpoPushToken(body.token)) throw badRequest("Not an Expo push token");
    // A token identifies one app install. If another account used this phone
    // before, the token moves to the current user.
    const [device] = await DeviceToken.upsert(
      {
        token: body.token,
        userId: req.auth!.sub,
        platform: body.platform,
        deviceName: body.deviceName ?? null,
        appVersion: body.appVersion ?? null,
        lastSeenAt: new Date(),
        disabledAt: null,
      },
      { conflictFields: ["token"] },
    );
    res.status(201).json({ device: { id: device.id, platform: device.platform, deviceName: device.deviceName } });
  }),
);

devicesRouter.post(
  "/unregister",
  validateBody(unregisterSchema),
  asyncHandler(async (req, res) => {
    await DeviceToken.destroy({ where: { token: req.body.token, userId: req.auth!.sub } });
    res.status(204).end();
  }),
);

devicesRouter.get(
  "/",
  asyncHandler(async (req, res) => {
    const devices = await DeviceToken.findAll({
      where: { userId: req.auth!.sub, disabledAt: { [Op.is]: null } },
      attributes: ["id", "platform", "deviceName", "appVersion", "lastSeenAt"],
      order: [["lastSeenAt", "DESC"]],
    });
    res.json({ devices });
  }),
);
