import { createUtilityProcessControlTransport } from "../pty-host/utilityProcessTransport";
import { RemoteHostService } from "./remoteHostService";

const control = createUtilityProcessControlTransport();
if (!control.available) {
  throw new Error(
    "remote-host requires an Electron UtilityProcess parent port"
  );
}

const service = new RemoteHostService({
  postMessage: (message) => control.postMessage(message),
  onMessage: (listener) =>
    control.onMessage((message, ports) => listener(message, ports))
});
service.start();

process.once("beforeExit", () => {
  void service.close();
});
