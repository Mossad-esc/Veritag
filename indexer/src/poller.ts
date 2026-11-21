import { rpc } from "@stellar/stellar-sdk";
import {
  decodeContractEvent,
  type ContractKind,
  type RawSorobanEvent,
} from "./decoder.js";
import type { IndexerWriter } from "./writer.js";

export interface EventPageResponse {
  latestLedger: number;
  cursor: string;
  events: RawSorobanEvent[];
}

export interface SorobanEventsProvider {
  fetchEvents(params: {
    contractId?: string;
    contractIds?: string[];
    cursor?: string;
    startLedger?: number;
    limit?: number;
  }): Promise<EventPageResponse>;
}

export class RpcEventsProvider implements SorobanEventsProvider {
  private readonly server: rpc.Server;

  constructor(rpcUrl: string) {
    this.server = new rpc.Server(rpcUrl, { allowHttp: rpcUrl.startsWith("http://") });
  }

  async fetchEvents(params: {
    contractId?: string;
    contractIds?: string[];
    cursor?: string;
    startLedger?: number;
    limit?: number;
  }): Promise<EventPageResponse> {
    const ids =
      params.contractIds && params.contractIds.length > 0
        ? params.contractIds
        : params.contractId
          ? [params.contractId]
          : [];
    const latest = await this.server.getLatestLedger();
    const requestParams: rpc.Server.GetEventsRequest = params.cursor
      ? {
          cursor: params.cursor,
          filters: [{ type: "contract", contractIds: ids }],
          limit: params.limit ?? 100,
        }
      : {
          startLedger: params.startLedger ?? Math.max(1, latest.sequence - 1000),
          filters: [{ type: "contract", contractIds: ids }],
          limit: params.limit ?? 100,
        };

    const res = await this.server.getEvents(requestParams);
    const events: RawSorobanEvent[] = res.events.map((ev) => ({
      id: ev.id,
      ledger: ev.ledger,
      txHash: ev.txHash,
      ...(ev.contractId ? { contractId: String(ev.contractId) } : {}),
      ledgerClosedAt: ev.ledgerClosedAt,
      topic: ev.topic,
      value: ev.value,
    }));

    return {
      latestLedger: res.latestLedger,
      cursor: res.cursor ?? events[events.length - 1]?.id ?? params.cursor ?? "",
      events,
    };
  }
}

export interface IndexerPollerOptions {
  contractId?: string;
  contractIds?: string[];
  contractKinds?: Record<string, ContractKind> | ReadonlyMap<string, ContractKind>;
  provider: SorobanEventsProvider;
  writer: IndexerWriter;
  confirmationLedgers?: number;
  batchLimit?: number;
}

export class IndexerPoller {
  private readonly watchedContracts: Set<string>;
  private readonly contractKinds: Map<string, ContractKind>;
  private readonly provider: SorobanEventsProvider;
  private readonly writer: IndexerWriter;
  private readonly confirmationLedgers: number;
  private readonly batchLimit: number;

  constructor(options: IndexerPollerOptions) {
    const initialIds =
      options.contractIds && options.contractIds.length > 0
        ? options.contractIds
        : options.contractId
          ? [options.contractId]
          : [];
    this.watchedContracts = new Set(initialIds.filter(Boolean));
    this.contractKinds =
      options.contractKinds instanceof Map
        ? new Map(options.contractKinds)
        : new Map(Object.entries(options.contractKinds ?? {}));
    this.provider = options.provider;
    this.writer = options.writer;
    this.confirmationLedgers = options.confirmationLedgers ?? 2;
    this.batchLimit = options.batchLimit ?? 100;
  }

  getWatchedContractIds(): string[] {
    return Array.from(this.watchedContracts);
  }

  addWatchedContractId(contractId: string, kind?: ContractKind): void {
    if (!contractId) return;
    this.watchedContracts.add(contractId);
    if (kind) {
      this.contractKinds.set(contractId, kind);
    }
  }

