const CONTROL_PATTERN = /[\u0000-\u001f\u007f]+/g;
const UNSAFE_DEVICE_WHITESPACE_OR_CONTROL = /[\s\u0000-\u001f\u007f]/u;

export function validateDevice(
  device: string,
  allowedHosts: ReadonlySet<string>,
  maxDeviceLength = 128,
): string {
  const target = device;

  if (target.length === 0) throw new Error("device is required");
  if (target.length > maxDeviceLength) throw new Error("device is too long");
  if (target.startsWith("-")) throw new Error("device must not start with '-'");
  if (UNSAFE_DEVICE_WHITESPACE_OR_CONTROL.test(target))
    throw new Error("device must not contain whitespace or control characters");
  if (!allowedHosts.has(target))
    throw new Error("device is not listed in SSH config");

  return target;
}

export function sanitizeSuggestedCommand(
  command?: string,
  maxLength = 4000,
): string | undefined {
  if (command === undefined) return undefined;

  const sanitized = command
    .slice(0, maxLength)
    .replace(CONTROL_PATTERN, " ")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized.length > 0 ? sanitized : undefined;
}
