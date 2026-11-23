import { spawn } from "node:child_process";
import type { Socket } from "node:net";

/** Node does not expose peer credentials on net.Socket. Pass its open handle
 * to the bundled getsockopt helper, keeping the lookup tied to this connection. */
export function socketPeerPid(helper: string, socket: Socket): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(helper, [], {
      stdio: [socket, "pipe", "ignore"],
      timeout: 3000
    });
    let output = "";
    child.stdout.setEncoding("ascii").on("data", (chunk) => {
      output += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      const pid = Number(output.trim());
      if (code === 0 && Number.isSafeInteger(pid) && pid > 0) resolve(pid);
      else reject(new Error("Cannot verify the orchestration socket peer"));
    });
  });
}
