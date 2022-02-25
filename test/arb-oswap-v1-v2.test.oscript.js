// uses `aa-testkit` testing framework for AA tests. Docs can be found here `https://github.com/valyakin/aa-testkit`
// `mocha` standard functions and `expect` from `chai` are available globally
// `Testkit`, `Network`, `Nodes` and `Utils` from `aa-testkit` are available globally too
const crypto = require('crypto')
const path = require('path')
const _ = require('lodash')
const Decimal = require('ocore/formula/common.js').Decimal;
const objectHash = require("ocore/object_hash.js");
//const { expect } = require('chai');



function round(n, precision) {
	return parseFloat(n.toFixed(precision));
}

function number_from_seed(seed) {
	var hash = crypto.createHash("sha256").update(seed.toString(), "utf8").digest("hex");
	var head = hash.substr(0, 16);
	var nominator = new Decimal("0x" + head);
	var denominator = new Decimal("0x1" + "0".repeat(16));
	var num = nominator.div(denominator); // float from 0 to 1
	return num.toNumber();
}


describe('Oswap v1-v2 arb', function () {
	this.timeout(1200000)


	before(async () => {
		this.network = await Network.create()
			.with.numberOfWitnesses(1)
			.with.asset({ x_asset: {} })
			.with.asset({ y_asset: {} })

			.with.agent({ lbc: path.join(__dirname, '../node_modules/oswap-v2-aa/linear-bonding-curve.oscript') })
			.with.agent({ pool_lib: path.join(__dirname, '../node_modules/oswap-v2-aa/pool-lib.oscript') })
			.with.agent({ pool_lib_by_price: path.join(__dirname, '../node_modules/oswap-v2-aa/pool-lib-by-price.oscript') })
			.with.agent({ governance_base: path.join(__dirname, '../node_modules/oswap-v2-aa/governance.oscript') })
			.with.agent({ v2Pool: path.join(__dirname, '../node_modules/oswap-v2-aa/pool.oscript') })
			.with.agent({ v2OswapFactory: path.join(__dirname, '../node_modules/oswap-v2-aa/factory.oscript') })

			.with.agent({ v1Pool: path.join(__dirname, '../node_modules/oswap/public/pool.oscript') })
			.with.agent({ v1OswapFactory: path.join(__dirname, '../node_modules/oswap/public/factory.oscript') })

			.with.agent({ arb_base: path.join(__dirname, '../arb-oswap-v1-v2.oscript') })
			.with.wallet({ alice: {base: 10000e9, x_asset: 1000e9, y_asset: 1000e9} })
			.with.wallet({ bob: {base: 1000e9, x_asset: 1000e9, y_asset: 1000e9} })
			.with.explorer()
			.run()
		console.log('--- agents\n', this.network.agent)
	//	console.log('--- wallets\n', this.network.wallet)
		this.alice = this.network.wallet.alice
		this.aliceAddress = await this.alice.getAddress()
		this.bob = this.network.wallet.bob
		this.bobAddress = await this.bob.getAddress()
		
		this.x_asset = this.network.asset.x_asset
		this.y_asset = this.network.asset.y_asset

		const balance = await this.bob.getBalance()
		console.log(balance)
		expect(balance.base.stable).to.be.equal(1000e9)

		this.executeGetter = async (aaAddress, getter, args = []) => {
			const { result, error } = await this.alice.executeGetter({
				aaAddress,
				getter,
				args
			})
			if (error)
				console.log(error)
			expect(error).to.be.null
			return result
		}

		this.get_price = async (aaAddress, asset_label, bAfterInterest = true) => {
			return await this.executeGetter(aaAddress, 'get_price', [asset_label, 0, 0, bAfterInterest])
		}

		this.get_leveraged_price = async (aaAddress, asset_label, L) => {
			return await this.executeGetter(aaAddress, 'get_leveraged_price', [asset_label, L, true])
		}

		this.printAllLogs = async (response) => {
			const { response_unit, logs, aa_address, response: { responseVars } } = response
			console.log('logs', aa_address, JSON.stringify(logs, null, 2))
			console.log('resp vars', responseVars)
			if (!response_unit)
				return;
			const { unitObj } = await this.alice.getUnitInfo({ unit: response_unit })
			const payments = Utils.getExternalPayments(unitObj)
			const addresses = _.uniq(payments.map(p => p.address)).sort()
			for (let aa of addresses) {
				const { response } = await this.network.getAaResponseToUnitByAA(response_unit, aa)
				if (response)
					await this.printAllLogs(response);
			}
		}

	})



	it('Bob defines a new oswap v2 pool', async () => {
		this.base_interest_rate = 0//.3
		this.swap_fee = 0.003
		this.exit_fee = 0.005
		this.leverage_profit_tax = 0.1
		this.arb_profit_tax = 0.9999
		this.alpha = 0.5
		this.beta = 1 - this.alpha
		this.mid_price = 0.95
		this.price_deviation = 1.1
		this.pool_leverage = 1
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.network.agent.v2OswapFactory,
			amount: 10000,
			data: {
				x_asset: this.x_asset,
				y_asset: this.y_asset,
				swap_fee: this.swap_fee,
				exit_fee: this.exit_fee,
				leverage_profit_tax: this.leverage_profit_tax,
				arb_profit_tax: this.arb_profit_tax,
				base_interest_rate: this.base_interest_rate,
				alpha: this.alpha,
				mid_price: this.mid_price,
				price_deviation: this.price_deviation,
				pool_leverage: this.pool_leverage,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
	//	await this.network.witnessUntilStable(response.response_unit)

		this.v2_aa = response.response.responseVars.address
		expect(this.v2_aa).to.be.validAddress

		const { vars } = await this.bob.readAAStateVars(this.v2_aa)
		this.v2_pool_shares_asset = vars.lp_shares.asset
		expect(this.v2_pool_shares_asset).to.be.validUnit

		this.linear_shares = 0
		this.issued_shares = 0
		this.coef = 1
		this.balances = { x: 0, y: 0, xn: 0, yn: 0 }
		this.profits = { x: 0, y: 0 }
		this.leveraged_balances = {}

		this.v2_bounce_fees = this.x_asset !== 'base' && { base: [{ address: this.v2_aa, amount: 1e4 }] }
		this.v2_bounce_fee_on_top = this.x_asset === 'base' ? 1e4 : 0

	})
	
	it('Bob defines a new oswap v1 pool', async () => {
		const swap_fee = 0.001e11
		const [asset0, asset1] = (number_from_seed(this.y_asset) > number_from_seed(this.x_asset)) ? [this.y_asset, this.x_asset] : [this.x_asset, this.y_asset]
		const definition = ['autonomous agent', {
			base_aa: this.network.agent.v1Pool,
			params: {
				asset0,
				asset1,
				swap_fee,
				factory: this.network.agent.v1OswapFactory,
			}
		}];
		const address = objectHash.getChash160(definition);
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.network.agent.v1OswapFactory,
			amount: 10000,
			data: {
				create: 1,
				asset0,
				asset1,
				swap_fee,
				address,
			},
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.bob, unit)
	//	const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { vars } = await this.bob.readAAStateVars(this.network.agent.v1OswapFactory)
		console.log('vars', vars)
		expect(vars['pools.' + address + '.asset0']).to.be.equal(asset0)
		expect(vars['pools.' + address + '.asset1']).to.be.equal(asset1)
		expect(vars['pools.' + address + '.asset']).to.be.validUnit

		this.v1_aa = address
		expect(this.v1_aa).to.be.validAddress

	})
	
	it('Bob defines a new arbitrage AA', async () => {
		const params = {
			oswap_v1_aa: this.v1_aa,
			oswap_v2_aa: this.v2_aa,
			owner: this.bobAddress,
			nonce: 0,
		}
		const definition = ['autonomous agent', {
			base_aa: this.network.agent.arb_base,
			params
		}];
		do {
			params.nonce++;
			this.arb_aa = objectHash.getChash160(definition);
		}
		while (!this.arb_aa.startsWith('22'));
		console.log('arb AA', this.arb_aa, params)
		const { unit, error } = await this.bob.sendMulti({
			messages: [{
				app: 'definition',
				payload: {
					address: this.arb_aa,
					definition,
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit
		await this.network.witnessUntilStable(unit)
	})


	it('Alice sends money to arbitrage AA', async () => {
		const amount = 10e9
		this.arb_asset = this.y_asset

		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				base: [{ address: this.arb_aa, amount: 1e4 }],
				[this.arb_asset]: [{ address: this.arb_aa, amount: amount }],
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null
		expect(response.response.responseVars.message).to.be.eq('added')
	})



	it('Alice adds liquidity to v2 pool', async () => {
		const x_amount = 40e4
		const y_amount = 0.95 * 40e4
		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				base: [{ address: this.v2_aa, amount: 1e4 }],
				[this.x_asset]: [{ address: this.v2_aa, amount: x_amount }],
				[this.y_asset]: [{ address: this.v2_aa, amount: y_amount }],
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(JSON.parse(response.response.responseVars.event).type).to.be.equal("add")
	})


	it('Alice adds liquidity to v1 pool', async () => {
		const y_amount = 1.1 * 60e4
		const x_amount = 60e4
		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				base: [{ address: this.v1_aa, amount: 1e4 }],
				[this.x_asset]: [{ address: this.v1_aa, amount: x_amount }],
				[this.y_asset]: [{ address: this.v1_aa, amount: y_amount }],
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.type).to.be.equal("mint")
	})




	it('Alice buys positive L-tokens in oswap v2', async () => {
	//	return;
		const x_change = 0
		const delta_Xn = -3e4
		const L = 5
		const result = await this.executeGetter(this.v2_aa, 'get_leveraged_trade_amounts', ['x', L, delta_Xn, 0, this.aliceAddress])
		console.log('result', result)
		const { shares, net_delta, gross_delta, avg_share_price, arb_profit_tax, total_fee, balances, leveraged_balances, initial_price, final_price } = result
		expect(leveraged_balances[L + 'x'].supply).to.be.eq(shares)
		
		this.leveraged_balances = leveraged_balances

		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.x_asset]: [{address: this.v2_aa, amount: gross_delta + x_change}],
				...this.v2_bounce_fees
			},
			messages: [{
				app: 'data',
				payload: {
					buy: 1,
				//	tokens: 1,
					L: L,
					asset: 'x',
					delta: -delta_Xn, // positive
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.alice.readAAStateVars(this.v2_aa)
		expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)

		const final_x5_leveraged_price = await this.get_leveraged_price(this.v2_aa, 'x', 5)
		console.log({ final_x5_leveraged_price })
		expect(final_x5_leveraged_price).to.be.gt(1)
		expect(final_x5_leveraged_price).to.be.gt(avg_share_price)
	})
	

	it('Alice buys negative L-tokens in oswap v2', async () => {
	//	return;
		const delta_Xn = -10e4
		const L = 10
		const result = await this.executeGetter(this.v2_aa, 'get_leveraged_trade_amounts', ['y', L, delta_Xn, 0, this.aliceAddress])
		console.log('result', result)
		const { shares, net_delta, gross_delta, avg_share_price, arb_profit_tax, total_fee, balances, leveraged_balances, initial_price, final_price } = result
		expect(leveraged_balances[-L + 'x'].supply).to.be.eq(shares)
		
		this.leveraged_balances = leveraged_balances

		const { unit, error } = await this.alice.sendMulti({
			outputs_by_asset: {
				[this.y_asset]: [{ address: this.v2_aa, amount: gross_delta }],
				base: [{ address: this.v2_aa, amount: 1e4 }],
			},
			messages: [{
				app: 'data',
				payload: {
					buy: 1,
				//	tokens: 1,
					L: L,
					asset: 'y',
					delta: -delta_Xn, // positive
				}
			}],
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnitOnNode(this.alice, unit)
	//	await this.network.witnessUntilStable(response.response_unit)
	//	console.log('logs', JSON.stringify(response.logs, null, 2))
		console.log(response.response.error)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.null

		const { vars } = await this.alice.readAAStateVars(this.v2_aa)
		console.log('vars', vars)
	//	expect(vars.leveraged_balances).to.be.deep.eq(this.leveraged_balances)

		const final_y10_leveraged_price = await this.get_leveraged_price(this.v2_aa, 'y', 10)
		console.log({ final_y10_leveraged_price })
		expect(final_y10_leveraged_price).to.be.gt(1)
		expect(final_y10_leveraged_price).to.be.gt(avg_share_price)
	})
	

	
	it('Alice triggers arbitrage to buy X from v2', async () => {
		await this.network.timetravel({ shift: '1h' })

		const initial_balances = await this.alice.getOutputsBalanceOf(this.arb_aa);
		console.log({initial_balances})

		const initial_v2_price = await this.get_price(this.v2_aa, 'x')
		console.log({ initial_v2_price })

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.arb_aa,
			amount: 1e4,
			data: {
				arb: 1,
			//	share: 0.9,
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	console.log('arb logs', JSON.stringify(response.logs, null, 2))
		await this.network.witnessUntilStable(response.response_unit)
		await this.printAllLogs(response)
		console.log(response.response.error);
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.message).to.be.equal(this.arb_asset === this.x_asset ? "will arb by selling X to v1 and buying from v2" : "will arb by buying X from v2 and selling to v1")
		console.log(response.response.responseVars);


		const v1_balances = await this.alice.getOutputsBalanceOf(this.v1_aa);
		const v1_price = v1_balances[this.y_asset].total / v1_balances[this.x_asset].total
		const v2_price = await this.get_price(this.v2_aa, 'x')
		console.log({ v1_price, v2_price })

		const final_balances = await this.alice.getOutputsBalanceOf(this.arb_aa);
		console.log({final_balances})

	//	expect(1).to.eq(0)
	})
	
	it('Alice triggers arbitrage 2 to buy X from v2', async () => {
		await this.network.timetravel({ shift: '1h' })

		const initial_balances = await this.alice.getOutputsBalanceOf(this.arb_aa);
		console.log({initial_balances})

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.arb_aa,
			amount: 1e4,
			data: {
				arb: 1,
			//	share: 0.9,
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
	//	console.log('arb logs', JSON.stringify(response.logs, null, 2))
		await this.network.witnessUntilStable(response.response_unit)
		await this.printAllLogs(response)
		console.log(response.response.error);
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.message).to.be.equal(this.arb_asset === this.x_asset ? "will arb by selling X to v1 and buying from v2" : "will arb by buying X from v2 and selling to v1")
		console.log(response.response.responseVars);

		const v1_balances = await this.alice.getOutputsBalanceOf(this.v1_aa);
		const v1_price = v1_balances[this.y_asset].total / v1_balances[this.x_asset].total
		const v2_price = await this.get_price(this.v2_aa, 'x')
		console.log({ v1_price, v2_price })


		const final_balances = await this.alice.getOutputsBalanceOf(this.arb_aa);
		console.log({final_balances})

	//	expect(1).to.eq(0)
	})

/*
	it('Alice triggers arbitrage again after buying', async () => {
	//	process.exit()
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.arb_aa,
			amount: 1e4,
			data: {
				arb: 1,
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		await this.network.witnessUntilStable(response.response_unit)
		console.log('arb logs', JSON.stringify(response.logs, null, 2))
		expect(response.response.error).to.be.eq("no arb opportunity exists")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null

		expect(1).to.eq(0)
	})*/

	
	it('Alice sells Y to v2 pool in order to lower its price and increase the X price', async () => {
		await this.network.timetravel({ shift: '1h' })

		const initial_price = await this.get_price(this.v2_aa, 'x')
		const final_price = initial_price * (this.mid_price ? 1.1 : 1.2)
		console.log({ initial_price, final_price })

		const shifts_and_bounds = await this.executeGetter(this.v2_aa, 'get_shifts_and_bounds')
		console.log({shifts_and_bounds})
		const result = await this.executeGetter(this.v2_aa, 'get_swap_amounts_by_final_price', ['y', final_price])
		const y_amount = result.in

		const { unit, error } = await this.alice.sendMulti({
			asset: this.y_asset,
			base_outputs: [{address: this.v2_aa, amount: 1e4}],
			asset_outputs: [{address: this.v2_aa, amount: y_amount}],
			spend_unconfirmed: 'all',
			messages: [{
				app: 'data',
				payload: {
					final_price,
				}
			}]
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		console.log(response.response.error)
	//	await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(JSON.parse(response.response.responseVars.event).type).to.be.equal("swap")
	})


	it('Alice triggers arbitrage to sell X to v2', async () => {
		await this.network.timetravel({ shift: '1h' })

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.arb_aa,
			amount: 1e4,
			data: {
				arb: 1,
			//	share: 0.9,
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		await this.network.witnessUntilStable(response.response_unit)
		await this.printAllLogs(response)
		console.log(response.response.responseVars);
		console.log(response.response.error);
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.message).to.be.equal(this.arb_asset === this.x_asset ? "will arb by selling X to v2 and buying from v1" : "will arb by buying X from v1 and selling to v2")

		const v1_balances = await this.alice.getOutputsBalanceOf(this.v1_aa);
		const v1_price = v1_balances[this.y_asset].total / v1_balances[this.x_asset].total
		const v2_price = await this.get_price(this.v2_aa, 'x')
		console.log({ v1_price, v2_price })

	})

/*	it('Alice triggers arbitrage 2 to sell X to v2', async () => {
		await this.network.timetravel({ shift: '1h' })

		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.arb_aa,
			amount: 1e4,
			data: {
				arb: 1,
			//	share: 0.9,
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		await this.network.witnessUntilStable(response.response_unit)
		await this.printAllLogs(response)
		console.log(response.response.responseVars);
		console.log(response.response.error);
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit
		expect(response.response.responseVars.message).to.be.equal(this.arb_asset === this.x_asset ? "will arb by selling X to v2 and buying from v1" : "will arb by buying X from v1 and selling to v2")

		const v1_balances = await this.alice.getOutputsBalanceOf(this.v1_aa);
		const v1_price = v1_balances[this.y_asset].total / v1_balances[this.x_asset].total
		const v2_price = await this.get_price(this.v2_aa, 'x')
		console.log({ v1_price, v2_price })

	})*/
	
	
	it('Alice triggers arbitrage again after selling', async () => {
		const { unit, error } = await this.alice.triggerAaWithData({
			toAddress: this.arb_aa,
			amount: 1e4,
			data: {
				arb: 1,
			},
			spend_unconfirmed: 'all',
		})

		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		await this.network.witnessUntilStable(response.response_unit)

		console.log(response.response.responseVars);
		expect(response.response.error).to.be.eq("no arb opportunity exists")
		expect(response.bounced).to.be.true
		expect(response.response_unit).to.be.null
	})
	

	it('Bob withdraws the funds', async () => {
		const { unit, error } = await this.bob.triggerAaWithData({
			toAddress: this.arb_aa,
			amount: 1e4,
			data: {
				withdraw: 1,
				asset: 'x'
			},
			spend_unconfirmed: 'all',
		})
		expect(error).to.be.null
		expect(unit).to.be.validUnit

		const { response } = await this.network.getAaResponseToUnit(unit)
		await this.network.witnessUntilStable(response.response_unit)
		expect(response.response.error).to.be.undefined
		expect(response.bounced).to.be.false
		expect(response.response_unit).to.be.validUnit

		const { unitObj } = await this.bob.getUnitInfo({ unit: response.response_unit })
		const payments = Utils.getExternalPayments(unitObj)
		expect(payments.length).to.eq(1)
		const payment = payments[0]
		expect(payment.asset).to.be.eq(this.x_asset)
		expect(payment.address).to.be.eq(this.bobAddress)
	//	expect(payment.amount).to.be.gt(10e9)

	})


	after(async () => {
	//	await Utils.sleep(3600 * 1000)
		await this.network.stop()
	})
})
