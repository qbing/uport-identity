const lightwallet = require('eth-signer')
const evm_increaseTime = require('./evmIncreaseTime.js')
const snapshots = require('./evmSnapshots.js')
const IdentityManager = artifacts.require('IdentityManager')
const Proxy = artifacts.require('Proxy')
const TestRegistry = artifacts.require('TestRegistry')
const Promise = require('bluebird')
const compareCode = require('./compareCode')
web3.eth = Promise.promisifyAll(web3.eth)

const LOG_NUMBER_1 = 1234
const LOG_NUMBER_2 = 2345

const userTimeLock = 100;
const adminTimeLock = 1000;
const adminRate = 200;

function getRanomNumber() {
  return Math.floor(Math.random() * (1000000 - 1)) + 1;
}

async function testForwardTo(testReg, identityManager, proxyAddress, fromAccount, shouldEqual) {
  let errorThrown = false
  let testNum = getRanomNumber()
  // Encode the transaction to send to the proxy contract
  let data = lightwallet.txutils._encodeFunctionTxData('register', ['uint256'], [testNum])
  // Send forward request from the owner
  try {
    await identityManager.forwardTo(proxyAddress, testReg.address, 0, '0x' + data, {from: fromAccount})
  } catch (error) {
    errorThrown = error.message
  }
  let regData = await testReg.registry.call(proxyAddress)
  if (shouldEqual) {
    assert.isNotOk(errorThrown, 'An error should not have been thrown')
    assert.equal(regData.toNumber(), testNum)
  } else {
    assert.match(errorThrown, /VM Exception while processing transaction: invalid opcode/, 'throws an error')
    assert.notEqual(regData.toNumber(), testNum)
  }
}


