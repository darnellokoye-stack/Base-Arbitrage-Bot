// Historical baseFeePerGas is exactly reconstructible per block (it's
// consensus data, not derived) — this is the one part of the backtest
// that isn't an approximation. What IS an approximation is the priority
// fee on top of it: config.js's assumedPriorityFeeGwei stands in for
// "what would publicClient.getGasPrice() have returned," which the live
// scanner uses directly and which has no clean historical equivalent
// without replaying mempool data this repo doesn't have.

async function getBaseFeePerGas(publicClient, blockNumber) {
  const block = await publicClient.getBlock({ blockNumber });
  if (block.baseFeePerGas === null || block.baseFeePerGas === undefined) {
    throw new Error(
      `gasHistory: block ${blockNumber} has no baseFeePerGas — this block predates Base's EIP-1559 activation ` +
      `(shouldn't happen for any realistic backtest window) or the RPC response is malformed.`
    );
  }
  return block.baseFeePerGas;
}

// Returns the buffered gas price to use for gasCostWei at this block,
// mirroring bot/scanner.js's gasCostInStartToken buffering
// (gasPrice * (10000 + gasPriceBufferBps) / 10000), with baseFeePerGas +
// an assumed flat priority fee standing in for live getGasPrice().
function bufferedGasPriceWei(baseFeePerGas, cfg) {
  const priorityFeeWei = BigInt(Math.round(cfg.backtest.assumedPriorityFeeGwei * 1e9));
  const gasPrice = baseFeePerGas + priorityFeeWei;
  return (gasPrice * (10000n + cfg.gasPriceBufferBps)) / 10000n;
}

module.exports = { getBaseFeePerGas, bufferedGasPriceWei };
