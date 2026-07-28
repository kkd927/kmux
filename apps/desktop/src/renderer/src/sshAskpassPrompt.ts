export type SshAskpassPromptKind = "credential" | "host-authenticity";

const HOST_AUTHENTICITY_QUESTION =
  "Are you sure you want to continue connecting (yes/no/[fingerprint])?";
const HOST_KEY_FINGERPRINT_PATTERN =
  /^[A-Za-z0-9@._+-]+ key fingerprint is: (?:SHA256:[A-Za-z0-9+/=_-]+|MD5:(?:[a-fA-F0-9]{2}:){15}[a-fA-F0-9]{2})$/u;

export function classifySshAskpassPrompt(prompt: string): SshAskpassPromptKind {
  const lines = prompt
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  if (
    lines[0]?.startsWith("The authenticity of host '") &&
    lines.some((line) => HOST_KEY_FINGERPRINT_PATTERN.test(line)) &&
    lines.at(-1) === HOST_AUTHENTICITY_QUESTION
  ) {
    return "host-authenticity";
  }
  return "credential";
}
