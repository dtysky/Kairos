export function toExecutableInputPath(
  filePath: string,
  executablePath?: string,
): string {
  const tool = executablePath?.trim();
  if (!tool) return filePath;
  if (process.platform === 'win32') return filePath;
  if (!tool.toLowerCase().endsWith('.exe')) return filePath;

  return convertWslPathToWindows(filePath);
}

export function toLocalWindowsServicePath(
  filePath: string,
  serviceUrl?: string,
): string {
  if (process.platform === 'win32') return filePath;
  if (!looksLikeLocalhostUrl(serviceUrl)) return filePath;
  return convertWslPathToWindows(filePath);
}

function convertWslPathToWindows(filePath: string): string {
  const match = filePath.match(/^\/mnt\/([a-zA-Z])\/(.*)$/);
  if (!match) return filePath;

  const drive = match[1].toUpperCase();
  const rest = match[2].replace(/\//g, '\\');
  return `${drive}:\\${rest}`;
}

function looksLikeLocalhostUrl(serviceUrl?: string): boolean {
  if (!serviceUrl) return true;
  try {
    const url = new URL(serviceUrl);
    return ['127.0.0.1', 'localhost', '::1'].includes(url.hostname);
  } catch {
    return false;
  }
}
