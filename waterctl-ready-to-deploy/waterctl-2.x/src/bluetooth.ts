import { resolveError } from "./errors";
import { clearLogs, getLogs, isLogEmpty, log } from "./logger";
import { endEpilogue, baAck, offlinebombFix, startPrologue, endPrologue } from "./payloads";
import { makeStartEpilogue, makeUnlockResponse } from "./solvers";
import { bufferToHexString } from "./utils";
import { logWriteValue } from "./writeValueLogging";

let bluetoothDevice: BluetoothDevice;
let txdCharacteristic: BluetoothRemoteGATTCharacteristic;
let rxdCharacteristic: BluetoothRemoteGATTCharacteristic;

let isStarted = false;
let writeQueue: Promise<void> = Promise.resolve();

let pendingStartEpilogue: number; // workaround for determining new firmware, see handleRxdNotifications
let pendingTimeoutMessage: number; // if we don't get a response in time, we should show an error message
const WATERCTL_SERVICE = 0xf1f0;
const WATERCTL_TXD = 0xf1f1;
const WATERCTL_RXD = 0xf1f2;

type ModernWriteCharacteristic = BluetoothRemoteGATTCharacteristic & {
  writeValueWithResponse?: (value: BufferSource) => Promise<void>;
  writeValueWithoutResponse?: (value: BufferSource) => Promise<void>;
};

function writeValue(characteristic: BluetoothRemoteGATTCharacteristic, value: Uint8Array): Promise<void> {
  const modernCharacteristic = characteristic as ModernWriteCharacteristic;

  // Prefer the explicit Web Bluetooth APIs on current Chromium/Android. The
  // legacy method is retained as a fallback for older supported browsers.
  if (characteristic.properties.write && modernCharacteristic.writeValueWithResponse) {
    return modernCharacteristic.writeValueWithResponse(value);
  }
  if (characteristic.properties.writeWithoutResponse && modernCharacteristic.writeValueWithoutResponse) {
    return modernCharacteristic.writeValueWithoutResponse(value);
  }
  if (modernCharacteristic.writeValueWithResponse) {
    return modernCharacteristic.writeValueWithResponse(value);
  }
  if (modernCharacteristic.writeValueWithoutResponse) {
    return modernCharacteristic.writeValueWithoutResponse(value);
  }
  return characteristic.writeValue(value);
}

function writeTxd(value: Uint8Array): Promise<void> {
  logWriteValue(value);

  // Android's Bluetooth stack rejects simultaneous GATT writes. Serializing
  // them also prevents notification handlers from colliding with a timer.
  const operation = writeQueue.then(() => writeValue(txdCharacteristic, value));
  writeQueue = operation.catch(() => undefined);
  return operation;
}

// I'm really sorry to have a DOM manipulation here, but this is the best way unless going down the rabbit hole of React (or any other frameworks you like)
// And... of course we had done that in the past (v0.x)
function updateUi(stage: "pending" | "ok" | "standby") {
  const mainButton = document.getElementById("main-button") as HTMLButtonElement;
  const deviceName = document.getElementById("device-name") as HTMLSpanElement;

  switch (stage) {
    case "pending":
      mainButton.innerText = "请稍候";
      mainButton.disabled = true;
      deviceName.innerText = "已连接：" + bluetoothDevice.name;
      break;
    case "ok":
      mainButton.innerText = "结束";
      mainButton.disabled = false;
      break;
    case "standby":
      mainButton.innerText = "开启";
      mainButton.disabled = false;
      deviceName.innerText = "未连接";
      break;
  }
}

async function disconnect() {
  if (bluetoothDevice?.gatt?.connected) bluetoothDevice.gatt.disconnect();
  isStarted = false;
  clearLogs();
  clearTimeout(pendingStartEpilogue);
  clearTimeout(pendingTimeoutMessage);
  updateUi("standby");
}

function handleDisconnected() {
  isStarted = false;
  clearTimeout(pendingStartEpilogue);
  clearTimeout(pendingTimeoutMessage);
  updateUi("standby");
}
async function handleBluetoothError(error: unknown) {
  // this is so fucking ugly but i have no choice
  // you would never know how those shitty browsers behave
  if (!error) throw error;

  const e = error.toString();

  if (e.match(/User cancelled/) || e == "2") {
    // "2" is a weird behavior of Bluefy browser on iOS
    return;
  }

  const dialogContent = document.getElementById("dialog-content") as HTMLParagraphElement;
  const dialogDebugContainer = document.getElementById("dialog-debug-container") as HTMLPreElement;
  const dialogDebugContent = document.getElementById("dialog-debug-content")!;

  const { output, isFatal, showLogs } = resolveError(error);
  output(dialogContent, error);

  dialogDebugContainer.style.display = "none";
  if (!isLogEmpty() && showLogs) {
    dialogDebugContainer.style.display = "block";
    dialogDebugContent.innerText = "调试信息：\n" + getLogs().join("\n");
  }

  (document.getElementById("dialog") as HTMLDialogElement).showModal();

  if (isFatal) disconnect();

  throw error;
}

