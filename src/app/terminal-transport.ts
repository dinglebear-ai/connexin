import type {
  ClientTerminalMessage,
  QuickShellAppSession,
} from "../shared/protocol.js";

export function openTerminalSocket(
  session: Pick<QuickShellAppSession, "wsUrl">,
): WebSocket {
  return new WebSocket(session.wsUrl);
}

export function sendTerminalTransportMessage(
  socket: WebSocket,
  message: ClientTerminalMessage,
): void {
  if (socket.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(message));
  }
}
