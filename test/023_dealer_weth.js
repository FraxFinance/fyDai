const Vat = artifacts.require('Vat');
const GemJoin = artifacts.require('GemJoin');
const DaiJoin = artifacts.require('DaiJoin');
const Weth = artifacts.require("WETH9");
const ERC20 = artifacts.require("TestERC20");
const Pot = artifacts.require('Pot');
const Chai = artifacts.require('Chai');
const ChaiOracle = artifacts.require('ChaiOracle');
const WethOracle = artifacts.require('WethOracle');
const Treasury = artifacts.require('Treasury');
const YDai = artifacts.require('YDai');
const Mint = artifacts.require('Mint');
const Dealer = artifacts.require('Dealer');

const helper = require('ganache-time-traveler');
const truffleAssert = require('truffle-assertions');
const { BN, expectRevert } = require('@openzeppelin/test-helpers');
const { toWad, toRay, toRad, addBN, subBN, mulRay, divRay } = require('./shared/utils');

contract('Dealer', async (accounts) =>  {
    let [ owner, user ] = accounts;
    let vat;
    let weth;
    let wethJoin;
    let dai;
    let daiJoin;
    let pot;
    let chai;
    let chaiOracle;
    let wethOracle;
    let treasury;
    let yDai;
    let mint;
    let dealer;

    let WETH = web3.utils.fromAscii("WETH")
    let CHAI = web3.utils.fromAscii("CHAI")
    let ilk = web3.utils.fromAscii("ETH-A")
    let Line = web3.utils.fromAscii("Line")
    let spotName = web3.utils.fromAscii("spot")
    let linel = web3.utils.fromAscii("line")

    let snapshot;
    let snapshotId;

    const limits = toRad(10000);
    const spot  = toRay(1.5);
    const rate  = toRay(1.25);
    const daiDebt = toWad(120);
    const daiTokens = mulRay(daiDebt, rate);
    const wethTokens = divRay(daiTokens, spot);
    let maturity;

    beforeEach(async() => {
        snapshot = await helper.takeSnapshot();
        snapshotId = snapshot['result'];

        // Setup vat
        vat = await Vat.new();
        await vat.init(ilk, { from: owner });

        weth = await Weth.new({ from: owner });
        wethJoin = await GemJoin.new(vat.address, ilk, weth.address, { from: owner });

        dai = await ERC20.new(0, { from: owner });
        daiJoin = await DaiJoin.new(vat.address, dai.address, { from: owner });

        await vat.file(ilk, spotName, spot, { from: owner });
        await vat.file(ilk, linel, limits, { from: owner });
        await vat.file(Line, limits); // TODO: Why can't we specify `, { from: owner }`?
        await vat.fold(ilk, vat.address, subBN(rate, toRay(1)), { from: owner }); // Fold only the increase from 1.0

        // Setup pot
        pot = await Pot.new(vat.address);

        // Permissions
        await vat.rely(vat.address, { from: owner });
        await vat.rely(wethJoin.address, { from: owner });
        await vat.rely(daiJoin.address, { from: owner });
        await vat.rely(pot.address, { from: owner });
        await vat.hope(daiJoin.address, { from: owner });
        await vat.hope(wethJoin.address, { from: owner });

        // Setup chai
        chai = await Chai.new(
            vat.address,
            pot.address,
            daiJoin.address,
            dai.address,
        );

        // Setup yDai
        const block = await web3.eth.getBlockNumber();
        maturity = (await web3.eth.getBlock(block)).timestamp + 1000;
        yDai = await YDai.new(vat.address, pot.address, maturity, "Name", "Symbol");

        // Setup Oracle
        wethOracle = await WethOracle.new(vat.address, { from: owner });

        // Setup ChaiOracle
        chaiOracle = await ChaiOracle.new(pot.address, { from: owner });

        // Set treasury
        treasury = await Treasury.new(
            dai.address,
            chai.address,
            chaiOracle.address,
            weth.address,
            daiJoin.address,
            wethJoin.address,
            vat.address,
        );

        // Setup mint
        mint = await Mint.new(
            treasury.address,
            dai.address,
            yDai.address,
            { from: owner },
        );
        await yDai.grantAccess(mint.address, { from: owner });
        await treasury.grantAccess(mint.address, { from: owner });

        // Setup Dealer
        dealer = await Dealer.new(
            treasury.address,
            dai.address,
            yDai.address,
            weth.address,
            wethOracle.address,
            chai.address,
            chaiOracle.address,
            { from: owner },
        );
        treasury.grantAccess(dealer.address, { from: owner });
        yDai.grantAccess(dealer.address, { from: owner });
    });

    afterEach(async() => {
        await helper.revertToSnapshot(snapshotId);
    });
    
    it("get the size of the contract", async() => {
        console.log();
        console.log("·--------------------|------------------|------------------|------------------·");
        console.log("|  Contract          ·  Bytecode        ·  Deployed        ·  Constructor     |");
        console.log("·····················|··················|··················|···················");
        
        const bytecode = dealer.constructor._json.bytecode;
        const deployed = dealer.constructor._json.deployedBytecode;
        const sizeOfB  = bytecode.length / 2;
        const sizeOfD  = deployed.length / 2;
        const sizeOfC  = sizeOfB - sizeOfD;
        console.log(
            "|  " + (dealer.constructor._json.contractName).padEnd(18, ' ') +
            "|" + ("" + sizeOfB).padStart(16, ' ') + "  " +
            "|" + ("" + sizeOfD).padStart(16, ' ') + "  " +
            "|" + ("" + sizeOfC).padStart(16, ' ') + "  |");
        console.log("·--------------------|------------------|------------------|------------------·");
        console.log();
    });

    it("allows user to post weth", async() => {
        assert.equal(
            (await vat.urns(ilk, treasury.address)).ink,
            0,
            "Treasury has weth in MakerDAO",
        );
        assert.equal(
            await dealer.powerOf.call(WETH, owner),
            0,
            "Owner has borrowing power",
        );
        
        await weth.deposit({ from: owner, value: wethTokens });
        await weth.approve(dealer.address, wethTokens, { from: owner }); 
        await dealer.post(WETH, owner, wethTokens, { from: owner });

        assert.equal(
            (await vat.urns(ilk, treasury.address)).ink,
            wethTokens.toString(),
            "Treasury should have weth in MakerDAO",
        );
        assert.equal(
            await dealer.powerOf.call(WETH, owner),
            daiTokens.toString(),
            "Owner should have " + daiTokens + " borrowing power, instead has " + await dealer.powerOf.call(WETH, owner),
        );
    });

    describe("with posted weth", () => {
        beforeEach(async() => {
            await weth.deposit({ from: owner, value: wethTokens });
            await weth.approve(dealer.address, wethTokens, { from: owner }); 
            await dealer.post(WETH, owner, wethTokens, { from: owner });
        });

        it("allows user to withdraw weth", async() => {
            assert.equal(
                (await vat.urns(ilk, treasury.address)).ink,
                wethTokens.toString(),
                "Treasury does not have weth in MakerDAO",
            );
            assert.equal(
                await dealer.powerOf.call(WETH, owner),
                daiTokens.toString(),
                "Owner does not have borrowing power",
            );
            assert.equal(
                await weth.balanceOf(owner),
                0,
                "Owner has collateral in hand"
            );
            
            await dealer.withdraw(WETH, owner, wethTokens, { from: owner });

            assert.equal(
                await weth.balanceOf(owner),
                wethTokens.toString(),
                "Owner should have collateral in hand"
            );
            assert.equal(
                (await vat.urns(ilk, treasury.address)).ink,
                0,
                "Treasury should not not have weth in MakerDAO",
            );
            assert.equal(
                await dealer.powerOf.call(WETH, owner),
                0,
                "Owner should not have borrowing power",
            );
        });

        it("allows to borrow yDai", async() => {
            assert.equal(
                await dealer.powerOf.call(WETH, owner),
                daiTokens.toString(),
                "Owner does not have borrowing power",
            );
            assert.equal(
                await yDai.balanceOf(owner),
                0,
                "Owner has yDai",
            );
            assert.equal(
                await dealer.debtDai(WETH, owner),
                0,
                "Owner has debt",
            );
    
            await dealer.borrow(WETH, owner, daiTokens, { from: owner });

            assert.equal(
                await yDai.balanceOf(owner),
                daiTokens.toString(),
                "Owner should have yDai",
            );
            assert.equal(
                await dealer.debtDai(WETH, owner),
                daiTokens.toString(),
                "Owner should have debt",
            );
        });

        it("doesn't allow to borrow yDai beyond borrowing power", async() => {
            assert.equal(
                await dealer.powerOf.call(WETH, owner),
                daiTokens.toString(),
                "Owner does not have borrowing power",
            );
            assert.equal(
                await dealer.debtDai(WETH, owner),
                0,
                "Owner has debt",
            );
    
            await expectRevert(
                dealer.borrow(WETH, owner, addBN(daiTokens, 1), { from: owner }), // Borrow 1 wei beyond power
                "Dealer: Post more collateral",
            );
        });

        describe("with borrowed yDai", () => {
            beforeEach(async() => {
                await dealer.borrow(WETH, owner, daiTokens, { from: owner });
            });

            it("doesn't allow to withdraw and become undercollateralized", async() => {
                assert.equal(
                    await dealer.powerOf.call(WETH, owner),
                    daiTokens.toString(),
                    "Owner does not have borrowing power",
                );
                assert.equal(
                    await dealer.debtDai(WETH, owner),
                    daiTokens.toString(),
                    "Owner does not have debt",
                );

                await expectRevert(
                    dealer.borrow(WETH, owner, wethTokens, { from: owner }),
                    "Dealer: Post more collateral",
                );
            });

            it("allows to repay yDai", async() => {
                assert.equal(
                    await yDai.balanceOf(owner),
                    daiTokens.toString(),
                    "Owner does not have yDai",
                );
                assert.equal(
                    await dealer.debtDai(WETH, owner),
                    daiTokens.toString(),
                    "Owner does not have debt",
                );

                await yDai.approve(dealer.address, daiTokens, { from: owner });
                await dealer.repayYDai(WETH, owner, daiTokens, { from: owner });
    
                assert.equal(
                    await yDai.balanceOf(owner),
                    0,
                    "Owner should not have yDai",
                );
                assert.equal(
                    await dealer.debtDai(WETH, owner),
                    0,
                    "Owner should not have debt",
                );
            });

            it("allows to repay yDai with dai", async() => {
                // Borrow dai
                await vat.hope(daiJoin.address, { from: owner });
                await vat.hope(wethJoin.address, { from: owner });
                let wethTokens = web3.utils.toWei("500");
                await weth.deposit({ from: owner, value: wethTokens });
                await weth.approve(wethJoin.address, wethTokens, { from: owner });
                await wethJoin.join(owner, wethTokens, { from: owner });
                await vat.frob(ilk, owner, owner, owner, wethTokens, daiTokens, { from: owner });
                await daiJoin.exit(owner, daiTokens, { from: owner });

                assert.equal(
                    await dai.balanceOf(owner),
                    daiTokens.toString(),
                    "Owner does not have dai",
                );
                assert.equal(
                    await dealer.debtDai(WETH, owner),
                    daiTokens.toString(),
                    "Owner does not have debt",
                );

                await dai.approve(dealer.address, daiTokens, { from: owner });
                await dealer.repayDai(WETH, owner, daiTokens, { from: owner });
    
                assert.equal(
                    await dai.balanceOf(owner),
                    0,
                    "Owner should not have yDai",
                );
                assert.equal(
                    await dealer.debtDai(WETH, owner),
                    0,
                    "Owner should not have debt",
                );
            });

            it("when dai is provided in excess for repayment, only the necessary amount is taken", async() => {
                // Mint some yDai the sneaky way
                await yDai.grantAccess(owner, { from: owner });
                await yDai.mint(owner, 1, { from: owner }); // 1 extra yDai wei
                const yDaiTokens = addBN(daiTokens, 1); // daiTokens + 1 wei

                assert.equal(
                    await yDai.balanceOf(owner),
                    yDaiTokens.toString(),
                    "Owner does not have yDai",
                );
                assert.equal(
                    await dealer.debtDai(WETH, owner),
                    daiTokens.toString(),
                    "Owner does not have debt",
                );

                await yDai.approve(dealer.address, yDaiTokens, { from: owner });
                await dealer.repayYDai(WETH, owner, yDaiTokens, { from: owner });
    
                assert.equal(
                    await yDai.balanceOf(owner),
                    1,
                    "Owner should have yDai left",
                );
                assert.equal(
                    await dealer.debtDai(WETH, owner),
                    0,
                    "Owner should not have debt",
                );
            });

            
            it("as rate increases after maturity, so does the debt in when measured in dai", async() => {
                assert.equal(
                    await dealer.debtDai(WETH, owner),
                    daiTokens.toString(),
                    "Owner should have " + daiTokens + " debt",
                );
                // yDai matures
                await helper.advanceTime(1000);
                await helper.advanceBlock();
                await yDai.mature();

                // Set rate to 1.5
                const rateIncrease = toRay(0.25);
                const rateDifferential = divRay(addBN(rate, rateIncrease), rate);
                const increasedDebt = mulRay(daiTokens, rateDifferential);
                await vat.fold(ilk, vat.address, rateIncrease, { from: owner });
                
                assert.equal(
                    await dealer.debtDai(WETH, owner),
                    increasedDebt.toString(),
                    "Owner should have " + increasedDebt + " debt after the rate change, instead has " + (await dealer.debtDai(WETH, owner)),
                );
            });

            it("as rate increases after maturity, the debt doesn't in when measured in yDai", async() => {
                assert.equal(
                    await dealer.debtDai(WETH, owner),
                    daiTokens.toString(),
                    "Owner should have " + daiTokens + " debt",
                );
                // yDai matures
                await helper.advanceTime(1000);
                await helper.advanceBlock();
                await yDai.mature();

                // Set rate to 1.5
                const rateIncrease = toRay(0.5);
                await vat.fold(ilk, vat.address, rateIncrease, { from: owner });
                
                let debt = await dealer.debtDai(WETH, owner);
                assert.equal(
                    await dealer.inYDai(debt),
                    daiTokens.toString(),
                    "Owner should have " + daiTokens + " debt after the rate change, instead has " + (await dealer.inYDai(debt)),
                );
            });

            // TODO: Test that when yDai is provided in excess for repayment, only the necessary amount is taken

            it("more yDai is required to repay after maturity as rate increases", async() => {
                assert.equal(
                    await yDai.balanceOf(owner),
                    daiTokens.toString(),
                    "Owner does not have yDai",
                );
                assert.equal(
                    await dealer.debtDai(WETH, owner),
                    daiTokens.toString(),
                    "Owner does not have debt",
                );

                // yDai matures
                await helper.advanceTime(1000);
                await helper.advanceBlock();
                await yDai.mature();

                // Set rate to 1.5
                const rateIncrease = toRay(0.25);
                const rateDifferential = divRay(addBN(rate, rateIncrease), rate);
                const increasedDebt = mulRay(daiTokens, rateDifferential);
                const debtIncrease = subBN(increasedDebt, daiTokens);
                await vat.fold(ilk, vat.address, rateIncrease, { from: owner });

                assert.equal(
                    await dealer.debtDai(WETH, owner),
                    increasedDebt.toString(),
                    "Owner does not have increased debt",
                );

                await yDai.approve(dealer.address, daiTokens, { from: owner });
                await dealer.repayYDai(WETH, owner, daiTokens, { from: owner });
    
                assert.equal(
                    await yDai.balanceOf(owner),
                    0,
                    "Owner should not have yDai",
                );
                assert.equal(
                    await dealer.debtDai(WETH, owner),
                    debtIncrease.toString(),
                    "Owner should have " + debtIncrease + " dai debt, instead has " + (await dealer.debtDai(WETH, owner)),
                );
            });

            it("all debt can be repaid after maturity", async() => {
                assert.equal(
                    await yDai.balanceOf(owner),
                    daiTokens.toString(),
                    "Owner does not have yDai",
                );
                assert.equal(
                    await dealer.debtDai(WETH, owner),
                    daiTokens.toString(),
                    "Owner does not have debt",
                );

                // yDai matures
                await helper.advanceTime(1000);
                await helper.advanceBlock();
                await yDai.mature();

                // Set rate to 1.5
                const rateIncrease = toRay(0.25);
                const rateDifferential = divRay(addBN(rate, rateIncrease), rate);
                const increasedDebt = mulRay(daiTokens, rateDifferential);
                const debtIncrease = subBN(increasedDebt, daiTokens);
                await vat.fold(ilk, vat.address, rateIncrease, { from: owner });

                // Mint some yDai the sneaky way
                await yDai.grantAccess(owner, { from: owner });
                await yDai.mint(owner, debtIncrease, { from: owner });

                assert.equal(
                    await dealer.debtDai(WETH, owner),
                    increasedDebt.toString(),
                    "Owner does not have increased debt",
                );

                await yDai.approve(dealer.address, increasedDebt, { from: owner });
                await dealer.repayYDai(WETH, owner, increasedDebt, { from: owner });
    
                assert.equal(
                    await yDai.balanceOf(owner),
                    0,
                    "Owner should not have yDai",
                );
                assert.equal(
                    await dealer.debtDai(WETH, owner),
                    0,
                    "Owner should have no remaining debt",
                );
            });

            it("allows to move debt to MakerDAO", async() => {
                // Treasury needs to have debt
                await helper.advanceTime(1000);
                await helper.advanceBlock();
                await yDai.mature();
                await yDai.approve(mint.address, daiTokens, { from: owner });
                await mint.redeem(owner, daiTokens, { from: owner });

                assert.equal(
                    (await vat.urns(ilk, treasury.address)).art,
                    daiDebt.toString(),
                    "Treasury does not have " + daiDebt + " debt, instead has " + (await vat.urns(ilk, treasury.address)).art,
                );
                assert.equal(
                    (await vat.urns(ilk, treasury.address)).ink,
                    wethTokens.toString(),
                    "Treasury does not have " + wethTokens + " collateral, instead has " + (await vat.urns(ilk, treasury.address)).ink,
                );
                assert.equal(
                    await dealer.debtDai(WETH, owner),
                    daiTokens.toString(),
                    "User does not have debt in Dealer",
                );
                assert.equal(
                    await dealer.posted.call(WETH, owner),
                    wethTokens.toString(),
                    "User does not have collateral in Dealer",
                );
                assert.equal(
                    (await vat.urns(ilk, owner)).art,
                    0,
                    "User has debt in MakerDAO",
                );
                assert.equal(
                    (await vat.urns(ilk, owner)).ink,
                    0,
                    "User has collateral in MakerDAO",
                );
                await vat.hope(treasury.address, { from: owner });
                await dealer.split(owner, owner, { from: owner });
                await vat.nope(treasury.address, { from: owner });
                // TODO: Test with different source and destination accounts
                // TODO: Test with CHAI collateral as well
                // TODO: Test with different rates

                assert.equal(
                    (await vat.urns(ilk, owner)).art,
                    daiDebt.toString(),
                    "User should have debt in MakerDAO",
                );
                assert.equal(
                    (await vat.urns(ilk, owner)).ink,
                    wethTokens.toString(),
                    "User should have collateral in MakerDAO",
                );
                assert.equal(
                    await dealer.debtDai(WETH, owner),
                    0,
                    "User should not have debt in Dealer",
                );
                assert.equal(
                    await dealer.posted.call(WETH, owner),
                    0,
                    "User should not have collateral in Dealer",
                );
            });

            it("allows to move user debt to MakerDAO beyond system debt", async() => {

                assert.equal(
                    (await vat.urns(ilk, treasury.address)).art,
                    0,
                    "Treasury has " + daiDebt + " debt, instead of none",
                );
                assert.equal(
                    (await vat.urns(ilk, treasury.address)).ink,
                    wethTokens.toString(),
                    "Treasury does not have " + wethTokens + " collateral, instead has " + (await vat.urns(ilk, treasury.address)).ink,
                );
                assert.equal(
                    await dealer.debtDai(WETH, owner),
                    daiTokens.toString(),
                    "User does not have debt in Dealer",
                );
                assert.equal(
                    await dealer.posted.call(WETH, owner),
                    wethTokens.toString(),
                    "User does not have collateral in Dealer",
                );
                assert.equal(
                    (await vat.urns(ilk, owner)).art,
                    0,
                    "User has debt in MakerDAO",
                );
                assert.equal(
                    (await vat.urns(ilk, owner)).ink,
                    0,
                    "User has collateral in MakerDAO",
                );
                assert.equal(
                    await treasury.savings.call(),
                    0,
                    "Treasury has savings in dai units"
                );

                await vat.hope(treasury.address, { from: owner });
                await dealer.split(owner, owner, { from: owner });
                await vat.nope(treasury.address, { from: owner });
                // TODO: Test with different source and destination accounts
                // TODO: Test with CHAI collateral as well
                // TODO: Test with different rates

                assert.equal(
                    await treasury.savings.call(),
                    daiTokens.toString(),
                    "Treasury should report savings in dai units"
                );
                assert.equal(
                    (await vat.urns(ilk, owner)).art,
                    daiDebt.toString(),
                    "User should have debt in MakerDAO",
                );
                assert.equal(
                    (await vat.urns(ilk, owner)).ink,
                    wethTokens.toString(),
                    "User should have collateral in MakerDAO",
                );
                assert.equal(
                    await dealer.debtDai(WETH, owner),
                    0,
                    "User should not have debt in Dealer",
                );
                assert.equal(
                    await dealer.posted.call(WETH, owner),
                    0,
                    "User should not have collateral in Dealer",
                );
            });
        });
    });
});