async function handleRxdNotifications(event: Event) {
  const value = (event.target! as BluetoothRemoteGATTCharacteristic).value!;

  log("RXD: " + bufferToHexString(value.buffer));

  try {
    let payload = new Uint8Array(value.buffer);

    // due to a bug in the firmware, it may send an AT command "AT+STAS?" via RXD; it doesn't start with FDFD09
    if (payload[0] === 0x41 && payload[1] === 0x54 && payload[2] === 0x2b) {
      return;
    }

    if (payload[0] !== 0xfd && payload[0] !== 0x09) {
      throw new Error("WATERCTL INTERNAL Unknown RXD data");
    }

    // sometimes, the first one or two bytes are missing maybe due to bad firmware implementation
    // explanation: [0xFD, 0x09, ...] => [0xFD, 0xFD, 0x09, ...]
    if (payload[1] === 0x09) {
      payload = new Uint8Array([0xfd, ...payload]);
    }

    // explanation: [0x09, ...] => [0xFD, 0xFD, 0x09, ...]
    if (payload[0] === 0x09) {
      payload = new Uint8Array([0xfd, 0xfd, ...payload]);
    }

    // ... and sometimes it sends a single byte 0xFD
    if (payload.length < 4) {
      return;
    }

    const dType = payload[3];

    // https://github.com/prettier/prettier/issues/5158
    // prettier-ignore
    switch (dType) {
      case 0xB0: // start prologue ok; delay 500ms for key authentication request (AE) if this is a new firmware
      case 0xB1:
        clearTimeout(pendingStartEpilogue);
        pendingStartEpilogue = setTimeout(() => {
          void writeTxd(makeStartEpilogue(bluetoothDevice.name!)).catch(handleBluetoothError);
        }, 500);
        break;
      case 0xAE: // receiving an unlock request (AE), this is a new firmware
        clearTimeout(pendingStartEpilogue);
        await writeTxd(await makeUnlockResponse(payload, bluetoothDevice.name!));
        break;
      case 0xAF:
        switch (payload[5]) {
          case 0x55: // key authentication ok; continue to send start epilogue (B2)
            await writeTxd(makeStartEpilogue(bluetoothDevice.name!, true));
            break;
          case 0x01: // key authentication failed; "err41" (bad key)
          case 0x02: // ?
          case 0x04: // "err43" (bad nonce)
            throw new Error("WATERCTL INTERNAL Bad key");
          default:
            await writeTxd(makeStartEpilogue(bluetoothDevice.name!, true));
            throw new Error("WATERCTL INTERNAL Unknown RXD data");
        }
        break;
      case 0xB2: // start ok; update ui
        clearTimeout(pendingStartEpilogue);
        clearTimeout(pendingTimeoutMessage);
        isStarted = true;
        updateUi("ok");
        break;
      case 0xB3: // end prologue ok (B3); disconnect
        await writeTxd(endEpilogue);
        disconnect();
        break;
      case 0xAA: // telemetry, no need to respond
      case 0xB5: // temperature settings related, no need to respond
      case 0xB8: // unknown, no need to respond
        break;
      case 0xBA: // user info upload request; send BA ack to tell it we have done that (won't actually do it)
        await writeTxd(baAck);
        break;
      case 0xBC: // see offlinebombFix
        await writeTxd(offlinebombFix);
        break;
      case 0xC8: // start epilogue (B2) is refused
        throw new Error("WATERCTL INTERNAL Refused");
      default:
        throw new Error("WATERCTL INTERNAL Unknown RXD data");
    }
  } catch (error) {
    handleBluetoothError(error);
  }
}

function setupTimeoutMessage() {
  if (!pendingTimeoutMessage) {
    pendingTimeoutMessage = setTimeout(() => {
      handleBluetoothError("WATERCTL INTERNAL Operation timed out");
    }, 15000);
  }
}

async function start() {
  try {
    bluetoothDevice = await navigator.bluetooth.requestDevice({
      // Do not filter by advertised name. Some Android/OEM Bluetooth stacks
      // hide or localize the advertised name, even though the GATT service is
      // usable. The user still explicitly selects the device in the browser.
      acceptAllDevices: true,
      optionalServices: [window.navigator.userAgent.match(/Bluefy/) ? "generic_access" : WATERCTL_SERVICE], // workaround for Bluefy
    });

    if (!bluetoothDevice.name) {
      throw new Error("WATERCTL INTERNAL Device name unavailable");
    }
    bluetoothDevice.addEventListener("gattserverdisconnected", handleDisconnected, { once: true });

    updateUi("pending");

    const server = await bluetoothDevice.gatt!.connect();
    const service = await server.getPrimaryService(WATERCTL_SERVICE);
    txdCharacteristic = await service.getCharacteristic(WATERCTL_TXD);
    rxdCharacteristic = await service.getCharacteristic(WATERCTL_RXD);

    await rxdCharacteristic.startNotifications();
    rxdCharacteristic.addEventListener("characteristicvaluechanged", handleRxdNotifications);

    await writeTxd(startPrologue);
    setupTimeoutMessage();
  } catch (error) {
    handleBluetoothError(error);
  }
}

async function end() {
  try {
    await writeTxd(endPrologue);
    setupTimeoutMessage();
  } catch (error) {
    handleBluetoothError(error);
  }
}

export function handleButtonClick() {
  isStarted ? end() : start();
}

