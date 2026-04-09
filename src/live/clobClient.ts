// src/services/clobConnect.ts
// Builds and verifies a Polymarket CLOB client from environment variables.
// Provides sig-type fallback logic so all entry points behave consistently.

import { Wallet } from "@ethersproject/wallet";
import {
  AssetType,
  type BalanceAllowanceParams,
  type ClobClient as ClobClientType,
  ClobClient,
} from "@polymarket/clob-client";

const CLOB_HOST = "https://clob.polymarket.com";
const CHAIN_ID = 137;

/**
 * Initialises a fully authenticated ClobClient from environment variables.
 * Requires PRIVATE_KEY and FUNDER to be set.
 *
 * If CLOB_API_KEY and CLOB_API_SECRET are set in .env, uses them directly
 * (skips deriveApiKey entirely — instant startup, no rate-limit risk).
 * Otherwise derives credentials with exponential-backoff retries.
 *
 * On successful derivation, logs the creds so they can be added to .env
 * for future restarts.
 */
export async function initClobClient(): Promise<ClobClientType> {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) throw new Error("PRIVATE_KEY not set in environment");
  const funder = process.env.FUNDER;
  if (!funder) throw new Error("FUNDER not set in environment");

  const signatureType = Number(process.env.SIGNATURE_TYPE ?? 0);
  const signer = new Wallet(privateKey);

  // Fast path: use cached credentials from .env
  const cachedKey = process.env.CLOB_API_KEY;
  const cachedSecret = process.env.CLOB_API_SECRET;
  const cachedPassphrase = process.env.CLOB_API_PASSPHRASE;
  if (cachedKey && cachedSecret) {
    const creds = { key: cachedKey, secret: cachedSecret, passphrase: cachedPassphrase ?? "" };
    const client = new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds, signatureType, funder);
    // Verify creds work with a lightweight call
    try {
      await client.getOpenOrders({ market: "0" });
      console.log("[clob] Connected using cached API credentials from .env");
      return client;
    } catch {
      console.warn("[clob] Cached credentials failed, falling back to deriveApiKey…");
    }
  }

  const makeClient = (sigType: number) => new ClobClient(CLOB_HOST, CHAIN_ID, signer, undefined, sigType, funder);

  const MAX_AUTH_RETRIES = 6;
  const AUTH_RETRY_BASE_MS = 30_000; // 30s → 60s → 120s → 240s → 480s → 960s (~32 min total)

  for (let attempt = 0; attempt < MAX_AUTH_RETRIES; attempt++) {
    if (attempt > 0) {
      const delayMs = AUTH_RETRY_BASE_MS * Math.pow(2, attempt - 1);
      console.log(
        `[clob] Auth retry ${attempt}/${MAX_AUTH_RETRIES - 1} — waiting ${delayMs / 1000}s (rate limit backoff)…`,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let creds: any;
    let finalSigType = signatureType;

    try {
      creds = await makeClient(signatureType).deriveApiKey();
      console.log(`[clob] Derived API key (signatureType=${signatureType})`);
    } catch {
      const alt = signatureType === 1 ? 0 : 1;
      try {
        creds = await makeClient(alt).deriveApiKey();
        finalSigType = alt;
        console.log(`[clob] Derived API key (fallback signatureType=${alt})`);
      } catch {
        console.warn("[clob] deriveApiKey failed; trying createOrDeriveApiKey…");
        try {
          creds = await makeClient(signatureType).createOrDeriveApiKey();
          console.log("[clob] createOrDeriveApiKey succeeded");
        } catch {
          console.warn(`[clob] All auth methods threw (attempt ${attempt + 1}/${MAX_AUTH_RETRIES})`);
          continue;
        }
      }
    }

    if (creds?.key && creds?.secret) {
      console.log(
        `[clob] Add to .env for instant restarts:\n` +
          `CLOB_API_KEY=${creds.key}\nCLOB_API_SECRET=${creds.secret}` +
          (creds.passphrase ? `\nCLOB_API_PASSPHRASE=${creds.passphrase}` : ""),
      );
      return new ClobClient(CLOB_HOST, CHAIN_ID, signer, creds, finalSigType, funder);
    }

    // deriveApiKey returned an HTTP response object instead of credentials — rate limited
    console.warn(
      `[clob] Auth returned no key/secret (likely rate limited) — attempt ${attempt + 1}/${MAX_AUTH_RETRIES}`,
    );
  }

  throw new Error("Failed to obtain CLOB API credentials after retries (rate limited or invalid key)");
}

/**
 * Fetches the current USDC (collateral) balance for the authenticated signer.
 * Returns the balance in whole USDC (divides raw micro-USDC by 1e6).
 */
export async function fetchUsdcBalance(client: ClobClientType): Promise<number> {
  const MAX_RETRIES = 3;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      const resp = await client.getBalanceAllowance({
        asset_type: AssetType.COLLATERAL,
      } as BalanceAllowanceParams);
      const bal = Number(resp?.balance ?? 0) / 1e6;
      if (bal > 0 || attempt === MAX_RETRIES) return bal;
      // $0 balance on first attempts likely means a transient CLOB timeout
      console.log(`[clob] Balance returned $0, retrying (${attempt}/${MAX_RETRIES})…`);
    } catch (err) {
      if (attempt === MAX_RETRIES) throw err;
      console.log(`[clob] Balance fetch failed, retrying (${attempt}/${MAX_RETRIES})…`);
    }
    await new Promise((r) => setTimeout(r, 5000 * attempt));
  }
  return 0;
}
