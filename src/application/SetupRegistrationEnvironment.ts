import type { DoctorProviderInspection } from "./Doctor.js";

/** Select exact non-secret settings published by available providers. */
export const providerRegistrationEnvironment = (
  inspections: readonly DoctorProviderInspection[],
): Readonly<Record<string, string>> =>
  Object.fromEntries(
    inspections
      .filter(({ available }) => available)
      .flatMap(({ registrationEnvironment }) =>
        Object.entries(registrationEnvironment),
      )
      .sort(([left], [right]) => left.localeCompare(right)),
  );
