/**
 * Validation policy for `PUT /api/settings` (#706).
 *
 * The body replaces the stored settings whole — DynamoDB rewrites the entire
 * `#SETTINGS` map — so a field the client omits is not "unchanged", it is
 * erased. A required field missing from the body is therefore rejected, not
 * defaulted. Returns the 400 error message, or null when the body is valid.
 */
export function settingsValidationError(settings: unknown): string | null {
  if (!settings || typeof settings !== "object") return "Missing settings";
  const s = settings as Record<string, unknown>;

  if (!["Low", "Med", "High"].includes(s.severityThreshold as string)) {
    return "Invalid severityThreshold";
  }
  if (typeof s.maxComments !== "number" || s.maxComments < 1 || s.maxComments > 50) {
    return "maxComments must be 1-50";
  }
  if (typeof s.customInstructions !== "string" || s.customInstructions.length > 1000) {
    return "customInstructions too long";
  }
  // #706 — required boolean: an omitted `approve` must not silently reset an
  // installation's choice.
  if (typeof s.approve !== "boolean") {
    return "approve must be a boolean";
  }
  return null;
}
