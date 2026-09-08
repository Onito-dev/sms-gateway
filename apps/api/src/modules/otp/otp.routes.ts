import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { AppError, ERROR_CODES } from "../../common/errors.js";
import { parseBody, zodJsonSchema } from "../../common/route-helpers.js";
import type { ApplicationService } from "../applications/application.service.js";
import { createApplicationAuthenticator } from "../applications/application.auth.js";
import type { OtpService } from "./otp.service.js";

const requestBody = z.object({
  phone: z.string().min(6).max(32),
  purpose: z.string().trim().min(1).max(64).regex(/^[a-zA-Z0-9_-]+$/),
});

const verifyBody = z.object({
  request_id: z.string().uuid(),
  phone: z.string().min(6).max(32),
  code: z.string().regex(/^\d{4,12}$/),
});

const requestResponse = {
  type: "object",
  required: ["request_id", "expires_in", "resend_after"],
  properties: {
    request_id: { type: "string", format: "uuid" },
    expires_in: { type: "integer", example: 120 },
    resend_after: { type: "integer", example: 60 },
    replayed: { type: "boolean" },
  },
};

export function registerOtpRoutes(
  app: FastifyInstance,
  deps: { otpService: OtpService; applicationService: ApplicationService },
): void {
  const authenticate = createApplicationAuthenticator(deps.applicationService);

  app.post("/api/v1/otp/request", {
    preHandler: authenticate,
    schema: {
      tags: ["OTP"],
      summary: "Generate and send an OTP",
      security: [{ applicationApiKey: [] }],
      headers: {
        type: "object",
        properties: { "idempotency-key": { type: "string", maxLength: 200 } },
      },
      body: zodJsonSchema(requestBody),
      response: { 200: requestResponse },
    },
  }, async (request, reply) => {
    const body = parseBody(requestBody, request.body);
    const idempotencyHeader = request.headers["idempotency-key"];
    const idempotencyKey = Array.isArray(idempotencyHeader) ? idempotencyHeader[0] : idempotencyHeader;
    if (idempotencyKey && (idempotencyKey.length < 1 || idempotencyKey.length > 200)) {
      throw AppError.validation("Idempotency-Key must be between 1 and 200 characters");
    }
    if (!request.application) throw AppError.unauthorized();
    const result = await deps.otpService.requestOtp(request.application, body, {
      ip: request.ip,
      ...(idempotencyKey ? { idempotencyKey } : {}),
    });
    return reply.code(200).send(result);
  });

  app.post("/api/v1/otp/verify", {
    preHandler: authenticate,
    schema: {
      tags: ["OTP"],
      summary: "Verify an OTP",
      security: [{ applicationApiKey: [] }],
      body: zodJsonSchema(verifyBody),
      response: {
        200: {
          type: "object",
          required: ["verified"],
          properties: {
            verified: { type: "boolean" },
            error: { type: "string" },
          },
        },
      },
    },
  }, async (request, reply) => {
    const body = parseBody(verifyBody, request.body);
    if (!request.application) throw AppError.unauthorized();
    try {
      return reply.code(200).send(await deps.otpService.verifyOtp(request.application, {
        requestId: body.request_id,
        phone: body.phone,
        code: body.code,
      }));
    } catch (error) {
      if (
        error instanceof AppError &&
        (error.code === ERROR_CODES.OTP_INVALID || error.code === ERROR_CODES.OTP_EXPIRED || error.code === ERROR_CODES.OTP_MAX_ATTEMPTS)
      ) {
        return reply.code(200).send({ verified: false, error: error.code });
      }
      throw error;
    }
  });

  app.get("/api/v1/otp/requests/:requestId", {
    preHandler: authenticate,
    schema: {
      tags: ["OTP"],
      summary: "Get an OTP request status",
      security: [{ applicationApiKey: [] }],
      params: {
        type: "object",
        required: ["requestId"],
        properties: { requestId: { type: "string", format: "uuid" } },
      },
    },
  }, async (request, reply) => {
    const params = request.params as { requestId?: string };
    if (!params.requestId || !z.string().uuid().safeParse(params.requestId).success) {
      throw AppError.validation("requestId must be a UUID");
    }
    if (!request.application) throw AppError.unauthorized();
    return reply.code(200).send(await deps.otpService.getStatus(request.application, params.requestId));
  });
}
