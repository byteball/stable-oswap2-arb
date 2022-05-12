"use strict";
var crypto = require('crypto');
const _ = require('lodash');

const eventBus = require('ocore/event_bus.js');
const conf = require('ocore/conf.js');
const mutex = require('ocore/mutex.js');
const network = require('ocore/network.js');
const device = require('ocore/device.js');
const aa_composer = require("ocore/aa_composer.js");
const storage = require("ocore/storage.js");
const db = require("ocore/db.js");
const constants = require("ocore/constants.js");
const light_wallet = require("ocore/light_wallet.js");

const dag = require('aabot/dag.js');
const operator = require('aabot/operator.js');
const aa_state = require('aabot/aa_state.js');
const CurveAA = require('./curve.js');
const xmutex = require("./xmutex");

const arb_base_aas = conf.ostable_arb_base_aas.concat(conf.v1v2_arb_base_aas);

let arb_aas;
let my_arb_aas;
let ostableArbsByAAs = {};
let v1v2ArbsByAAs = {};
let prev_trigger_initial_unit = {};
let oswapAAsByArb = {};

let curvesByArb = {};
let yAssetInfosByArb = {}; // for v1-v2
let arbInfo = {}; // for v1-v2

let oswap_aas = {};

let lastArbTs = {};

let prevStateHashes = {};

let busyArbs = {};

const sha256 = str => crypto.createHash("sha256").update(str, "utf8").digest("base64");

