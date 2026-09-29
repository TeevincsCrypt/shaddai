// Only the in-process Hardhat Network is used; contracts are compiled with solc-js by run.ts.
module.exports = {
  solidity: '0.8.24',
  networks: { hardhat: { chainId: 31337, allowBlocksWithSameTimestamp: false } },
};
