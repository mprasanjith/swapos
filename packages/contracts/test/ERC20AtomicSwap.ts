import { EventFragment, FormatTypes, LogDescription } from '@ethersproject/abi'
import { TransactionResponse } from '@ethersproject/providers'
import { loadFixture, time } from '@nomicfoundation/hardhat-network-helpers'
import { expect } from 'chai'
import crypto, { BinaryLike } from 'crypto'
import { Contract } from 'ethers'
import { ethers } from 'hardhat'

describe('ERC20AtomicSwap between two ERC20 tokens', function() {
  const tokenSupply = 1000
  const senderInitialBalance = 100
  const tokenAmount = 5

  const deployContractsFixture = async () => {
    const [, Alice, Bob] = await ethers.getSigners()
    // if both tokens run on the same chain, they can share the HTLC contract to
    // coordinate the swap. They can also use separate instances on the same chain,
    // or even separate instances on different chains.
    // The key is the HTLC contract must be running on the same chain
    // that the target Token to be transferred between the two counterparties runs on

    const ERC20AtomicSwap = await ethers.getContractFactory('ERC20AtomicSwap')
    const htlc = await ERC20AtomicSwap.deploy()

    const AliceERC20 = await ethers.getContractFactory('AliceERC20')
    const aliceERC20 = await AliceERC20.deploy(tokenSupply)

    const BobERC20 = await ethers.getContractFactory('BobERC20')
    const bobERC20 = await BobERC20.deploy(tokenSupply)

    await aliceERC20.transfer(Alice.address, senderInitialBalance) // so Alice has some tokens to trade
    await bobERC20.transfer(Bob.address, senderInitialBalance) // so Bob has some tokens to trade

    const hashPair = newSecretHashPair()

    return {
      Alice,
      Bob,
      htlc,
      aliceERC20,
      bobERC20,
      hashPair,
    }
  }

  // Format required for sending bytes through eth client:
  //  - hex string representation
  //  - prefixed with 0x
  const bufToStr = (b: Buffer) => '0x' + b.toString('hex')

  const sha256 = (x: BinaryLike) =>
    crypto
      .createHash('sha256')
      .update(x)
      .digest()

  const random32 = () => crypto.randomBytes(32)

  const newSecretHashPair = () => {
    const secret = random32()
    const hash = sha256(secret)
    return {
      secret: bufToStr(secret),
      hash: bufToStr(hash),
    }
  }

  const getTxLogs = async (txResponse: TransactionResponse, contract: Contract) => {
    const txReceipt = await txResponse.wait()

    return txReceipt.logs
      .map(log => {
        try {
          return contract.interface.parseLog(log)
        } catch (e) {
          return null
        }
      })
      .filter((log): log is LogDescription => !!log)
  }

  const getTxLog = (txLogs: LogDescription[], event: EventFragment) => {
    return txLogs.find(log => event.format(FormatTypes.sighash) === log.signature)
  }

  it('Should be setup correctly', async function() {
    const { Alice, Bob, aliceERC20, bobERC20 } = await loadFixture(deployContractsFixture)

    expect(await aliceERC20.balanceOf(Alice.address)).to.equal(senderInitialBalance)
    expect(await aliceERC20.balanceOf(Bob.address)).to.equal(0)
    expect(await bobERC20.balanceOf(Bob.address)).to.equal(senderInitialBalance)
    expect(await bobERC20.balanceOf(Alice.address)).to.equal(0)
  })

  it('Should be working correctly in the happy path', async () => {
    const { Alice, Bob, aliceERC20, bobERC20, htlc, hashPair } = await loadFixture(
      deployContractsFixture,
    )

    // Step 1: Alice sets up a swap with Bob in the AliceERC20 contract
    // Alice initiates the swap by setting up a transfer of AliceERC20 tokens to Bob
    // she does not need to worry about Bob unilaterally take ownership of the tokens
    // without fulfilling his side of the deal, because this transfer is locked by a hashed secret
    // that only Alice knows at this point
    const aliceTimeLock = (await time.latest()) + 10 // 10 seconds
    await aliceERC20.connect(Alice).approve(htlc.address, tokenAmount)
    const aliceContractTx: TransactionResponse = await htlc
      .connect(Alice)
      .newContract(Bob.address, hashPair.hash, aliceTimeLock, aliceERC20.address, tokenAmount)
    const aliceTxLogs = await getTxLogs(aliceContractTx, htlc)
    const aliceTxEvent = getTxLog(aliceTxLogs, htlc.interface.getEvent('HTLCERC20Created'))
    const a2bSwapId = aliceTxEvent?.args.contractId

    expect(await aliceERC20.balanceOf(Alice.address)).to.equal(senderInitialBalance - tokenAmount)
    expect(await aliceERC20.balanceOf(htlc.address)).to.equal(tokenAmount)

    // Step 2: Bob sets up a swap with Alice in the BobERC20 contract
    // Bob having observed the contract getting set up by Alice in the AliceERC20, now
    // responds by setting up the corresponding contract in the BobERC20, using the same
    // hash lock as Alice' side of the deal, so that he can be guaranteed Alice must
    // disclose the secret to unlock the BobERC20 tokens transfer, and the same secret can then
    // be used to unlock the AliceERC20 transfer
    const bobTimeLock = (await time.latest()) + 5 // 5 seconds

    await bobERC20.connect(Bob).approve(htlc.address, tokenAmount)
    const bobContractTx: TransactionResponse = await htlc
      .connect(Bob)
      .newContract(Alice.address, hashPair.hash, bobTimeLock, bobERC20.address, tokenAmount)
    const bobTxLogs = await getTxLogs(bobContractTx, htlc)
    const bobTxEvent = getTxLog(bobTxLogs, htlc.interface.getEvent('HTLCERC20Created'))
    const b2aSwapId = bobTxEvent?.args.contractId

    expect(await bobERC20.balanceOf(Bob.address)).to.equal(senderInitialBalance - tokenAmount)
    expect(await bobERC20.balanceOf(htlc.address)).to.equal(tokenAmount)

    // Step 3: Alice as the initiator withdraws from the BobERC20 with the secret
    // Alice has the original secret, calls withdraw with the secret to claim the EU tokens
    await htlc.connect(Alice).withdraw(b2aSwapId, hashPair.secret)

    // Check tokens now owned by Alice
    expect(await bobERC20.balanceOf(Alice.address)).to.equal(tokenAmount)
    expect(await bobERC20.balanceOf(htlc.address)).to.equal(0)

    const b2aContract = await htlc.getContract(b2aSwapId)
    expect(b2aContract.withdrawn).to.equal(true) // withdrawn set
    expect(b2aContract.refunded).to.equal(false) // refunded still false

    // with this the secret is out in the open and Bob will have knowledge of it
    expect(b2aContract.preimage).to.equal(hashPair.secret)
    const learnedSecret = b2aContract.preimage

    // Step 4: Bob as the counterparty withdraws from the AliceERC20 with the secret learned from Alice's withdrawal
    await htlc.connect(Bob).withdraw(a2bSwapId, learnedSecret)

    // Check tokens now owned by Bob
    expect(await aliceERC20.balanceOf(Bob.address)).to.equal(tokenAmount)

    const a2bContract = await htlc.getContract(a2bSwapId)
    expect(a2bContract.withdrawn).to.equal(true) // withdrawn set
    expect(a2bContract.refunded).to.equal(false) // refunded still false
    expect(a2bContract.preimage).to.equal(learnedSecret)
  })

  it('Should allow refunds', async () => {
    const { Alice, Bob, aliceERC20, bobERC20, htlc, hashPair } = await loadFixture(
      deployContractsFixture,
    )

    // the swap is set up with 5 second timeout on both sides
    const timeLock = (await time.latest()) + 5

    await aliceERC20.connect(Alice).approve(htlc.address, tokenAmount)
    await bobERC20.connect(Bob).approve(htlc.address, tokenAmount)

    const aliceContractTx: TransactionResponse = await htlc
      .connect(Alice)
      .newContract(Bob.address, hashPair.hash, timeLock, aliceERC20.address, tokenAmount)

    const bobContractTx: TransactionResponse = await htlc
      .connect(Bob)
      .newContract(Alice.address, hashPair.hash, timeLock, bobERC20.address, tokenAmount)

    const aliceTxLogs = await getTxLogs(aliceContractTx, htlc)
    const aliceTxEvent = getTxLog(aliceTxLogs, htlc.interface.getEvent('HTLCERC20Created'))
    const a2bSwapId = aliceTxEvent?.args.contractId

    expect(await aliceERC20.balanceOf(Alice.address)).to.equal(senderInitialBalance - tokenAmount)
    expect(await aliceERC20.balanceOf(htlc.address)).to.equal(tokenAmount)

    const bobTxLogs = await getTxLogs(bobContractTx, htlc)
    const bobTxEvent = getTxLog(bobTxLogs, htlc.interface.getEvent('HTLCERC20Created'))
    const b2aSwapId = bobTxEvent?.args.contractId

    expect(await bobERC20.balanceOf(Bob.address)).to.equal(senderInitialBalance - tokenAmount)
    expect(await bobERC20.balanceOf(htlc.address)).to.equal(tokenAmount)

    await time.increaseTo(timeLock)

    // after the timeout expiry Alice calls refund() to get her tokens back
    const aliceRefundTx = await htlc.connect(Alice).refund(a2bSwapId)
    const aliceRefundTxLogs = await getTxLogs(aliceRefundTx, htlc)
    const aliceRefundTxEvent = getTxLog(
      aliceRefundTxLogs,
      htlc.interface.getEvent('HTLCERC20Refunded'),
    )
    expect(aliceRefundTxEvent).to.not.equal(undefined)

    expect(await aliceERC20.balanceOf(Alice.address)).to.equal(senderInitialBalance)
    expect(await aliceERC20.balanceOf(htlc.address)).to.equal(0)

    // Bob can also get his tokens back by calling refund()
    const bobRefundTx = await htlc.connect(Bob).refund(b2aSwapId)
    const bobRefundTxLogs = await getTxLogs(bobRefundTx, htlc)
    const bobRefundTxEvent = getTxLog(bobRefundTxLogs, htlc.interface.getEvent('HTLCERC20Refunded'))
    expect(bobRefundTxEvent).to.not.equal(undefined)

    expect(await bobERC20.balanceOf(Bob.address)).to.equal(senderInitialBalance)
    expect(await bobERC20.balanceOf(htlc.address)).to.equal(0)
  })

  it('should not allow deposits without approval', async () => {
    const { Alice, Bob, aliceERC20, htlc, hashPair } = await loadFixture(deployContractsFixture)

    const aliceTimeLock = (await time.latest()) + 5 // 5 seconds
    await expect(
      htlc
        .connect(Alice)
        .newContract(Bob.address, hashPair.hash, aliceTimeLock, aliceERC20.address, tokenAmount),
    ).to.be.revertedWith('tokensTransferable: token allowance must be >= amount')
  })

  it('should not allow deposits without balance', async () => {
    const { Alice, Bob, aliceERC20, htlc, hashPair } = await loadFixture(deployContractsFixture)

    const aliceTimeLock = (await time.latest()) + 5 // 5 seconds
    await aliceERC20.connect(Alice).approve(htlc.address, tokenAmount)
    await expect(
      htlc
        .connect(Alice)
        .newContract(Bob.address, hashPair.hash, aliceTimeLock, aliceERC20.address, 0),
    ).to.be.revertedWith('tokensTransferable: token amount must be > 0')
  })

  it('should not allow deposits with timelock in the past', async () => {
    const { Alice, Bob, aliceERC20, htlc, hashPair } = await loadFixture(deployContractsFixture)

    await aliceERC20.connect(Alice).approve(htlc.address, tokenAmount)

    let aliceTimeLock = await time.latest() // current time
    await expect(
      htlc
        .connect(Alice)
        .newContract(Bob.address, hashPair.hash, aliceTimeLock, aliceERC20.address, tokenAmount),
    ).to.be.revertedWith('futureTimelock: timelock time must be in the future')

    aliceTimeLock = (await time.latest()) - 5 // current time
    await expect(
      htlc
        .connect(Alice)
        .newContract(Bob.address, hashPair.hash, aliceTimeLock, aliceERC20.address, tokenAmount),
    ).to.be.revertedWith('futureTimelock: timelock time must be in the future')
  })

  it('should not allow duplicate contract IDs', async () => {
    const { Alice, Bob, aliceERC20, htlc, hashPair } = await loadFixture(deployContractsFixture)

    await aliceERC20.connect(Alice).approve(htlc.address, tokenAmount * 2)

    const aliceTimeLock = (await time.latest()) + 5 // current time
    await htlc
      .connect(Alice)
      .newContract(Bob.address, hashPair.hash, aliceTimeLock, aliceERC20.address, tokenAmount)

    await expect(
      htlc
        .connect(Alice)
        .newContract(Bob.address, hashPair.hash, aliceTimeLock, aliceERC20.address, tokenAmount),
    ).to.be.revertedWith('newContract: Contract already exists')
  })

  it('should not allow withdrawals on non-existing contracts', async () => {
    const { Bob, htlc, hashPair } = await loadFixture(deployContractsFixture)

    await expect(
      htlc
        .connect(Bob)
        .withdraw(
          '0x2335bdc450f6affcf18b52ea4e50076346d79533fe5131664b50feea35e0f307',
          hashPair.secret,
        ),
    ).to.be.revertedWith('contractExists: contractId does not exist')
  })

  it('should not allow withdrawals on incorrect hashlock', async () => {
    const { Alice, Bob, aliceERC20, htlc, hashPair } = await loadFixture(deployContractsFixture)

    // Step 1: Alice sets up a swap with Bob in the AliceERC20 contract
    const aliceTimeLock = (await time.latest()) + 5 // 5 seconds
    await aliceERC20.connect(Alice).approve(htlc.address, tokenAmount)
    const aliceContractTx: TransactionResponse = await htlc
      .connect(Alice)
      .newContract(Bob.address, hashPair.hash, aliceTimeLock, aliceERC20.address, tokenAmount)
    const aliceTxLogs = await getTxLogs(aliceContractTx, htlc)
    const aliceTxEvent = getTxLog(aliceTxLogs, htlc.interface.getEvent('HTLCERC20Created'))

    const a2bSwapId = aliceTxEvent?.args.contractId

    await expect(htlc.connect(Bob).withdraw(a2bSwapId, hashPair.hash)).to.be.revertedWith(
      'hashlockMatches: hashlock hash does not match',
    )
    expect(await aliceERC20.balanceOf(Bob.address)).to.equal(0)
    expect(await aliceERC20.balanceOf(htlc.address)).to.equal(tokenAmount)
  })

  it('should only allow withdrawals from receiver', async () => {
    const { Alice, Bob, aliceERC20, htlc, hashPair } = await loadFixture(deployContractsFixture)

    // Step 1: Alice sets up a swap with Bob in the AliceERC20 contract
    const aliceTimeLock = (await time.latest()) + 5 // 5 seconds
    await aliceERC20.connect(Alice).approve(htlc.address, tokenAmount)
    const aliceContractTx: TransactionResponse = await htlc
      .connect(Alice)
      .newContract(Bob.address, hashPair.hash, aliceTimeLock, aliceERC20.address, tokenAmount)
    const aliceTxLogs = await getTxLogs(aliceContractTx, htlc)
    const aliceTxEvent = getTxLog(aliceTxLogs, htlc.interface.getEvent('HTLCERC20Created'))

    const a2bSwapId = aliceTxEvent?.args.contractId

    await expect(htlc.connect(Alice).withdraw(a2bSwapId, hashPair.secret)).to.be.revertedWith(
      'withdrawable: not receiver',
    )
    expect(await aliceERC20.balanceOf(Alice.address)).to.equal(senderInitialBalance - tokenAmount)
    expect(await aliceERC20.balanceOf(Bob.address)).to.equal(0)
    expect(await aliceERC20.balanceOf(htlc.address)).to.equal(tokenAmount)
  })

  it('should not allow duplicate withdrawals', async () => {
    const { Alice, Bob, aliceERC20, htlc, hashPair } = await loadFixture(deployContractsFixture)

    // Step 1: Alice sets up a swap with Bob in the AliceERC20 contract
    const aliceTimeLock = (await time.latest()) + 5 // 5 seconds
    await aliceERC20.connect(Alice).approve(htlc.address, tokenAmount)
    const aliceContractTx: TransactionResponse = await htlc
      .connect(Alice)
      .newContract(Bob.address, hashPair.hash, aliceTimeLock, aliceERC20.address, tokenAmount)
    const aliceTxLogs = await getTxLogs(aliceContractTx, htlc)
    const aliceTxEvent = getTxLog(aliceTxLogs, htlc.interface.getEvent('HTLCERC20Created'))

    const a2bSwapId = aliceTxEvent?.args.contractId
    await htlc.connect(Bob).withdraw(a2bSwapId, hashPair.secret)

    await expect(htlc.connect(Bob).withdraw(a2bSwapId, hashPair.secret)).to.be.revertedWith(
      'withdrawable: already withdrawn',
    )
    expect(await aliceERC20.balanceOf(Alice.address)).to.equal(senderInitialBalance - tokenAmount)
    expect(await aliceERC20.balanceOf(Bob.address)).to.equal(tokenAmount)
    expect(await aliceERC20.balanceOf(htlc.address)).to.equal(0)
  })

  it('should not allow withdrawals after timelock', async () => {
    const { Alice, Bob, aliceERC20, htlc, hashPair } = await loadFixture(deployContractsFixture)

    // Step 1: Alice sets up a swap with Bob in the AliceERC20 contract
    const aliceTimeLock = (await time.latest()) + 5 // 5 seconds
    await aliceERC20.connect(Alice).approve(htlc.address, tokenAmount)
    const aliceContractTx: TransactionResponse = await htlc
      .connect(Alice)
      .newContract(Bob.address, hashPair.hash, aliceTimeLock, aliceERC20.address, tokenAmount)
    const aliceTxLogs = await getTxLogs(aliceContractTx, htlc)
    const aliceTxEvent = getTxLog(aliceTxLogs, htlc.interface.getEvent('HTLCERC20Created'))

    const a2bSwapId = aliceTxEvent?.args.contractId

    await time.increaseTo(aliceTimeLock)

    await expect(htlc.connect(Bob).withdraw(a2bSwapId, hashPair.secret)).to.be.revertedWith(
      'withdrawable: timelock expired',
    )
    expect(await aliceERC20.balanceOf(Bob.address)).to.equal(0)
    expect(await aliceERC20.balanceOf(htlc.address)).to.equal(tokenAmount)
  })

  it('should not allow refunds on non-existing contracts', async () => {
    const { Bob, htlc } = await loadFixture(deployContractsFixture)

    await expect(
      htlc
        .connect(Bob)
        .refund('0x2335bdc450f6affcf18b52ea4e50076346d79533fe5131664b50feea35e0f307'),
    ).to.be.revertedWith('contractExists: contractId does not exist')
  })

  it('should only allow refunds from sender', async () => {
    const { Alice, Bob, aliceERC20, htlc, hashPair } = await loadFixture(deployContractsFixture)

    // Step 1: Alice sets up a swap with Bob in the AliceERC20 contract
    const aliceTimeLock = (await time.latest()) + 5 // 5 seconds
    await aliceERC20.connect(Alice).approve(htlc.address, tokenAmount)
    const aliceContractTx: TransactionResponse = await htlc
      .connect(Alice)
      .newContract(Bob.address, hashPair.hash, aliceTimeLock, aliceERC20.address, tokenAmount)
    const aliceTxLogs = await getTxLogs(aliceContractTx, htlc)
    const aliceTxEvent = getTxLog(aliceTxLogs, htlc.interface.getEvent('HTLCERC20Created'))

    const a2bSwapId = aliceTxEvent?.args.contractId

    await time.increaseTo(aliceTimeLock)

    await expect(htlc.connect(Bob).refund(a2bSwapId)).to.be.revertedWith('refundable: not sender')
    expect(await aliceERC20.balanceOf(Alice.address)).to.equal(senderInitialBalance - tokenAmount)
    expect(await aliceERC20.balanceOf(Bob.address)).to.equal(0)
    expect(await aliceERC20.balanceOf(htlc.address)).to.equal(tokenAmount)
  })

  it('should not allow duplicate refunds', async () => {
    const { Alice, Bob, aliceERC20, htlc, hashPair } = await loadFixture(deployContractsFixture)

    // Step 1: Alice sets up a swap with Bob in the AliceERC20 contract
    const aliceTimeLock = (await time.latest()) + 5 // 5 seconds
    await aliceERC20.connect(Alice).approve(htlc.address, tokenAmount)
    const aliceContractTx: TransactionResponse = await htlc
      .connect(Alice)
      .newContract(Bob.address, hashPair.hash, aliceTimeLock, aliceERC20.address, tokenAmount)
    const aliceTxLogs = await getTxLogs(aliceContractTx, htlc)
    const aliceTxEvent = getTxLog(aliceTxLogs, htlc.interface.getEvent('HTLCERC20Created'))
    const a2bSwapId = aliceTxEvent?.args.contractId

    await time.increaseTo(aliceTimeLock)

    await htlc.connect(Alice).refund(a2bSwapId)

    await expect(htlc.connect(Alice).refund(a2bSwapId)).to.be.revertedWith(
      'refundable: already refunded',
    )
    expect(await aliceERC20.balanceOf(Alice.address)).to.equal(senderInitialBalance)
    expect(await aliceERC20.balanceOf(Bob.address)).to.equal(0)
    expect(await aliceERC20.balanceOf(htlc.address)).to.equal(0)
  })

  it('should not allow refunds on withdrawn contracts', async () => {
    const { Alice, Bob, aliceERC20, htlc, hashPair } = await loadFixture(deployContractsFixture)

    // Step 1: Alice sets up a swap with Bob in the AliceERC20 contract
    const aliceTimeLock = (await time.latest()) + 5 // 5 seconds
    await aliceERC20.connect(Alice).approve(htlc.address, tokenAmount)
    const aliceContractTx: TransactionResponse = await htlc
      .connect(Alice)
      .newContract(Bob.address, hashPair.hash, aliceTimeLock, aliceERC20.address, tokenAmount)
    const aliceTxLogs = await getTxLogs(aliceContractTx, htlc)
    const aliceTxEvent = getTxLog(aliceTxLogs, htlc.interface.getEvent('HTLCERC20Created'))
    const a2bSwapId = aliceTxEvent?.args.contractId

    await htlc.connect(Bob).withdraw(a2bSwapId, hashPair.secret)

    await time.increaseTo(aliceTimeLock)

    await expect(htlc.connect(Alice).refund(a2bSwapId)).to.be.revertedWith(
      'refundable: already withdrawn',
    )
    expect(await aliceERC20.balanceOf(Alice.address)).to.equal(senderInitialBalance - tokenAmount)
    expect(await aliceERC20.balanceOf(Bob.address)).to.equal(tokenAmount)
    expect(await aliceERC20.balanceOf(htlc.address)).to.equal(0)
  })

  it('should not allow refunds before timelock', async () => {
    const { Alice, Bob, aliceERC20, htlc, hashPair } = await loadFixture(deployContractsFixture)

    // Step 1: Alice sets up a swap with Bob in the AliceERC20 contract
    const aliceTimeLock = (await time.latest()) + 5 // 5 seconds
    await aliceERC20.connect(Alice).approve(htlc.address, tokenAmount)
    const aliceContractTx: TransactionResponse = await htlc
      .connect(Alice)
      .newContract(Bob.address, hashPair.hash, aliceTimeLock, aliceERC20.address, tokenAmount)
    const aliceTxLogs = await getTxLogs(aliceContractTx, htlc)
    const aliceTxEvent = getTxLog(aliceTxLogs, htlc.interface.getEvent('HTLCERC20Created'))

    const a2bSwapId = aliceTxEvent?.args.contractId

    await expect(htlc.connect(Alice).refund(a2bSwapId)).to.be.revertedWith(
      'refundable: timelock not yet passed',
    )
    expect(await aliceERC20.balanceOf(Alice.address)).to.equal(senderInitialBalance - tokenAmount)
    expect(await aliceERC20.balanceOf(htlc.address)).to.equal(tokenAmount)

    await time.increaseTo(aliceTimeLock)

    await htlc.connect(Alice).refund(a2bSwapId)
    expect(await aliceERC20.balanceOf(Alice.address)).to.equal(senderInitialBalance)
    expect(await aliceERC20.balanceOf(htlc.address)).to.equal(0)
  })
})
