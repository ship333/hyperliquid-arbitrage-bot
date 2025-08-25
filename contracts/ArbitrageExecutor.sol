// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title ArbitrageExecutor
/// @notice Production-grade flash-loan executor for HyperEVM that performs two generic router swaps.
/// @dev HyperLend pool interfaces here are placeholders; replace with official ABI/addresses before deployment.

/// @notice Minimal ERC20 interface
interface IERC20 {
  function balanceOf(address) external view returns (uint256);
  function allowance(address, address) external view returns (uint256);
  function approve(address, uint256) external returns (bool);
  function transfer(address, uint256) external returns (bool);
  function transferFrom(address, address, uint256) external returns (bool);
}

/// @notice Lightweight SafeERC20 helpers (success boolean enforced)
library SafeERC20 {
  function safeApprove(IERC20 t, address s, uint256 v) internal {
    require(t.approve(s, v), "APPROVE_FAIL");
  }
  function safeTransfer(IERC20 t, address to, uint256 v) internal {
    require(t.transfer(to, v), "TRANSFER_FAIL");
  }
  function safeTransferFrom(IERC20 t, address f, address to, uint256 v) internal {
    require(t.transferFrom(f, to, v), "TF_FROM_FAIL");
  }
}

/// @notice Minimal, storage-slot reentrancy guard
abstract contract ReentrancyGuard {
  uint256 private _guard;
  modifier nonReentrant() {
    require(_guard == 0, "REENTRANT");
    _guard = 1;
    _;
    _guard = 0;
  }
}

/// @notice Two-step ownable pattern (no OZ import)
abstract contract Ownable2Step {
  address public owner;
  address private _pendingOwner;

  event OwnershipTransferStarted(address indexed currentOwner, address indexed newOwner);
  event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);

  modifier onlyOwner() {
    require(msg.sender == owner, "OWNER_ONLY");
    _;
  }

  constructor() { owner = msg.sender; emit OwnershipTransferred(address(0), msg.sender); }

  function transferOwnership(address n) external onlyOwner {
    _pendingOwner = n; emit OwnershipTransferStarted(owner, n);
  }

  function acceptOwnership() external {
    require(msg.sender == _pendingOwner, "NOT_PENDING");
    address prev = owner; owner = _pendingOwner; _pendingOwner = address(0);
    emit OwnershipTransferred(prev, owner);
  }
}

/// @notice Simple pausability gated by owner
abstract contract Pausable is Ownable2Step {
  bool public paused;
  event Paused(address);
  event Unpaused(address);
  modifier whenNotPaused() { require(!paused, "PAUSED"); _; }
  function pause() external onlyOwner { paused = true; emit Paused(msg.sender); }
  function unpause() external onlyOwner { paused = false; emit Unpaused(msg.sender); }
}

/// @notice Minimal HyperLend pool interface placeholders. Replace with official ABI.
interface IHyperLendPoolSimple {
  /// @dev Confirm signature against HyperLend docs; this is modelled after Aave V3 "flashLoanSimple".
  function flashLoanSimple(
    address receiver,
    address asset,
    uint256 amount,
    bytes calldata params,
    uint16 referralCode
  ) external;
}

/// @notice Optional multi-asset flash loan entrypoint (placeholder). Confirm or remove when integrating.
interface IHyperLendPoolMultiAsset {
  function flashLoan(
    address receiver,
    address[] calldata assets,
    uint256[] calldata amounts,
    bytes calldata params,
    uint16 referralCode
  ) external;
}

