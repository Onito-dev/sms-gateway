import type { FastifyReply, FastifyRequest } from "fastify";
import { AppError } from "../../common/errors.js";
import type { ApplicationService } from "./application.service.js";

export function createApplicationAuthenticator(applicationService: ApplicationService) {
  return async function authenticateApplication(
    request: FastifyRequest,
    _reply: FastifyReply,
  ): Promise<void> {
    const apiKeyHeader = request.headers["x-api-key"];
    const apiSecretHeader = request.headers["x-api-secret"];
    const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
    const apiSecret = Array.isArray(apiSecretHeader) ? apiSecretHeader[0] : apiSecretHeader;
    if (!apiKey || !apiSecret) throw AppError.unauthorized();

    const application = await applicationService.findForCredentials(apiKey, apiSecret);
    if (!application) throw AppError.unauthorized();
    request.application = application;
  };
}