  /**
   * Executes one idempotent poll cycle, decoding events, updating database projections,
   * advancing the saved cursor, and promoting confirmed events to finalized.
   */
  async pollOnce(): Promise<{ fetched: number; applied: number; finalized: number }> {
    const cursorState = await this.writer.getCursor();
    const contractIds = this.getWatchedContractIds();

    let page: EventPageResponse;
    try {
      page = await this.provider.fetchEvents({
        contractId: contractIds[0],
        contractIds,
        cursor: cursorState.lastCursor || undefined,
        startLedger: cursorState.lastCursor ? undefined : Math.max(1, cursorState.lastLedger),
        limit: this.batchLimit,
      });
    } catch {
      // Handle RPC retention window cursor expiration by falling back to startLedger
      page = await this.provider.fetchEvents({
        contractId: contractIds[0],
        contractIds,
        startLedger: Math.max(1, cursorState.lastLedger),
        limit: this.batchLimit,
      });
    }

    const confirmedCutoff = page.latestLedger - this.confirmationLedgers;
    let appliedCount = 0;
    let highestLedger = cursorState.lastLedger;

    for (const rawEv of page.events) {
      highestLedger = Math.max(highestLedger, rawEv.ledger);
      const decoded = decodeContractEvent(rawEv, this.contractKinds);
      if (!decoded) continue;

      if (decoded.type === "account_deployed") {
        this.addWatchedContractId(decoded.account, "passkey_account");
      }

      const isFinalized = decoded.ledger <= confirmedCutoff;
      const { applied } = await this.writer.applyEvent(decoded, isFinalized);
      if (applied) {
        appliedCount++;
      }
    }

    const newlyFinalized = await this.writer.finalizeEventsUpTo(confirmedCutoff);

    if (page.events.length > 0 || page.cursor) {
      await this.writer.saveCursor({
        lastLedger: Math.max(highestLedger, page.latestLedger),
        lastCursor: page.cursor || cursorState.lastCursor,
      });
    }

    return {
      fetched: page.events.length,
      applied: appliedCount,
      finalized: newlyFinalized,
    };
  }

  /**
   * Backfills contract events across a historical ledger range `[fromLedger, toLedger]`,
   * paginating by cursor until `toLedger` is reached.
   */
  async backfillRange(
    fromLedger: number,
    toLedger: number,
  ): Promise<{ pages: number; fetched: number; applied: number }> {
    if (fromLedger <= 0 || toLedger < fromLedger) {
      throw new Error("Invalid backfill ledger range");
    }

    let cursor: string | undefined;
    let currentStart = fromLedger;
    let pages = 0;
    let totalFetched = 0;
    let totalApplied = 0;

    while (currentStart <= toLedger) {
      const contractIds = this.getWatchedContractIds();
      const page = await this.provider.fetchEvents({
        contractId: contractIds[0],
        contractIds,
        cursor,
        startLedger: cursor ? undefined : currentStart,
        limit: this.batchLimit,
      });
      pages++;

      if (page.events.length === 0) {
        break;
      }

      const confirmedCutoff = page.latestLedger - this.confirmationLedgers;
      let maxEventLedger = currentStart;

      for (const rawEv of page.events) {
        maxEventLedger = Math.max(maxEventLedger, rawEv.ledger);
        if (rawEv.ledger > toLedger) continue;
        totalFetched++;

        const decoded = decodeContractEvent(rawEv, this.contractKinds);
        if (!decoded) continue;

        if (decoded.type === "account_deployed") {
          this.addWatchedContractId(decoded.account, "passkey_account");
        }

        const isFinalized = decoded.ledger <= confirmedCutoff;
        const { applied } = await this.writer.applyEvent(decoded, isFinalized);
        if (applied) {
          totalApplied++;
        }
      }

      await this.writer.saveCursor({
        lastLedger: Math.min(maxEventLedger, toLedger),
        lastCursor: page.cursor || cursor || "",
      });

      if (maxEventLedger >= toLedger || !page.cursor || page.cursor === cursor) {
        break;
      }
      cursor = page.cursor;
      currentStart = maxEventLedger;
    }

    return { pages, fetched: totalFetched, applied: totalApplied };
  }
}
