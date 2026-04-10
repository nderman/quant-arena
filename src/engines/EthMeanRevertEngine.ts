import { AbstractEngine } from "./BaseEngine";
import { MeanRevertV2Engine } from "./MeanRevertV2Engine";
import { CONFIG } from "../config";
import type { EngineAction, EngineState, MarketTick, SignalSnapshot } from "../types";

/**
 * ETH-Only Mean Reverter — coin-specialized variant of mean-revert-v2.
 *
 * Hypothesis tested: mean-revert-v2 has produced 4 consecutive winning rounds
 * on ETH (+$105 cumulative) but bleeds catastrophically on BTC (-$152 / 6 rounds)
 * and SOL (-$162 / 6 rounds). Same exact code, dramatically different outcomes.
 *
 * Either ETH has a structurally more rangebound 5M market microstructure than
 * BTC/SOL, or this is a 6-round lucky streak. By running this engine ALONGSIDE
 * the original on the eth coin process — and disabling it on btc/sol — we get
 * a clean comparison: same parameters, half the noise.
 *
 * Implementation: composition over inheritance. Delegates everything to an
 * inner MeanRevertV2Engine instance, with a coin gate at the top of onTick.
 * That way we automatically inherit any future tweaks to mean-revert-v2's
 * parameters without needing to keep two copies in sync.
 */
export class EthMeanRevertEngine extends AbstractEngine {
  id = "eth-mean-revert-v1";
  name = "ETH-Only Mean Revert";
  version = "1.0.0";

  private readonly inner = new MeanRevertV2Engine();

  init(state: EngineState): void {
    super.init(state);
    this.inner.init(state);
  }

  onTick(tick: MarketTick, state: EngineState, signals?: SignalSnapshot): EngineAction[] {
    if (CONFIG.ARENA_COIN !== "eth") return [];
    return this.inner.onTick(tick, state, signals);
  }

  onRoundEnd(state: EngineState): void {
    this.inner.onRoundEnd(state);
  }
}