contract('IdentityManager', (accounts) => {
  let proxy
  let deployedProxy
  let testReg
  let identityManager
  let user1
  let user2
  let user3
  let user4
  let user5
  let nobody

  let recoveryKey
  let recoveryKey2

  let snapshotId

  before(async function() {
    // Truffle deploys contracts with accounts[0]
    user1 = accounts[0]
    nobody = accounts[1] // has no authority
    user2 = accounts[2]
    user3 = accounts[3]
    user4 = accounts[4]
    user5 = accounts[5]
    recoveryKey = accounts[8]
    recoveryKey2 = accounts[9]
    identityManager = await IdentityManager.new(userTimeLock, adminTimeLock, adminRate)
    deployedProxy = await Proxy.new({from: user1})
    testReg = await TestRegistry.deployed()
    //   return snapshots.snapshot()
    // }).then(id => {
    //   snapshotId = id
  })

  // afterEach(done => {
  //   snapshots.revert(snapshotId)
  //   done()
  // })

  it('Correctly creates Identity', async function() {
    let tx = await identityManager.createIdentity(user1, recoveryKey, {from: nobody})
    let log = tx.logs[0]
    assert.equal(log.event, 'IdentityCreated', 'wrong event')

    assert.equal(log.args.owner,
                 user1,
                 'Owner key is set in event')
    assert.equal(log.args.recoveryKey,
                 recoveryKey,
                 'Recovery key is set in event')
    assert.equal(log.args.creator,
                 nobody,
                 'Creator is set in event')

    await compareCode(log.args.identity, deployedProxy.address)
    let proxyOwner = await Proxy.at(log.args.identity).owner.call()
    assert.equal(proxyOwner, identityManager.address, 'Proxy owner should be the identity manager')
  })

  describe('existing identity', () => {

    beforeEach(async function() {
      let tx = await identityManager.createIdentity(user1, recoveryKey, {from: nobody})
      let log = tx.logs[0]
      assert.equal(log.event, 'IdentityCreated', 'wrong event')
      proxy = Proxy.at(log.args.identity)
    })

    it('allow transactions initiated by owner', async function() {
      await testForwardTo(testReg, identityManager, proxy.address, user1, true)
    })

    it('don\'t allow transactions initiated by non owner', async function() {
      await testForwardTo(testReg, identityManager, proxy.address, user2, false)
    })

    it('don\'t allow transactions initiated by recoveryKey', async function() {
      await testForwardTo(testReg, identityManager, proxy.address, recoveryKey, false)
    })

    it('owner can add other owner', async function() {
      let isOwner = await identityManager.isOwner(proxy.address, user5, {from: user1})
      assert.isFalse(isOwner, 'user5 should not be owner yet')
      let tx = await identityManager.addOwner(proxy.address, user5, {from: user1})
      let log = tx.logs[0]
      assert.equal(log.event, 'OwnerAdded', 'should trigger correct event')
      assert.equal(log.args.identity,
                  proxy.address,
                  'event should be for correct proxy')
      assert.equal(log.args.owner,
                  user5,
                  'Owner key is set in event')
      assert.equal(log.args.instigator,
                  user1,
                  'Instigator key is set in event')
      isOwner = await identityManager.isOwner(proxy.address, user5, {from: user1})
      assert.isTrue(isOwner, 'user5 should be owner now')
    })

    it('non-owner can not add other owner', async function() {
      try {
        await identityManager.addOwner(proxy.address, user4, {from: user3})
      } catch(error) {
        assert.match(error.message, /VM Exception while processing transaction: invalid opcode/, 'throws an error')
      }
    })

    describe('new owner added by owner', () => {
      beforeEach(async function() {
        await identityManager.addOwner(proxy.address, user2, {from: user1})
        errorThrown = false
      })

      it('can send transactions directly', async function() {
        await testForwardTo(testReg, identityManager, proxy.address, user2, true)
      })

      describe('after userTimeLock', () => {
        beforeEach(() => evm_increaseTime(userTimeLock))

        it('can not add other owner yet', async function() {
          try {
            await identityManager.addOwner(proxy.address, user4, {from: user2})
          } catch(error) {
            assert.match(error.message, /VM Exception while processing transaction: invalid opcode/, 'throws an error')
          }
        })

        it('can not remove other owner yet', async function() {
          try {
            await identityManager.removeOwner(proxy.address, user1, {from: user2})
          } catch(error) {
            assert.match(error.message, /VM Exception while processing transaction: invalid opcode/, 'throws an error')
          }
        })

        it('can not change recoveryKey yet', async function() {
          try {
            await identityManager.changeRecovery(proxy.address, recoveryKey2, {from: user2})
          } catch(error) {
            assert.match(error.message, /VM Exception while processing transaction: invalid opcode/, 'throws an error')
          }
        })
      })

      describe('after adminTimeLock', () => {
        beforeEach(() => evm_increaseTime(adminTimeLock))

        it('can add new owner', async function() {
          let tx = await identityManager.addOwner(proxy.address, user3, {from: user2})
          const log = tx.logs[0]
          assert.equal(log.args.owner,
                      user3,
                      'Owner key is set in event')
          assert.equal(log.args.instigator,
                      user2,
                      'Instigator key is set in event')
        })

        it('can remove other owner', async function() {
          let tx = await identityManager.removeOwner(proxy.address, user1, {from: user2})
          const log = tx.logs[0]
          assert.equal(log.args.owner,
                      user1,
                      'Owner key is set in event')
          assert.equal(log.args.instigator,
                      user2,
                      'Instigator key is set in event')
        })

        it('can change recoveryKey', async function() {
          let isRecovery = await identityManager.isRecovery(proxy.address, recoveryKey2, {from: user1})
          assert.isFalse(isRecovery, 'recoveryKey2 should not be recovery yet')
          let tx = await identityManager.changeRecovery(proxy.address, recoveryKey2, {from: user2})
          const log = tx.logs[0]
          assert.equal(log.args.recoveryKey,
                      recoveryKey2,
                      'recoveryKey key is set in event')
          assert.equal(log.args.instigator,
                      user2,
                      'Instigator key is set in event')
          isRecovery = await identityManager.isRecovery(proxy.address, recoveryKey2, {from: user1})
          assert.isTrue(isRecovery, 'recoveryKey2 should be recovery now')
        })
      })
    })

    describe('new owner added by recoveryKey', () => {
      beforeEach(async function() {
        await identityManager.addOwnerFromRecovery(proxy.address, user2, {from: recoveryKey})
      })

      it('within userTimeLock is not allowed transactions', async function() {
        await testForwardTo(testReg, identityManager, proxy.address, user2, false)
      })

      describe('after userTimeLock', () => {
        beforeEach(() => evm_increaseTime(userTimeLock))

        it('Allow transactions', async function() {
          await testForwardTo(testReg, identityManager, proxy.address, user2, true)
        })
      })

      describe('after adminTimeLock', () => {
        beforeEach(() => evm_increaseTime(adminTimeLock))

        it('can add new owner', async function() {
          let tx = await identityManager.addOwner(proxy.address, user3, {from: user2})
          const log = tx.logs[0]
          assert.equal(log.args.owner,
                      user3,
                      'Owner key is set in event')
          assert.equal(log.args.instigator,
                      user2,
                      'Instigator key is set in event')
        })

        it('can remove other owner', async function() {
          let tx = await identityManager.removeOwner(proxy.address, user1, {from: user2})
          const log = tx.logs[0]
          assert.equal(log.args.owner,
                      user1,
                      'Owner key is set in event')
          assert.equal(log.args.instigator,
                      user2,
                      'Instigator key is set in event')
        })

        it('can change recoveryKey', async function() {
          let tx = await identityManager.changeRecovery(proxy.address, recoveryKey2, {from: user2})
          const log = tx.logs[0]
          assert.equal(log.args.recoveryKey,
                      recoveryKey2,
                      'recoveryKey key is set in event')
          assert.equal(log.args.instigator,
                      user2,
                      'Instigator key is set in event')
        })
      })
    })
  })

  describe('migration', () => {
    let newIdenManager
    beforeEach(async function() {
      let tx = await identityManager.createIdentity(user1, recoveryKey, {from: nobody})
      let log = tx.logs[0]
      assert.equal(log.event, 'IdentityCreated', 'wrong event')
      proxy = Proxy.at(log.args.identity)
      newIdenManager = await IdentityManager.new(userTimeLock, adminTimeLock, adminRate)
      //user2 is now a younger owner, while user1 is an olderowner
      tx = await identityManager.addOwner(proxy.address, user2)
      log = tx.logs[0]
      assert.equal(log.event, 'OwnerAdded', 'wrong event')
      assert.equal(log.args.identity, proxy.address, 'wrong proxy')
      assert.equal(log.args.owner, user2, 'wrong owner added')
      assert.equal(log.args.instigator, user1, 'wrong initiator')
    })

    it('older owner can start transfer', async function() {
      let tx = await identityManager.initiateMigration(proxy.address, newIdenManager.address, {from: user1})
      let log = tx.logs[0]
      assert.equal(log.event, 'MigrationInitiated', 'wrong event initiated')
      assert.equal(log.args.identity, proxy.address, 'migrating wrong proxy')
      assert.equal(log.args.newIdManager, newIdenManager.address, 'migrating to wrong location')
      assert.equal(log.args.instigator, user1, 'migrating to wrong location')
    })

    it('young owner should not be able to start transfer', async function() {
      let threwError = false
      try {
        await identityManager.initiateMigration(proxy.address, newIdenManager.address, {from: user2})
      } catch(error) {
        assert.match(error.message, /VM Exception while processing transaction: invalid opcode/, 'throws an error')
        threwError = true
      }
      assert.isTrue(threwError, 'Should have thrown an error here')
    })

    it('non-owner should not be able to start transfer' , async function() {
      let threwError = false
      try {
        await identityManager.initiateMigration(proxy.address, newIdenManager.address, {from: nobody})
      } catch(error) {
        assert.match(error.message, /VM Exception while processing transaction: invalid opcode/, 'throws an error')
        threwError = true
      }
      assert.isTrue(threwError, 'Should have thrown an error here')
    })

    it('correct keys can cancel migration', async function() {
      let tx = await identityManager.initiateMigration(proxy.address, newIdenManager.address, {from: user1})
      let log = tx.logs[0]
      assert.equal(log.event, 'MigrationInitiated', 'wrong event initiated')
      assert.equal(log.args.identity, proxy.address, 'migrating wrong proxy')
      assert.equal(log.args.newIdManager, newIdenManager.address, 'migrating to wrong location')
      assert.equal(log.args.instigator, user1, 'started migrating from wrong user')

      tx = await identityManager.cancelMigration(proxy.address, {from: user1})
      log = tx.logs[0]
      assert.equal(log.event, 'MigrationCanceled', 'wrong event initiated')
      assert.equal(log.args.identity, proxy.address, 'canceled migrating wrong proxy')
      assert.equal(log.args.newIdManager, newIdenManager.address, 'canceled migration to wrong location')
      assert.equal(log.args.instigator, user1, 'canceled migrating from wrong user')

      //set up migration again
      tx = await identityManager.initiateMigration(proxy.address, newIdenManager.address, {from: user1})
      //Second migration attempt, should allow
      log = tx.logs[0]
      assert.equal(log.event, 'MigrationInitiated', 'wrong event initiated')
      assert.equal(log.args.identity, proxy.address, 'migrating wrong proxy')
      assert.equal(log.args.newIdManager, newIdenManager.address, 'migrating to wrong location')
      assert.equal(log.args.instigator, user1, 'started migrating from wrong person')

      await evm_increaseTime(userTimeLock)
      tx = await identityManager.cancelMigration(proxy.address, {from: user2})
      //young owner should also be able to cancel migration
      log = tx.logs[0]
      assert.equal(log.event, 'MigrationCanceled', 'wrong event initiated')
      assert.equal(log.args.identity, proxy.address, 'canceled migrating wrong proxy')
      assert.equal(log.args.newIdManager, newIdenManager.address, 'canceled migration to wrong location')
      assert.equal(log.args.instigator, user2, 'canceled migrating from wrong person')

      await identityManager.initiateMigration(proxy.address, newIdenManager.address, {from: user1})
      //Don't need to check setup again
      let threwError = false
      try {
        await identityManager.cancelMigration(proxy.address, {from: nobody})
      } catch(error) {
        assert.match(error.message, /VM Exception while processing transaction: invalid opcode/, 'throws an error')
        threwError = true
      }
      assert.isTrue(threwError, 'Should have thrown error')
    })

    it('correct keys should finilize transfer', async function() {
      await identityManager.initiateMigration(proxy.address, newIdenManager.address, {from: user1})
      let threwError = false
      try {
          await identityManager.finalizeMigration(proxy.address, {from: nobody})
      } catch(error) {
        assert.match(error.message, /VM Exception while processing transaction: invalid opcode/, 'throws an error')
        threwError = true
      }
      assert.isTrue(threwError, 'non-owner should not be able to finalize')
      threwError = false
      try {
          await identityManager.finalizeMigration(proxy.address, {from: user2})
      } catch(error) {
        assert.match(error.message, /VM Exception while processing transaction: invalid opcode/, 'throws an error')
        threwError = true
      }
      assert.isTrue(threwError, 'young owner should not be able to finalize')

      await evm_increaseTime(2 * adminTimeLock)
      let tx = await identityManager.finalizeMigration(proxy.address, {from: user1})
      let log = tx.logs[0]
      assert.equal(log.event, 'MigrationFinalized', 'wrong event initiated')
      assert.equal(log.args.identity, proxy.address, 'finalized migrating wrong proxy')
      assert.equal(log.args.newIdManager, newIdenManager.address, 'finalized migration to wrong location')
      assert.equal(log.args.instigator, user1, 'finalized migrating from wrong person')
    })

    it('should be owner of new identityManager after successful transfer', async function() {
      await identityManager.initiateMigration(proxy.address, newIdenManager.address, {from: user1})
      let data = '0x' + lightwallet.txutils._encodeFunctionTxData('registerIdentity', ['address', 'address'], [user1, recoveryKey])
      await identityManager.forwardTo(proxy.address, newIdenManager.address, 0, data, {from: user1})
      //increase time until migration can be finialized
      await evm_increaseTime(2 * adminTimeLock)
      let tx = await identityManager.finalizeMigration(proxy.address, newIdenManager.address, {from: user1})
      let log = tx.logs[0]
      assert.equal(log.event, 'MigrationFinalized', 'wrong event initiated')
      assert.equal(log.args.identity, proxy.address, 'finalized migrating wrong proxy')
      assert.equal(log.args.newIdManager, newIdenManager.address, 'finalized migration to wrong location')
      assert.equal(log.args.instigator, user1, 'finalized migrating from wrong user')
      data = '0x' + lightwallet.txutils._encodeFunctionTxData('register', ['uint256'], [LOG_NUMBER_1])
      await newIdenManager.forwardTo(proxy.address, testReg.address, 0, data, {from: user1})
      // Verify that the proxy address is logged as the sender
      let regData = await testReg.registry.call(proxy.address)
        assert.equal(regData.toNumber(), LOG_NUMBER_1, 'User1 should be able to send transaction from new contract')
    })
  })
})
