import { log } from "./logger";
import { bufferToHexString } from "./utils";

// Keep logging separate from the Web Bluetooth prototype. Modern Chromium
// exposes writeValueWithResponse()/writeValueWithoutResponse() instead of the
// deprecated writeValue(), so patching only the old API loses logs.
export function logWriteValue(value: Uint8Array) {
  const copy = new Uint8Array(value);
  log("TXD: " + bufferToHexString(copy.buffer));
}
