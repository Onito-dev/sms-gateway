# راهنمای فارسی توسعه‌دهنده

## این برنامه چیست؟

**Central OTP & SMS Gateway** یک سرویس مرکزی برای تولید، ارسال و اعتبارسنجی کد یک‌بارمصرف است. چند پروژه می‌توانند با Credential جداگانه از آن استفاده کنند. این سرویس حساب کاربری، رمز عبور، Session، JWT یا منطق Login و Register را مدیریت نمی‌کند؛ پروژه مصرف‌کننده فقط نتیجه Verify را دریافت می‌کند.

## اجزای اصلی

- **Fastify + TypeScript**: API اصلی در `apps/api`.
- **PostgreSQL + Prisma**: نگهداری Applicationها، Providerها، متادیتای درخواست OTP، Usage، قیمت‌ها، Quota و Audit Log.
- **Redis**: نگهداری موقت Hash کد OTP، شمارنده تلاش‌ها، Rate Limit، Quota مصرف‌شده، Idempotency و Circuit Breaker.
- **React + Vite**: پنل مدیریت در `apps/admin`.
- **otp-client**: کلاینت قابل استفاده مجدد در `packages/otp-client`.

## جریان درخواست OTP

1. پروژه مصرف‌کننده با هدرهای `X-API-Key` و `X-API-Secret` درخواست می‌فرستد.
2. شماره تلفن به E.164 تبدیل می‌شود؛ برای ایران ورودی‌هایی مثل `0912...`، `+98912...` و `00989...` پشتیبانی می‌شوند.
3. کشور مجاز، محدودیت IP/Application/Phone، Cooldown ارسال مجدد و Quota بررسی می‌شوند.
4. OTP با CSPRNG ساخته می‌شود و فقط HMAC آن در Redis با TTL ذخیره می‌شود.
5. یک ردیف متادیتا در PostgreSQL ساخته می‌شود؛ کد واقعی هرگز در Database ذخیره نمی‌شود.
6. `ProviderManager` بر اساس Strategy برنامه (`AUTO`، `PRIORITY`، `CHEAPEST` یا `WEIGHTED`) Provider را انتخاب می‌کند.
7. در خطاهای قابل Retry، Provider بعدی امتحان می‌شود. خطای نامشخص به‌صورت خودکار Retry نمی‌شود تا احتمال SMS تکراری کم شود.
8. Usage با قیمت همان لحظه ثبت می‌شود و پاسخ فقط شامل `request_id`، زمان انقضا و زمان مجاز ارسال بعدی است.

## جریان Verify

در `POST /api/v1/otp/verify`، Application و شماره تلفن بررسی می‌شوند. Hash کد ورودی با Hash Redis به‌صورت constant-time مقایسه می‌شود. در Verify موفق، کلید Redis حذف و درخواست `VERIFIED` می‌شود. کد اشتباه تعداد تلاش را زیاد می‌کند؛ پس از رسیدن به حداکثر تلاش، OTP مصرف و غیرقابل استفاده می‌شود.

## Endpointهای مهم

### Application API

```http
POST /api/v1/otp/request
POST /api/v1/otp/verify
GET  /api/v1/otp/requests/:requestId
```

هدرهای لازم:

```http
X-API-Key: <application-api-key>
X-API-Secret: <application-api-secret>
```

برای جلوگیری از ارسال تکراری در خطای شبکه:

```http
Idempotency-Key: checkout-123-attempt-1
```

### Admin API و ابزارها

- Swagger: `/docs`
- Health: `/health`, `/health/live`, `/health/ready`
- Metrics: `/metrics`
- Dashboard: `/api/v1/admin/dashboard`
- مدیریت Application: `/api/v1/admin/applications`
- مدیریت Provider: `/api/v1/admin/providers`
- گزارش Usage: `/api/v1/admin/reports/summary`

Admin API با `Authorization: Bearer <ADMIN_TOKEN>` محافظت می‌شود.

## راه‌اندازی محلی

1. فایل `.env.example` را به `.env` کپی کنید.
2. `MASTER_KEY` حداقل ۳۲ کاراکتر تصادفی و `ADMIN_TOKEN` یک مقدار طولانی و امن باشد.
3. PostgreSQL و Redis را اجرا کنید.
4. دستورات زیر را اجرا کنید:

