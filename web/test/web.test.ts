import { Keypair, TransactionBuilder } from "@stellar/stellar-sdk";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildDiagnosticReportText,
  ClaimResolutionModal,
  parseReplacementSerials,
  RESOLUTION_OUTCOMES,
} from "../components/ClaimResolutionModal.js";
import {
  createDebouncedCallback,
  filterServiceSuggestions,
  hasBarcodeTerminator,
  nextSuggestionIndex,
  normalizeSearchQuery,
  SerialSearchBar,
} from "../components/SerialSearchBar.js";
import { registerPasskeySmartWallet } from "../lib/passkey.js";
import {
  buildUnsignedRegistryTxXdr,
  getFileDownloadUrl,
  PUBLIC_CONFIG,
  signRegistryTxWithSecret,
  verifyProduct,
} from "../lib/stellar.js";

describe("@veritag/web verification & passkey wallet logic", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("Offline test mode")),
    );
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("resolves offline/demo verification states accurately across serial patterns", async () => {
    const brand = "GB7TAYRUZGE6TVT7NHP5SMIZRNQA6PLM423EYISAOAP3MKYIQMVYP2JO";
    const batch = "6b86b273ff34fce19d6b804eff5a3f5747ada4eaa22f1d49c01e52ddb7875b4b";

    const unclaimed = await verifyProduct(brand, batch, "CH-2026-000101");
    expect(unclaimed.status).toBe("AuthenticInactive");
    expect(unclaimed.authentic).toBe(true);

    const active = await verifyProduct(brand, batch, "CH-2026-ACTIVE-04");
    expect(active.status).toBe("AuthenticActive");
    expect(active.unit?.warrantyValid).toBe(true);

    const dup = await verifyProduct(brand, batch, "CH-2026-DUP-88");
    expect(dup.status).toBe("AlreadyClaimedWarning");
    expect(dup.suspiciousScanVolume).toBe(true);

    const recalled = await verifyProduct(brand, batch, "CH-2026-RECALL-19");
    expect(recalled.status).toBe("Recalled");

    const fake = await verifyProduct(brand, batch, "FAKE-000999");
    expect(fake.status).toBe("Unknown");
    expect(fake.authentic).toBe(false);
  });

  it("generates P-256 passkey wallet credentials and formats file download URLs", async () => {
    const cred = await registerPasskeySmartWallet("Test Consumer Passkey");
    expect(cred.publicKeyHex.length).toBe(130);
    expect(cred.publicKeyHex.startsWith("04")).toBe(true);
    expect(cred.stellarSmartAddress.startsWith("C")).toBe(true);
    expect(cred.stellarSmartAddress.length).toBe(56);

    const fileUrl = getFileDownloadUrl("a".repeat(64));
    expect(fileUrl).toContain("/v1/files/" + "a".repeat(64));

    const kp = Keypair.random();
    const unsignedXdr = buildUnsignedRegistryTxXdr({
      callerAddress: kp.publicKey(),
      method: "commit_batch",
    });
    const signedXdr = signRegistryTxWithSecret(unsignedXdr, kp.secret());
    const parsedTx = TransactionBuilder.fromXDR(signedXdr, PUBLIC_CONFIG.networkPassphrase);
    expect(parsedTx.signatures.length).toBe(1);

    const passkeyUnsignedXdr = buildUnsignedRegistryTxXdr({
      callerAddress: cred.stellarSmartAddress,
      method: "activate",
    });
    expect(passkeyUnsignedXdr.length).toBeGreaterThan(20);
  });

  it("renders ClaimResolutionModal and builds diagnostic reports with technician notes", () => {
    const outcomeValues = RESOLUTION_OUTCOMES.map((o) => o.value);
    expect(outcomeValues).toContain("Approved");
    expect(outcomeValues).toContain("Rejected");
    expect(outcomeValues).toContain("PartiallyCovered");

    const serials = parseReplacementSerials("PART-01, PART-02\nPART-03");
    expect(serials).toEqual(["PART-01", "PART-02", "PART-03"]);

    const report = buildDiagnosticReportText({
      claimId: 42,
      unitId: "a".repeat(64),
      outcome: "PartiallyCovered",
      technicianNotes: "Replaced crystal gasket; bezel impact outside coverage.",
      replacementPartSerials: serials,
    });
    expect(report).toContain("Claim ID: #42");
    expect(report).toContain("Outcome: PartiallyCovered");
    expect(report).toContain("PART-01, PART-02, PART-03");

    const html = renderToStaticMarkup(
      React.createElement(ClaimResolutionModal, {
        claim: {
          claimId: 42,
          unitId: "a".repeat(64),
          brandDomain: "chronos-watches.swiss",
          serialNumber: "CH-2026-000101",
          warrantyValid: true,
          filedDate: "2026-11-05",
          outcome: "Pending",
          reportHash: "",
        },
        onClose: () => {},
        onResolve: () => {},
      }),
    );
    expect(html).toContain("Claim #42");
    expect(html).toContain("PartiallyCovered");
    expect(html).toContain("Technician Assessment");
    expect(html).toContain("Replacement Part Serial Numbers");
    expect(html).toContain("resolve_claim");
  });

  it("supports debounced search, barcode carriage-return auto-submit, and keyboard navigation", () => {
    vi.useFakeTimers();
    try {
      const spy = vi.fn();
      const debounced = createDebouncedCallback(spy, 300);

      debounced.call("CH-20");
      debounced.call("CH-2026");
      vi.advanceTimersByTime(299);
      expect(spy).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(spy).toHaveBeenCalledTimes(1);
      expect(spy).toHaveBeenCalledWith("CH-2026");
    } finally {
      vi.useRealTimers();
    }

    expect(hasBarcodeTerminator("CH-2026-000101\r")).toBe(true);
    expect(hasBarcodeTerminator("CH-2026-000101\n")).toBe(true);
    expect(hasBarcodeTerminator("CH-2026-000101")).toBe(false);
    expect(normalizeSearchQuery("  CH-2026-000101\r\n ")).toBe("CH-2026-000101");

    const suggestions = [
      {
        id: "1",
        unitId: "55".repeat(32),
        serialNumber: "CH-2026-000101",
        brandDomain: "chronos-watches.swiss",
        customerEmail: "alice@example.ch",
        label: "Claim #1 · CH-2026-000101",
      },
      {
        id: "2",
        unitId: "66".repeat(32),
        serialNumber: "ALP-2026-000202",
        brandDomain: "alpine-optics.ch",
        customerEmail: "bob@example.ch",
        label: "Claim #2 · ALP-2026-000202",
      },
    ];

    expect(filterServiceSuggestions(suggestions, "alice@example.ch")).toHaveLength(1);
    expect(filterServiceSuggestions(suggestions, "alpine-optics")).toHaveLength(1);

    expect(nextSuggestionIndex(-1, "ArrowDown", 2)).toBe(0);
    expect(nextSuggestionIndex(0, "ArrowDown", 2)).toBe(1);
    expect(nextSuggestionIndex(1, "ArrowDown", 2)).toBe(0);
    expect(nextSuggestionIndex(0, "ArrowUp", 2)).toBe(1);

    const html = renderToStaticMarkup(
      React.createElement(SerialSearchBar, {
        suggestions,
        isLoading: true,
        onSearch: () => {},
      }),
    );
    expect(html).toContain('role="combobox"');
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-label="Searching"');
  });
});
