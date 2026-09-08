import type { AppContext } from "../modules/otp/otp.types.js";

declare module "fastify" {
  interface FastifyRequest {
    application?: AppContext;
    correlationId: string;
  }
}

export {};