function wait(ms) {
	return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForAaStateToEmpty() {
	const unlock = await mutex.lock('aa_free');
	while (true) {
		const ts = Date.now();
		const aa_unlock = await aa_state.lock();
		aa_unlock();
		const elapsed = Date.now() - ts;
		if (elapsed <= 1)
			break;
		console.log(`taking aa_state lock took ${elapsed}ms, will wait more`);
	}
	process.nextTick(unlock); // delay unlock to give a chance to the immediately following code to lock aa_state
}

function getWaitTimeTillNextArb(arb_aa) {
	let timeout = 0;
	for (let oswap_aa of oswapAAsByArb[arb_aa]) {
		const t = lastArbTs[oswap_aa] + 3000 - Date.now();
		if (t > timeout)
			timeout = t;
	}
	return timeout;
}

async function estimateAndArbAll() {
	await waitForAaStateToEmpty();
	console.log('estimateAndArbAll');
	for (let arb_aa of my_arb_aas)
		await queueEstimateAndArb(arb_aa);
}

async function queueEstimateAndArb(arb_aa) {
	if (busyArbs[arb_aa])
		return console.log(`arb ${arb_aa} already busy or queued`);
	busyArbs[arb_aa] = true;
	console.log(`arb ${arb_aa} added to busy`);
	await estimateAndArbUnderArbLock(arb_aa);
}

async function estimateAndArbUnderArbLock(arb_aa) {
	await xmutex.lock();
	await estimateAndArb(arb_aa);
	await xmutex.unlock();
}

async function estimateAndArb(arb_aa) {
	await waitForAaStateToEmpty();
	const unlock = await mutex.lock('estimate');
	const curve_aa = curvesByArb[arb_aa];
	console.log('===== estimateAndArb arb ' + arb_aa + ' on curve ' + curve_aa);
	const timeout = getWaitTimeTillNextArb(arb_aa);
	if (timeout > 0) {
		setTimeout(() => estimateAndArbUnderArbLock(arb_aa), timeout + 10);
		return unlock(`too fast after the previous arb, will estimate again in ${timeout}ms`);
	}

	const finish = (msg) => {
		busyArbs[arb_aa] = false;
		console.log(`arb ${arb_aa} removed from busy`);
		unlock(msg);
	};

	let dfUpdated = false;
	if (curve_aa) {
		const curveAA = CurveAA.get(curve_aa);
		dfUpdated = await curveAA.updateDataFeeds(false, true);
	}
	
	// simulate an arb request
	const aa_unlock = await aa_state.lock();
	let upcomingStateVars = _.cloneDeep(aa_state.getUpcomingStateVars());
	let upcomingBalances = _.cloneDeep(aa_state.getUpcomingBalances());
	const arb_balances = upcomingBalances[arb_aa];
	if (!curve_aa) {
		const { x_asset, y_asset, oswaps } = arbInfo[arb_aa];
		if (!arb_balances[x_asset] || !arb_balances[y_asset]) {
			console.log(`arb ${arb_aa} zero balance`, arb_balances);
			aa_unlock();
			return finish();
		}
		for (let oswap_aa of oswaps) {
			const balances = upcomingBalances[oswap_aa];
			if (!balances[x_asset] || !balances[y_asset]) {
				console.log(`arb ${arb_aa}: oswap ${oswap_aa} zero balance`, balances);
				aa_unlock();
				return finish();
			}
		}
	}
	else {
		if (!arb_balances.base) {
			console.log(`arb ${arb_aa} zero GBYTE balance`, arb_balances);
			aa_unlock();
			return finish();
		}
	}
	const state = sha256(JSON.stringify([upcomingStateVars, upcomingBalances]));
/*	if (curve_aa) {
		const { stable_oswap_aa, reserve_oswap_aa } = await dag.readAAParams(arb_aa);
		console.log('state before estimate', stable_oswap_aa, JSON.stringify(upcomingStateVars[stable_oswap_aa], null, 2), '\n', reserve_oswap_aa, JSON.stringify(upcomingStateVars[reserve_oswap_aa], null, 2));
	}*/

	if (!dfUpdated && state === prevStateHashes[arb_aa]) {
		console.log(`arb ${arb_aa}: the state hasn't changed`);
		aa_unlock();
		return finish();
	}
	prevStateHashes[arb_aa] = state;

	let payload = {
		arb: 1
	};
	const share = conf[curve_aa ? 'oswap_arb_share' : 'v1v2_arb_share'];
	if (share && share !== 1)
		payload.share = share;
	let objUnit = {
		unit: 'dummy_trigger_unit',
		authors: [{ address: operator.getAddress() }],
		messages: [
			{
				app: 'payment',
				payload: {
					outputs: [{ address: arb_aa, amount: 1e4 }]
				}
			},
			{
				app: 'data',
				payload
			},
		],
		timestamp: Math.round(Date.now() / 1000),
	};
	const start_ts = Date.now();
	let arrResponses = await aa_composer.estimatePrimaryAATrigger(objUnit, arb_aa, upcomingStateVars, upcomingBalances);
	console.log(`--- estimated responses to simulated arb request in ${Date.now() - start_ts}ms`, JSON.stringify(arrResponses, null, 2));
	aa_unlock();
	if (arrResponses[0].bounced)
		return finish(`${arb_aa}/${curve_aa} would bounce: ` + arrResponses[0].response.error);
	const balances = upcomingBalances[arb_aa];
	for (let asset in balances)
		if (balances[asset] < 0)
			return finish(`${arb_aa}/${curve_aa}: ${asset} balance would become negative: ${balances[asset]}`);
	const arbResponses = arrResponses.filter(r => r.aa_address === arb_aa);
	const lastResponse = arbResponses[arbResponses.length - 1];
	const profit = lastResponse.response.responseVars.profit;
	if (!profit)
		throw Error(`no profit in response vars from ${arb_aa}`);
	let usd_profit;
	if (curve_aa) {
		usd_profit = profit / 1e9 * network.exchangeRates.GBYTE_USD;
	}
	else {
		let { asset, decimals } = yAssetInfosByArb[arb_aa];
		if (!asset)
			throw Error(`no y asset for arb ${arb_aa}`);
		if (asset === 'base')
			asset = 'GBYTE';
		usd_profit = profit / 10 ** decimals * network.exchangeRates[asset + '_USD'];
	}
	console.log(`estimateAndArb: ${arb_aa}/${curve_aa} would succeed with profit ${profit} or $${usd_profit}`);
	if (usd_profit < conf.min_profit)
		return finish(`profit would be too small`);
	const unit = await dag.sendAARequest(arb_aa, payload);
	if (!unit)
		return finish(`sending arb request failed`);
	const objJoint = await dag.readJoint(unit);
	// upcoming state vars are updated and the next request will see them
	console.log(`estimateAndArb: ${arb_aa}/${curve_aa} calling onAARequest manually`);
	await aa_state.onAARequest({ unit: objJoint.unit, aa_address: arb_aa });
	for (let oswap_aa of oswapAAsByArb[arb_aa])
		lastArbTs[oswap_aa] = Date.now();
	finish();
}

async function swapStable() {
	await xmutex.lock();
	console.log('swapStable');
	for (let arb_aa of my_arb_aas) {
		const curve_aa = curvesByArb[arb_aa];
		if (!curve_aa)
			continue;
		const balances = await dag.readAABalances(arb_aa);
		const { stable_aa, stable_oswap_aa } = await dag.readAAParams(arb_aa);
		const { decimals2 } = await dag.readAAParams(curve_aa);
		const { asset: stable_asset } = aa_state.getAAStateVars(stable_aa);
		const balance = balances[stable_asset] || 0;
		const rate = network.exchangeRates[stable_asset + '_USD']; // in display units per USD
		const usd_balance = balance / 10 ** decimals2 * rate;
		console.log(`stable balance of ${arb_aa} is ${balance} or $${usd_balance}`);
		if (usd_balance > 1) {
			const unit = await dag.sendAARequest(arb_aa, { swap_stable: 1 });
			console.log(`sent request to swap stable in arb ${arb_aa}: ${unit}`);
			lastArbTs[stable_oswap_aa] = Date.now();
		}
		else
			console.log(`stable balance of arb ${arb_aa} is too small`);
	}
	console.log('swapStable done');
	await xmutex.unlock();
}

async function swapImported() {
	await xmutex.lock();
	console.log('swapImported');
	for (let arb_aa of my_arb_aas) {
		const curve_aa = curvesByArb[arb_aa];
		if (!curve_aa)
			continue;
		const balances = await dag.readAABalances(arb_aa);
		const { reserve_oswap_aa } = await dag.readAAParams(arb_aa);
		const { x_asset, y_asset } = await dag.readAAParams(reserve_oswap_aa);
		const { reserve_asset = 'base' } = aa_state.getAAStateVars(curve_aa);
		const imported_asset = reserve_asset === x_asset ? y_asset : x_asset;
		const { decimals } = await getAssetInfo(imported_asset);
		const balance = balances[imported_asset] || 0;
		const rate = network.exchangeRates[imported_asset + '_USD']; // in display units per USD
		const usd_balance = balance / 10 ** decimals * rate;
		console.log(`imported balance of ${arb_aa} is ${balance} or $${usd_balance}`);
		if (usd_balance > 1) {
			const unit = await dag.sendAARequest(arb_aa, { swap_imported: 1 });
			console.log(`sent request to swap imported in arb ${arb_aa}: ${unit}`);
			lastArbTs[reserve_oswap_aa] = Date.now();
		}
		else
			console.log(`imported balance of arb ${arb_aa} is too small`);
	}
	console.log('swapImported done');
	await xmutex.unlock();
}

let assetInfos = {};
async function getAssetInfo(asset){
	if (asset == 'base')
		return { symbol: 'GBYTE', asset, decimals: 9 };
	if (assetInfos[asset])
		return assetInfos[asset];
	const symbol = await dag.readAAStateVar(conf.token_registry_address, "a2s_" + asset);
	if (!symbol)
		throw Error(`no such asset ` + asset);
	const desc_hash = await dag.readAAStateVar(conf.token_registry_address, "current_desc_" + asset);
	if (!desc_hash)
		throw Error(`no desc_hash for ` + symbol);
	const decimals = await dag.readAAStateVar(conf.token_registry_address, "decimals_" + desc_hash);
	if (typeof decimals !== 'number')
		throw Error(`no decimals for ` + symbol);
	assetInfos[asset] = { symbol, asset, decimals };
	return assetInfos[asset];
}

async function checkOswapAAsForSufficientBytes() {
	console.log('checkOswapAAsForSufficientBytes');
	const upcomingBalances = aa_state.getUpcomingBalances();
	for (let oswap_aa in oswap_aas) {
		if (upcomingBalances[oswap_aa].base <= 50000) {
			console.log(`bytes balance of ${oswap_aa} is only ${upcomingBalances[oswap_aa].base}, will add`);
			// the request will bounce but leave 10Kb on the AA
			await dag.sendPayment({ to_address: oswap_aa, amount: 10000, is_aa: true });
		}
	}
	console.log('checkOswapAAsForSufficientBytes done');
}

async function onAAResponse(objAAResponse) {
	const { aa_address, trigger_unit, trigger_initial_unit, trigger_address, bounced, response } = objAAResponse;
	if (bounced && trigger_address === operator.getAddress())
		return console.log(`=== our request ${trigger_unit} bounced with error`, response.error);
	if (bounced)
		return console.log(`request ${trigger_unit} bounced with error`, response.error);
	const arbs = getAffectedArbs([aa_address]);
	console.log(`arbs affected by response from ${aa_address} initial trigger ${trigger_initial_unit} trigger ${trigger_unit}`, arbs);
	if (arbs.length === 0)
		return;
	await waitForAaStateToEmpty();
	const unlock = await mutex.lock('resp');
	for (let arb of arbs) {
		if (trigger_initial_unit !== prev_trigger_initial_unit[arb])
			await queueEstimateAndArb(arb);
		prev_trigger_initial_unit[arb] = trigger_initial_unit;
	}
	unlock();
}

async function onAARequest(objAARequest, arrResponses) {
	const address = objAARequest.unit.authors[0].address;
	if (address === operator.getAddress())
		return console.log(`skipping our own request`);
	if (arrResponses[0].bounced)
		return console.log(`trigger ${objAARequest.unit.unit} from ${address} will bounce`, arrResponses[0].response.error);
	const aas = arrResponses.map(r => r.aa_address);
	console.log(`request from ${address} trigger ${objAARequest.unit.unit} affected AAs`, aas);
	const arbs = getAffectedArbs(aas);
	console.log(`affected arbs`, arbs);
	if (arbs.length === 0)
		return;
	await waitForAaStateToEmpty();
	for (let arb of arbs)
		await queueEstimateAndArb(arb);
}

function getAffectedArbs(aas) {
	let affected_arbs = [];
	for (let aa of aas) {
		let arbs = ostableArbsByAAs[aa];
		if (arbs)
			for (let arb of arbs)
				affected_arbs.push(arb);
		arbs = v1v2ArbsByAAs[aa];
		if (arbs)
			for (let arb of arbs)
				affected_arbs.push(arb);
	}
	return _.uniq(affected_arbs);
}

async function waitForStability() {
	const last_mci = await device.requestFromHub('get_last_mci', null);
	console.log(`last mci ${last_mci}`);
	while (true) {
		await wait(60 * 1000);
		const props = await device.requestFromHub('get_last_stable_unit_props', null);
		const { main_chain_index } = props;
		console.log(`last stable mci ${main_chain_index}`);
		if (main_chain_index >= last_mci)
			break;
	}
	console.log(`mci ${last_mci} is now stable`);
}

async function initArbList() {
	if (conf.arb_aas && conf.arb_aas.length > 0) {
		arb_aas = conf.arb_aas;
		my_arb_aas = conf.arb_aas;
		return;
	}
	if (!conf.owner)
		throw Error(`neither owner nor arb list`);
	const rows = await dag.getAAsByBaseAAs(arb_base_aas);
	arb_aas = [];
	my_arb_aas = [];
	for (let { address, definition } of rows) {
		arb_aas.push(address);
		if (definition[1].params.owner === conf.owner && address.startsWith('22'))
			my_arb_aas.push(address);
	}
	console.log('my arb AAs', my_arb_aas);
	console.log('all arb AAs', arb_aas);
}

function add(obj, key, el) {
	if (!obj[key])
		obj[key] = [];
	obj[key].push(el);
}

async function addArb(arb_aa) {
	console.log(`adding arb ${arb_aa}`);
	await aa_state.followAA(arb_aa);

	// follow the dependent AAs
	const { stable_aa, stable_oswap_aa, reserve_oswap_aa, oswap_v1_aa, oswap_v2_aa } = await dag.readAAParams(arb_aa);
	if (stable_aa) {
		await aa_state.followAA(stable_aa);
		await aa_state.followAA(stable_oswap_aa);
		await aa_state.followAA(reserve_oswap_aa);
		oswap_aas[stable_oswap_aa] = true;
		oswap_aas[reserve_oswap_aa] = true;

		const { curve_aa } = await dag.readAAParams(stable_aa);
		const { decision_engine_aa, fund_aa, governance_aa, p2 } = await dag.readAAStateVars(curve_aa);
		await aa_state.followAA(decision_engine_aa);
		await aa_state.followAA(fund_aa);
		await aa_state.followAA(governance_aa);

		if (my_arb_aas.includes(arb_aa)) {
			add(ostableArbsByAAs, curve_aa, arb_aa);
			add(ostableArbsByAAs, stable_oswap_aa, arb_aa);
			add(ostableArbsByAAs, reserve_oswap_aa, arb_aa);
			curvesByArb[arb_aa] = curve_aa;
			oswapAAsByArb[arb_aa] = [stable_oswap_aa, reserve_oswap_aa];
		}

	/*	const curve_params = await dag.readAAParams(curve_aa);
		const { asset: stable_asset } = await dag.readAAStateVars(stable_aa);
		const g = await dag.executeGetter(arb_aa, 'get_growth_factor', [curve_aa]);
		const target_p2 = await dag.executeGetter(arb_aa, 'get_target_p2_by_params', [curve_aa, curve_params, g]);
		const prices = await dag.executeGetter(arb_aa, 'get_stable_prices', []);
		const p_stable_in_imported = await dag.executeGetter(stable_oswap_aa, 'get_price', [stable_asset]);
		const p_reserve_in_imported = await dag.executeGetter(reserve_oswap_aa, 'get_price', [curve_params.reserve_asset]);
		const p_stable_in_reserve = p_stable_in_imported / p_reserve_in_imported;
		console.error('==== getters', { arb_aa, g, target_p2, p2, prices, oswap: { p_stable_in_imported, p_reserve_in_imported, p_stable_in_reserve } });*/

		await CurveAA.create(curve_aa);
	}
	else {
		if (!oswap_v1_aa)
			throw Error(`unknown type of arb: ${arb_aa}`)
		await aa_state.followAA(oswap_v1_aa);
		await aa_state.followAA(oswap_v2_aa);
		oswap_aas[oswap_v1_aa] = true;
		oswap_aas[oswap_v2_aa] = true;

		const { factory } = await dag.readAAParams(oswap_v1_aa);
		await aa_state.followAA(factory);
	
		if (my_arb_aas.includes(arb_aa)) {
			add(v1v2ArbsByAAs, oswap_v1_aa, arb_aa);
			add(v1v2ArbsByAAs, oswap_v2_aa, arb_aa);
			oswapAAsByArb[arb_aa] = [oswap_v2_aa];
			const { x_asset, y_asset } = await dag.readAAParams(oswap_v2_aa);
			arbInfo[arb_aa] = { x_asset, y_asset, oswaps: [oswap_v1_aa, oswap_v2_aa] };
			yAssetInfosByArb[arb_aa] = await getAssetInfo(y_asset);
		}
	}
}

async function loadLibs() {
	for (let address of conf.lib_aas) {
	//	await dag.loadAA(address);
		const definition = await dag.readAADefinition(address);
		const payload = { address, definition };
		await storage.insertAADefinitions(db, [payload], constants.GENESIS_UNIT, 0, false);
	}
}

async function watchForNewArbs() {
	for (let aa of arb_base_aas) {
		await dag.loadAA(aa);
		network.addLightWatchedAa(aa); // to learn when new arb AAs are defined based on it
	}
	for (let aa of arb_base_aas) {
		eventBus.on("aa_definition_applied-" + aa, async (address, definition) => {
			console.log(`new arb defined ${address}`);
			const owner = definition[1].params.owner;
			if (owner === conf.owner)
				my_arb_aas.push(address);
			arb_aas.push(address);
			await addArb(address);
		});
	}
}


async function watchBuffers() {
	const rows = await dag.getAAsByBaseAAs(conf.buffer_base_aas);
	for (let { address, definition } of rows) {
		let curve_aa = definition[1].params.curve_aa;
		if (CurveAA.get(curve_aa))
			await aa_state.followAA(address);
	}
}

async function watchForNewBuffers() {
	for (let aa of conf.buffer_base_aas) {
		await dag.loadAA(aa);
		network.addLightWatchedAa(aa); // to learn when new buffer AAs are defined based on it
	}
	for (let aa of conf.buffer_base_aas) {
		eventBus.on("aa_definition_applied-" + aa, async (address, definition) => {
			let curve_aa = definition[1].params.curve_aa;
			if (CurveAA.get(curve_aa))
				await aa_state.followAA(address);
		});
	}
}

async function watchV1Arbs() {
	const rows = await dag.getAAsByBaseAAs(conf.v1_arb_base_aas);
	for (let { address, definition } of rows) {
		const { stable_aa, stable_oswap_aa, reserve_oswap_aa } = definition[1].params;
		const { curve_aa } = await dag.readAAParams(stable_aa);
		if (CurveAA.get(curve_aa)) {
			await aa_state.followAA(address);
			await aa_state.followAA(stable_aa);
			await aa_state.followAA(stable_oswap_aa);
			await aa_state.followAA(reserve_oswap_aa);
		}
	}
}

async function startWatching() {
	await loadLibs();
	await initArbList();
	for (let arb_aa of arb_aas)
		await addArb(arb_aa);
	await watchForNewArbs();

	// init the buffers linked to the watched curves
	await watchBuffers();
	await watchForNewBuffers();

	await watchV1Arbs();

	await light_wallet.waitUntilFirstHistoryReceived();

	await waitForStability();

	eventBus.on("aa_request_applied", onAARequest);
	eventBus.on("aa_response_applied", onAAResponse);
	eventBus.on('data_feeds_updated', estimateAndArbAll);

	await swapStable();
	setInterval(swapStable, 4 * 3600 * 1000);
	setTimeout(() => {
		swapImported();
		setInterval(swapImported, 4 * 3600 * 1000);
	}, 3600 * 1000);

	setTimeout(estimateAndArbAll, 1000);
	setTimeout(checkOswapAAsForSufficientBytes, 100);
	setInterval(checkOswapAAsForSufficientBytes, 3600 * 1000);
}


exports.startWatching = startWatching;

