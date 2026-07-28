import type {
  ClientTerminalMessage,
  QuickShellAppSession,
} from "../shared/protocol.js";

export function openTerminalSocket(
  session: Pick<QuickShellAppSession, "wsUrl">,
): WebSocket {
  return new WebSocket(session.wsUrl);
}

/**
 * Send a message if the socket is open.
 *
 * Returns whether the message was actually handed to the socket. Callers must
 * check it: this used to return void, so a send into a closing socket looked
 * identical to a successful one and silently dropped keystrokes, session-close
 * requests, and audit records.
 */
export function sendTerminalTransportMessage(
  socket: WebSocket,
  message: ClientTerminalMessage,
): boolean {
  if (socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}
