// Metadata-only CLI fixture. Any session or inference request fails the test.
const { Buffer } = require("node:buffer");
const process = require("node:process");
let buffer = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  buffer = Buffer.concat([buffer, chunk]);
  while (true) {
    const end = buffer.indexOf("\r\n\r\n");
    if (end < 0) return;
    const length = Number(
      buffer
        .subarray(0, end)
        .toString()
        .match(/Content-Length:\s*(\d+)/iu)?.[1]
    );
    if (buffer.length < end + 4 + length) return;
    const request = JSON.parse(
      buffer.subarray(end + 4, end + 4 + length).toString()
    );
    buffer = buffer.subarray(end + 4 + length);
    let result;
    if (request.method === "connect") result = {};
    else if (request.method === "models.list")
      result = {
        models: [
          {
            id: "fixture-model",
            name: "Fixture reasoning",
            supportedReasoningEfforts: ["low", "high"],
            defaultReasoningEffort: "low"
          },
          {
            id: "fixture-fast",
            name: "Fixture fast",
            supportedReasoningEfforts: []
          }
        ]
      };
    else process.exit(2);
    const body = Buffer.from(
      JSON.stringify({ jsonrpc: "2.0", id: request.id, result })
    );
    process.stdout.write(`Content-Length: ${body.length}\r\n\r\n`);
    process.stdout.write(body);
  }
});
