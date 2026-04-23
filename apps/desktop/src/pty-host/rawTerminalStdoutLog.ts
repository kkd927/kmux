import { PTY_STDOUT_LOGS_ENV } from "../shared/diagnostics";

export type RawTerminalStdoutEvent = {
  kind: "osc.7" | "bell" | "osc.9" | "osc.99" | "osc.777" | "notification";
  surfaceId: string;
  sessionId: string;
  payloadLength?: number;
  parsed?: boolean;
  protocol?: 9 | 99 | 777;
  hasTitle?: boolean;
  hasMessage?: boolean;
  hasCwd?: boolean;
  resolvedCwd?: boolean;
};

type WriteLine = (line: string) => void;

export function createRawTerminalEventStdoutLogger(
  env: Partial<Record<string, string | undefined>> = process.env,
  writeLine: WriteLine = (line) => process.stdout.write(`${line}\n`)
): (event: RawTerminalStdoutEvent) => void {
  const enabled = env[PTY_STDOUT_LOGS_ENV] === "1";
  return (event) => {
    if (!enabled) {
      return;
    }
    writeLine(
      JSON.stringify({
        scope: "pty-host.raw-terminal-event",
        ...event
      })
    );
  };
}
