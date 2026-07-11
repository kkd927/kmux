export interface TerminalQueryReplyTarget {
  isCurrent(): boolean;
  write(reply: string): void;
  onWriteError?(error: unknown, replyBytes: number): void;
}

/** Forwards headless xterm's parser-generated replies directly to the PTY. */
export function createTerminalQueryReplyHandler(
  target: TerminalQueryReplyTarget
): (reply: string) => void {
  return (reply) => {
    if (!target.isCurrent()) {
      return;
    }
    try {
      target.write(reply);
    } catch (error) {
      target.onWriteError?.(error, Buffer.byteLength(reply, "utf8"));
    }
  };
}
