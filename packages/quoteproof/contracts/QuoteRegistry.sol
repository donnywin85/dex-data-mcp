// SPDX-License-Identifier: MIT
pragma solidity 0.8.26;

/// @title QuoteRegistry
/// @notice Anchors the hash of a served quote against the pool it priced and the block it was
///         read at, so an answer given off-chain can later be shown to be the one that was given.
/// @dev WHAT AN ANCHOR PROVES, AND WHAT IT DOES NOT. An anchor proves that `submitter` committed to
///      `quoteHash` for `pool` at `quotedBlock`, no later than `anchoredBlock`. It proves NOTHING
///      about whether the quote was true: a fabricated quote anchors just as validly. Truth is
///      checked by re-reading the pool at `quotedBlock` (an eth_call any archive node answers) and
///      comparing it with the anchored payload. Anchor = commitment; re-read = audit.
///
///      Holds no funds: no payable function, no receive, no fallback. Not upgradeable. The only
///      privileged action is pausing new anchors; views are never pausable, because a paused view
///      would stop verification of quotes that were already anchored.
contract QuoteRegistry {
    /// @dev One record, two slots: submitter (160) + anchoredBlock (48) + anchoredTime (48) = 256,
    ///      then pool (160) + quotedBlock (96) = 256.
    struct Anchor {
        address submitter;
        uint48 anchoredBlock;
        uint48 anchoredTime;
        address pool;
        uint96 quotedBlock;
    }

    /// @dev ArbSys precompile. On an Arbitrum chain the NUMBER opcode returns the PARENT chain's
    ///      block number — measured on Robinhood Chain 2026-09-15: NUMBER 25,985,166 against
    ///      arbBlockNumber() 63,927,342 — so a quote's L2 block must be compared with
    ///      ArbSys.arbBlockNumber(), or every real quote would look like it came from the future.
    address internal constant ARBSYS = address(0x64);

    /// @notice The one address that may pause and unpause new anchors. Fixed at deployment; there
    ///         is no transfer and no other privilege.
    address public immutable pauser;

    bool public paused;

    mapping(bytes32 quoteHash => Anchor) private _anchors;

    event QuoteAnchored(
        bytes32 indexed quoteHash,
        address indexed pool,
        address indexed submitter,
        uint256 quotedBlock,
        uint256 anchoredBlock,
        uint256 anchoredTime
    );
    event Paused(address indexed by);
    event Unpaused(address indexed by);

    error AlreadyAnchored(bytes32 quoteHash, uint256 anchoredBlock);
    error AnchoringPaused();
    error NotPauser();
    error ZeroHash();
    error ZeroPool();
    error ZeroBlock();
    error FutureBlock(uint256 quotedBlock, uint256 currentBlock);
    error BlockTooLarge(uint256 quotedBlock);

    constructor() {
        pauser = msg.sender;
    }

    /// @notice Anchor a quote hash. A hash can be anchored exactly once, by anyone; a replay of a
    ///         known hash reverts, so the first record — the one carrying the timestamp claim — can
    ///         never be overwritten.
    /// @param quoteHash keccak256 of the served quote's canonical bytes.
    /// @param pool The pool the quote priced (a v3 pool, or the v4 PoolManager).
    /// @param blockNumber The chain block the quote was read at.
    function anchor(bytes32 quoteHash, address pool, uint256 blockNumber) external {
        if (paused) revert AnchoringPaused();
        if (quoteHash == bytes32(0)) revert ZeroHash();
        if (pool == address(0)) revert ZeroPool();
        if (blockNumber == 0) revert ZeroBlock();
        if (blockNumber > type(uint96).max) revert BlockTooLarge(blockNumber);
        uint256 current = _currentBlock();
        if (blockNumber > current) revert FutureBlock(blockNumber, current);

        Anchor storage a = _anchors[quoteHash];
        if (a.anchoredBlock != 0) revert AlreadyAnchored(quoteHash, a.anchoredBlock);

        a.submitter = msg.sender;
        a.anchoredBlock = uint48(current);
        a.anchoredTime = uint48(block.timestamp);
        a.pool = pool;
        a.quotedBlock = uint96(blockNumber);

        emit QuoteAnchored(quoteHash, pool, msg.sender, blockNumber, current, block.timestamp);
    }

    /// @notice Look up an anchor. `anchored` is false, and every other field zero, for an unknown hash.
    function verify(bytes32 quoteHash)
        external
        view
        returns (bool anchored, address submitter, address pool, uint256 quotedBlock, uint256 anchoredBlock, uint256 anchoredTime)
    {
        Anchor storage a = _anchors[quoteHash];
        return (a.anchoredBlock != 0, a.submitter, a.pool, a.quotedBlock, a.anchoredBlock, a.anchoredTime);
    }

    /// @notice True only if `quoteHash` is anchored for exactly this pool and quoted block.
    function verifyQuote(bytes32 quoteHash, address pool, uint256 blockNumber) external view returns (bool) {
        Anchor storage a = _anchors[quoteHash];
        return a.anchoredBlock != 0 && a.pool == pool && a.quotedBlock == blockNumber;
    }

    function pause() external {
        if (msg.sender != pauser) revert NotPauser();
        paused = true;
        emit Paused(msg.sender);
    }

    function unpause() external {
        if (msg.sender != pauser) revert NotPauser();
        paused = false;
        emit Unpaused(msg.sender);
    }

    function _currentBlock() internal view returns (uint256) {
        if (ARBSYS.code.length > 0) return IArbSys(ARBSYS).arbBlockNumber();
        return block.number;
    }
}

interface IArbSys {
    function arbBlockNumber() external view returns (uint256);
}
