const SSH_IPC_ERROR_PREFIX =
  /^Error invoking remote method 'kmux:ssh-connections:[^']+': (?:(?:[A-Za-z_$][\w$]*)?Error: )?/u;

export function describeSshConnectionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(SSH_IPC_ERROR_PREFIX, "");
}
