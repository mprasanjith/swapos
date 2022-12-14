// SPDX-License-Identifier: GPL-2.0-or-later

pragma solidity ^0.8.8;

import '@openzeppelin/contracts/token/ERC20/ERC20.sol';

/**
 * A basic token for testing the HashedTimelockERC20.
 */
contract AliceERC20 is ERC20 {
  constructor(uint256 initialSupply) ERC20('AliceToken', 'ALICE') {
    _mint(msg.sender, initialSupply);
  }
}
