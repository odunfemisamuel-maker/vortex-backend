import {
  WebSocketGateway,
  WebSocketServer,
  OnGatewayConnection,
  OnGatewayDisconnect,
} from "@nestjs/websockets";
import { Logger } from "@nestjs/common";
import { Server, WebSocket } from "ws";
import { Intent, IntentFill } from "./intents.types";

/**
 * WebSocket event types broadcast by the gateway.
 *
 * Partial-fill events added by issue #427:
 *  - `intent_partially_filled`  — a new fill tranche was recorded but the
 *                                  intent still has remaining amount.
 *  - `intent_fill_progress`     — periodic progress update (fillProgress, remainingAmount).
 */
export type WsEventType =
  | "intent_created"
  | "intent_accepted"
  | "intent_filled"
  | "intent_cancelled"
  | "intent_expired"
  | "intent_slashed"
  | "intent_partially_filled"
  | "intent_fill_progress";

/** Base shape every broadcast event shares. */
export interface WsEvent {
  type: WsEventType;
  intentId: string;
  timestamp: number;
}

export interface IntentCreatedEvent extends WsEvent {
  type: "intent_created";
  intent: Intent;
}

export interface IntentAcceptedEvent extends WsEvent {
  type: "intent_accepted";
  intentId: string;
  solver: string;
}

export interface IntentFilledEvent extends WsEvent {
  type: "intent_filled";
  intentId: string;
  solver: string;
  fillAmount: string;
  txHash?: string;
}

export interface IntentCancelledEvent extends WsEvent {
  type: "intent_cancelled";
  intentId: string;
}

export interface IntentExpiredEvent extends WsEvent {
  type: "intent_expired";
  intentId: string;
}

export interface IntentSlashedEvent extends WsEvent {
  type: "intent_slashed";
  intentId: string;
  solver: string;
  reason?: string;
}

/**
 * Emitted each time a partial-fill tranche is recorded (issue #427).
 * The intent is still open for further fills.
 */
export interface IntentPartiallyFilledEvent extends WsEvent {
  type: "intent_partially_filled";
  intentId: string;
  solver: string;
  fill: IntentFill;
  fillProgress: number;
  remainingAmount: string;
}

/**
 * Periodic progress broadcast for partial-fill intents (issue #427).
 */
export interface IntentFillProgressEvent extends WsEvent {
  type: "intent_fill_progress";
  intentId: string;
  fillProgress: number;
  filledAmount: string;
  remainingAmount: string;
  fills: IntentFill[];
}

export type AnyWsEvent =
  | IntentCreatedEvent
  | IntentAcceptedEvent
  | IntentFilledEvent
  | IntentCancelledEvent
  | IntentExpiredEvent
  | IntentSlashedEvent
  | IntentPartiallyFilledEvent
  | IntentFillProgressEvent;

/**
 * WebSocket gateway that broadcasts intent lifecycle events to all connected clients.
 *
 * Clients may subscribe to a chain filter:
 *   { type: "subscribe", chains: ["stellar", "ethereum"] }
 * An absent or empty filter means "all events".
 */
@WebSocketGateway({ path: "/ws" })
export class IntentsGateway
  implements OnGatewayConnection, OnGatewayDisconnect
{
  private readonly logger = new Logger(IntentsGateway.name);

  @WebSocketServer()
  private server!: Server;

  /**
   * Per-client chain filters. Key = WebSocket reference, value = set of
   * chain names the client is interested in (empty set = all chains).
   */
  private readonly chainFilters = new WeakMap<WebSocket, Set<string>>();

  /** Total number of currently connected clients (used by health indicator). */
  private connectionCount = 0;

  handleConnection(client: WebSocket): void {
    this.connectionCount += 1;
    this.chainFilters.set(client, new Set());
    this.logger.debug(`[ws] client connected (total=${this.connectionCount})`);

    client.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString()) as { type?: string; chains?: string[] };
        if (msg.type === "subscribe" && Array.isArray(msg.chains)) {
          const filter = new Set(msg.chains.map((c) => c.toLowerCase()));
          this.chainFilters.set(client, filter);
          this.logger.debug(`[ws] client subscribed to chains: ${[...filter].join(", ")}`);
        }
      } catch {
        // Non-JSON messages are silently dropped
      }
    });
  }

  handleDisconnect(client: WebSocket): void {
    this.connectionCount = Math.max(0, this.connectionCount - 1);
    this.chainFilters.delete(client);
    this.logger.debug(`[ws] client disconnected (total=${this.connectionCount})`);
  }

  getConnectionCount(): number {
    return this.connectionCount;
  }

  /**
   * Broadcast a structured event to all connected clients.
   *
   * When the event carries a `srcChain` (via intent) clients that have
   * subscribed to a specific chain filter only receive matching events.
   * Clients with an empty filter receive everything.
   */
  broadcast(event: AnyWsEvent & { srcChain?: string }): void {
    const payload = JSON.stringify(event);

    this.server?.clients?.forEach((client) => {
      if (client.readyState !== WebSocket.OPEN) return;

      const filter = this.chainFilters.get(client as WebSocket);
      if (filter && filter.size > 0 && event.srcChain) {
        if (!filter.has(event.srcChain.toLowerCase())) return;
      }

      try {
        client.send(payload);
      } catch (err) {
        this.logger.warn(`[ws] send failed: ${(err as Error).message}`);
      }
    });
  }
}
