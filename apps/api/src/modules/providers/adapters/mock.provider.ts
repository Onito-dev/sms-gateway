import type {
  AdapterContext,
  AdapterFactory,
  ProviderParamField,
  SendSmsParams,
  SendSmsResult,
  SmsProviderAdapter,
} from "../provider.interface.js";

/**
 * Mock provider — for local development and integration tests.
 * Config:
 *   { "failNext": 2 }   → the next 2 sends fail (retryable), for failover testing
 *   { "failRate": 0.3 } → ~30% of sends fail randomly
 */
export class MockProvider implements SmsProviderAdapter {
  readonly type = "MOCK";
  private failNext: number;
  private failRate: number;
  private sent = 0;

  constructor(private readonly ctx: AdapterContext) {
    this.failNext = typeof ctx.config.failNext === "number" ? ctx.config.failNext : 0;
    this.failRate = typeof ctx.config.failRate === "number" ? ctx.config.failRate : 0;
  }

  async sendSms(params: SendSmsParams): Promise<SendSmsResult> {
    if (this.failNext > 0) {
      this.failNext -= 1;
      return { ok: false, error: "mock: simulated failure", retryable: true, kind: "CONNECTION" };
    }
    if (this.failRate > 0 && Math.random() < this.failRate) {
      return { ok: false, error: "mock: random failure", retryable: true, kind: "CONNECTION" };
    }
    this.sent += 1;
    return {
      ok: true,
      providerMessageId: `mock-${this.ctx.providerId}-${this.sent}-${Date.now()}`,
    };
  }

  async healthCheck() {
    return { status: "HEALTHY" as const, detail: "mock provider" };
  }
}

export const MOCK_PARAMS: ProviderParamField[] = [
  {
    name: "failNext",
    group: "config",
    kind: "number",
    label: "Fail next N sends",
    integer: true,
    min: 0,
    max: 1000,
    default: 0,
    description: "Testing helper: simulate transient failures for failover checks.",
  },
  {
    name: "failRate",
    group: "config",
    kind: "number",
    label: "Random failure rate",
    min: 0,
    max: 1,
    default: 0,
    description: "Probability (0–1) that any given send fails.",
  },
];

export const mockAdapterFactory: AdapterFactory = (ctx) => new MockProvider(ctx);
