// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {ERC8056BaseUpgradeable} from "./ERC8056BaseUpgradeable.sol";

/**
 * @dev Concrete BeaconProxy-deployable EIP-8056 token.
 *
 * Ready to deploy — no subclassing required. Deploy via:
 *   npm run deploy:upgradeable:testnet
 *   npm run deploy:upgradeable:mainnet
 *
 * To extend with custom logic, inherit from {ERC8056BaseUpgradeable} instead
 * and implement {_authorizeMultiplierUpdate}.
 */
contract ERC8056TokenUpgradeable is ERC8056BaseUpgradeable, OwnableUpgradeable {
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initializes the token. Called once by the proxy on first deployment.
     * @param name_         Token name.
     * @param symbol_       Token symbol.
     * @param initialSupply Initial supply in whole tokens (scaled by decimals internally).
     * @param initialOwner  Address that receives the initial supply and becomes owner.
     */
    function initialize(
        string memory name_,
        string memory symbol_,
        uint256 initialSupply,
        address initialOwner
    ) public initializer {
        __erc8056Base_init(name_, symbol_);
        __Ownable_init(initialOwner);
        _mint(initialOwner, initialSupply * 10 ** decimals());
    }

    function _authorizeMultiplierUpdate() internal override onlyOwner {}
}
