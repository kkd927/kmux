import type { StartedTestContainer } from "testcontainers";

const SSHD_LOG_PATH = "/var/log/kmux-ssh/sshd.log";

export interface SshConnectionAuditSnapshot {
  acceptedTcpConnections: number;
  authenticationAttempts: number;
  acceptedAuthentications: number;
  closedConnections: number;
  liveTcpConnections: number;
}

export interface SshConnectionAuditDelta extends SshConnectionAuditSnapshot {}

export class SshConnectionAudit {
  constructor(private readonly target: StartedTestContainer) {}

  async snapshot(): Promise<SshConnectionAuditSnapshot> {
    const logResult = await this.target.exec(["cat", SSHD_LOG_PATH]);
    if (logResult.exitCode !== 0) {
      throw new Error(`unable to read sshd audit log: ${logResult.stderr}`);
    }
    const lines = logResult.stdout.split(/\r?\n/u);
    const liveResult = await this.target.exec([
      "sh",
      "-c",
      "ss -Htn state established '( sport = :22 )' | wc -l"
    ]);
    if (liveResult.exitCode !== 0) {
      throw new Error(
        `unable to inspect sshd connections: ${liveResult.stderr}`
      );
    }
    return {
      acceptedTcpConnections: count(lines, /Connection from /u),
      authenticationAttempts: count(
        lines,
        /(?:Accepted|Failed) (?:publickey|password|keyboard-interactive) for /u
      ),
      acceptedAuthentications: count(
        lines,
        /Accepted (?:publickey|password|keyboard-interactive) for /u
      ),
      closedConnections: count(
        lines,
        /(?:Connection closed|Disconnected from) /u
      ),
      liveTcpConnections: Number(liveResult.stdout.trim())
    };
  }

  static delta(
    before: SshConnectionAuditSnapshot,
    after: SshConnectionAuditSnapshot
  ): SshConnectionAuditDelta {
    return {
      acceptedTcpConnections:
        after.acceptedTcpConnections - before.acceptedTcpConnections,
      authenticationAttempts:
        after.authenticationAttempts - before.authenticationAttempts,
      acceptedAuthentications:
        after.acceptedAuthentications - before.acceptedAuthentications,
      closedConnections: after.closedConnections - before.closedConnections,
      liveTcpConnections: after.liveTcpConnections - before.liveTcpConnections
    };
  }
}

function count(lines: readonly string[], pattern: RegExp): number {
  return lines.reduce((total, line) => total + Number(pattern.test(line)), 0);
}