```bash
npm install
npm run db:generate --workspace apps/api
npm run db:migrate
npm run db:seed
npm run dev:api
npm run dev:admin
```

برای تست نوع‌ها و تست‌ها:

```bash
npm run typecheck
npm test
```

Seed یک Provider آزمایشی `MOCK` و یک Application نمونه ایجاد می‌کند و Secret نمونه را فقط در خروجی همان اجرای Seed نشان می‌دهد.

## افزودن Provider جدید

1. در `apps/api/src/modules/providers/adapters/` یک Adapter بسازید.
2. Adapter باید قرارداد `SmsProviderAdapter` را پیاده کند و نتیجه خطا را با `retryable` و `kind` درست برگرداند.
3. آن را در `provider.registry.ts` ثبت کنید.
4. Provider را از Admin API بسازید و Credential را به‌صورت ورودی امن تنظیم کنید.

منطق OTP نباید مستقیماً Adapter را صدا بزند؛ فقط `ProviderManager` باید مسئول انتخاب و ارسال باشد.

### Provider آماده sms.ir (type: `SMSIR`)

ارسال از نوع VERIFY در `POST https://api.sms.ir/v1/send/verify` با هدر `x-api-key` انجام می‌شود. قبل از استفاده، قالب پیامک را در پنل sms.ir تعریف کنید و شناسه قالب (TemplateId) را یادداشت کنید.

هنگام ساخت Provider از پنل مدیریت:

- **Credentials** (رمزنگاری‌شده ذخیره می‌شود): `{ "apiKey": "کلید API پنل sms.ir" }`
- **Config**:
  - `templateId` (اجباری): شناسه قالب تأییدشده، مثل `123456`
  - `codeParameter` (اختیاری): نام پارامتر کد در قالب؛ پیش‌فرض `Code`
  - `mobileWithCountryCode` (اختیاری): اگر `true` باشد شماره به‌صورت `989121234567` ارسال می‌شود؛ پیش‌فرض فرمت محلی `9121234567` است.

مثال ساخت با Admin API:

```bash
curl -X POST http://localhost:3000/api/v1/admin/providers \
  -H "Authorization: Bearer $ADMIN_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "SMS.ir OTP",
    "type": "SMSIR",
    "priority": 1,
    "costPerSms": 0.0015,
    "supportedCountries": ["IR"],
    "credentials": { "apiKey": "<x-api-key از پنل sms.ir>" },
    "config": { "templateId": 123456, "codeParameter": "Code" }
  }'
```

نکات: موفقیت فقط زمانی است که HTTP پاسخ `2xx` و `status === 1` برگرداند؛ در این حالت `data.messageId` به‌عنوان شناسه پیامک ذخیره می‌شود. خطای `401/403` از نوع `AUTH` است و Failover نمی‌شود؛ Timeout و خطای اتصال قابل Retry هستند و به Provider بعدی منتقل می‌شوند. کد OTP از متن پیام رندرشده استخراج می‌شود، پس حتماً `OTP_MESSAGE_TEMPLATE` باید شامل `{{code}}` باشد.

## نکات امنیتی مهم

- OTP، API Secret، Admin Token و Credential Provider را Log نکنید.
- Secretهای Application فقط Hash می‌شوند؛ Secret Provider با AES-256-GCM رمزنگاری می‌شود.
- در محیط واقعی حتماً HTTPS، Secret Manager یا حداقل مدیریت امن Environment، محدودسازی دسترسی Admin و Backup رمزگذاری‌شده داشته باشید.
- قبل از ارسال واقعی، Providerها را با Mock تست کنید.
- Queryهای وابسته به Application باید همیشه `applicationId` داشته باشند تا Tenantها از هم جدا بمانند.
- حذف یا Rotate کردن Credential قبلی را در کلاینت‌های مصرف‌کننده هماهنگ کنید، چون Credential قدیمی فوراً نامعتبر می‌شود.

## ساختار داده

