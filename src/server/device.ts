const DEVICE_PATTERN = /^[A-Za-z0-9._@%:+-]+$/;
const CONTROL_PATTERN = /[\u0000-\u001f\u007f]+/g;

export function validateDevice(
  device: string,
  allowedHosts: ReadonlySet<string>,
  maxDeviceLength = 128,
): string {
  const target = device.trim();

  if (target.length === 0) throw new Error("device is required");
  if (target.length > maxDeviceLength) throw new Error("device is too long");
  if (target.startsWith("-")) throw new Error("device must not start with '-'");
  if (!DEVICE_PATTERN.test(target))
    throw new Error("device contains unsupported characters");
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
