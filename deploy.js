/*jslint node: true */
"use strict";
const eventBus = require('ocore/event_bus.js');
const network = require('ocore/network.js');
const conf = require('ocore/conf.js');
const objectHash = require("ocore/object_hash.js");
const light_wallet = require("ocore/light_wallet.js");

const operator = require('aabot/operator.js');
const dag = require('aabot/dag.js');

const ostable_base_aa = conf.ostable_arb_base_aas[conf.ostable_arb_base_aas.length - 1];
const v1v2_base_aa = conf.v1v2_arb_base_aas[conf.v1v2_arb_base_aas.length - 1];

const paramsByCurrency = {
	USD: {
		stable_aa: 'KGMHPPH4H4K2HSRKFSBZLMDANQYC6DFN',
		stable_oswap_aa: 'UR6IFUPLU4S7GGODTEUCF7PIPSNSW2PN',
		reserve_oswap_aa: 'MBTF5GG44S3ARJHIZH3DEAB4DGUCHCF6',
		owner: conf.owner,
		nonce: 0,
	},
	BTC: {
		stable_aa: '3ADUTYSUBDIS6ET3D5N4ERGUAY3NW7LE',
		stable_oswap_aa: 'KBQO4XLXGLKANN6ODC3FS7JBCINW62RU',
		reserve_oswap_aa: '22AL2GJFGYK7ISFSNUJIX2OSR56HB6Y7',
		owner: conf.owner,
		nonce: 0,
	},
	ETH: {
		stable_aa: 'DJHSXSWWPLMRNZZWBFDLRR47NKW7ZU73',
		stable_oswap_aa: 'VNTX5S6BVUOXZXCCK2LCWCH7S3SWEAVW',
		reserve_oswap_aa: 'YDLB64237VRAYNOO4IPWQKM2CW3PYT3V',
		owner: conf.owner,
		nonce: 0,
	},
};

const paramsByPair = {
	GU: { // GBYTE-USDC
		oswap_v1_aa: 'BNSIB6AH77L4VFAJDKD43K46B6WKVYDM',
		oswap_v2_aa: 'MBTF5GG44S3ARJHIZH3DEAB4DGUCHCF6',
		owner: conf.owner,
		nonce: 0,
	},
	GB: { // GBYTE-WBTC
		oswap_v1_aa: 'KF56ZXXS5LPFOXPMZTJA5RVLQ3OSGTRG',
		oswap_v2_aa: '22AL2GJFGYK7ISFSNUJIX2OSR56HB6Y7',
		owner: conf.owner,
		nonce: 0,
	},
	GE: { // GBYTE-ETH
		oswap_v1_aa: '2VGKYBKUY6ZW5L43N33VUNXRA7DB5TUI',
		oswap_v2_aa: 'YDLB64237VRAYNOO4IPWQKM2CW3PYT3V',
		owner: conf.owner,
		nonce: 0,
	},
	UU: { // OUSD-USDC
		oswap_v1_aa: 'UNSX6BCDLLZCLYOD7UFBJFVQIUQ2ENTU',
		oswap_v2_aa: 'UR6IFUPLU4S7GGODTEUCF7PIPSNSW2PN',
		owner: conf.owner,
		nonce: 0,
	},
	BB: { // OBIT-WBTC
		oswap_v1_aa: '7U5P7LJWDWN2JMXEL2OCUJF43SXTWFXQ',
		oswap_v2_aa: 'KBQO4XLXGLKANN6ODC3FS7JBCINW62RU',
		owner: conf.owner,
		nonce: 0,
	},
	EE: { // OETH-ETH
		oswap_v1_aa: 'HXRYUP5EBHVLG4J3D37CQORQYAQN2ZRZ',
		oswap_v2_aa: 'VNTX5S6BVUOXZXCCK2LCWCH7S3SWEAVW',
		owner: conf.owner,
		nonce: 0,
	},
};

const getOstableArbDefinition = id => ['autonomous agent', {
	base_aa: ostable_base_aa,
	params: paramsByCurrency[id]
}];

const getV1V2ArbDefinition = id => ['autonomous agent', {
	base_aa: v1v2_base_aa,
	params: paramsByPair[id]
}];

async function deploy(id, definitionFunc) {
	const prefix = new RegExp('^22\\d' + id);
	const definition = definitionFunc(id);
	const params = definition[1].params;
	console.error(`searching for nonce matching prefix ${prefix} ...`);
	const start_ts = Date.now();
	const printProgress = () => {
		const elapsed = Date.now() - start_ts;
		console.error(`trying ${params.nonce}, ${params.nonce / elapsed * 1000} nonces/sec`);
	};
	const interval = setInterval(printProgress, 10 * 1000);
	let arb_aa;
	do {
		params.nonce++;
		arb_aa = objectHash.getChash160(definition);
		if (params.nonce % 100000 === 0)
			printProgress();
	}
	while (!arb_aa.match(prefix));
	clearInterval(interval);
	console.error(`found arb AA ${arb_aa}, search took ${(Date.now() - start_ts)/1000} seconds`, definition);
	const unit = await dag.defineAA(definition);
	console.error('deployed in unit', unit);
}

eventBus.on('headless_wallet_ready', async () => {
	await operator.start();
	network.start();
	await light_wallet.waitUntilFirstHistoryReceived();
//	await deploy('ETH', getOstableArbDefinition);
	for (let id in paramsByCurrency)
		await deploy(id, getOstableArbDefinition);
	for (let id in paramsByPair)
		await deploy(id, getV1V2ArbDefinition);
	process.exit();
});

process.on('unhandledRejection', up => {
	console.error('unhandledRejection event', up, up.stack);
	throw up;
});
