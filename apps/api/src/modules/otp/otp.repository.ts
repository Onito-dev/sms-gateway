import type { PrismaClient } from "@prisma/client";
import type { OtpRepository } from "./otp.types.js";

export class PrismaOtpRepository implements OtpRepository {
  constructor(private readonly prisma: PrismaClient) {}

  async create(data: {
    id: string;
    applicationId: string;
    phone: string;
    purpose: string;
    expiresAt: Date;
    ip?: string;
  }): Promise<{ id: string }> {
    const row = await this.prisma.otpRequest.create({
      data: {
        id: data.id,
        applicationId: data.applicationId,
        phone: data.phone,
        purpose: data.purpose,
        expiresAt: data.expiresAt,
        ip: data.ip ?? null,
      },
      select: { id: true },
    });
    return row;
  }

  async markSent(id: string, providerId: string): Promise<void> {
    await this.prisma.otpRequest.update({
      where: { id },
      data: { status: "SENT", providerId },
    });
  }

  async markVerified(id: string): Promise<void> {
    await this.prisma.otpRequest.update({
      where: { id },
      data: { status: "VERIFIED", verifiedAt: new Date() },
    });
  }

  async markFailed(id: string, _error: string): Promise<void> {
    await this.prisma.otpRequest.update({
      where: { id },
      data: { status: "FAILED" },
    });
  }

  async markExpired(id: string): Promise<void> {
    await this.prisma.otpRequest.update({
      where: { id },
      data: { status: "EXPIRED" },
    });
  }

  async setAttempts(id: string, attempts: number): Promise<void> {
    await this.prisma.otpRequest.update({
      where: { id },
      data: { attempts },
    });
  }

  async findById(id: string) {
    return this.prisma.otpRequest.findUnique({
      where: { id },
      select: {
        id: true,
        applicationId: true,
        phone: true,
        status: true,
        createdAt: true,
        verifiedAt: true,
      },
    });
  }
}
