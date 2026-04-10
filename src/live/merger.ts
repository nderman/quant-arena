/**
 * Live merger — translates a sim MERGE action into on-chain operations.
 *
 * Two flavors:
 *   A) "Just merge what we have" — we already hold both UP and DOWN from
 *      prior fills. Single mergePositions() tx. Gas only.
 *   B) "Buy + merge" — we hold one side. Buy enough opposite via CLOB to
 *      reach action.size, wait for fill, then mergePositions().
 *
 * Reuses ABI + RPC pattern from polymarket-ai-bot/services/redeemer.ts.
 */

import { Wallet } from "@ethersproject/wallet";
import { Contract } from "@ethersproject/contracts";
import * as providers from "@ethersproject/providers";
import { BigNumber } from "@ethersproject/bignumber";
import { utils, constants } from "ethers";
import type { ClobClient } from "@polymarket/clob-client";
import type { LiveEngineState, TokenConditionMap } from "./liveState";

// ── Polygon contract addresses ──────────────────────────────────────────────

const CTF_ADDRESS = "0x4D97DCd97eC945f40cF65F87097ACe5EA0476045";
const USDC_ADDRESS = "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174";

const CTF_IFACE = new utils.Interface([
  "function mergePositions(address collateralToken, bytes32 parentCollectionId, bytes32 conditionId, uint256[] partition, uint256 amount) external",
  "function balanceOf(address account, uint256 id) external view returns (uint256)",
  "function getCollectionId(bytes32 parentCollectionId, bytes32 conditionId, uint256 indexSet) external view returns (bytes32)",
  "function getPositionId(address collateralToken, bytes32 collectionId) external pure returns (uint256)",
]);

const RPC_URL = process.env.POLYGON_RPC_URL || "https://polygon-rpc.com";
const RPC_FALLBACK = process.env.POLYGON_RPC_FALLBACK || "https://polygon-rpc.com";

// ── Provider singleton ──────────────────────────────────────────────────────

let _provider: providers.StaticJsonRpcProvider | null = null;

async function getProvider(): Promise<providers.StaticJsonRpcProvider> {
  if (_provider) return _provider;
  for (const url of [RPC_URL, RPC_FALLBACK]) {
    try {
      const p = new providers.StaticJsonRpcProvider(url, 137);
      await p.getBlockNumber();
      _provider = p;
      return p;
    } catch { /* try next */ }
  }
  throw new Error("No working Polygon RPC");
}

// ── On-chain balance reads ──────────────────────────────────────────────────

/**
 * Read the on-chain balance for a specific token (in CTF position-id units).
 * Returns shares as a regular number (USDC has 6 decimals → divide by 1e6).
 */
async function getOnchainBalance(
  funderAddress: string,
  conditionId: string,
  outcomeIndex: 1 | 2, // 1 = YES, 2 = NO
): Promise<number> {
  const provider = await getProvider();
  const ctf = new Contract(CTF_ADDRESS, CTF_IFACE, provider);

  const collectionId = await ctf.getCollectionId(constants.HashZero, conditionId, outcomeIndex);
  const positionId = await ctf.getPositionId(USDC_ADDRESS, collectionId);
  const balance: BigNumber = await ctf.balanceOf(funderAddress, positionId);
  return Number(balance.toString()) / 1e6; // USDC 6 decimals
}

export interface MergePlan {
  flavor: "A" | "B";
  mergeShares: number;        // how many pairs we'll merge
  buyOppositeShares: number;  // for flavor B; 0 for flavor A
  oppositeTokenId?: string;   // for flavor B
  reason: string;
}

/**
 * Decide how to execute a MERGE action.
 * If we already hold both sides → flavor A (no buy needed).
 * If we only hold one side → flavor B (buy opposite first).
 */
export async function planMerge(
  funderAddress: string,
  tcm: TokenConditionMap,
  desiredShares: number,
  holdingSide: "UP" | "DOWN",
): Promise<MergePlan> {
  const upBalance = await getOnchainBalance(funderAddress, tcm.conditionId, 1);
  const downBalance = await getOnchainBalance(funderAddress, tcm.conditionId, 2);

  const haveBoth = Math.min(upBalance, downBalance);
  if (haveBoth >= desiredShares) {
    return {
      flavor: "A",
      mergeShares: desiredShares,
      buyOppositeShares: 0,
      reason: `already hold both: up=${upBalance.toFixed(2)} down=${downBalance.toFixed(2)}`,
    };
  }

  // Need to buy more of the opposite side
  const oppositeHeld = holdingSide === "UP" ? downBalance : upBalance;
  const needToBuy = desiredShares - oppositeHeld;
  const oppositeTokenId = holdingSide === "UP" ? tcm.downTokenId : tcm.upTokenId;

  return {
    flavor: "B",
    mergeShares: desiredShares,
    buyOppositeShares: needToBuy,
    oppositeTokenId,
    reason: `holding ${holdingSide}, need to buy ${needToBuy.toFixed(2)} ${holdingSide === "UP" ? "DOWN" : "UP"}`,
  };
}

/**
 * Execute the on-chain mergePositions call.
 * Returns tx hash on success.
 *
 * Note: caller must ensure both sides are held in the right amounts BEFORE
 * calling this. Use planMerge first; if flavor B, buy via CLOB first, then
 * call this.
 */
export async function executeOnchainMerge(
  conditionId: string,
  shares: number,
): Promise<{ ok: boolean; txHash?: string; error?: string }> {
  const privateKey = process.env.PRIVATE_KEY;
  if (!privateKey) return { ok: false, error: "PRIVATE_KEY not set" };

  try {
    const provider = await getProvider();
    const wallet = new Wallet(privateKey, provider);
    const ctf = new Contract(CTF_ADDRESS, CTF_IFACE, wallet);

    const amountRaw = BigNumber.from(Math.floor(shares * 1e6)); // USDC 6 decimals
    const partition = [BigNumber.from(1), BigNumber.from(2)]; // YES + NO

    // EIP-1559 gas
    const feeData = await provider.getFeeData();
    const gasParams = feeData.maxFeePerGas
      ? {
          maxFeePerGas: feeData.maxFeePerGas.add(feeData.maxFeePerGas.div(4)),
          maxPriorityFeePerGas: BigNumber.from(utils.parseUnits("30", "gwei")),
        }
      : { gasPrice: feeData.gasPrice };

    const tx = await ctf.mergePositions(
      USDC_ADDRESS,
      constants.HashZero,
      conditionId,
      partition,
      amountRaw,
      { ...gasParams, gasLimit: 300_000 },
    );
    const receipt = await tx.wait(1);
    return { ok: true, txHash: receipt.transactionHash };
  } catch (err: any) {
    return { ok: false, error: err.message?.slice(0, 200) ?? "unknown" };
  }
}

/**
 * Update LiveEngineState after a successful merge: deduct from both positions,
 * credit cash with the merged USDC.
 */
export function applyMergeToLiveState(
  state: LiveEngineState,
  upTokenId: string,
  downTokenId: string,
  shares: number,
): void {
  const up = state.positions.get(upTokenId);
  const down = state.positions.get(downTokenId);
  if (up) {
    up.shares -= shares;
    if (up.shares <= 0) state.positions.delete(upTokenId);
  }
  if (down) {
    down.shares -= shares;
    if (down.shares <= 0) state.positions.delete(downTokenId);
  }
  state.cashBalance += shares; // $1 per pair merged
}
