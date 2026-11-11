/*
  Live suites read DIFFBOT_API_TOKEN at module load and build a DiffbotClient
  before `describe.skipIf` can skip. Treat missing, empty, and whitespace-only
  values as unset:

  - The SDK rejects empty strings (`if (!options.token) throw`), so `''`
    crashes at construction time, before skipIf can run.
  - A whitespace-only token is truthy, so the constructor accepts it and
    `!token` is false — the suite would actually run and make live calls
    with an unusable token. The SDK also does not trim, so this helper
    trims before the client sees the value.
*/

const PLACEHOLDER = "unused-token-suite-skipped";

export function resolveDiffbotLiveToken(envValue: string | undefined): string | undefined {
  if (envValue === undefined) return undefined;
  const trimmed = envValue.trim();
  return trimmed === "" ? undefined : trimmed;
}

export function diffbotLiveClientToken(resolved: string | undefined): string {
  return resolved ?? PLACEHOLDER;
}
