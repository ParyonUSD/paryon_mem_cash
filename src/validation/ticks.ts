/**
 * CHIP-2025-03, one-minute blocks. A block adds 600 ticks to the chain up to and including the
 * activation block and 60 after it, and a height in a locktime, a sequence number or the coinbase
 * maturity keeps meaning 600 ticks. Without an activation height every block adds 600, and the tick
 * rules below are the block-height rules.
 */

/** The ticks one unit of a height-mode locktime or sequence number stands for. */
export const LOCK_UNIT_TICKS = 600;

/** The ticks a block adds after the activation block. */
export const ONE_MINUTE_BLOCK_TICKS = 60;

/**
 * Throws unless the value is a height a chain can activate at. Never 0: every block would be a
 * one-minute block.
 */
export function assertOneMinuteBlocksActivationHeight(activationHeight: number | undefined): void {
	if (activationHeight === undefined) return;
	if (!Number.isSafeInteger(activationHeight) || activationHeight <= 0) {
		throw new Error(`oneMinuteBlocksActivationHeight must be a positive block height, got ${activationHeight}`);
	}
}

/**
 * The chain's tick at a block, counting the block's own contribution: T(0) = 0, T(1) = 600.
 * `activationHeight` is the last block of 600 ticks; undefined on a chain without the upgrade.
 */
export function tickAtHeight(height: number, activationHeight?: number): number {
	if (activationHeight === undefined || height <= activationHeight) return height * LOCK_UNIT_TICKS;
	return activationHeight * LOCK_UNIT_TICKS + (height - activationHeight) * ONE_MINUTE_BLOCK_TICKS;
}