- `Application`: Tenant و تنظیمات آن.
- `ApplicationCredential`: API Key و Hash Secret.
- `SmsProvider`: تنظیمات Adapter، اولویت، هزینه و وضعیت سلامت.
- `ProviderPrice`: تاریخچه قیمت؛ Usage قیمت را Snapshot می‌کند.
- `OtpRequest`: فقط متادیتای OTP.
- `UsageEvent`: هر تلاش مصرف/هزینه با Status.
- `Quota` و `RateLimitConfig`: سقف مصرف و محدودیت‌ها.
- `AuditLog`: عملیات مدیریتی بدون اطلاعات حساس.

## مدیریت API Keyها و قالب Providerها از پنل

از پنل مدیریت می‌توانید Credentialها و تنظیمات قالب را بدون دسترسی به سرور ویرایش کنید:

**پنل Applications — بخش API keys:**

- دکمه **Keys** هر برنامه لیست کلیدهای API آن را باز می‌کند (کلید، وضعیت، آخرین استفاده).
- **Add another API key**: یک کلید جدید می‌سازد بدون باطل کردن کلیدهای قبلی — مناسب مهاجرت تدریجی چند سرویس مصرف‌کننده.
- **Revoke**: کلید انتخابی فوراً باطل می‌شود؛ درخواست‌های با آن کلید بلافاصله رد می‌شوند.
- **Rotate all credentials**: همه کلیدهای فعال باطل و یک کلید جدید ساخته می‌شود.

Secret فقط یک‌بار و همان لحظه در کادر «SHOW ONCE» نمایش داده می‌شود؛ در دیتابیس فقط Hash آن نگهداری می‌شود.

**پنل Providers — فرم ساختاری پارامترها:**

دیگر JSON دستی لازم نیست. هر Adapter پارامترهای خودش را به‌صورت Schema اعلام می‌کند و پنل به‌طور خودکار فرم همان نوع Provider را نمایش می‌دهد:

- **SMSIR**: فیلدهای API Key، Template ID، نام پارامتر کد (مثلاً `OTP`)، ارسال با کد کشور و Base URL.
- **KAVENEGAR**: API Key و نام قالب Verify.
- **GENERIC_HTTP**: URL، متد، Sender و کلیدهای اختیاری.

قواعد اعمال‌شده در سمت سرور هم هنگام ذخیره اجرا می‌شوند:

- فیلدهای الزامی (مثل `apiKey` و `templateId`) خالی قبول نمی‌شوند.
- کلید ناشناس یا غلط املایی رد می‌شود با پیام دقیق (`Unknown config parameter ...`) — یعنی خطای تایپی دیگر در زمان ارسال کشف نمی‌شود، همان لحظه در ذخیره.
- مقادیر از نظر نوع (عدد صحیح، بازه، الگو) اعتبارسنجی می‌شوند.
- فیلدهای Secret فقط نوشتنی هستند (هرگز برگشت داده نمی‌شوند) و در زمان ویرایش اگر خالی بمانند کلید فعلی حفظ می‌شود.
- ویرایش بخشی از Config باقی فیلدها را حفظ می‌کند (Merge) — مثلاً تغییر `codeParameter` پاک‌کردن `templateId` ممکن نیست.
- دکمه **Test** دیگر خطا را مخفی نمی‌کند؛ متن واقعی خطای Provider همراه نوع خطا (AUTH/REJECTED/TIMEOUT/…) داخل مودال نمایش داده می‌شود.

هر تغییر Credential یا Config در Audit Log ثبت می‌شود و کش ProviderManager بلافاصله باطل می‌شود، پس تغییرات بدون Restart اعمال می‌شوند.

## کلاینت TypeScript

```ts
import { OtpClient } from "@gateway/otp-client";

const client = new OtpClient({
  baseUrl: "https://gateway.example.com",
  apiKey: process.env.OTP_API_KEY!,
  apiSecret: process.env.OTP_API_SECRET!,
});

const request = await client.request({
  phone: "+989121234567",
  purpose: "login",
  idempotencyKey: "login-request-unique-id",
});

const result = await client.verify({
  requestId: request.request_id,
  phone: "+989121234567",
  code: codeReceivedFromUser,
});

if (result.verified) {
  // Login یا ساخت Session در پروژه خودتان انجام می‌شود.
}
```
