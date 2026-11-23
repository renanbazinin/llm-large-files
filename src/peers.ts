/**
 * Loads an optional dependency. When it is not installed, the error says so in `missing`, words for
 * a user ("Reading PDF files needs the optional dependency \"unpdf\"."). When it is installed but
 * fails to load (a version this Node cannot run, a broken install), the error says that, with the
 * reason, and keeps the failure as its cause: it was reported as missing before 0.8.0.
 */
export async function importPeer<T>(name: string, load: () => Promise<T>, missing: string): Promise<T> {
  try {
    return await load();
  } catch (error) {
    if (notFound(error, name)) throw new Error(missing, { cause: error });
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`The optional dependency "${name}" is installed but could not be loaded (${reason.split("\n")[0]}). Reinstall it, or install a version this Node can run.`, { cause: error });
  }
}

/**
 * Whether an import failed because the package is not installed: Node's code, or the words of Node
 * and of bundlers that give none, about this package and not one it needs. A loader that wraps the
 * failure (a test runner's mock) keeps it as a cause, looked at too.
 */
function notFound(error: unknown, name: string): boolean {
  for (let current = error, depth = 0; current && depth < 4; current = (current as { cause?: unknown }).cause, depth++) {
    const { code, message } = current as { code?: unknown; message?: unknown };
    if (typeof message === "string" && message.includes(name)
      && (code === "ERR_MODULE_NOT_FOUND" || code === "MODULE_NOT_FOUND" || /Cannot find (?:package|module)/.test(message))) return true;
  }
  return false;
}
