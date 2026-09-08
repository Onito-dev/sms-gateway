import { AppError } from "./errors.js";

export interface CountryPhoneConfig {
  iso: string;
  dialCode: string;
  /** Local (national) mobile number format without the leading 0. */
  localMobile: RegExp;
  /** Expected total digits after the dial code. */
  nationalDigits: number;
}

/**
 * Country registry — extend this map to support more countries.
 * Nothing else in the codebase hardcodes a specific country.
 */
export const COUNTRIES: Record<string, CountryPhoneConfig> = {
  IR: { iso: "IR", dialCode: "98", localMobile: /^9\d{9}$/, nationalDigits: 10 },
  TR: { iso: "TR", dialCode: "90", localMobile: /^5\d{9}$/, nationalDigits: 10 },
  AE: { iso: "AE", dialCode: "971", localMobile: /^5\d{8}$/, nationalDigits: 9 },
  DE: { iso: "DE", dialCode: "49", localMobile: /^1[5-7]\d{8,9}$/, nationalDigits: 10 },
  US: { iso: "US", dialCode: "1", localMobile: /^[2-9]\d{9}$/, nationalDigits: 10 },
};

export interface NormalizedPhone {
  /** E.164 representation, e.g. "+989121234567" */
  e164: string;
  /** ISO country code detected from the number */
  countryIso: string;
}

function cleanPhone(input: string): { digits: string; international: boolean } {
  const trimmed = input.trim();
  if (!trimmed) throw AppError.invalidPhone();
  if (!/^[+]?[-\s().\d]+$/.test(trimmed)) throw AppError.invalidPhone();
  const international = trimmed.startsWith("+") || trimmed.replace(/[\s().-]/g, "").startsWith("00");
  const digits = trimmed.replace(/\D/g, "");
  if (!digits || digits.length < 6 || digits.length > 15) throw AppError.invalidPhone();
  return { digits, international };
}

/**
 * Normalize a phone number into E.164.
 * Handles: 09121234567 | +989121234567 | 00989121234567 | 989121234567.
 */
export function normalizePhone(input: string, defaultCountryIso: string): NormalizedPhone {
  const { digits, international } = cleanPhone(input);
  const defaultCountry = COUNTRIES[defaultCountryIso.toUpperCase()];
  if (!defaultCountry) throw AppError.invalidPhone(`Unknown default country: ${defaultCountryIso}`);

  let internationalDigits = digits;
  if (input.trim().replace(/[\s().-]/g, "").startsWith("00")) {
    internationalDigits = digits.slice(2);
  }

  // An explicit international number is validated against known dial codes.
  if (international) {
    for (const country of Object.values(COUNTRIES)) {
      if (
        internationalDigits.startsWith(country.dialCode) &&
        internationalDigits.length === country.dialCode.length + country.nationalDigits
      ) {
        return { e164: `+${internationalDigits}`, countryIso: country.iso };
      }
    }
    // Keep the normalizer extensible for countries added later or not yet in
    // the registry; E.164 permits up to 15 digits. Country is intentionally XX.
    if (internationalDigits.length >= 8 && internationalDigits.length <= 15) {
      return { e164: `+${internationalDigits}`, countryIso: "XX" };
    }
    throw AppError.invalidPhone();
  }

  // National number with a trunk prefix (e.g. 09121234567).
  if (digits.startsWith("0")) {
    const national = digits.slice(1);
    if (!defaultCountry.localMobile.test(national)) throw AppError.invalidPhone();
    return { e164: `+${defaultCountry.dialCode}${national}`, countryIso: defaultCountry.iso };
  }

  // Dial code without a plus (e.g. 989121234567).
  for (const country of Object.values(COUNTRIES)) {
    if (
      digits.startsWith(country.dialCode) &&
      digits.length === country.dialCode.length + country.nationalDigits
    ) {
      return { e164: `+${digits}`, countryIso: country.iso };
    }
  }

  // Bare national mobile number without a trunk prefix.
  if (defaultCountry.localMobile.test(digits)) {
    return { e164: `+${defaultCountry.dialCode}${digits}`, countryIso: defaultCountry.iso };
  }

  throw AppError.invalidPhone();
}