/// @notice Flash-loan executor supporting two opaque router calls and strict profit checks.
contract ArbitrageExecutor is ReentrancyGuard, Pausable {
  using SafeERC20 for IERC20;

  /// @dev Pool expected to call back one of the below; we support both common shapes.
  address public immutable HYPERLEND_POOL;

  /// @notice Emitted after a successful flash arbitrage.
  event FlashArbExecuted(address indexed asset, uint256 amount, uint256 fee, address profitToken, uint256 profit);
  /// @notice Emitted when admin sweeps tokens.
  event Swept(address indexed token, address indexed to, uint256 amount);

  /// @notice Parameters encoded into flash-loan callback.
  struct FlashParams {
    address buyRouter;       // target contract for leg 1
    address buySpender;      // token spender for leg 1 approvals
    bytes   buyCalldata;     // low-level call data for leg 1

    address sellRouter;      // target contract for leg 2
    address sellSpender;     // token spender for leg 2 approvals
    bytes   sellCalldata;    // low-level call data for leg 2

    address tokenBorrowed;   // asset borrowed from pool
    address tokenIntermediate; // asset received after buy (sold in leg 2)
    address profitToken;     // token in which profit is measured (often same as tokenBorrowed)
    uint256 minProfit;       // required profit in profitToken AFTER repaying amount+fee
  }

  /// @param pool_ Set to the HyperLend pool address on the target chain.
  constructor(address pool_) {
    require(pool_ != address(0), "POOL_0");
    HYPERLEND_POOL = pool_;
  }

  // ===================== External: Initiation helpers (optional) =====================

  /// @notice Initiate a single-asset flash loan (provider-specific). Only owner can start.
  /// @dev Confirm the exact function name/signature on HyperLend; this is a placeholder.
  function initiateFlashArb(
    address asset,
    uint256 amount,
    bytes calldata params,
    uint16 referralCode
  ) external onlyOwner whenNotPaused {
    IHyperLendPoolSimple(HYPERLEND_POOL).flashLoanSimple(address(this), asset, amount, params, referralCode);
  }

  /// @notice Initiate a multi-asset flash loan (if provider supports). Placeholder ABI; comment out if unused.
  function initiateFlashArbMulti(
    address[] calldata assets,
    uint256[] calldata amounts,
    bytes calldata params,
    uint16 referralCode
  ) external onlyOwner whenNotPaused {
    IHyperLendPoolMultiAsset(HYPERLEND_POOL).flashLoan(address(this), assets, amounts, params, referralCode);
  }

  // ===================== Callback variants (provider-specific) =====================

  /// @dev Variant 1: Aave-style signature. Pool should call this on receiver.
  function onFlashLoan(
    address initiator,
    address asset,
    uint256 amount,
    uint256 fee,
    bytes calldata params
  ) external nonReentrant whenNotPaused returns (bytes32) {
    _validatePoolCaller();
    _validateInitiator(initiator);
    _handleFlashloan(asset, amount, fee, params);
    // Return value is not standardized across providers; this constant can be adjusted if needed.
    return keccak256("ArbitrageExecutor.onFlashLoan");
  }

  /// @dev Variant 2: Alternative naming used by some pools.
  function executeOperation(
    address asset,
    uint256 amount,
    uint256 fee,
    address initiator,
    bytes calldata params
  ) external nonReentrant whenNotPaused returns (bool) {
    _validatePoolCaller();
    _validateInitiator(initiator);
    _handleFlashloan(asset, amount, fee, params);
    return true;
  }

  // ===================== Core flash-loan handler =====================

  function _handleFlashloan(
    address asset,
    uint256 amount,
    uint256 fee,
    bytes calldata params
  ) internal {
    FlashParams memory p = abi.decode(params, (FlashParams));
    require(p.tokenBorrowed == asset, "ASSET_MISMATCH");

    // Snapshot profit token before operations
    uint256 beforeProfit = IERC20(p.profitToken).balanceOf(address(this));

    // Approve leg 1 (buy)
    if (p.buySpender != address(0) && amount > 0) {
      IERC20(asset).safeApprove(p.buySpender, 0);
      IERC20(asset).safeApprove(p.buySpender, amount);
    }
    _rawCall(p.buyRouter, p.buyCalldata);

    // Approve leg 2 (sell) for full intermediate balance
    uint256 midBal = IERC20(p.tokenIntermediate).balanceOf(address(this));
    if (p.sellSpender != address(0) && midBal > 0) {
      IERC20(p.tokenIntermediate).safeApprove(p.sellSpender, 0);
      IERC20(p.tokenIntermediate).safeApprove(p.sellSpender, midBal);
    }
    _rawCall(p.sellRouter, p.sellCalldata);

    // Repay loan: amount + fee in borrowed asset
    uint256 repay = amount + fee;
    IERC20(asset).safeTransfer(HYPERLEND_POOL, repay);

    // Best-effort allowance cleanup
    if (p.buySpender != address(0)) {
      IERC20(asset).safeApprove(p.buySpender, 0);
    }
    if (p.sellSpender != address(0)) {
      IERC20(p.tokenIntermediate).safeApprove(p.sellSpender, 0);
    }

    // Profit check in the chosen token
    uint256 afterProfit = IERC20(p.profitToken).balanceOf(address(this));
    require(afterProfit >= beforeProfit, "NEGATIVE_PROFIT");
    uint256 profit = afterProfit - beforeProfit;
    require(profit >= p.minProfit, "MIN_PROFIT");

    emit FlashArbExecuted(asset, amount, fee, p.profitToken, profit);
  }

  function _validatePoolCaller() internal view {
    require(msg.sender == HYPERLEND_POOL, "NOT_POOL");
  }

  function _validateInitiator(address initiator) internal view {
    // Allow pool to set initiator as this contract (common) or owner (alternative)
    require(initiator == address(this) || initiator == owner, "BAD_INITIATOR");
  }

  /// @dev Low-level opaque call. Reverts bubbling up the original reason.
  function _rawCall(address target, bytes memory data) internal {
    require(target != address(0), "TARGET_0");
    (bool ok, bytes memory ret) = target.call(data);
    if (!ok) {
      assembly {
        let size := mload(ret)
        revert(add(ret, 0x20), size)
      }
    }
  }

  // ===================== Admin utilities =====================

  /// @notice Sweep stray ERC20 tokens to a receiver.
  function sweep(address token, address to, uint256 amount) external onlyOwner {
    IERC20(token).safeTransfer(to, amount);
    emit Swept(token, to, amount);
  }

  /// @notice Optional: receive native asset in case routers refund gas token.
  receive() external payable {}
}
