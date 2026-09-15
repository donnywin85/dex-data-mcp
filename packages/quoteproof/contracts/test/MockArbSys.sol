// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @dev Test double for the ArbSys precompile. The contract tests place this contract's runtime
///      code at address 0x64 to exercise QuoteRegistry's Arbitrum block-number path, and write
///      slot 0 directly to set the L2 block it reports.
contract MockArbSys {
    uint256 public l2Block;

    function arbBlockNumber() external view returns (uint256) {
        return l2Block;
    }
}
