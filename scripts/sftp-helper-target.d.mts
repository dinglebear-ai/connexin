// Types for sftp-helper-target.mjs. The implementation stays plain JavaScript
// because it runs as npm's postinstall hook on machines that have no tsx.

export interface HelperTarget {
  /** Release asset filename; must match the release workflow's build matrix. */
  asset: string;
  /** Binary name inside the archive (.exe on Windows). */
  binary: string;
}

export function supportedTargets(): string[];
export function targetFor(platform?: string, arch?: string): HelperTarget;
export function packageRoot(): string;
export function packageVersion(): string;
export function releaseVersion(
  env?: Record<string, string | undefined>,
): string;
export function releaseBaseUrl(
  env?: Record<string, string | undefined>,
): string;
export function downloadUrl(
  target: Pick<HelperTarget, "asset">,
  env?: Record<string, string | undefined>,
): string;
export function helperDestination(target: HelperTarget, root?: string): string;
export function shouldSkipDownload(
  env?: Record<string, string | undefined>,
): boolean;
export function isSourceCheckout(
  root?: string,
  exists?: (path: string) => boolean,
): boolean;
